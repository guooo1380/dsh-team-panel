#!/usr/bin/env node
// ============================================================================
// lib/team-hub.mjs —— dsh-team-panel 的团队服务器（零依赖，只用 Node 内置模块）
// ============================================================================
// 作用：把每个成员的 Token 用量汇总到一处，让所有人的面板都能「联网实时」看到全队数据。
//
// 启动：
//   node lib/team-hub.mjs                          # 只监听 127.0.0.1（配合内网穿透用）
//   node lib/team-hub.mjs --public                 # 监听 0.0.0.0（公网 VPS 用）
//   node lib/team-hub.mjs --port 7801 --data D:\team\hub.json
//
// 跨公网的两种放法：
//   1) 公网 VPS 上 `--public`，再用 Nginx/Caddy 反代加 HTTPS（推荐）；
//   2) 本机跑默认监听，用 cloudflared / ngrok 等内网穿透暴露成一个 https 地址。
//   ⚠️ 直接裸奔在公网且不套 HTTPS 时，邀请码和成员令牌会以明文经过网络。
//
// 团队成员加入的方式：把「地址 + 邀请码」给队友，队友在面板里填这两项即可。
// ============================================================================

import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { peakSnapshot } from './peak.mjs'
import { classifyAddresses as classify } from './net-addresses.mjs'

const VERSION = '0.2.1'
const BODY_LIMIT = 64 * 1024
const MEMBER_ONLINE_MS = 70 * 1000 // 超过 70 秒没上报就算离线

// ---------------------------------------------------------------------------
// 命令行参数
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = { port: 7801, host: '', data: '', team: '我的团队', public: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--port' || a === '-p') out.port = Number(argv[++i]) || out.port
    else if (a === '--host') out.host = String(argv[++i] || '')
    else if (a === '--data' || a === '-d') out.data = String(argv[++i] || '')
    else if (a === '--team' || a === '-t') out.team = String(argv[++i] || out.team)
    else if (a === '--public') out.public = true
    else if (a === '--help' || a === '-h') out.help = true
  }
  if (!out.host) out.host = out.public ? '0.0.0.0' : '127.0.0.1'
  if (!out.data) out.data = path.join(process.cwd(), 'team-hub-data.json')
  return out
}

const ARGS = parseArgs(process.argv.slice(2))

if (ARGS.help) {
  console.log(`
dsh-team-panel 团队服务器 v${VERSION}

用法: node team-hub.mjs [选项]

  -p, --port <端口>    监听端口（默认 7801）
      --host <地址>    监听地址（默认 127.0.0.1；--public 时 0.0.0.0）
      --public         等价于 --host 0.0.0.0，用于公网 VPS
  -d, --data <文件>    数据文件路径（默认 ./team-hub-data.json）
  -t, --team <名称>    首次启动时创建的团队名称（默认「我的团队」）
  -h, --help           显示本帮助
`)
  process.exit(0)
}

// ---------------------------------------------------------------------------
// 数据层
// ---------------------------------------------------------------------------
const EMPTY_DATA = { version: 1, createdAt: new Date().toISOString(), teams: {} }

function loadData() {
  try {
    const raw = fs.readFileSync(ARGS.data, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && parsed.teams && typeof parsed.teams === 'object') {
      parsed.version = parsed.version || 1
      return parsed
    }
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      console.warn(`[hub] 数据文件读取失败，将重新开始：${err.message}`)
    }
  }
  return JSON.parse(JSON.stringify(EMPTY_DATA))
}

const DATA = loadData()

let saveTimer = null
let saving = false
function saveData() {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    try {
      const dir = path.dirname(ARGS.data)
      fs.mkdirSync(dir, { recursive: true })
      const tmp = `${ARGS.data}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(DATA, null, 2), 'utf8')
      fs.renameSync(tmp, ARGS.data)
    } catch (err) {
      saving = false
      console.error(`[hub] 数据落盘失败：${err.message}`)
    }
  }, 400)
  saving = true
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
/** 去掉易混淆字符（0/O/1/I/L）的随机串，用作邀请码。 */
function randomCode(len) {
  const alphabet = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
  const bytes = randomBytes(len)
  let out = ''
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length]
  return out
}

function randomId() {
  return randomBytes(12).toString('hex')
}

function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex')
}

function tokenMatches(token, storedHash) {
  if (!token || !storedHash) return false
  const a = Buffer.from(hashToken(token), 'hex')
  const b = Buffer.from(String(storedHash), 'hex')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function num(x) {
  const n = Number(x)
  return Number.isFinite(n) && n >= 0 ? n : 0
}

function str(x, max) {
  const s = x === undefined || x === null ? '' : String(x)
  return s.slice(0, max || 64)
}

/** 规整成员上报的逐项目明细：[{name, tokens, cost}]，最多 20 条。 */
function normalizeProjects(raw) {
  if (!Array.isArray(raw)) return null
  return raw
    .filter((x) => x && typeof x === 'object')
    .map((x) => ({
      name: str(x.name, 60) || '未命名项目',
      tokens: num(x.tokens),
      cost: num(x.cost),
    }))
    .slice(0, 20)
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > BODY_LIMIT) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text) return resolve({})
      try {
        resolve(JSON.parse(text))
      } catch (err) {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

// ---------------------------------------------------------------------------
// 团队 / 成员
// ---------------------------------------------------------------------------
function createTeam(name) {
  const teamId = randomId()
  const team = {
    id: teamId,
    name: str(name, 40) || '我的团队',
    inviteCode: randomCode(8),
    adminKey: randomBytes(16).toString('hex'),
    createdAt: new Date().toISOString(),
    members: {},
  }
  DATA.teams[teamId] = team
  saveData()
  return team
}

if (Object.keys(DATA.teams).length === 0) {
  createTeam(ARGS.team)
  console.log('[hub] 首次启动：已创建默认团队。')
}

function findTeamByInvite(code) {
  const want = str(code, 32).trim().toUpperCase()
  if (!want) return null
  for (const team of Object.values(DATA.teams)) {
    if (String(team.inviteCode).toUpperCase() === want) return team
  }
  return null
}

function publicMember(m) {
  const now = Date.now()
  return {
    id: m.id,
    name: m.name,
    machine: m.machine,
    /** 该成员正在监测的项目名（未选择时为空串） */
    project: m.project || '',
    /** 该成员所选项目的完整本地路径，供队友悬停查看 */
    projectPath: m.projectPath || '',
    /** 是否已经选定了要监测的项目 */
    monitoring: m.monitoring !== false && Boolean(m.project),
    projects: Array.isArray(m.projects) ? m.projects.slice(0, 20) : [],
    tokens: m.tokens,
    cost: m.cost,
    input: m.input,
    cache: m.cache,
    output: m.output,
    lastUsedAt: m.lastUsedAt || 0,
    lastReportAt: m.lastReportAt || 0,
    joinedAt: m.joinedAt || 0,
    online: now - (m.lastReportAt || 0) < MEMBER_ONLINE_MS,
  }
}

function buildSnapshot(team) {
  const members = Object.values(team.members).map(publicMember).sort((a, b) => b.tokens - a.tokens)
  const totals = members.reduce(
    (acc, m) => {
      acc.tokens += m.tokens
      acc.cost += m.cost
      acc.input += m.input
      acc.cache += m.cache
      acc.output += m.output
      return acc
    },
    { tokens: 0, cost: 0, input: 0, cache: 0, output: 0 },
  )
  // 每个成员只监测一个项目，所以这里按「项目名」把选了同一个项目的成员合并起来。
  // 没选项目的成员不进项目聚合（他们的用量本来就是 0，也不该占一个项目条目）。
  const byProject = new Map()
  for (const m of members) {
    if (!m.project) continue
    const breakdown =
      Array.isArray(m.projects) && m.projects.length > 0
        ? m.projects
        : [{ name: m.project, tokens: m.tokens, cost: m.cost }]
    for (const item of breakdown) {
      const name = item && item.name ? String(item.name).slice(0, 60) : m.project
      const entry = byProject.get(name) || { name, tokens: 0, cost: 0, memberIds: new Set(), lastUsedAt: 0, paths: new Set() }
      entry.tokens += Number(item.tokens) || 0
      entry.cost += Number(item.cost) || 0
      entry.memberIds.add(m.id)
      if (m.projectPath) entry.paths.add(m.projectPath)
      entry.lastUsedAt = Math.max(entry.lastUsedAt, m.lastUsedAt || 0)
      byProject.set(name, entry)
    }
  }
  const projects = [...byProject.values()]
    .map((e) => ({
      name: e.name,
      tokens: Math.round(e.tokens),
      cost: Number(e.cost.toFixed(4)),
      members: e.memberIds.size,
      paths: [...e.paths].slice(0, 5),
      lastUsedAt: e.lastUsedAt,
    }))
    .sort((a, b) => b.tokens - a.tokens)
  return {
    teamId: team.id,
    teamName: team.name,
    serverTime: Date.now(),
    totals: {
      ...totals,
      members: members.length,
      online: members.filter((m) => m.online).length,
      projects: projects.length,
    },
    members,
    projects,
    peak: peakSnapshot(),
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
function adminPageHtml(team, adminKey, authed) {
  const peak = peakSnapshot()
  const snapshot = buildSnapshot(team)
  const esc = (s) =>
    String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  const fmt = (n) => {
    const v = Number(n) || 0
    if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B'
    if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M'
    if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K'
    return String(Math.round(v))
  }
  if (!authed) {
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>dsh-team-panel 团队服务器</title>
<style>body{font-family:system-ui,"Segoe UI","Microsoft YaHei",sans-serif;background:#FFF7ED;color:#7C2D12;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
.box{background:#fff;border:1px solid #F6C89A;border-radius:14px;padding:28px 30px;box-shadow:0 10px 30px rgba(124,45,18,.10);max-width:420px}
h1{font-size:18px;margin:0 0 6px}p{font-size:13px;color:#9A5B33;line-height:1.7;margin:0 0 16px}
input{width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid #F6C89A;border-radius:9px;font-size:14px;background:#FFFBF5;color:#7C2D12}
button{margin-top:12px;width:100%;padding:10px;border:0;border-radius:9px;background:#EA580C;color:#fff;font-size:14px;cursor:pointer}
button:hover{background:#C2410C}</style></head><body>
<form class="box" method="get" action="/admin">
  <h1>🦦 dsh-team-panel 团队服务器</h1>
  <p>请输入启动时控制台打印的<b>管理密钥</b>。密钥只保存在本服务器与你的终端里。</p>
  <input name="key" placeholder="管理密钥" autocomplete="off" autofocus>
  <button type="submit">进入管理页</button>
</form></body></html>`
  }
  const rows = snapshot.members
    .map(
      (m) => `<tr><td>${m.online ? '🟢' : '⚪'} ${esc(m.name)}</td><td>${esc(m.project || '—')}</td><td class="n">${fmt(m.tokens)}</td><td class="n">¥${m.cost.toFixed(2)}</td><td>${m.lastUsedAt ? new Date(m.lastUsedAt).toLocaleString('zh-CN') : '—'}</td><td><form method="post" action="/admin/remove"><input type="hidden" name="key" value="${esc(adminKey)}"><input type="hidden" name="teamId" value="${esc(team.id)}"><input type="hidden" name="memberId" value="${esc(m.id)}"><button class="del">移除</button></form></td></tr>`,
    )
    .join('')
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(team.name)} · dsh-team-panel</title>
<style>body{font-family:system-ui,"Segoe UI","Microsoft YaHei",sans-serif;background:#FFF7ED;color:#7C2D12;margin:0;padding:32px}
.card{background:#fff;border:1px solid #F6C89A;border-radius:14px;padding:20px 22px;box-shadow:0 10px 30px rgba(124,45,18,.08);max-width:920px;margin:0 auto 18px}
h1{font-size:19px;margin:0 0 4px}.sub{color:#9A5B33;font-size:13px}
.code{display:inline-block;margin-top:10px;background:#FFEDD5;border:1px dashed #EA580C;color:#9A3412;border-radius:10px;padding:8px 14px;font-size:20px;letter-spacing:3px;font-weight:700;font-family:ui-monospace,Consolas,monospace}
table{width:100%;border-collapse:collapse;font-size:13px;margin-top:8px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #FDE4C7}th{color:#9A5B33;font-weight:600}
td.n{text-align:right;font-family:ui-monospace,Consolas,monospace}
.badge{display:inline-block;background:${peak.isPeak ? '#E4572E' : '#3F8F6B'};color:#fff;border-radius:999px;padding:2px 12px;font-size:13px}
.del{background:#fff;border:1px solid #F6C89A;color:#B45309;border-radius:7px;padding:3px 10px;cursor:pointer}
.kv{display:flex;gap:26px;flex-wrap:wrap;margin-top:10px;font-size:13px}.kv b{font-size:16px;display:block;color:#C2410C}</style></head><body>
<div class="card">
  <h1>团队：${esc(team.name)}</h1>
  <div class="sub">把下面这个地址和邀请码给队友，在 DSH 面板的「设置」里填写即可加入。</div>
  <div class="code">${esc(team.inviteCode)}</div>
  <div class="kv">
    <div><b>${fmt(snapshot.totals.tokens)}</b>全队总 Token</div>
    <div><b>${snapshot.totals.members}</b>成员数（在线 ${snapshot.totals.online}）</div>
    <div><b>${snapshot.totals.projects}</b>项目数</div>
    <div><b>¥${snapshot.totals.cost.toFixed(2)}</b>估算花费</div>
    <div><span class="badge">${peak.label}</span> 当前${peak.text}</div>
  </div>
</div>
<div class="card">
  <h1>成员</h1>
  <table><thead><tr><th>名字</th><th>项目</th><th>Token</th><th>花费</th><th>最后消耗</th><th></th></tr></thead>
  <tbody>${rows || '<tr><td colspan="6" style="color:#B08968">还没有成员加入。</td></tr>'}</tbody></table>
</div>
</body></html>`
}

function requireMember(team, body) {
  const member = team && team.members ? team.members[body.memberId] : null
  if (!member) throw Object.assign(new Error('成员不存在，请重新加入团队'), { status: 404 })
  if (!tokenMatches(body.memberToken, member.tokenHash)) {
    throw Object.assign(new Error('成员令牌无效，请重新加入团队'), { status: 401 })
  }
  return member
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
  const p = url.pathname
  try {
    if (p === '/api/health') {
      return sendJson(res, 200, { ok: true, name: 'dsh-team-hub', version: VERSION, time: Date.now(), teams: Object.keys(DATA.teams).length })
    }

    // ---- 管理页（浏览器打开）----
    if (p === '/' || p === '/admin') {
      if (req.method === 'POST') {
        // 仅 /admin/remove 走 POST
      }
      const key = url.searchParams.get('key') || ''
      const team = Object.values(DATA.teams)[0]
      if (!team) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        return res.end('<h1>暂无团队</h1>')
      }
      const authed = key && key === team.adminKey
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      return res.end(adminPageHtml(team, team.adminKey, authed))
    }

    if (p === '/admin/remove' && req.method === 'POST') {
      const form = await readFormBody(req)
      const team = Object.values(DATA.teams)[0]
      if (!team || form.key !== team.adminKey) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
        return res.end('管理密钥无效')
      }
      delete team.members[form.memberId]
      saveData()
      res.writeHead(303, { Location: `/admin?key=${encodeURIComponent(form.key)}` })
      return res.end()
    }

    // ---- 加入团队 ----
    if (p === '/api/join' && req.method === 'POST') {
      const body = await readJsonBody(req)
      const team = findTeamByInvite(body.inviteCode)
      if (!team) return sendJson(res, 403, { ok: false, error: '邀请码不正确' })
      const memberId = str(body.memberId, 64) || randomId()
      const existing = team.members[memberId]
      const memberToken = randomBytes(24).toString('hex')
      const seedUsage = body.usage && typeof body.usage === 'object' ? body.usage : null
      team.members[memberId] = {
        id: memberId,
        name: str(body.displayName, 40) || (existing && existing.name) || '未命名成员',
        machine: str(body.machine, 60),
        project: str(body.project, 60) || (existing && existing.project) || '',
        projectPath: str(body.projectPath, 300) || (existing && existing.projectPath) || '',
        monitoring: body.monitoring !== undefined ? Boolean(body.monitoring) : existing ? existing.monitoring : false,
        projects: normalizeProjects(body.projects) || (existing && existing.projects) || [],
        tokenHash: hashToken(memberToken),
        // 加入时允许带上已有账本，避免「刚加入时全队总数是 0」这一瞬间的错读
        tokens: seedUsage ? num(seedUsage.tokens) : existing ? existing.tokens : 0,
        cost: seedUsage ? num(seedUsage.cost) : existing ? existing.cost : 0,
        input: seedUsage ? num(seedUsage.input) : existing ? existing.input : 0,
        cache: seedUsage ? num(seedUsage.cache) : existing ? existing.cache : 0,
        output: seedUsage ? num(seedUsage.output) : existing ? existing.output : 0,
        lastUsedAt: num(body.lastUsedAt) || (existing ? existing.lastUsedAt : 0),
        lastReportAt: Date.now(),
        joinedAt: existing ? existing.joinedAt : Date.now(),
      }
      saveData()
      return sendJson(res, 200, {
        ok: true,
        teamId: team.id,
        teamName: team.name,
        memberId,
        memberToken,
        snapshot: buildSnapshot(team),
      })
    }

    // ---- 上报用量（成员令牌）----
    if (p === '/api/report' && req.method === 'POST') {
      const body = await readJsonBody(req)
      const team = DATA.teams[str(body.teamId, 64)]
      const member = requireMember(team, body)
      const usage = body.usage && typeof body.usage === 'object' ? body.usage : {}
      member.tokens = num(usage.tokens)
      member.cost = num(usage.cost)
      member.input = num(usage.input)
      member.cache = num(usage.cache)
      member.output = num(usage.output)
      member.lastUsedAt = num(body.lastUsedAt) || member.lastUsedAt || 0
      member.lastReportAt = Date.now()
      if (body.displayName !== undefined) member.name = str(body.displayName, 40) || member.name
      if (body.project !== undefined) member.project = str(body.project, 60)
      if (body.projectPath !== undefined) member.projectPath = str(body.projectPath, 300)
      if (body.monitoring !== undefined) member.monitoring = Boolean(body.monitoring)
      if (body.machine !== undefined) member.machine = str(body.machine, 60)
      const projects = normalizeProjects(body.projects)
      if (projects) member.projects = projects
      saveData()
      return sendJson(res, 200, { ok: true, snapshot: buildSnapshot(team) })
    }

    // ---- 改名 / 改项目（成员令牌）----
    if (p === '/api/profile' && req.method === 'POST') {
      const body = await readJsonBody(req)
      const team = DATA.teams[str(body.teamId, 64)]
      const member = requireMember(team, body)
      if (body.displayName !== undefined) {
        const name = str(body.displayName, 40).trim()
        if (!name) return sendJson(res, 400, { ok: false, error: '名字不能为空' })
        member.name = name
      }
      if (body.project !== undefined) member.project = str(body.project, 60)
      if (body.projectPath !== undefined) member.projectPath = str(body.projectPath, 300)
      if (body.monitoring !== undefined) member.monitoring = Boolean(body.monitoring)
      saveData()
      return sendJson(res, 200, { ok: true, snapshot: buildSnapshot(team) })
    }

    // ---- 拉取快照 ----
    if (p === '/api/snapshot') {
      const team = DATA.teams[str(url.searchParams.get('teamId'), 64)]
      const member = requireMember(team, {
        memberId: str(url.searchParams.get('memberId'), 64),
        memberToken: str(url.searchParams.get('memberToken'), 128),
      })
      void member
      return sendJson(res, 200, { ok: true, snapshot: buildSnapshot(team) })
    }

    // ---- 退出团队 ----
    if (p === '/api/leave' && req.method === 'POST') {
      const body = await readJsonBody(req)
      const team = DATA.teams[str(body.teamId, 64)]
      requireMember(team, body)
      delete team.members[body.memberId]
      saveData()
      return sendJson(res, 200, { ok: true })
    }

    return sendJson(res, 404, { ok: false, error: `未知接口 ${p}` })
  } catch (err) {
    const status = (err && err.status) || 500
    if (status >= 500) console.error('[hub] 请求处理失败：', err)
    return sendJson(res, status, { ok: false, error: String((err && err.message) || err).slice(0, 200) })
  }
})

function readFormBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > BODY_LIMIT) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      const out = {}
      for (const [k, v] of new URLSearchParams(text)) out[k] = v
      resolve(out)
    })
    req.on('error', reject)
  })
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
/** 本机地址分类（含虚拟网卡剔除）在 lib/net-addresses.mjs 里，与 hub-info 共用。 */
function classifyAddresses() {
  return classify()
}

server.listen(ARGS.port, ARGS.host, () => {
  const team = Object.values(DATA.teams)[0]
  const shown = ARGS.host === '0.0.0.0' ? '0.0.0.0' : ARGS.host
  const lines = [
    '',
    '  ┌──────────────────────────────────────────────────────────────┐',
    '  │        dsh-team-panel 团队服务器已启动                        │',
    '  └──────────────────────────────────────────────────────────────┘',
    `   监听地址      http://${shown}:${ARGS.port}`,
    `   数据文件      ${ARGS.data}`,
    '',
    `   团队名称      ${team.name}`,
    `   邀请码        ${team.inviteCode}      <-- 给队友这个`,
    `   管理密钥      ${team.adminKey}`,
    `   管理页面      http://127.0.0.1:${ARGS.port}/admin?key=${team.adminKey}`,
  ]
  if (ARGS.host === '0.0.0.0') {
    const addr = classifyAddresses()
    const teammates = []
    const fmt = (l) => `http://${l.addr}:${ARGS.port}  (${l.name})`
    const url = (l) => `http://${l.addr}:${ARGS.port}`
    if (addr.lan.length) {
      lines.push('', `   局域网地址    ${addr.lan.map(fmt).join('   ')}`)
      teammates.push(url(addr.lan[0]))
    }
    if (addr.tailscale.length) {
      lines.push(`   Tailscale     ${addr.tailscale.map(fmt).join('   ')}`)
      teammates.push(url(addr.tailscale[0]))
    }
    if (addr.other.length) {
      lines.push(`   其它网卡      ${addr.other.map(fmt).join('   ')}`)
    }
    if (teammates.length) {
      lines.push('', `   👉 队友「团队服务器地址」填：${teammates[0]}`)
    }
    lines.push(
      '',
      '   ⚠️ 已监听所有网卡。两点必查：',
      '      1) 服务器这台机器的防火墙要放行入站端口 → 跑 scripts\\allow-firewall.cmd（需管理员）',
      '      2) 跨公网请套 HTTPS 反向代理（Caddy/Nginx），或改用 Tailscale / Cloudflare 隧道',
    )
  } else {
    lines.push(
      '',
      '   当前只监听本机 127.0.0.1，队友连不上。三种做法：',
      '     · 局域网 / Tailscale：改用 scripts\\start-hub-public.cmd 起服务（--public）',
      '     · 公网 VPS：同样用 start-hub-public.cmd，再套 Caddy 反代加 HTTPS',
      '     · 临时外网：另开一个窗口跑  cloudflared tunnel --url http://127.0.0.1:' + ARGS.port,
    )
  }
  lines.push(
    '',
    '   队友加入方式：DSH 面板侧栏底部的面板 → ⊕ 展开 → 填「团队服务器地址 + 邀请码」→ 加入团队。',
    '   连不上时在队友那台机器上跑：node scripts\\netcheck.mjs <上面的地址> <邀请码>',
    '',
  )
  console.log(lines.join('\n'))
})

process.on('SIGINT', () => {
  try {
    fs.writeFileSync(ARGS.data, JSON.stringify(DATA, null, 2), 'utf8')
  } catch (err) {
    /* 退出时落盘失败只影响最后一次快照 */
  }
  console.log('\n[hub] 已停止。')
  process.exit(0)
})
