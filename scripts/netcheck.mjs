#!/usr/bin/env node
// ============================================================================
// scripts/netcheck.mjs —— 联网连通性自检（在「队友那台机器」上跑最有价值）
// ============================================================================
// 作用：把「连不上团队服务器」这件事拆成可判定的几步，直接告诉你卡在哪。
//
// 用法：
//   node scripts/netcheck.mjs http://192.168.1.10:7801
//   node scripts/netcheck.mjs https://team.example.com <邀请码>
//
// 它只做只读检查 + 一次「加入→上报→退出」的完整往返（用了临时成员身份，
// 结束后会自己清理），不会动你自己的成员记录。
// ============================================================================

import { randomBytes } from 'node:crypto'

const raw = process.argv[2]
const invite = process.argv[3] || process.env.HUB_INVITE

let pass = 0
let fail = 0
let warn = 0
function ok(msg, detail) {
  pass++
  console.log(`  ✅ ${msg}${detail ? '  — ' + detail : ''}`)
}
function bad(msg, detail) {
  fail++
  console.log(`  ❌ ${msg}${detail ? '  — ' + detail : ''}`)
}
function caution(msg, detail) {
  warn++
  console.log(`  ⚠️  ${msg}${detail ? '  — ' + detail : ''}`)
}

if (!raw) {
  console.log(`
用法: node scripts/netcheck.mjs <团队服务器地址> [邀请码]

  地址就是你要填进 DSH 面板「团队服务器地址」里的那个，例如：
    http://192.168.1.10:7801          局域网
    http://my-pc.tailxxxx.ts.net:7801 Tailscale 虚拟局域网
    https://team.example.com          公网 + HTTPS
`)
  process.exit(2)
}

function normalize(s) {
  let v = String(s).trim()
  if (!/^https?:\/\//i.test(v)) v = 'http://' + v
  return v.replace(/\/+$/, '')
}

const base = normalize(raw)
let u
try {
  u = new URL(base)
} catch (err) {
  console.log(`\n❌ 地址格式不对：${raw}\n`)
  process.exit(1)
}

/** 私网 / 虚拟局域网地址判定：这些走明文 http 是可接受的。 */
function isPrivateHost(host) {
  const h = host.toLowerCase()
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.ts.net') || h.endsWith('.internal')) return true
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h)
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  if (a === 127 || a === 10) return true
  if (a === 192 && b === 168) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 100 && b >= 64 && b <= 127) return true // Tailscale / CGNAT 段
  if (a === 169 && b === 254) return true
  return false
}

async function timedFetch(url, opts = {}, timeout = 8000) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeout)
  const started = Date.now()
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal })
    const text = await res.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch (err) {
      json = null
    }
    return { ok: true, status: res.status, json, text, ms: Date.now() - started }
  } catch (err) {
    const msg = err && err.name === 'AbortError' ? `超时（>${timeout}ms）` : String((err && err.message) || err)
    return { ok: false, error: msg, ms: Date.now() - started }
  } finally {
    clearTimeout(t)
  }
}

console.log(`\n检查目标：${base}`)
console.log(`           主机 ${u.hostname} · 端口 ${u.port || (u.protocol === 'https:' ? 443 : 80)} · ${u.protocol.replace(':', '').toUpperCase()}`)

console.log('\n[1] 可达性')
const health = await timedFetch(base + '/api/health', { headers: { Accept: 'application/json' } })
if (!health.ok) {
  bad('连不上团队服务器', health.error)
  console.log(`
  按顺序排查：
    1) 服务器那台机器上，hub 起来了吗？应当看到「dsh-team-panel 团队服务器已启动」横幅
    2) hub 是不是只监听了本机？只监听 127.0.0.1 时别的机器永远连不上 ——
       用 scripts\\start-hub-public.cmd 起（等价于 --public，监听 0.0.0.0）
    3) 服务器那台的 Windows 防火墙放行了吗？跑一次 scripts\\allow-firewall.cmd（需要管理员）
    4) 两台机器在同一个局域网 / 同一个 Tailscale 网络里吗？互相 ping 一下
    5) 端口对不对？默认 7801
    6) 跨公网的话，地址填对了吗（域名解析、安全组、反向代理是否转发到 7801）
`)
} else if (health.status !== 200 || !health.json || health.json.ok !== true) {
  bad('地址能连通，但返回的不是团队服务器', `HTTP ${health.status}`)
  console.log('  这个地址后面挂着的像是别的东西。确认端口 / 路径有没有写错。\n')
} else {
  ok('连上了', `HTTP 200 · ${health.ms}ms · hub v${health.json.version}`)
}

console.log('\n[2] 往返延迟（3 次取中位）')
if (health.ok && health.json && health.json.ok) {
  const samples = [health.ms]
  for (let i = 0; i < 2; i++) {
    const r = await timedFetch(base + '/api/health', {}, 8000)
    if (r.ok) samples.push(r.ms)
  }
  samples.sort((a, b) => a - b)
  const med = samples[Math.floor(samples.length / 2)]
  if (med < 80) ok(`很快：${med}ms`, '面板 3 秒轮询完全够用')
  else if (med < 400) ok(`可用：${med}ms`)
  else if (med < 1500) caution(`偏慢：${med}ms`, '面板仍能用，但「实时」感会打折')
  else caution(`很慢：${med}ms`, '如果地址在境外而队友在国内，考虑换就近的服务器')
} else {
  caution('跳过（前面没连上）')
}

console.log('\n[3] 传输安全')
if (u.protocol === 'https:') {
  ok('使用 HTTPS，邀请码与成员令牌在传输中加密')
} else if (isPrivateHost(u.hostname)) {
  ok('明文 HTTP，但目标是私网 / 虚拟局域网地址', '局域网与 Tailscale 这类链路本身已加密或不出公网，可接受')
} else {
  caution('明文 HTTP 走公网', '邀请码和成员令牌会以明文经过网络。建议套一层 HTTPS（Caddy）或用 Cloudflare 隧道')
}

console.log('\n[4] 端到端往返（加入 → 上报 → 读快照 → 退出）')
if (!health.ok || !health.json || health.json.ok !== true) {
  caution('跳过（前面没连上）')
} else if (!invite) {
  caution('跳过（没提供邀请码）', '要完整验证就再带上服务端打印的那 8 位邀请码')
} else {
  const memberId = 'netcheck-' + randomBytes(6).toString('hex')
  const join = await timedFetch(base + '/api/join', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ inviteCode: invite, memberId, displayName: '连通性自检', machine: 'netcheck', project: '自检' }),
  })
  if (!join.ok) {
    bad('加入团队失败', join.error)
  } else if (join.status === 403) {
    bad('邀请码不正确', '请对照服务器启动横幅里的那 8 位（区分大小写，已自动转大写）')
  } else if (join.status !== 200 || !join.json || join.json.ok !== true) {
    bad('加入团队被拒绝', `HTTP ${join.status} ${(join.json && join.json.error) || ''}`)
  } else {
    ok('加入成功', `团队「${join.json.teamName}」`)
    const teamId = join.json.teamId
    const token = join.json.memberToken

    const report = await timedFetch(base + '/api/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        teamId,
        memberId,
        memberToken: token,
        displayName: '连通性自检',
        project: '自检',
        projects: [{ name: '自检', tokens: 1, cost: 0 }],
        usage: { tokens: 1, cost: 0, input: 1, cache: 0, output: 0 },
        lastUsedAt: Date.now(),
      }),
    })
    if (report.ok && report.json && report.json.ok) {
      const snap = report.json.snapshot
      ok('上报用量成功', `服务器当前共 ${snap.totals.members} 名成员、${snap.totals.projects} 个项目`)
      const online = snap.members.filter((m) => m.online)
      console.log(`      在线成员：${online.map((m) => m.name + (m.project ? '(' + m.project + ')' : '(未选项目)')).join('、') || '无'}`)
    } else {
      bad('上报用量失败', (report.json && report.json.error) || report.error)
    }

    const leave = await timedFetch(base + '/api/leave', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId, memberId, memberToken: token }),
    })
    if (leave.ok && leave.json && leave.json.ok) ok('已清理自检用的临时成员')
    else caution('临时成员没能自动清理', '可在管理页面手动移除「连通性自检」')
  }
}

console.log('\n' + '─'.repeat(64))
console.log(`结果：通过 ${pass} · 警告 ${warn} · 失败 ${fail}`)
if (fail === 0) {
  console.log(`\n这个地址从本机可用 ✅  把它填进 DSH 面板的「团队服务器地址」即可。`)
} else {
  console.log(`\n先解决上面的 ❌ 项。多数情况是「hub 只监听了 127.0.0.1」或「防火墙没放行」。`)
}
console.log('')
process.exit(fail === 0 ? 0 : 1)
