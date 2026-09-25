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
    textContent: '',
    disabled: false,
    _rectWidth: 264, // 侧栏常态宽度（264–420px）
    classList: { contains: () => false, add() {}, remove() {} },
    addEventListener() {},
    removeEventListener() {},
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
  fetch: () =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ ok: true, version: 'test', self: {}, team: {}, peak: null, ui: {} }),
    }),
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

console.log(`\n结果：通过 ${pass}，失败 ${fail}\n`)
process.exit(fail === 0 ? 0 : 1)
