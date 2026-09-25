#!/usr/bin/env node
// ============================================================================
// scripts/hub-info.mjs —— 团队服务器信息速查（中文输出）
// ============================================================================
// 为什么需要它：把 hub 装成开机自启的后台任务后，它以 SYSTEM 身份在后台跑，
// **没有控制台可以看横幅**，也就看不到邀请码和管理密钥。这个工具直接读数据文件，
// 把该给队友的东西、该做什么，一次性打印出来。
//
// 用法：
//   node scripts/hub-info.mjs
//   node scripts/hub-info.mjs --data D:\team\team-hub-data.json --port 7801
// ============================================================================

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { classifyAddresses } from '../lib/net-addresses.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function arg(name, fallback) {
  const i = process.argv.indexOf(name)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const DATA_FILE = path.resolve(arg('--data', path.join(ROOT, 'data', 'team-hub-data.json')))
const PORT = Number(arg('--port', '7801')) || 7801

console.log('\n══════════ dsh-team-panel 团队服务器信息 ══════════\n')
console.log(`  数据文件    ${DATA_FILE}`)

let data = null
try {
  data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))
} catch (err) {
  console.log('\n  ⚠️  读不到数据文件，说明这台机器上的 hub 还没成功启动过。\n')
  console.log('  先启动一次（二选一）：')
  console.log(`    scripts\\start-hub-public.cmd ${PORT}          # 前台，能直接看到横幅`)
  console.log('    scripts\\install-autostart.cmd ' + PORT + '        # 装成开机自启（需管理员）')
  console.log('')
  process.exit(1)
}

const teams = Object.values(data.teams || {})
if (teams.length === 0) {
  console.log('\n  ⚠️  数据文件里还没有任何团队。重启一次 hub 会自动创建。\n')
  process.exit(1)
}

const team = teams[0]

// —— 是否正在运行 ——
let running = false
let latency = 0
try {
  const started = Date.now()
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 3000)
  const res = await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: ctrl.signal })
  clearTimeout(t)
  running = res.ok
  latency = Date.now() - started
} catch (err) {
  running = false
}

console.log(`  运行状态    ${running ? `✅ 正在运行（127.0.0.1:${PORT}，${latency}ms）` : `❌ 没在 127.0.0.1:${PORT} 上监听`}`)
console.log(`  团队名称    ${team.name}`)
console.log(`  创建时间    ${team.createdAt ? new Date(team.createdAt).toLocaleString('zh-CN') : '—'}`)
console.log('')
console.log('  ┌────────────────────────────────────────────────┐')
console.log(`  │  邀请码（发给队友）：  ${String(team.inviteCode).padEnd(22)}│`)
console.log('  └────────────────────────────────────────────────┘')
console.log('')
console.log(`  管理密钥    ${team.adminKey}`)
console.log(`  管理页面    http://127.0.0.1:${PORT}/admin?key=${team.adminKey}`)
console.log('   （管理页面可直接在浏览器打开：看邀请码、成员列表、全队总量，还能移除成员）')

// —— 队友该填的地址 ——
const addr = classifyAddresses()
console.log('\n  ── 队友「团队服务器地址」可以填 ──────────────────')
const candidates = []
for (const x of addr.tailscale) candidates.push({ url: `http://${x.addr}:${PORT}`, note: `Tailscale（${x.name}）` })
for (const x of addr.lan) candidates.push({ url: `http://${x.addr}:${PORT}`, note: `局域网（${x.name}）` })
if (candidates.length === 0) {
  console.log('     （没找到可用的局域网 / Tailscale 地址）')
} else {
  candidates.forEach((c, i) => console.log(`   ${i === 0 ? '👉' : '  '} ${c.url.padEnd(34)} ${c.note}`))
  console.log(`\n   推荐用第一行：${candidates[0].url}`)
}
if (addr.other.length) {
  console.log(`   另外还有（多半是虚拟网卡，队友连不上，仅供参考）：${addr.other.map((x) => `${x.addr}(${x.name})`).join('、')}`)
}

// —— 成员 ——
const members = Object.values(team.members || {})
console.log('\n  ── 成员 ────────────────────────────────────────')
if (members.length === 0) {
  console.log('   还没有成员加入。')
} else {
  const now = Date.now()
  const sorted = members.slice().sort((a, b) => (b.tokens || 0) - (a.tokens || 0))
  for (const m of sorted) {
    const online = now - (m.lastReportAt || 0) < 70 * 1000
    const proj = m.project ? m.project : '（未选择监测项目）'
    const tok = Math.round(m.tokens || 0).toLocaleString('en-US')
    console.log(`   ${online ? '🟢' : '⚪'} ${String(m.name).padEnd(16)} ${proj.padEnd(20)} ${tok.padStart(12)} tokens`)
  }
}

// —— 下一步 ——
console.log('\n  ── 下一步 ──────────────────────────────────────')
const steps = []
if (!running) {
  steps.push(`启动 hub：scripts\\start-hub-public.cmd ${PORT}  或  schtasks /run /tn "dsh-team-panel hub"`)
  steps.push(`放行端口（需管理员）：scripts\\allow-firewall.cmd ${PORT}`)
}
steps.push('每台机器装 Tailscale 并登录同一账号：https://tailscale.com/download/windows')
steps.push(`队友在 DSH 面板里填上面的地址 + 邀请码 ${team.inviteCode} → 加入团队`)
steps.push(`队友自检连通性：node scripts\\netcheck.mjs ${candidates[0] ? candidates[0].url : 'http://<地址>:' + PORT} ${team.inviteCode}`)
steps.push('装成开机自启（需管理员）：scripts\\install-autostart.cmd ' + PORT)
steps.forEach((s, i) => console.log(`   ${i + 1}. ${s}`))
console.log('')
