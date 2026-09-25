#!/usr/bin/env node
// ============================================================================
// scripts/plugintest.mjs —— 宿主端插件自检（用 mock ctx 拉起 lib/index.js）
// ============================================================================
// 目的：不重启 DSH Desktop 就能验证插件的路由、**项目选择语义**、token 采集、
//       注入与团队同步。
//
// 核心口径（本文件重点验证）：
//   ① 没选监测项目 → 一个 token 都不统计；
//   ② 选定后 → 只统计该项目的会话，别的项目的用量必须被忽略；
//   ③ 切换项目 → 旧账本保留但不再上报，新项目从 0 开始；
//   ④ 团队页面上能看到「我选了哪个项目」。
//
// 用法：
//   node scripts/plugintest.mjs [hubUrl] [inviteCode]
//   例：node scripts/plugintest.mjs http://127.0.0.1:7899 5GYYN87G
// ============================================================================

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TMP_HOME = path.join(ROOT, 'data', 'test-dsh-home')
const TMP_PROJECTS = path.join(ROOT, 'data', 'test-projects')

// 必须在 import 插件之前改掉 DSH_HOME，插件才会把状态写进工作区内的临时目录
fs.rmSync(TMP_HOME, { recursive: true, force: true })
fs.rmSync(TMP_PROJECTS, { recursive: true, force: true })
fs.mkdirSync(TMP_HOME, { recursive: true })

// 造几个「真实存在」的项目目录：插件的项目选择会校验目录存在
const PROJ_A = path.join(TMP_PROJECTS, '演示项目')
const PROJ_B = path.join(TMP_PROJECTS, '另一个项目')
const PROJ_SUB = path.join(PROJ_A, '子目录')
for (const d of [PROJ_A, PROJ_B, PROJ_SUB]) fs.mkdirSync(d, { recursive: true })
process.env.DSH_HOME = TMP_HOME

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
function checkThat(name, cond, detail) {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.log(`  ✗ ${name}${detail ? '  → ' + detail : ''}`)
  }
}

// ---------------------------------------------------------------------------
// mock 宿主
// ---------------------------------------------------------------------------
const routes = new Map()
const taps = []
const listeners = new Map()

// 模拟 DSH 的工作区注册表（真实环境里由 @deepseek-ai/dsh-workspace 提供）
const fakeRegistry = {
  list() {
    return [
      { id: 'w1', path: PROJ_A, title: '演示项目', sessionIds: ['s1', 's2'] },
      { id: 'w2', path: PROJ_B, title: '另一个项目', sessionIds: ['s3'] },
    ]
  },
}

const ctx = {
  get: (name) => (name === 'workspaceRegistry' ? fakeRegistry : undefined),
  webServer: {
    register(route) {
      const key = `${route.kind}:${route.path}`
      if (routes.has(key)) throw new Error(`duplicate route ${key}`)
      routes.set(key, route)
      return () => routes.delete(key)
    },
    tapIndex(fn) {
      taps.push(fn)
      return () => {}
    },
  },
  on(name, fn) {
    if (!listeners.has(name)) listeners.set(name, [])
    listeners.get(name).push(fn)
    return () => {}
  },
  effect(fn) {
    fn()
    return () => {}
  },
}

const plugin = (await import(pathToFileURL(path.join(ROOT, 'lib', 'index.js')).href)).default
check('插件名正确', plugin.name, 'dsh-team-panel')
check('声明了 webServer / connection 依赖', plugin.inject, ['webServer', 'connection'])
plugin.apply(ctx)

const server = http.createServer(async (req, res) => {
  const p = new URL(req.url || '/', 'http://x').pathname
  const route = routes.get(`exact:${p}`)
  if (!route) {
    res.writeHead(404)
    res.end()
    return
  }
  await route.handler(req, res)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const BASE = `http://127.0.0.1:${server.address().port}`

async function api(method, pathname, body) {
  const res = await fetch(BASE + pathname, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, json }
}
const stateOf = () => api('GET', '/dsh-team/state').then((r) => r.json)

/** 模拟一次模型回复：触发插件的 usage 采集。 */
function emitTurn(cwd, { input = 1000, cache = 5000, output = 2000, model = 'deepseek-flash' } = {}) {
  for (const fn of listeners.get('session/event') || []) {
    fn(
      { id: 'sess-1', header: { cwd } },
      { type: 'assistant/message', data: { turn: 1, usage: { inputTokens: input, cacheReadTokens: cache, outputTokens: output }, message: { source: { model } } } },
    )
  }
}

console.log('\n[1] 路由注册')
checkThat('/dsh-team/state 已注册', routes.has('exact:/dsh-team/state'))
checkThat('/dsh-team/project 已注册', routes.has('exact:/dsh-team/project'))
checkThat('/dsh-team/reset 已注册', routes.has('exact:/dsh-team/reset'))
checkThat('/dsh-team/panel.js 已注册', routes.has('exact:/dsh-team/panel.js'))
checkThat('注册了 index 注入 tap', taps.length, 1)

console.log('\n[2] index 注入')
const html = taps[0]('<html><body><div id="root"></div></body></html>')
checkThat('注入了 panel.js script 标签', html.includes('<script defer src="/dsh-team/panel.js"></script>'))
check('重复注入保持幂等', taps[0](html), html)

console.log('\n[3] 初始状态：还没选项目')
const s0 = await stateOf()
check('未开始监测', s0.self.monitoring, false)
check('没有选中项目', s0.self.selectedProject, null)
checkThat('返回可选项目列表', Array.isArray(s0.self.projects))
checkThat('项目列表来自 DSH 工作区注册表', s0.self.projects.some((p) => p.title === '演示项目' && p.source === 'registry'))
check('项目列表带会话数', s0.self.projects.find((p) => p.title === '演示项目').sessions, 2)

console.log('\n[4] 未选择项目时，一个 token 都不统计')
emitTurn(PROJ_A)
const s1 = await stateOf()
check('用量仍为 0', s1.self.usage.tokens, 0)
check('调用次数仍为 0', s1.self.usage.calls, 0)
checkThat('但记住了见过的项目目录（用于列表兜底）', s1.self.projects.some((p) => p.path.toLowerCase() === PROJ_A.toLowerCase()))

console.log('\n[5] 选择要监测的项目')
const notExist = await api('POST', '/dsh-team/project', { path: path.join(TMP_PROJECTS, '不存在的项目') })
check('选不存在的目录被拒绝', notExist.status, 400)
const pickA = await api('POST', '/dsh-team/project', { path: PROJ_A })
check('选择成功', pickA.status, 200)
check('标题取自 DSH 注册表', pickA.json.selectedProject.title, '演示项目')
const s2 = await stateOf()
check('已标记为监测中', s2.self.monitoring, true)
check('选中项目路径正确', s2.self.selectedProject.path.toLowerCase(), PROJ_A.toLowerCase())

console.log('\n[6] 只统计所选项目')
emitTurn(PROJ_A)
const s3 = await stateOf()
check('累计 token = 8000', s3.self.usage.tokens, 8000)
check('输入 = 1000', s3.self.usage.input, 1000)
check('缓存 = 5000', s3.self.usage.cache, 5000)
check('输出 = 2000', s3.self.usage.output, 2000)
check('调用次数 = 1', s3.self.usage.calls, 1)
checkThat('记录了最后消耗时间', s3.self.usage.lastUsedAt > 0)
// 空闲时段 deepseek-flash：1k 未命中输入 + 5k 缓存命中 + 2k 输出
// = 0.001*1 + 0.005*0.02 + 0.002*4 = 0.0091
checkThat('按官方价目估算花费', Math.abs(s3.self.usage.cost - 0.0091) < 1e-9, `实际 ${s3.self.usage.cost}`)

// 关键用例：别的项目产生的用量必须被忽略
emitTurn(PROJ_B, { input: 999999, cache: 0, output: 0 })
const s4 = await stateOf()
check('其它项目的用量被忽略（仍为 8000）', s4.self.usage.tokens, 8000)
// 子目录下的会话算同一个项目
emitTurn(PROJ_SUB)
const s5 = await stateOf()
check('项目子目录的会话计入（8000 + 8000）', s5.self.usage.tokens, 16000)
// 没带 cwd 的会话也不该被误算
emitTurn('')
const s6 = await stateOf()
check('没有 cwd 的会话不计入', s6.self.usage.tokens, 16000)

console.log('\n[7] 切换项目：旧账本保留、新项目从 0 开始')
await api('POST', '/dsh-team/project', { path: PROJ_B })
const s7 = await stateOf()
check('切到新项目后用量归 0', s7.self.usage.tokens, 0)
check('新项目标题正确', s7.self.selectedProject.title, '另一个项目')
emitTurn(PROJ_B, { input: 300, cache: 0, output: 0 })
const s8 = await stateOf()
check('新项目开始累计（300）', s8.self.usage.tokens, 300)
// 切回原项目，旧数据仍在
await api('POST', '/dsh-team/project', { path: PROJ_A })
const s9 = await stateOf()
check('切回原项目，旧账本仍在（16000）', s9.self.usage.tokens, 16000)

console.log('\n[8] 清零与取消监测')
await api('POST', '/dsh-team/reset', {})
const s10 = await stateOf()
check('清零后为 0', s10.self.usage.tokens, 0)
check('清零后仍在监测该项目', s10.self.monitoring, true)
emitTurn(PROJ_A)
const s11 = await stateOf()
check('清零后重新累计', s11.self.usage.tokens, 8000)

await api('POST', '/dsh-team/project', { path: '' })
const s12 = await stateOf()
check('取消监测后 monitoring = false', s12.self.monitoring, false)
check('取消监测后用量对外为 0', s12.self.usage.tokens, 0)
emitTurn(PROJ_A)
const s13 = await stateOf()
check('取消监测后不再累计', s13.self.usage.tokens, 0)
// 复位：重新选中，供后面联调用
await api('POST', '/dsh-team/project', { path: PROJ_A })

console.log('\n[9] 本机设置与错误处理')
await api('POST', '/dsh-team/config', { displayName: '测试机', expanded: true })
const s14 = await stateOf()
check('改名生效', s14.self.displayName, '测试机')
check('展开态被持久化', s14.ui.expanded, true)
await new Promise((r) => setTimeout(r, 500))
checkThat('状态已落盘', fs.existsSync(path.join(TMP_HOME, 'team-panel', 'state.json')))
const badJoin = await api('POST', '/dsh-team/join', { hubUrl: '', inviteCode: '', displayName: 'x' })
check('缺少服务器地址时 400', badJoin.status, 400)

// ---------------------------------------------------------------------------
// 与真实 hub 联调
// ---------------------------------------------------------------------------
const hubUrl = process.argv[2]
const inviteCode = process.argv[3]
if (!hubUrl || !inviteCode) {
  console.log('\n[10] 与团队服务器联调 —— 已跳过（未提供 hubUrl / 邀请码）')
} else {
  console.log(`\n[10] 与团队服务器联调（${hubUrl}）`)
  const join = await api('POST', '/dsh-team/join', { hubUrl, inviteCode, displayName: '测试机' })
  check('加入团队成功', join.status, 200)

  const s15 = await stateOf()
  check('已标记为已加入', s15.team.configured, true)
  const me = (s15.team.snapshot?.members || []).find((m) => m.name === '测试机')
  checkThat('快照里能看见自己', !!me)
  if (me) {
    check('团队看到我选的项目名', me.project, '演示项目')
    check('团队看到我选的项目路径', me.projectPath.toLowerCase(), PROJ_A.toLowerCase())
    check('团队看到该项目已产生的 token', me.tokens, 8000)
    check('团队看到我已选定项目', me.monitoring, true)
  }
  checkThat(
    '项目聚合里出现「演示项目」',
    (s15.team.snapshot?.projects || []).some((p) => p.name === '演示项目' && p.tokens === 8000),
  )

  // 取消监测后，团队侧应看到「未选择项目」
  await api('POST', '/dsh-team/project', { path: '' })
  await api('POST', '/dsh-team/sync', {})
  const s16 = await stateOf()
  const me2 = (s16.team.snapshot?.members || []).find((m) => m.name === '测试机')
  check('取消监测后团队看到空项目名', me2 ? me2.project : 'missing', '')
  check('取消监测后团队看到未选定', me2 ? me2.monitoring : 'missing', false)
  check('取消监测后团队看到 token 归 0', me2 ? me2.tokens : -1, 0)
  // 没选项目的成员不该在项目聚合里凭空造一个「未命名项目」条目
  check('未选项目的成员不进项目聚合', (s16.team.snapshot?.projects || []).length, 0)
  checkThat('但成员本人仍留在成员列表里', (s16.team.snapshot?.members || []).some((m) => m.name === '测试机'))
  await api('POST', '/dsh-team/project', { path: PROJ_A })

  const leave = await api('POST', '/dsh-team/leave', {})
  check('退出团队成功', leave.status, 200)
  const s17 = await stateOf()
  check('退出后回到未加入状态', s17.team.configured, false)
}

server.close()
console.log(`\n结果：通过 ${pass}，失败 ${fail}\n`)
process.exit(fail === 0 ? 0 : 1)
