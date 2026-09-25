// ============================================================================
// dsh-team-panel —— 宿主端插件（lib/index.js）
// ============================================================================
// 职责：
//   1. 监听 DSH 的 session/event，抓取每一次模型调用的真实 usage；
//   2. **只统计用户选定的那一个 DSH 项目**（未选择时不统计任何东西）；
//   3. 通过 ctx.webServer 暴露 /dsh-team/* 路由，供注入到 Web 界面的面板脚本读写；
//   4. 把本机用量与「我选了哪个项目」上报给团队服务器，并把全队快照拉回来；
//   5. 把面板脚本 lib/panel.js 注入 Web 界面（tapIndex）。
//
// 统计口径（唯一真源）：
//   只有「当前选中的项目」下的会话产生的 usage 才会计入账本。
//   切换项目时旧项目的账本会保留（它当时确实被监测过），但不再上报、不再显示；
//   想重来就点「清零」。
//
// 前端脚本只与本机宿主通信（同源），由宿主去访问团队服务器，
// 因此团队服务器即使只有 http、或浏览器有跨域限制，都不影响面板工作。
// ============================================================================

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { peakSnapshot } from './peak.mjs'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const STATE_DIR = path.join(DSH_HOME, 'team-panel')
const STATE_FILE = path.join(STATE_DIR, 'state.json')
const PANEL_JS_FILE = path.join(PACKAGE_ROOT, 'lib', 'panel.js')

const VERSION = '0.2.0'
const MACHINE = (() => {
  try {
    return os.hostname()
  } catch (err) {
    return 'unknown'
  }
})()

// ---------------------------------------------------------------------------
// DeepSeek 价目表（元 / 百万 token），索引 0 = 空闲(谷)，1 = 高峰(峰)
// 来源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing
// ---------------------------------------------------------------------------
const PRICE_FLASH = { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] }
const PRICE_PRO = { hit: [0.15, 0.3], miss: [4.5, 9.0], out: [13.5, 27.0] }
const PRICING = [
  ['deepseek-v4-pro', PRICE_PRO],
  ['deepseek-flash', PRICE_FLASH],
  ['deepseek-v4-flash', PRICE_FLASH],
  ['deepseek-v4-flash-vision-exp', PRICE_FLASH],
]

function priceFor(model) {
  const m = String(model || '').toLowerCase()
  for (const [key, p] of PRICING) {
    if (m.indexOf(key) !== -1) return p
  }
  return PRICE_FLASH
}

function costOf({ input, cache, output }, model, isPeak) {
  const p = priceFor(model)
  const idx = isPeak ? 1 : 0
  return (cache / 1e6) * p.hit[idx] + (input / 1e6) * p.miss[idx] + (output / 1e6) * p.out[idx]
}

// ---------------------------------------------------------------------------
// 路径归一化：同一项目的不同写法必须落到同一个 key
// ---------------------------------------------------------------------------
function normKey(p) {
  if (!p || typeof p !== 'string') return ''
  let s = p.trim()
  if (!s) return ''
  try {
    s = path.resolve(s)
  } catch (err) {
    /* 解析不了就按原样比较 */
  }
  s = s.replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? s.toLowerCase() : s
}

/** cwd 是否属于所选项目（项目根目录本身，或其子目录下的会话）。 */
function underProject(cwd, projectPath) {
  const a = normKey(cwd)
  const b = normKey(projectPath)
  if (!a || !b) return false
  if (a === b) return true
  const sep = process.platform === 'win32' ? '\\' : '/'
  return a.startsWith(b + sep)
}

function baseTitle(p) {
  const clean = String(p || '').replace(/[\\/]+$/, '')
  const base = clean.split(/[\\/]/).pop()
  return String(base || clean || '未命名项目').slice(0, 60)
}

// ---------------------------------------------------------------------------
// 本地状态（成员身份 + 项目选择 + 用量账本 + 团队配置）
// ---------------------------------------------------------------------------
function emptyLedger(projectPath, title) {
  return {
    path: projectPath,
    title: title || baseTitle(projectPath),
    tokens: 0,
    cost: 0,
    input: 0,
    cache: 0,
    output: 0,
    calls: 0,
    lastUsedAt: 0,
  }
}

function emptyState() {
  return {
    version: 2,
    memberId: randomBytes(12).toString('hex'),
    displayName: '',
    hubUrl: '',
    teamId: '',
    teamName: '',
    inviteCode: '',
    memberToken: '',
    /** 用户选定要监测的那一个项目；null = 还没选，此时完全不统计 */
    selectedProject: null,
    /** 见过哪些项目目录（注册表不可用时作为项目列表的兜底） */
    seenProjects: {},
    ui: { expanded: false },
    usage: { byProject: {} },
    createdAt: Date.now(),
  }
}

function loadState() {
  let parsed = null
  try {
    parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  } catch (err) {
    parsed = null
  }
  const base = emptyState()
  if (!parsed || typeof parsed !== 'object') return base
  const merged = { ...base, ...parsed }
  merged.ui = { ...base.ui, ...(parsed.ui || {}) }
  merged.seenProjects = { ...(parsed.seenProjects || {}) }
  // v1 的账本是「整机累计 + 按项目名」的旧口径，与「只监测单一项目」不兼容，直接丢弃重来
  if (Number(parsed.version) >= 2 && parsed.usage && typeof parsed.usage.byProject === 'object') {
    merged.usage = { byProject: { ...parsed.usage.byProject } }
  } else {
    merged.usage = { byProject: {} }
  }
  merged.version = 2
  if (!merged.memberId) merged.memberId = base.memberId
  if (merged.selectedProject && !merged.selectedProject.path) merged.selectedProject = null
  return merged
}

let STATE = loadState()
let saveTimer = null

function saveState() {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    writeStateNow()
  }, 300)
}

function writeStateNow() {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true })
    const tmp = `${STATE_FILE}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(STATE, null, 2), 'utf8')
    fs.renameSync(tmp, STATE_FILE)
  } catch (err) {
    try {
      console.warn(`[dsh-team-panel] 状态写盘失败：${err && err.message}`)
    } catch (e) {
      /* 忽略日志失败 */
    }
  }
}

// ---------------------------------------------------------------------------
// 项目列表：优先取 DSH 自己的工作区注册表，保证与左侧栏「工作区」一致
// ---------------------------------------------------------------------------
let pluginCtx = null

function resolveRegistry() {
  try {
    if (!pluginCtx) return null
    const reg = pluginCtx.get('workspaceRegistry')
    if (reg && typeof reg.list === 'function') return reg
  } catch (err) {
    /* 服务不存在或尚未就绪 */
  }
  return null
}

function listProjects() {
  const out = []
  const seen = new Set()
  const reg = resolveRegistry()
  if (reg) {
    let items = []
    try {
      items = reg.list() || []
    } catch (err) {
      items = []
    }
    for (const w of items) {
      let p = ''
      let title = ''
      let sessions = 0
      try {
        p = w.path
        title = w.title
        sessions = Array.isArray(w.sessionIds) ? w.sessionIds.length : 0
      } catch (err) {
        continue
      }
      const key = normKey(p)
      if (!key || seen.has(key)) continue
      seen.add(key)
      out.push({
        path: p,
        key,
        title: String(title || baseTitle(p)).slice(0, 60),
        sessions,
        source: 'registry',
        exists: existsDir(p),
      })
    }
  }
  // 兜底：把本插件见过的项目目录也列上（注册表不可用、或项目刚建还没进注册表时）
  for (const [key, info] of Object.entries(STATE.seenProjects || {})) {
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      path: info.path || key,
      key,
      title: String(info.title || baseTitle(info.path)).slice(0, 60),
      sessions: 0,
      source: 'observed',
      exists: existsDir(info.path || key),
    })
  }
  return out
}

function existsDir(p) {
  try {
    return fs.statSync(p).isDirectory()
  } catch (err) {
    return false
  }
}

// ---------------------------------------------------------------------------
// 账本访问：对外一切数字都只来自「当前选中的那个项目」
// ---------------------------------------------------------------------------
function selectedKey() {
  return STATE.selectedProject ? normKey(STATE.selectedProject.path) : ''
}

function selectedLedger() {
  const key = selectedKey()
  if (!key) return null
  let led = STATE.usage.byProject[key]
  if (!led) {
    led = emptyLedger(STATE.selectedProject.path, STATE.selectedProject.title)
    STATE.usage.byProject[key] = led
  }
  if (!led.path) led.path = STATE.selectedProject.path
  if (!led.title) led.title = STATE.selectedProject.title
  return led
}

function publicLedger() {
  const led = selectedLedger()
  if (!led) {
    return { monitoring: false, tokens: 0, cost: 0, input: 0, cache: 0, output: 0, calls: 0, lastUsedAt: 0 }
  }
  return {
    monitoring: true,
    tokens: Math.round(Number(led.tokens) || 0),
    cost: Number(led.cost) || 0,
    input: Math.round(Number(led.input) || 0),
    cache: Math.round(Number(led.cache) || 0),
    output: Math.round(Number(led.output) || 0),
    calls: Number(led.calls) || 0,
    lastUsedAt: Number(led.lastUsedAt) || 0,
  }
}

// ---------------------------------------------------------------------------
// 团队服务器客户端
// ---------------------------------------------------------------------------
let snapshotCache = { at: 0, snapshot: null, error: null, teamName: '' }

function normalizeHubUrl(raw) {
  let s = String(raw || '').trim()
  if (!s) return ''
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`
  return s.replace(/\/+$/, '')
}

async function hubFetch(hubUrl, pathname, { method = 'GET', body, query, timeout = 8000 } = {}) {
  const base = normalizeHubUrl(hubUrl)
  if (!base) throw new Error('未配置团队服务器地址')
  const url = new URL(base + pathname)
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v))
    }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    })
    const text = await res.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch (err) {
      json = null
    }
    if (!res.ok) {
      throw new Error((json && json.error) || `团队服务器返回 HTTP ${res.status}`)
    }
    if (!json || typeof json !== 'object') throw new Error('团队服务器返回了非法响应')
    return json
  } catch (err) {
    if (err && err.name === 'AbortError') throw new Error('连接团队服务器超时')
    throw err
  } finally {
    clearTimeout(timer)
  }
}

function reportPayload() {
  const led = selectedLedger()
  const usage = publicLedger()
  return {
    teamId: STATE.teamId,
    memberId: STATE.memberId,
    memberToken: STATE.memberToken,
    displayName: STATE.displayName || MACHINE,
    machine: MACHINE,
    /** 团队页面上看到的「这个成员在监测哪个项目」 */
    monitoring: Boolean(led),
    project: led ? led.title : '',
    projectPath: led ? led.path : '',
    // 只上报选中的这一个项目；还没产生用量就不占一个项目条目
    projects: led && usage.tokens > 0 ? [{ name: led.title, tokens: usage.tokens, cost: usage.cost }] : [],
    usage: {
      tokens: usage.tokens,
      cost: usage.cost,
      input: usage.input,
      cache: usage.cache,
      output: usage.output,
    },
    lastUsedAt: usage.lastUsedAt || 0,
  }
}

let pushTimer = null
let pushing = false
let pushQueued = false

function schedulePush(delay = 1500) {
  if (!STATE.teamId || !STATE.memberToken || !STATE.hubUrl) return
  if (pushTimer) return
  pushTimer = setTimeout(() => {
    pushTimer = null
    void pushUsage()
  }, delay)
}

async function pushUsage() {
  if (!STATE.teamId || !STATE.memberToken || !STATE.hubUrl) return
  if (pushing) {
    pushQueued = true
    return
  }
  pushing = true
  try {
    const out = await hubFetch(STATE.hubUrl, '/api/report', { method: 'POST', body: reportPayload() })
    if (out && out.snapshot) {
      snapshotCache = { at: Date.now(), snapshot: out.snapshot, error: null, teamName: out.snapshot.teamName || '' }
    }
  } catch (err) {
    snapshotCache = { ...snapshotCache, error: String((err && err.message) || err) }
  } finally {
    pushing = false
    if (pushQueued) {
      pushQueued = false
      schedulePush(800)
    }
  }
}

async function pullSnapshot({ force = false } = {}) {
  if (!STATE.teamId || !STATE.memberToken || !STATE.hubUrl) return null
  const age = Date.now() - snapshotCache.at
  if (!force && snapshotCache.snapshot && age < 2000) return snapshotCache.snapshot
  try {
    const out = await hubFetch(STATE.hubUrl, '/api/snapshot', {
      query: { teamId: STATE.teamId, memberId: STATE.memberId, memberToken: STATE.memberToken },
      timeout: 6000,
    })
    snapshotCache = {
      at: Date.now(),
      snapshot: out.snapshot || null,
      error: null,
      teamName: (out.snapshot && out.snapshot.teamName) || '',
    }
    return snapshotCache.snapshot
  } catch (err) {
    snapshotCache = { ...snapshotCache, at: Date.now(), error: String((err && err.message) || err) }
    return snapshotCache.snapshot
  }
}

// ---------------------------------------------------------------------------
// usage 采集（严格限定在所选项目内）
// ---------------------------------------------------------------------------
function num(x) {
  const n = Number(x)
  return Number.isFinite(n) && n > 0 ? n : 0
}

function recordUsage({ input, cache, output, model }) {
  const led = selectedLedger()
  if (!led) return
  const tokens = input + cache + output
  if (tokens <= 0) return
  const cost = costOf({ input, cache, output }, model, peakSnapshot().isPeak)
  led.tokens += tokens
  led.input += input
  led.cache += cache
  led.output += output
  led.cost += cost
  led.calls += 1
  led.lastUsedAt = Date.now()
  STATE.usage.byProject[selectedKey()] = led
  saveState()
  schedulePush()
}

function handleSessionEvent(session, event) {
  try {
    if (!event || event.type !== 'assistant/message') return
    const d = event.data || event
    const usage = d.usage || (d.message && d.message.usage)
    if (!usage || typeof usage !== 'object') return
    const cwd =
      (session && session.header && session.header.cwd) || (session && session.meta && session.meta.cwd) || ''
    const key = normKey(cwd)
    // 见过哪些项目目录（只记名字与路径，不记用量），供项目列表兜底
    if (key && !STATE.seenProjects[key]) {
      STATE.seenProjects[key] = { path: cwd, title: baseTitle(cwd), lastSeenAt: Date.now() }
      saveState()
    }
    // 还没选项目 → 不统计任何东西
    if (!STATE.selectedProject) return
    // 不属于所选项目 → 不统计
    if (!underProject(cwd, STATE.selectedProject.path)) return
    const model = (d.message && d.message.source && d.message.source.model) || d.model || ''
    recordUsage({
      input: num(usage.inputTokens),
      cache: num(usage.cacheReadTokens) + num(usage.cacheWriteTokens),
      // DSH 的 outputTokens 已包含 reasoningTokens，不能再单独累加，否则输出侧重复计费
      output: num(usage.outputTokens),
      model,
    })
  } catch (err) {
    /* 采集失败不能影响会话本身 */
  }
}

// ---------------------------------------------------------------------------
// HTTP 小工具
// ---------------------------------------------------------------------------
const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }

function readJsonBody(req) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > 128 * 1024) {
        req.destroy()
        resolve({})
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
        resolve({})
      }
    })
    req.on('error', () => resolve({}))
  })
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { ...JSON_HEADERS, 'Content-Length': Buffer.byteLength(body) })
  res.end(body)
}

function str(x, max) {
  return String(x === undefined || x === null ? '' : x).slice(0, max || 200)
}

// ---------------------------------------------------------------------------
// 插件
// ---------------------------------------------------------------------------
export default {
  name: 'dsh-team-panel',
  inject: ['webServer', 'connection'],
  apply(ctx) {
    pluginCtx = ctx
    const disposers = []

    // —— 浏览器信任栅栏：拒绝 Host/Origin 被伪造（DNS 重绑定）或未认证的请求 ——
    function rejected(req, res) {
      try {
        const conn = ctx.get('connection') || ctx.connection
        if (!conn || typeof conn.requestRejection !== 'function') return false
        const code = conn.requestRejection(req)
        if (code === undefined || code === null || code === false) return false
        res.statusCode = typeof code === 'number' ? code : 403
        res.end()
        return true
      } catch (err) {
        return false
      }
    }

    function route(spec) {
      const inner = spec.handler
      disposers.push(
        ctx.webServer.register({
          ...spec,
          handler: async (req, res) => {
            if (rejected(req, res)) return
            try {
              await inner(req, res)
            } catch (err) {
              try {
                sendJson(res, 500, { ok: false, error: String((err && err.message) || err).slice(0, 300) })
              } catch (e) {
                /* 响应可能已发出 */
              }
            }
          },
        }),
      )
    }

    // ---- 面板脚本 ----
    route({
      kind: 'exact',
      path: '/dsh-team/panel.js',
      handler: (req, res) => {
        let js = ''
        try {
          js = fs.readFileSync(PANEL_JS_FILE, 'utf8')
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('panel.js 读取失败')
          return
        }
        res.writeHead(200, {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Length': Buffer.byteLength(js),
        })
        res.end(js)
      },
    })

    // ---- 面板状态（前端轮询这个接口实现「实时」）----
    route({
      kind: 'exact',
      path: '/dsh-team/state',
      handler: async (req, res) => {
        await pullSnapshot()
        const usage = publicLedger()
        sendJson(res, 200, {
          ok: true,
          version: VERSION,
          self: {
            memberId: STATE.memberId,
            displayName: STATE.displayName || MACHINE,
            machine: MACHINE,
            monitoring: usage.monitoring,
            selectedProject: STATE.selectedProject
              ? { path: STATE.selectedProject.path, title: STATE.selectedProject.title }
              : null,
            /** 可供选择的 DSH 项目（来自 DSH 自己的工作区注册表） */
            projects: listProjects(),
            usage,
          },
          team: {
            configured: Boolean(STATE.teamId && STATE.memberToken && STATE.hubUrl),
            hubUrl: STATE.hubUrl || '',
            teamId: STATE.teamId || '',
            teamName: STATE.teamName || '',
            inviteCode: STATE.inviteCode || '',
            online: Boolean(snapshotCache.snapshot) && !snapshotCache.error,
            error: snapshotCache.error || null,
            fetchedAt: snapshotCache.at || 0,
            snapshot: snapshotCache.snapshot || null,
          },
          peak: peakSnapshot(),
          ui: { expanded: Boolean(STATE.ui && STATE.ui.expanded) },
        })
      },
    })

    // ---- 选择 / 取消「要监测的 DSH 项目」----
    route({
      kind: 'exact',
      path: '/dsh-team/project',
      handler: async (req, res) => {
        const body = await readJsonBody(req)
        const projectPath = str(body.path, 400).trim()
        if (!projectPath) {
          // 取消监测
          STATE.selectedProject = null
          saveState()
          await pushUsage()
          return sendJson(res, 200, { ok: true, selectedProject: null, usage: publicLedger() })
        }
        if (!existsDir(projectPath)) {
          return sendJson(res, 400, { ok: false, error: `目录不存在：${projectPath}` })
        }
        // 标题优先取 DSH 注册表里的（与左侧栏显示一致），取不到就用目录名
        const found = listProjects().find((p) => p.key === normKey(projectPath))
        const title = (found && found.title) || baseTitle(projectPath)
        const key = normKey(projectPath)
        STATE.selectedProject = { path: found ? found.path : projectPath, title }
        if (!STATE.usage.byProject[key]) STATE.usage.byProject[key] = emptyLedger(STATE.selectedProject.path, title)
        saveState()
        await pushUsage()
        await pullSnapshot({ force: true })
        sendJson(res, 200, {
          ok: true,
          selectedProject: STATE.selectedProject,
          usage: publicLedger(),
          snapshot: snapshotCache.snapshot || null,
        })
      },
    })

    // ---- 清零当前所选项目的账本 ----
    route({
      kind: 'exact',
      path: '/dsh-team/reset',
      handler: async (req, res) => {
        const key = selectedKey()
        if (!key) return sendJson(res, 400, { ok: false, error: '还没有选择要监测的项目' })
        STATE.usage.byProject[key] = emptyLedger(STATE.selectedProject.path, STATE.selectedProject.title)
        saveState()
        await pushUsage()
        await pullSnapshot({ force: true })
        sendJson(res, 200, { ok: true, usage: publicLedger() })
      },
    })

    // ---- 修改本机设置（改名 / 服务器地址 / 邀请码 / 展开态）----
    route({
      kind: 'exact',
      path: '/dsh-team/config',
      handler: async (req, res) => {
        const body = await readJsonBody(req)
        if (body.displayName !== undefined) STATE.displayName = str(body.displayName, 40).trim() || STATE.displayName
        if (body.hubUrl !== undefined) STATE.hubUrl = normalizeHubUrl(str(body.hubUrl, 300))
        if (body.inviteCode !== undefined) STATE.inviteCode = str(body.inviteCode, 32).trim().toUpperCase()
        if (body.expanded !== undefined) STATE.ui.expanded = Boolean(body.expanded)
        saveState()
        // 已加入团队时，改名要同步到服务器（让队友立刻看到新名字）
        if (STATE.teamId && STATE.memberToken && body.displayName !== undefined) {
          try {
            await hubFetch(STATE.hubUrl, '/api/profile', {
              method: 'POST',
              body: {
                teamId: STATE.teamId,
                memberId: STATE.memberId,
                memberToken: STATE.memberToken,
                displayName: STATE.displayName || MACHINE,
                project: STATE.selectedProject ? STATE.selectedProject.title : '',
                projectPath: STATE.selectedProject ? STATE.selectedProject.path : '',
                monitoring: Boolean(selectedLedger()),
              },
            })
            await pullSnapshot({ force: true })
          } catch (err) {
            /* 同步失败不阻塞本地修改，下一次上报会补上 */
          }
        }
        sendJson(res, 200, { ok: true })
      },
    })

    // ---- 加入团队 ----
    route({
      kind: 'exact',
      path: '/dsh-team/join',
      handler: async (req, res) => {
        const body = await readJsonBody(req)
        const hubUrl = normalizeHubUrl(str(body.hubUrl, 300) || STATE.hubUrl)
        const inviteCode = str(body.inviteCode, 32).trim().toUpperCase() || STATE.inviteCode
        const displayName = str(body.displayName, 40).trim() || STATE.displayName || MACHINE
        if (!hubUrl) return sendJson(res, 400, { ok: false, error: '请先填写团队服务器地址' })
        if (!inviteCode) return sendJson(res, 400, { ok: false, error: '请先填写邀请码' })
        try {
          const payload = reportPayload()
          const out = await hubFetch(hubUrl, '/api/join', {
            method: 'POST',
            body: {
              inviteCode,
              memberId: STATE.memberId,
              displayName,
              machine: MACHINE,
              monitoring: payload.monitoring,
              project: payload.project,
              projectPath: payload.projectPath,
              projects: payload.projects,
              usage: payload.usage,
              lastUsedAt: payload.lastUsedAt,
            },
          })
          STATE.hubUrl = hubUrl
          STATE.inviteCode = inviteCode
          STATE.displayName = displayName
          STATE.teamId = out.teamId || ''
          STATE.teamName = out.teamName || ''
          if (out.memberId) STATE.memberId = out.memberId
          STATE.memberToken = out.memberToken || ''
          snapshotCache = { at: Date.now(), snapshot: out.snapshot || null, error: null, teamName: STATE.teamName }
          saveState()
          // 加入后再补一次正式上报，确保服务器侧的令牌与账本都已就位
          await pushUsage()
          await pullSnapshot({ force: true })
          return sendJson(res, 200, { ok: true, teamName: STATE.teamName, snapshot: snapshotCache.snapshot })
        } catch (err) {
          return sendJson(res, 400, { ok: false, error: String((err && err.message) || err).slice(0, 200) })
        }
      },
    })

    // ---- 退出团队 ----
    route({
      kind: 'exact',
      path: '/dsh-team/leave',
      handler: async (req, res) => {
        if (STATE.teamId && STATE.memberToken && STATE.hubUrl) {
          try {
            await hubFetch(STATE.hubUrl, '/api/leave', {
              method: 'POST',
              body: { teamId: STATE.teamId, memberId: STATE.memberId, memberToken: STATE.memberToken },
              timeout: 5000,
            })
          } catch (err) {
            /* 服务器不可达时也允许本地退出 */
          }
        }
        STATE.teamId = ''
        STATE.teamName = ''
        STATE.memberToken = ''
        snapshotCache = { at: 0, snapshot: null, error: null, teamName: '' }
        saveState()
        sendJson(res, 200, { ok: true })
      },
    })

    // ---- 手动立即同步 ----
    route({
      kind: 'exact',
      path: '/dsh-team/sync',
      handler: async (req, res) => {
        if (!STATE.teamId || !STATE.memberToken) return sendJson(res, 400, { ok: false, error: '尚未加入团队' })
        await pushUsage()
        const snap = await pullSnapshot({ force: true })
        sendJson(res, 200, { ok: !snapshotCache.error, error: snapshotCache.error || null, snapshot: snap || null })
      },
    })

    // ---- 自检 ----
    route({
      kind: 'exact',
      path: '/dsh-team/ping',
      handler: (req, res) => {
        const usage = publicLedger()
        sendJson(res, 200, {
          ok: true,
          version: VERSION,
          machine: MACHINE,
          stateFile: STATE_FILE,
          panelJs: PANEL_JS_FILE,
          teamConfigured: Boolean(STATE.teamId && STATE.memberToken),
          monitoring: usage.monitoring,
          selectedProject: STATE.selectedProject ? STATE.selectedProject.path : null,
          projectsKnown: listProjects().length,
          tokens: usage.tokens,
        })
      },
    })

    // ---- 把面板脚本注入 Web 界面 ----
    disposers.push(
      ctx.webServer.tapIndex((html) => {
        if (html.indexOf('/dsh-team/panel.js') !== -1) return html
        const tag = '<script defer src="/dsh-team/panel.js"></script>'
        if (html.indexOf('</body>') !== -1) return html.replace('</body>', tag + '</body>')
        return html + tag
      }),
    )

    // ---- 采集用量 ----
    disposers.push(
      ctx.on('session/event', (session, event) => {
        handleSessionEvent(session, event)
      }),
    )

    // ---- 心跳：保持在线状态，并定期拉快照 ----
    const heartbeat = setInterval(() => {
      if (!STATE.teamId || !STATE.memberToken) return
      void pushUsage()
      void pullSnapshot()
    }, 20000)
    if (typeof heartbeat.unref === 'function') heartbeat.unref()
    disposers.push(() => clearInterval(heartbeat))
    disposers.push(() => {
      if (saveTimer) {
        clearTimeout(saveTimer)
        saveTimer = null
        writeStateNow()
      }
    })

    ctx.effect(() => () => {
      for (const d of disposers) {
        try {
          d()
        } catch (err) {
          /* 忽略单个 disposer 失败 */
        }
      }
    })
  },
}
