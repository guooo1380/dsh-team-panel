#!/usr/bin/env node
// ============================================================================
// scripts/mounttest.mjs —— 挂载逻辑自检（仿 DOM，不需要浏览器）
// ============================================================================
// 验证 panel.js 真的会把自己插到「左侧边栏 → footArea → 设置行之前」，
// 并且：侧栏收起成图标轨（宽约 56px）时自动隐藏、重复挂载不会插出多个。
//
// 为什么要这么测：本机沙箱禁止无头浏览器（Edge 的命名管道 IPC 被拒绝），
// 所以用仿 DOM 跑**真实源码**，而不是靠读代码下结论。
//
// 用法：node scripts/mounttest.mjs
// ============================================================================

import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

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
// 极简 DOM：只实现 panel.js 真正用到的那部分
// ---------------------------------------------------------------------------
// panel.js 通过 dock.querySelectorAll('[data-el]') 拿到所有具名节点；
// 这里把替身登记进 panelEls，测试就能像用户一样去改 .value、派发 input/click。
const panelEls = {}

function makeEl(tag) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    children: [],
    parentElement: null,
    dataset: {},
    style: {},
    _attrs: {},
    _html: '',
    _stubCache: new Map(),
    _listeners: {},
    textContent: '',
    value: '',
    disabled: false,
    _rectWidth: 264, // 侧栏常态宽度（264–420px）
    classList: { contains: () => false, add() {}, remove() {} },
    addEventListener(type, fn) {
      if (!el._listeners[type]) el._listeners[type] = []
      el._listeners[type].push(fn)
    },
    removeEventListener(type, fn) {
      const list = el._listeners[type] || []
      const at = list.indexOf(fn)
      if (at !== -1) list.splice(at, 1)
    },
    /** 派发一个事件（只需要事件对象上那几个字段） */
    dispatch(type) {
      ;(el._listeners[type] || []).forEach((fn) =>
        fn({ type, preventDefault() {}, stopPropagation() {} }),
      )
    },
    getAttribute(k) {
      return Object.prototype.hasOwnProperty.call(el._attrs, k) ? el._attrs[k] : null
    },
    setAttribute(k, v) {
      el._attrs[k] = String(v)
    },
    getBoundingClientRect() {
      return { width: el._rectWidth, height: 100, top: 0, left: 0, right: el._rectWidth, bottom: 100 }
    },
    appendChild(child) {
      return el.insertBefore(child, null)
    },
    insertBefore(child, before) {
      if (child.parentElement) child.parentElement.removeChild(child)
      const at = before ? el.children.indexOf(before) : -1
      if (at === -1) el.children.push(child)
      else el.children.splice(at, 0, child)
      child.parentElement = el
      return child
    },
    removeChild(child) {
      const at = el.children.indexOf(child)
      if (at !== -1) el.children.splice(at, 1)
      child.parentElement = null
      return child
    },
    // 面板内部的渲染细节不是本测试的目标：按选择器返回稳定替身即可
    querySelector(sel) {
      if (!el._stubCache.has(sel)) el._stubCache.set(sel, makeEl('div'))
      return el._stubCache.get(sel)
    },
    querySelectorAll(sel) {
      if (sel !== '[data-el]') return []
      const names = []
      const re = /data-el="([^"]+)"/g
      let m
      while ((m = re.exec(el._html)) !== null) names.push(m[1])
      return names.map((name) => {
        const stub = makeEl('div')
        stub._attrs['data-el'] = name
        panelEls[name] = stub
        return stub
      })
    },
  }
  // panel.js 用 `dock.id = '...'` 赋值 → 记录进 _attrs，便于查找
  Object.defineProperty(el, 'id', {
    get() {
      return el._attrs.id || ''
    },
    set(v) {
      el._attrs.id = String(v)
    },
  })
  Object.defineProperty(el, 'nextElementSibling', {
    get() {
      if (!el.parentElement) return null
      const at = el.parentElement.children.indexOf(el)
      return at === -1 ? null : el.parentElement.children[at + 1] || null
    },
  })
  Object.defineProperty(el, 'innerHTML', {
    get() {
      return el._html
    },
    set(v) {
      el._html = String(v)
    },
  })
  return el
}

// ---------------------------------------------------------------------------
// 复刻真实侧栏结构（与 ui-renderer / ui-sidebar 的产出一致）：
//   sidebarRoot(flex column)
//     ├ logoRow / 新会话 / regionArea …
//     └ footArea(flex:none)
//         ├ footerActions ← renderSlot("sidebar.footer.action")
//         └ settingsArea  ← renderSlot("sidebar.settings")  ←「设置」行
//   renderSlot 的包装器是 <div data-slot="…" style="display:contents">
// ---------------------------------------------------------------------------
const sidebarRoot = makeEl('div')
const regionArea = makeEl('div')
const footArea = makeEl('div')
const footerActions = makeEl('div')
const settingsArea = makeEl('div')
const settingsSlot = makeEl('div')
settingsSlot.setAttribute('data-slot', 'sidebar.settings')
settingsArea.appendChild(settingsSlot)
footArea.appendChild(footerActions)
footArea.appendChild(settingsArea)
sidebarRoot.appendChild(regionArea)
sidebarRoot.appendChild(footArea)

const headEl = makeEl('head')
const bodyEl = makeEl('body')
bodyEl.appendChild(sidebarRoot)

const documentStub = {
  head: headEl,
  body: bodyEl,
  documentElement: makeEl('html'),
  activeElement: null,
  createElement: (tag) => makeEl(tag),
  getElementById(id) {
    if (id === 'dsh-team-style') return headEl.children.find((c) => c._attrs.id === id) || null
    if (id === 'dsh-team-dock') return findDock()
    return null
  },
  querySelector(sel) {
    if (sel === '[data-slot="sidebar.settings"]') return settingsSlot
    return null
  },
  addEventListener() {},
}

function findDock() {
  // 启动时先挂到 body，mount() 随即把它移进 footArea，所以两处都要找
  return (
    footArea.children.find((c) => c._attrs.id === 'dsh-team-dock') ||
    bodyEl.children.find((c) => c._attrs.id === 'dsh-team-dock') ||
    null
  )
}

const intervalCallbacks = []

// 服务端状态：可控，用来复现「本机还没保存过地址」的初始情形
let serverState = {
  ok: true,
  version: 'test',
  self: {},
  team: { configured: false, hubUrl: '', inviteCode: '' },
  peak: null,
  ui: {},
}
let lastConfig = null
function fetchStub(url, init) {
  const method = (init && init.method) || 'GET'
  if (method === 'POST' && String(url).includes('/dsh-team/config')) {
    const body = JSON.parse((init && init.body) || '{}')
    lastConfig = body
    // 复刻宿主端的规范化：地址去尾部斜杠、邀请码转大写
    serverState.team.hubUrl = String(body.hubUrl || '').trim().replace(/\/+$/, '')
    serverState.team.inviteCode = String(body.inviteCode || '').trim().toUpperCase()
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) })
  }
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(serverState) })
}

/** 让 panel.js 内部的 Promise 链跑完（刷新 → 重绘） */
async function flush(times = 8) {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setImmediate(resolve))
}

const sandbox = {
  document: documentStub,
  getComputedStyle: () => ({ backgroundColor: 'rgb(251, 251, 251)' }),
  setInterval: (fn) => {
    intervalCallbacks.push(fn)
    return intervalCallbacks.length
  },
  clearInterval: () => {},
  setTimeout: () => 1,
  clearTimeout: () => {},
  fetch: fetchStub,
  console,
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  // 显式共享外层的 Date：vm 上下文默认有自己的一份内建对象，
  // 不注入的话下面推时间就推不动 panel.js 里的 Date.now()
  Date,
}
sandbox.window = sandbox
sandbox.globalThis = sandbox

console.log('\n[1] 执行 panel.js')
const code = fs.readFileSync(path.join(ROOT, 'lib', 'panel.js'), 'utf8')
try {
  vm.runInContext(code, vm.createContext(sandbox), { filename: 'panel.js' })
  checkThat('执行无异常', true)
} catch (err) {
  checkThat('执行无异常', false, String((err && err.stack) || err))
}

const dock = findDock()

console.log('\n[2] 锚点与插入位置')
checkThat('面板已创建并挂在 DOM 上', !!dock, bodyEl.children.map((c) => c._attrs.id || c.tagName).join(','))
if (dock) {
  check('父节点是 footArea', dock.parentElement === footArea, true)
  check('紧邻「设置」行之前（nextElementSibling === settingsArea）', dock.nextElementSibling === settingsArea, true)
  check('footArea 子节点数 = 3', footArea.children.length, 3)
  check('footArea 顺序 = [footerActions, 面板, settingsArea]', footArea.children.indexOf(dock), 1)
  check('没有挂到对话区/body 上', dock.parentElement === bodyEl, false)
  check('已从隐藏态切到显示', dock.dataset.hidden, '0')
  check('侧栏宽度 264px 时不隐藏（>150）', dock.dataset.hidden, '0')
}

console.log('\n[3] 重复挂载不产生重复节点')
// 触发 panel.js 内部每 700ms 的 mount()
intervalCallbacks.forEach((fn) => fn())
check('footArea 仍然只有 3 个子节点', footArea.children.length, 3)
check('面板仍然是同一个节点', findDock() === dock, true)
check('DOM 里仍然只有一个面板', footArea.children.filter((c) => c._attrs.id === 'dsh-team-dock').length, 1)

console.log('\n[4] 侧栏收起成图标轨（宽 56px）时自动隐藏')
settingsArea._rectWidth = 56
// mount() 有 1.5 秒的防抖（刚拿不到锚点时不立刻隐藏），这里把时间往前推
const realNow = Date.now
Date.now = () => realNow.call(Date) + 10000
intervalCallbacks.forEach((fn) => fn())
Date.now = realNow
check('已隐藏（data-hidden=1）', dock.dataset.hidden, '1')
check('节点仍留在 footArea（不销毁，展开侧栏即可复用）', dock.parentElement === footArea, true)

console.log('\n[5] 侧栏恢复宽度后重新出现')
settingsArea._rectWidth = 280
intervalCallbacks.forEach((fn) => fn())
check('重新显示', dock.dataset.hidden, '0')
check('依然在「设置」行之前', dock.nextElementSibling === settingsArea, true)

// ---------------------------------------------------------------------------
// 回归：轮询每 3 秒重绘面板，不能把用户「已经输入但还没提交」的内容抹掉。
// 原始症状（第二台设备）：先填「团队服务器地址」，再点进「邀请码」框输入，
// 地址框一失焦就被服务器那边还空着的 hubUrl 覆盖 → 地址凭空消失。
// ---------------------------------------------------------------------------
console.log('\n[6] 轮询不覆盖用户正在填写的内容')
await flush() // 让启动时那次 refresh 先跑完，输入框完成首次对齐
checkThat('已拿到设置区的输入框', !!(panelEls.inHub && panelEls.inInvite && panelEls.inName))
check('初始服务器地址为空', panelEls.inHub.value, '')

// 用户在第二台设备上：先填地址
panelEls.inHub.value = 'http://192.168.1.10:7801'
panelEls.inHub.dispatch('input')
// 然后点进邀请码框继续填 → 地址框失焦
documentStub.activeElement = panelEls.inInvite
panelEls.inInvite.value = 'ubq8x853'
panelEls.inInvite.dispatch('input')
check('刚填完地址、还没提交时地址在框里', panelEls.inHub.value, 'http://192.168.1.10:7801')

// 轮询发生（serverState 里 hubUrl 仍然是空的）
intervalCallbacks.forEach((fn) => fn())
await flush()
check('轮询后地址没被抹掉', panelEls.inHub.value, 'http://192.168.1.10:7801')
check('轮询后邀请码没被抹掉', panelEls.inInvite.value, 'ubq8x853')

console.log('\n[7] 保存成功后输入框重新与服务器对齐')
documentStub.activeElement = documentStub.body
panelEls.saveBtn.dispatch('click')
await flush()
check('保存时带上了地址', lastConfig && lastConfig.hubUrl, 'http://192.168.1.10:7801')
check('地址按服务器值回填（去尾部斜杠）', panelEls.inHub.value, 'http://192.168.1.10:7801')
check('邀请码按服务器值回填（转大写）', panelEls.inInvite.value, 'UBQ8X853')

// 保存后用户再改地址、但这次不保存 → 轮询依旧不许覆盖
panelEls.inHub.value = 'http://10.0.0.9:7801'
panelEls.inHub.dispatch('input')
documentStub.activeElement = panelEls.inInvite
intervalCallbacks.forEach((fn) => fn())
await flush()
check('保存过之后的新改动同样不会被轮询抹掉', panelEls.inHub.value, 'http://10.0.0.9:7801')

console.log(`\n结果：通过 ${pass}，失败 ${fail}\n`)
process.exit(fail === 0 ? 0 : 1)
