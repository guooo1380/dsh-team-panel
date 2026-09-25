#!/usr/bin/env node
// ============================================================================
// scripts/fake-device.mjs —— 单机模拟「第二台设备」（演示 / 自测用）
// ============================================================================
// 为什么需要它：只有一台电脑时，没法真的验证「两台设备互相看见」。
// 这个脚本用**和真插件完全相同的 hub 协议**（/api/join + /api/report + /api/leave）
// 冒充一台队友机器，于是你在自己这一台上就能看到：面板里出现第二名成员、
// 在线 2/2、总 Token 有两个来源一起涨。
//
// ⚠️ 它与真插件的唯一差别：用量数字是造出来的（--tokens / --step），
//    不代表任何真实会话。它只用来验证「连接与显示」这条路是通的。
//
// 用法：
//   node scripts\fake-device.mjs <hub地址> <邀请码>
//   node scripts\fake-device.mjs http://127.0.0.1:7801 H8JEY3S3 --name 小明的 DSH --project 演示项目
//
// 选项：
//   --name <名称>      显示名（默认「模拟队友」，会出现在面板成员列表里）
//   --project <项目名> 他监测的项目名（默认「模拟项目」）
//   --tokens <起始量>  起始 token（默认 12000）
//   --step <每次增量>  每次心跳增加多少 token（默认 300）
//   --interval <秒>    心跳间隔（默认 20，与真插件一致；演示时可给 2）
//   --once             只加入并上报一次就停下（冒烟测试）
//   --keep             退出时**保留**这个成员（默认退出时把自己从团队里移除）
//
// 停止：Ctrl+C。默认会先退出团队（干净），加了 --keep 才会留下。
// ============================================================================

import { createHash } from 'node:crypto'

const argv = process.argv.slice(2)
const hubArg = argv[0]
const inviteArg = argv[1]

function flag(name, fallback) {
  const i = argv.indexOf(name)
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback
}
function has(name) {
  return argv.includes(name)
}

if (!hubArg || !inviteArg || hubArg.startsWith('--') || inviteArg.startsWith('--')) {
  console.log(`
用法: node scripts\\fake-device.mjs <hub地址> <邀请码> [选项]

  hub地址   团队服务器地址，例如 http://127.0.0.1:7801
  邀请码    服务器启动横幅 / hub-info.mjs 里的那 8 位

选项:
  --name <名称>       显示名（默认「模拟队友」）
  --project <项目名>  他监测的项目名（默认「模拟项目」）
  --tokens <起始量>   起始 token（默认 12000）
  --step <每次增量>   每次心跳增加多少（默认 300）
  --interval <秒>     心跳间隔（默认 20）
  --once              只加入并上报一次
  --keep              退出时保留成员（默认移除）

停止: Ctrl+C
`)
  process.exit(2)
}

const displayName = String(flag('--name', '模拟队友')).slice(0, 40)
const projectName = String(flag('--project', '模拟项目')).slice(0, 60)
let tokens = Math.max(0, Number(flag('--tokens', '12000')) || 12000)
const step = Math.max(0, Number(flag('--step', '300')) || 300)
const intervalSec = Math.max(1, Number(flag('--interval', '20')) || 20)
const once = has('--once')
const keep = has('--keep')

// 成员 ID 由名字推出 → 同一个名字反复运行只会更新同一个成员，不会堆出一串幽灵成员。
const memberId = 'fake-' + createHash('sha1').update(displayName).digest('hex').slice(0, 12)

function normalize(raw) {
  let v = String(raw || '').trim()
  if (!/^https?:\/\//i.test(v)) v = 'http://' + v
  return v.replace(/\/+$/, '')
}

const base = normalize(hubArg)
const invite = String(inviteArg).trim().toUpperCase()

/** 带超时的 JSON 请求；返回 { ok, status, json, error } */
async function call(pathname, { method = 'GET', body } = {}, timeout = 8000) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeout)
  try {
    const res = await fetch(base + pathname, {
      method,
      signal: ctrl.signal,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch (err) {
      /* 非 JSON 响应 */
    }
    return { ok: true, status: res.status, json }
  } catch (err) {
    return { ok: false, status: 0, json: null, error: String((err && err.message) || err) }
  } finally {
    clearTimeout(t)
  }
}

function stamp() {
  const d = new Date()
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':')
}

console.log(`\n模拟设备启动：我是「${displayName}」，监测项目「${projectName}」`)
console.log(`目标服务器：${base}\n`)

// ---- 1) 可达性 ----
const health = await call('/api/health')
if (!health.ok || !health.json || health.json.ok !== true) {
  console.log(`❌ 连不上团队服务器：${health.error || ('HTTP ' + health.status)}\n`)
  console.log('  按顺序查：')
  console.log('    1) hub 起来了吗？应当看到「dsh-team-panel 团队服务器已启动」窗口')
  console.log('    2) hub 是不是只监听 127.0.0.1？要别的机器能连就得用 scripts\\start-hub-public.cmd')
  console.log('    3) 服务器那台放行入站端口了吗？scripts\\allow-firewall.cmd（需管理员）')
  console.log('    4) 地址和端口对吗？默认 http://127.0.0.1:7801\n')
  process.exit(1)
}
console.log(`✅ 服务器在：hub v${health.json.version} · ${base}`)

// ---- 2) 加入 ----
const join = await call('/api/join', {
  method: 'POST',
  body: {
    inviteCode: invite,
    memberId,
    displayName,
    machine: 'fake-device',
    project: projectName,
    monitoring: true,
  },
})
if (!join.ok) {
  console.log(`❌ 加入失败：${join.error}\n`)
  process.exit(1)
}
if (join.status === 403) {
  console.log(`❌ 邀请码不正确：${invite}`)
  console.log('   对照服务器窗口里「邀请码」那一行（8 位，字母数字，不含易混的 0/O/1/I/L）\n')
  process.exit(1)
}
if (join.status !== 200 || !join.json || join.json.ok !== true) {
  console.log(`❌ 加入被拒绝：HTTP ${join.status} ${(join.json && join.json.error) || ''}\n`)
  process.exit(1)
}

const teamId = join.json.teamId
const memberToken = join.json.memberToken
console.log(`✅ 已加入团队「${join.json.teamName}」（memberId ${memberId}）`)

/** 造一份上报体：数字是假的，字段结构与真插件一致。 */
function payload() {
  const cost = Math.round((tokens / 1_000_000) * 2 * 1e6) / 1e6
  return {
    teamId,
    memberId,
    memberToken,
    displayName,
    machine: 'fake-device',
    project: projectName,
    monitoring: true,
    projects: [{ name: projectName, tokens, cost }],
    usage: {
      tokens,
      cost,
      input: Math.round(tokens * 0.02),
      cache: Math.round(tokens * 0.86),
      output: Math.round(tokens * 0.12),
    },
    lastUsedAt: Date.now(),
  }
}

let leaving = false
async function leave() {
  if (leaving) return
  leaving = true
  const res = await call('/api/leave', {
    method: 'POST',
    body: { teamId, memberId, memberToken },
  })
  if (res.ok && res.json && res.json.ok) console.log(`\n已退出团队（成员「${displayName}」已从服务器移除）`)
  else console.log('\n⚠️ 没能自动退出团队，可在管理页面手动移除这个成员。')
}

async function reportOnce() {
  const res = await call('/api/report', { method: 'POST', body: payload() })
  if (!res.ok || !res.json || res.json.ok !== true) {
    console.log(`❌ 上报失败：${(res.json && res.json.error) || res.error || ('HTTP ' + res.status)}`)
    return false
  }
  const totals = res.json.snapshot.totals
  console.log(
    `[${stamp()}] 已上报 ${Math.round(tokens).toLocaleString('en-US')} tokens` +
      `   · 服务器现在：${totals.online}/${totals.members} 在线 · ${totals.projects} 个项目 · 全队 ${Math.round(
        totals.tokens || 0
      ).toLocaleString('en-US')} tokens`
  )
  return true
}

await reportOnce()
if (once) {
  console.log('\n（--once：只上报一次。面板里应当已经能看到这个成员了。）')
  if (!keep) {
    await leave()
  } else {
    console.log(`成员「${displayName}」已保留在团队里；不要了就去管理页面移除。`)
  }
  console.log('')
  process.exit(0)
}

console.log(`\n开始每 ${intervalSec} 秒心跳一次（Ctrl+C 停止）：`)
const timer = setInterval(() => {
  tokens += step
  reportOnce().catch(() => {})
}, intervalSec * 1000)

process.on('SIGINT', async () => {
  clearInterval(timer)
  if (!keep) await leave()
  else console.log(`\n已停止上报；成员「${displayName}」保留在团队里（服务器 70 秒后会显示为离线）。`)
  process.exit(0)
})
