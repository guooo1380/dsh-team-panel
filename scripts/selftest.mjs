#!/usr/bin/env node
// ============================================================================
// scripts/selftest.mjs —— dsh-team-panel 自检
// ============================================================================
// 用法：
//   node scripts/selftest.mjs                    # 只测峰谷判定（离线）
//   node scripts/selftest.mjs http://127.0.0.1:7899   # 额外测团队服务器 API
// ============================================================================

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isPeakTime, nextPeakChangeAt, peakSnapshot } from '../lib/peak.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0
let fail = 0

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.log(`  ✗ ${name}\n      期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
  }
}

/** 把「北京时间」换算成 epoch 秒，方便写用例。 */
function bj(y, mo, d, h, mi) {
  return Math.floor(Date.UTC(y, mo - 1, d, h - 8, mi || 0, 0) / 1000)
}

console.log('\n[1] 峰谷判定（官方规则：北京时间 周一至周五非节假日 9-12、14-18 为高峰）')
// 2026-09-18 是周五，且不在节假日表里 → 正常工作日
check('工作日 08:59 → 谷', isPeakTime(bj(2026, 9, 18, 8, 59)), false)
check('工作日 09:00 → 峰', isPeakTime(bj(2026, 9, 18, 9, 0)), true)
check('工作日 11:59 → 峰', isPeakTime(bj(2026, 9, 18, 11, 59)), true)
check('工作日 12:00 → 谷', isPeakTime(bj(2026, 9, 18, 12, 0)), false)
check('工作日 13:59 → 谷', isPeakTime(bj(2026, 9, 18, 13, 59)), false)
check('工作日 14:00 → 峰', isPeakTime(bj(2026, 9, 18, 14, 0)), true)
check('工作日 17:59 → 峰', isPeakTime(bj(2026, 9, 18, 17, 59)), true)
check('工作日 18:00 → 谷', isPeakTime(bj(2026, 9, 18, 18, 0)), false)
check('工作日 23:30 → 谷', isPeakTime(bj(2026, 9, 18, 23, 30)), false)
// 2026-09-24 是周四，且不在节假日表里
check('周四 2026-09-24 10:00 → 峰', isPeakTime(bj(2026, 9, 24, 10, 0)), true)
check('周四 2026-09-24 20:00 → 谷', isPeakTime(bj(2026, 9, 24, 20, 0)), false)
// 周末 → 全天谷
check('周六 2026-09-19 10:00 → 谷', isPeakTime(bj(2026, 9, 19, 10, 0)), false)
check('周日 2026-09-20 15:00 → 谷', isPeakTime(bj(2026, 9, 20, 15, 0)), false)
// 法定节假日：2026-09-25（周五，中秋）与 2026-10-01（周四，国庆）→ 全天谷
check('中秋 2026-09-25（周五）10:00 → 谷', isPeakTime(bj(2026, 9, 25, 10, 0)), false)
check('中秋 2026-09-26（周六）10:00 → 谷', isPeakTime(bj(2026, 9, 26, 10, 0)), false)
check('国庆 2026-10-01（周四）10:00 → 谷', isPeakTime(bj(2026, 10, 1, 10, 0)), false)
// 节假日结束后的工作日恢复高峰
check('2026-09-28（周一，节后）10:00 → 峰', isPeakTime(bj(2026, 9, 28, 10, 0)), true)

const nextFrom = bj(2026, 9, 18, 8, 0)
check('工作日 08:00 的下一次切换 = 09:00', nextPeakChangeAt(nextFrom), bj(2026, 9, 18, 9, 0))
check('工作日 12:30 的下一次切换 = 14:00', nextPeakChangeAt(bj(2026, 9, 18, 12, 30)), bj(2026, 9, 18, 14, 0))

const nextFrom2 = bj(2026, 9, 24, 8, 0)
check('周四 08:00 的下一次切换 = 09:00', nextPeakChangeAt(nextFrom2), bj(2026, 9, 24, 9, 0))

const snap = peakSnapshot()
console.log(`  · 当前时段快照：${snap.text}（${snap.label}），下一次切换 ${snap.nextChangeAt ? new Date(snap.nextChangeAt * 1000).toLocaleString('zh-CN') : '—'}`)

// 打包体积自检：确认 panel.js 不会引用不存在的宿主接口
console.log('\n[2] 资源自检')
const panel = fs.readFileSync(path.join(ROOT, 'lib', 'panel.js'), 'utf8')
check('panel.js 使用 /dsh-team 前缀', panel.includes("'/dsh-team'"), true)
check('panel.js 锚定左侧边栏的「设置」槽位', panel.includes('[data-slot="sidebar.settings"]'), true)
check('panel.js 已脱离对话区底部（避免与鲸鱼插件相撞）', panel.includes('[data-composer-seat]'), false)
check('panel.js 无 import/export（浏览器直接执行）', /^\s*(import|export)\s/m.test(panel), false)

// ---------------------------------------------------------------------------
// 团队服务器 API 自检
// ---------------------------------------------------------------------------
const hubBase = process.argv[2]
if (!hubBase) {
  console.log('\n[3] 团队服务器 API —— 已跳过（未提供地址）')
  console.log(`\n结果：通过 ${pass}，失败 ${fail}\n`)
  process.exit(fail === 0 ? 0 : 1)
}

console.log(`\n[3] 团队服务器 API（${hubBase}）`)

async function req(method, pathname, body, query) {
  const url = new URL(hubBase + pathname)
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v))
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, json }
}

const health = await req('GET', '/api/health')
check('/api/health 返回 ok', health.json && health.json.ok, true)

// 邀请码：第 3 个参数优先，其次环境变量 HUB_INVITE（从 hub 启动横幅里抄）
const invite = process.argv[3] || process.env.HUB_INVITE
if (!invite) {
  console.log('  ! 未提供邀请码（第 3 个参数或 HUB_INVITE），跳过 join/report/snapshot 用例')
  console.log(`\n结果：通过 ${pass}，失败 ${fail}\n`)
  process.exit(fail === 0 ? 0 : 1)
}

const bad = await req('POST', '/api/join', { inviteCode: 'WRONGCODE', displayName: 'x' })
check('错误邀请码被拒绝', bad.status, 403)

const a = await req('POST', '/api/join', { inviteCode: invite, memberId: 'test-member-a', displayName: '甲', machine: 'PC-A', project: '项目甲' })
check('加入团队成功', a.json && a.json.ok, true)
check('返回成员令牌', typeof (a.json && a.json.memberToken), 'string')

const b = await req('POST', '/api/join', { inviteCode: invite, memberId: 'test-member-b', displayName: '乙', machine: 'PC-B', project: '项目乙' })
check('第二个成员加入成功', b.json && b.json.ok, true)

const r1 = await req('POST', '/api/report', {
  teamId: a.json.teamId,
  memberId: 'test-member-a',
  memberToken: a.json.memberToken,
  displayName: '甲',
  project: '项目甲',
  projects: [{ name: '项目甲', tokens: 1200000, cost: 3.5 }],
  usage: { tokens: 1200000, cost: 3.5, input: 800000, cache: 300000, output: 100000 },
  lastUsedAt: Date.now(),
})
check('上报用量成功', r1.json && r1.json.ok, true)

await req('POST', '/api/report', {
  teamId: b.json.teamId,
  memberId: 'test-member-b',
  memberToken: b.json.memberToken,
  displayName: '乙',
  project: '项目乙',
  projects: [{ name: '项目乙', tokens: 800000, cost: 2.25 }],
  usage: { tokens: 800000, cost: 2.25, input: 500000, cache: 200000, output: 100000 },
  lastUsedAt: Date.now(),
})

const badToken = await req('POST', '/api/report', {
  teamId: a.json.teamId,
  memberId: 'test-member-a',
  memberToken: 'deadbeef',
  usage: { tokens: 1 },
})
check('伪造令牌被拒绝', badToken.status, 401)

const snapRes = await req('GET', '/api/snapshot', null, {
  teamId: a.json.teamId,
  memberId: 'test-member-a',
  memberToken: a.json.memberToken,
})
const s = snapRes.json && snapRes.json.snapshot
check('快照含 2 名成员', s && s.members.length, 2)
check('全队总 Token = 2,000,000', s && s.totals.tokens, 2000000)
check('团队总花费 ≈ 5.75', s && Number(s.totals.cost.toFixed(2)), 5.75)
check('项目聚合为 2 个', s && s.projects.length, 2)
check('在线人数 2', s && s.totals.online, 2)
check('按 Token 降序', s && s.members[0].name, '甲')

await req('POST', '/api/leave', { teamId: b.json.teamId, memberId: 'test-member-b', memberToken: b.json.memberToken })
const after = await req('GET', '/api/snapshot', null, {
  teamId: a.json.teamId,
  memberId: 'test-member-a',
  memberToken: a.json.memberToken,
})
check('退出后只剩 1 名成员', after.json && after.json.snapshot.members.length, 1)
await req('POST', '/api/leave', { teamId: a.json.teamId, memberId: 'test-member-a', memberToken: a.json.memberToken })

console.log(`\n结果：通过 ${pass}，失败 ${fail}\n`)
process.exit(fail === 0 ? 0 : 1)
