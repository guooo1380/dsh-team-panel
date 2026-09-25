// ============================================================================
// dsh-team-panel —— 注入到 DSH Web 界面的面板脚本（lib/panel.js）
// ============================================================================
// 由宿主端通过 ctx.webServer.tapIndex() 以 <script defer src="/dsh-team/panel.js">
// 注入。纯浏览器脚本、零依赖、不需要构建。
//
// 挂载点：**左侧边栏的底部**（图二那一栏），插在「设置」行的正上方。
//   侧边栏结构： root(flex column)
//                  ├─ logoRow
//                  ├─ 新会话按钮
//                  ├─ nav.panelList（全局面板）
//                  ├─ regionArea（「工作区」列表，flex:1）
//                  └─ footArea（flex:none）
//                       ├─ footerActions ← [data-slot="sidebar.footer.action"]
//                       └─ settingsArea  ← [data-slot="sidebar.settings"]  ←「设置」行
//
// 槽位包装器由 ui-renderer 渲染成 <div data-slot="<slotKey>" style="display:contents">，
// 所以它是可靠且与构建哈希无关的锚点；但它 display:contents、没有布局盒
// （getBoundingClientRect 恒为 0），量宽度必须用它的父级真实 div。
//
// 统计口径：**先选项目，再统计**。没选项目时面板显示成待选择状态，
// 选定后只统计那一个项目，并把「我选了哪个项目」展示给全队。
// ============================================================================

;(function () {
  'use strict'

  if (window.__DSH_TEAM_PANEL__) return
  window.__DSH_TEAM_PANEL__ = true

  var API = '/dsh-team'
  var POLL_OPEN = 3000
  var POLL_CLOSED = 8000
  var RAIL_MIN_WIDTH = 150 // 侧栏收起成图标轨（约 56px）时本面板不显示

  // -------------------------------------------------------------------------
  // 状态
  // -------------------------------------------------------------------------
  var state = null
  var expanded = false
  var expandedTouched = false
  var lastError = null
  var settingsOpen = false
  var pollTimer = null
  var pickerSig = null
  var promptedForProject = false

  // -------------------------------------------------------------------------
  // 工具
  // -------------------------------------------------------------------------
  function esc(s) {
    return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    })
  }

  function fmtTokens(n) {
    var v = Number(n) || 0
    if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B'
    if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M'
    if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K'
    return String(Math.round(v))
  }

  function fmtCost(n) {
    var v = Number(n) || 0
    if (v > 0 && v < 0.01) return '<¥0.01'
    return '¥' + v.toFixed(2)
  }

  function pad2(x) {
    return x < 10 ? '0' + x : String(x)
  }

  function fmtClock(ts) {
    if (!ts) return '—'
    try {
      var d = new Date(ts)
      return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes())
    } catch (e) {
      return '—'
    }
  }

  function fmtRelative(ts) {
    if (!ts) return '从未'
    var diff = Date.now() - Number(ts)
    if (diff < 0) diff = 0
    var sec = Math.floor(diff / 1000)
    if (sec < 20) return '刚刚'
    if (sec < 60) return sec + ' 秒前'
    var min = Math.floor(sec / 60)
    if (min < 60) return min + ' 分钟前'
    var hr = Math.floor(min / 60)
    if (hr < 24) return hr + ' 小时前'
    var day = Math.floor(hr / 24)
    if (day < 30) return day + ' 天前'
    return fmtClock(ts)
  }

  function fmtCountdown(sec) {
    if (!sec || sec < 0) return ''
    var h = Math.floor(sec / 3600)
    var m = Math.floor((sec % 3600) / 60)
    if (h > 0) return h + ' 小时 ' + m + ' 分'
    if (m > 0) return m + ' 分钟'
    return Math.max(1, Math.floor(sec)) + ' 秒'
  }

  function isDark() {
    try {
      var de = document.documentElement
      var attr = String(
        de.getAttribute('data-theme') || de.getAttribute('data-color-scheme') || de.getAttribute('data-mode') || '',
      ).toLowerCase()
      if (attr.indexOf('dark') !== -1) return true
      if (attr.indexOf('light') !== -1) return false
      if (de.classList.contains('dark') || de.classList.contains('theme-dark')) return true
      if (document.body && document.body.classList.contains('dark')) return true
      var probes = [document.body, document.getElementById('root'), de]
      for (var i = 0; i < probes.length; i++) {
        if (!probes[i]) continue
        var m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(getComputedStyle(probes[i]).backgroundColor)
        if (!m) continue
        var r = Number(m[1])
        var g = Number(m[2])
        var b = Number(m[3])
        if (r + g + b === 0) continue // 全透明，换下一个探针
        return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128
      }
    } catch (e) {
      /* 探测失败就走系统偏好 */
    }
    try {
      return window.matchMedia('(prefers-color-scheme: dark)').matches
    } catch (e) {
      return false
    }
  }

  // -------------------------------------------------------------------------
  // 样式（暖色调卡片，适配 264–420px 的侧边栏宽度）
  // -------------------------------------------------------------------------
  var CSS = [
    '#dsh-team-dock{--dt-bg1:#FFF8F0;--dt-bg2:#FFEFDD;--dt-border:#F3C99A;--dt-text:#7C2D12;',
    '--dt-muted:#A9764B;--dt-accent:#EA580C;--dt-accent-soft:#FFEDD5;--dt-line:#FBE0C4;',
    '--dt-peak:#E4572E;--dt-valley:#3F8F6B;--dt-shadow:0 4px 14px rgba(124,45,18,.10);',
    'flex:none;align-self:stretch;width:100%;box-sizing:border-box;margin:6px 0 8px;',
    'font-family:system-ui,"Segoe UI","Microsoft YaHei",sans-serif;font-size:12px;line-height:1.5;',
    'color:var(--dt-text);background:var(--dt-bg2);border:1px solid var(--dt-border);',
    'border-radius:11px;overflow:hidden;position:relative;z-index:1;-webkit-font-smoothing:antialiased}',

    '#dsh-team-dock[data-theme=dark]{--dt-bg1:#2A1A12;--dt-bg2:#241610;--dt-border:#573823;--dt-text:#FFD9B8;',
    '--dt-muted:#C79A73;--dt-accent:#FB923C;--dt-accent-soft:#3A2517;--dt-line:#3E2A1B;',
    '--dt-peak:#F8714B;--dt-valley:#4FB48A;--dt-shadow:0 4px 14px rgba(0,0,0,.35)}',

    '#dsh-team-dock[data-hidden="1"]{display:none}',
    // 还没选监测项目 → 用琥珀色虚线边框提示「待选择」
    '#dsh-team-dock[data-nomon="1"]{border-color:var(--dt-accent);border-style:dashed}',

    // ---- 展开面板 ----
    '.dt-panel{display:none;max-height:min(50vh,440px);overflow:hidden auto;background:var(--dt-bg1);',
    'border-bottom:1px solid var(--dt-border)}',
    '.dt-panel[data-open="1"]{display:block}',
    '.dt-panel-head{display:flex;align-items:center;gap:6px;padding:8px 10px 6px;position:sticky;top:0;',
    'background:var(--dt-bg1);border-bottom:1px solid var(--dt-line);z-index:2;flex-wrap:wrap}',
    '.dt-title{font-weight:700;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}',
    '.dt-sub{color:var(--dt-muted);font-size:11px;width:100%;order:3;margin-top:2px}',
    '.dt-spacer{flex:1}',
    '.dt-btn{border:1px solid var(--dt-border);background:var(--dt-bg2);color:var(--dt-text);border-radius:7px;',
    'padding:2px 8px;font-size:11px;cursor:pointer;font-family:inherit;white-space:nowrap}',
    '.dt-btn:hover{background:var(--dt-accent-soft);border-color:var(--dt-accent)}',
    '.dt-btn[data-primary="1"]{background:var(--dt-accent);border-color:var(--dt-accent);color:#fff}',
    '.dt-btn[data-primary="1"]:hover{background:#C2410C}',
    '.dt-btn[data-danger="1"]:hover{background:#FEE2E2;border-color:#DC2626;color:#B91C1C}',
    '.dt-btn:disabled{opacity:.6;cursor:default}',

    // ---- 项目选择区 ----
    '.dt-picker{padding:8px 10px;border-bottom:1px solid var(--dt-line);background:var(--dt-bg1)}',
    '.dt-step{font-size:11px;color:var(--dt-accent);font-weight:700;margin-bottom:4px}',
    '.dt-path{font-family:ui-monospace,Consolas,monospace;font-size:10.5px;color:var(--dt-muted);',
    'word-break:break-all;margin:-2px 0 7px;line-height:1.4}',
    '.dt-mine{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--dt-muted);margin-bottom:7px}',
    '.dt-mine b{color:var(--dt-text);font-size:12px}',
    '.dt-chip{border-radius:5px;padding:0 6px;font-size:10px;flex:none}',
    '.dt-chip[data-kind=on]{background:rgba(63,143,107,.16);color:#2F7057}',
    '.dt-chip[data-kind=off]{background:var(--dt-accent-soft);color:#B45309}',
    // 注册表里没有想要的目录时，允许手填路径兜底
    '.dt-link{background:none;border:none;color:var(--dt-accent);font-size:10.5px;cursor:pointer;padding:0;',
    'font-family:inherit;text-decoration:underline;margin-top:6px}',
    '.dt-manual{display:none;gap:5px;margin-top:5px}',
    '.dt-manual[data-open="1"]{display:flex}',
    '.dt-manual input{flex:1;border:1px solid var(--dt-border);background:var(--dt-bg1);color:var(--dt-text);',
    'border-radius:7px;padding:4px 7px;font-size:11px;font-family:ui-monospace,Consolas,monospace;min-width:0;box-sizing:border-box}',

    // 成员列表（窄栏用两行式，不用表格）
    '.dt-member{display:flex;flex-direction:column;gap:1px;padding:6px 10px;border-bottom:1px solid var(--dt-line)}',
    '.dt-member:last-child{border-bottom:none}',
    '.dt-member[data-me="1"]{background:var(--dt-accent-soft);box-shadow:inset 3px 0 0 var(--dt-accent)}',
    '.dt-mrow{display:flex;align-items:center;gap:6px;min-width:0}',
    '.dt-dot{width:7px;height:7px;min-width:7px;border-radius:50%;background:#C9A88B}',
    '.dt-dot[data-on="1"]{background:var(--dt-valley)}',
    '.dt-name{font-weight:600;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.dt-tag{font-size:10px;color:var(--dt-accent);background:var(--dt-accent-soft);border-radius:5px;padding:0 5px;flex:none}',
    '.dt-member[data-me="1"] .dt-tag{background:#fff}',
    '.dt-tok{font-family:ui-monospace,Consolas,monospace;font-weight:700;color:var(--dt-accent);flex:none;font-size:12px}',
    '.dt-msub{display:flex;align-items:center;gap:5px;color:var(--dt-muted);font-size:11px;padding-left:13px;min-width:0}',
    '.dt-msub span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.dt-msub .dt-last{flex:none}',
    '.dt-msub .dt-nop{color:#B45309}',
    '.dt-empty{padding:14px 10px;color:var(--dt-muted);text-align:center}',
    '.dt-sum{padding:7px 10px;border-top:1px solid var(--dt-line);color:var(--dt-muted);font-size:11px;',
    'display:flex;justify-content:space-between;gap:8px;background:var(--dt-bg2)}',
    '.dt-sum b{color:var(--dt-accent);font-family:ui-monospace,Consolas,monospace}',

    // ---- 设置区 ----
    '.dt-settings{display:none;padding:8px 10px 10px;border-top:1px solid var(--dt-line);background:var(--dt-bg2)}',
    '.dt-settings[data-open="1"]{display:block}',
    '.dt-field{display:flex;flex-direction:column;gap:2px;margin-bottom:7px;min-width:0}',
    '.dt-field label{font-size:11px;color:var(--dt-muted)}',
    '.dt-field input,.dt-field select{border:1px solid var(--dt-border);background:var(--dt-bg1);color:var(--dt-text);',
    'border-radius:7px;padding:5px 8px;font-size:12px;font-family:inherit;width:100%;box-sizing:border-box;min-width:0}',
    '.dt-field select{cursor:pointer}',
    '.dt-field input:focus,.dt-field select:focus{outline:none;border-color:var(--dt-accent);box-shadow:0 0 0 2px rgba(234,88,12,.14)}',
    '.dt-actions{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:2px}',
    '.dt-notice{font-size:11px;border-radius:6px;padding:3px 8px;width:100%;order:9}',
    '.dt-notice[data-kind=ok]{background:rgba(63,143,107,.14);color:#2F7057}',
    '.dt-notice[data-kind=err]{background:rgba(220,38,38,.12);color:#B91C1C}',
    '.dt-meta{color:var(--dt-muted);font-size:10.5px;margin-top:8px;display:flex;flex-direction:column;gap:2px;word-break:break-all}',

    // ---- 折叠栏（两行）----
    '.dt-bar{padding:7px 10px 8px;position:relative;background:linear-gradient(180deg,var(--dt-bg1),var(--dt-bg2))}',
    '.dt-bar-top{display:flex;align-items:center;gap:8px;min-width:0}',
    '.dt-circle{width:21px;height:21px;min-width:21px;border-radius:50%;display:flex;align-items:center;',
    'justify-content:center;font-size:11px;font-weight:700;color:#fff;border:none;padding:0;',
    'cursor:pointer;user-select:none;transition:transform .12s ease,box-shadow .12s ease;',
    'font-family:system-ui,"Microsoft YaHei",sans-serif;line-height:1}',
    '.dt-circle:hover{transform:translateY(-1px);box-shadow:0 3px 8px rgba(124,45,18,.25)}',
    '.dt-circle:active{transform:translateY(0)}',
    '.dt-peak{background:var(--dt-valley);box-shadow:0 0 0 3px rgba(63,143,107,.16)}',
    '.dt-peak[data-peak="1"]{background:var(--dt-peak);box-shadow:0 0 0 3px rgba(228,87,46,.18);',
    'animation:dt-breathe 2.6s ease-in-out infinite}',
    '@keyframes dt-breathe{0%,100%{box-shadow:0 0 0 3px rgba(228,87,46,.16)}50%{box-shadow:0 0 0 6px rgba(228,87,46,.06)}}',
    '.dt-toggle{background:var(--dt-accent);box-shadow:0 2px 6px rgba(234,88,12,.30);margin-left:auto;flex:none}',
    '.dt-toggle svg{width:11px;height:11px;display:block}',
    '.dt-toggle[data-open="1"]{background:#C2410C}',
    '#dsh-team-dock[data-theme=dark] .dt-toggle[data-open="1"]{background:#9A3412}',
    '.dt-proj{font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}',
    '.dt-proj[data-nomon="1"]{color:var(--dt-accent);font-weight:600}',
    '.dt-bar-bottom{display:flex;align-items:center;gap:6px;margin-top:5px;color:var(--dt-muted);font-size:11px;min-width:0}',
    '.dt-live{width:7px;height:7px;min-width:7px;border-radius:50%;background:#C9A88B}',
    '.dt-live[data-on="1"]{background:var(--dt-valley);box-shadow:0 0 0 3px rgba(63,143,107,.18)}',
    '.dt-live[data-on="err"]{background:#DC2626;box-shadow:0 0 0 3px rgba(220,38,38,.16)}',
    '.dt-total b{font-family:ui-monospace,Consolas,"Courier New",monospace;color:var(--dt-accent);font-size:13px}',
    '.dt-cost{font-family:ui-monospace,Consolas,monospace}',
    '.dt-online{margin-left:auto;flex:none}',
    '.dt-warn{color:#B45309;background:var(--dt-accent-soft);border-radius:5px;padding:0 6px;cursor:pointer;flex:none}',
    '.dt-bubble{position:absolute;left:10px;right:10px;bottom:100%;margin-bottom:4px;background:var(--dt-bg1);',
    'color:var(--dt-text);border:1px solid var(--dt-border);border-radius:8px;padding:5px 9px;font-size:11px;',
    'box-shadow:var(--dt-shadow);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;pointer-events:none;z-index:3}',
  ].join('')

  function ensureStyle() {
    if (document.getElementById('dsh-team-style')) return
    var tag = document.createElement('style')
    tag.id = 'dsh-team-style'
    tag.textContent = CSS
    document.head.appendChild(tag)
  }

  // -------------------------------------------------------------------------
  // DOM
  // -------------------------------------------------------------------------
  var dock = document.createElement('div')
  dock.id = 'dsh-team-dock'
  dock.dataset.hidden = '1'
  dock.dataset.theme = 'light'
  dock.dataset.nomon = '1'

  dock.innerHTML = [
    '<div class="dt-panel" data-open="0">',
    '  <div class="dt-panel-head">',
    '    <span class="dt-title" data-el="teamTitle">未加入团队</span>',
    '    <span class="dt-spacer"></span>',
    '    <button class="dt-btn" data-el="refreshBtn" title="立即与团队服务器同步">同步</button>',
    '    <button class="dt-btn" data-el="settingsBtn" title="团队设置 / 加入团队">设置</button>',
    '    <span class="dt-sub" data-el="teamSub"></span>',
    '  </div>',

    // —— 第一步：先选要监测的项目 ——
    '  <div class="dt-picker">',
    '    <div class="dt-step">① 选择要监测的 DSH 项目</div>',
    '    <div class="dt-mine"><span>我的监测状态</span><span class="dt-chip" data-el="mineChip" data-kind="off">未选择</span></div>',
    '    <div class="dt-field">',
    '      <select data-el="selProject"></select>',
    '    </div>',
    '    <div class="dt-path" data-el="projPath">未选择监测项目</div>',
    '    <div class="dt-actions">',
    '      <button class="dt-btn" data-primary="1" data-el="applyProjectBtn">开始监测</button>',
    '      <button class="dt-btn" data-el="stopProjectBtn">取消监测</button>',
    '      <button class="dt-btn" data-danger="1" data-el="resetProjectBtn" title="把该项目的用量清零">清零</button>',
    '      <span class="dt-notice" data-el="projectNotice" style="display:none"></span>',
    '    </div>',
    '    <button class="dt-link" data-el="manualToggle">手动填写目录路径…</button>',
    '    <div class="dt-manual" data-el="manualBox">',
    '      <input data-el="inManualPath" placeholder="D:\\Work\\我的项目">',
    '      <button class="dt-btn" data-el="manualApplyBtn">使用</button>',
    '    </div>',
    '  </div>',

    '  <div data-el="listWrap"></div>',
    '  <div class="dt-sum" data-el="sumBox" style="display:none"></div>',

    // —— 第二步：加入团队 ——
    '  <div class="dt-settings" data-open="0">',
    '    <div class="dt-step">② 加入团队（可选）</div>',
    '    <div class="dt-field"><label>我的 DSH 名字（每个成员给自己这台 DSH 起名）</label>',
    '      <input data-el="inName" maxlength="40" placeholder="例如：小明的 DSH"></div>',
    '    <div class="dt-field"><label>团队服务器地址</label>',
    '      <input data-el="inHub" maxlength="300" placeholder="http://192.168.1.10:7801"></div>',
    '    <div class="dt-field"><label>邀请码（向团队服务器管理员索取）</label>',
    '      <input data-el="inInvite" maxlength="32" placeholder="8 位邀请码"></div>',
    '    <div class="dt-actions">',
    '      <button class="dt-btn" data-primary="1" data-el="joinBtn">加入团队</button>',
    '      <button class="dt-btn" data-el="saveBtn">保存本机设置</button>',
    '      <button class="dt-btn" data-danger="1" data-el="leaveBtn">退出团队</button>',
    '      <span class="dt-notice" data-el="notice" style="display:none"></span>',
    '    </div>',
    '    <div class="dt-meta" data-el="metaBox"></div>',
    '  </div>',
    '</div>',
    '<div class="dt-bar">',
    '  <div class="dt-bar-top">',
    '    <button class="dt-circle dt-peak" data-el="peakBtn" data-peak="0" title="">谷</button>',
    '    <span class="dt-proj" data-el="proj">—</span>',
    '    <button class="dt-circle dt-toggle" data-el="toggleBtn" data-open="0" title="展开团队详情">',
    '      <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M5 0h2v5h5v2H7v5H5V7H0V5h5z" fill="currentColor"></path></svg>',
    '    </button>',
    '  </div>',
    '  <div class="dt-bar-bottom">',
    '    <span class="dt-live" data-el="live" data-on="0" title="团队服务器连接状态"></span>',
    '    <span class="dt-total">总 Token <b data-el="total">0</b></span>',
    '    <span class="dt-cost" data-el="cost">¥0.00</span>',
    '    <span class="dt-online" data-el="online"></span>',
    '    <span class="dt-warn" data-el="warn" style="display:none"></span>',
    '  </div>',
    '  <span class="dt-bubble" data-el="bubble" style="display:none"></span>',
    '</div>',
  ].join('')

  var el = {}
  Array.prototype.forEach.call(dock.querySelectorAll('[data-el]'), function (node) {
    el[node.getAttribute('data-el')] = node
  })

  // -------------------------------------------------------------------------
  // 挂载 / 卸载（锚定左侧边栏「设置」行的正上方）
  // -------------------------------------------------------------------------
  function findAnchor() {
    var settingsSlot = document.querySelector('[data-slot="sidebar.settings"]')
    if (!settingsSlot) return null
    var settingsArea = settingsSlot.parentElement
    if (!settingsArea) return null
    var footArea = settingsArea.parentElement
    if (!footArea) return null
    // 侧栏收起成图标轨时不显示本面板（槽位包装器是 display:contents，量不到宽，
    // 必须量它父级的真实 div）
    var w = settingsArea.getBoundingClientRect().width
    if (w > 0 && w < RAIL_MIN_WIDTH) return null
    return { parent: footArea, before: settingsArea }
  }

  var lastAnchorAt = 0
  function mount() {
    var anchor = findAnchor()
    if (anchor) {
      lastAnchorAt = Date.now()
      if (dock.parentElement !== anchor.parent || dock.nextElementSibling !== anchor.before) {
        anchor.parent.insertBefore(dock, anchor.before)
      }
      if (dock.dataset.hidden === '1') dock.dataset.hidden = '0'
    } else if (Date.now() - lastAnchorAt > 1500) {
      // 取不到锚点（例如侧栏正在重渲染）时先藏起来，避免闪烁与错位
      if (dock.dataset.hidden !== '1') dock.dataset.hidden = '1'
    }
    var theme = isDark() ? 'dark' : 'light'
    if (dock.dataset.theme !== theme) dock.dataset.theme = theme
  }

  // -------------------------------------------------------------------------
  // 渲染
  // -------------------------------------------------------------------------
  function peakTipText() {
    var peak = state && state.peak
    if (!peak) return '时段未知'
    var tip = '当前：' + peak.text + '（' + peak.label + '）'
    tip += '\n高峰时段：北京时间 周一至周五 ' + (peak.peakHours || []).join('、')
    tip += '\n其余时段（含周末、法定节假日全天）为空闲（谷）时段，价格为高峰的一半'
    if (peak.nextChangeAt) {
      var left = Math.round(peak.nextChangeAt - Date.now() / 1000)
      tip += '\n距下一次切换（' + (peak.isPeak ? '转空闲' : '转高峰') + '）还有 ' + fmtCountdown(left)
    }
    return tip
  }

  var bubbleTimer = null
  function showBarBubble(text) {
    el.bubble.textContent = text
    el.bubble.style.display = ''
    if (bubbleTimer) clearTimeout(bubbleTimer)
    bubbleTimer = setTimeout(function () {
      el.bubble.style.display = 'none'
    }, 3600)
  }

  function renderPeak() {
    var peak = state && state.peak
    var btn = el.peakBtn
    if (!peak) {
      btn.textContent = '—'
      btn.dataset.peak = '0'
      btn.title = '时段未知'
      return
    }
    btn.textContent = peak.label
    btn.dataset.peak = peak.isPeak ? '1' : '0'
    btn.title = peakTipText()
  }

  function renderBar() {
    var self = (state && state.self) || {}
    var team = (state && state.team) || {}
    var snap = team.snapshot
    var monitoring = Boolean(self.monitoring)

    dock.dataset.nomon = monitoring ? '0' : '1'
    el.proj.dataset.nomon = monitoring ? '0' : '1'

    // 折叠栏第一行：团队正在做的项目；自己还没选项目时先提示选择
    if (!monitoring) {
      el.proj.textContent = '⚠ 未选择监测项目'
      el.proj.title = '点右下角 ⊕ 展开，先选一个要监测的 DSH 项目；未选择时不会统计任何用量'
    } else {
      var projects = (snap && snap.projects) || []
      var label
      if (projects.length === 0) label = self.selectedProject ? self.selectedProject.title : '我的项目'
      else if (projects.length === 1) label = projects[0].name
      else label = projects[0].name + ' +' + (projects.length - 1)
      el.proj.textContent = label
      el.proj.title = '团队正在做的项目：' + projects.map(function (p) { return p.name }).join('、')
    }

    // 折叠栏第二行：全队总量
    var totalTokens = (snap && snap.totals && snap.totals.tokens) || 0
    var totalCost = (snap && snap.totals && snap.totals.cost) || 0
    el.total.textContent = fmtTokens(totalTokens)
    el.total.title = String(Math.round(Number(totalTokens) || 0)) + ' tokens（全队合计）'
    el.cost.textContent = fmtCost(totalCost)

    if (snap && snap.totals) {
      el.online.textContent = '在线 ' + snap.totals.online + '/' + snap.totals.members
    } else if (monitoring) {
      el.online.textContent = '本机 ' + fmtTokens(self.usage && self.usage.tokens)
    } else {
      el.online.textContent = ''
    }

    var live = el.live
    if (team.configured) {
      if (team.online) {
        live.dataset.on = '1'
        live.title = '已连接团队服务器' + (team.fetchedAt ? '（更新于 ' + fmtClock(team.fetchedAt) + '）' : '')
      } else {
        live.dataset.on = 'err'
        live.title = '团队服务器连接失败：' + (team.error || '未知原因')
      }
    } else {
      live.dataset.on = '0'
      live.title = '尚未加入团队，当前只显示本机数据'
    }

    var warn = el.warn
    var warnText = ''
    if (team.configured && !team.online && team.error) warnText = '离线'
    if (lastError) warnText = '异常'
    if (warnText) {
      warn.style.display = ''
      warn.textContent = warnText
      warn.title = lastError || team.error || ''
    } else {
      warn.style.display = 'none'
    }
  }

  function renderPicker() {
    var self = (state && state.self) || {}
    var projects = self.projects || []
    var selected = self.selectedProject
    var monitoring = Boolean(self.monitoring)

    el.mineChip.textContent = monitoring ? '监测中' : '未选择'
    el.mineChip.dataset.kind = monitoring ? 'on' : 'off'
    el.projPath.textContent = selected ? selected.path : '未选择监测项目（此时不统计任何用量）'
    el.projPath.title = selected ? selected.path : ''

    // 下拉框只在选项集合变化时重建，且用户正在操作时不打断
    var sig =
      projects
        .map(function (p) {
          return p.key + '|' + p.title + '|' + (p.exists ? 1 : 0)
        })
        .join(';') +
      '#sel=' +
      (selected ? selected.path : '')
    if (sig !== pickerSig && document.activeElement !== el.selProject) {
      pickerSig = sig
      var html = '<option value="">— 请选择要监测的项目 —</option>'
      projects.forEach(function (p) {
        html +=
          '<option value="' +
          esc(p.path) +
          '"' +
          (p.exists ? '' : ' disabled') +
          '>' +
          esc(p.title) +
          (p.exists ? '' : '（目录不存在）') +
          (p.source === 'observed' ? '' : '') +
          '</option>'
      })
      el.selProject.innerHTML = html
      el.selProject.value = selected ? selected.path : ''
    }
    el.stopProjectBtn.disabled = !monitoring
    el.resetProjectBtn.disabled = !monitoring

    // 一个项目都没读到（注册表不可用且本插件还没见过任何会话）→ 直接摊开手动填写
    if (projects.length === 0) {
      el.manualBox.dataset.open = '1'
      if (!selected) {
        el.projPath.textContent = '没读到 DSH 工作区列表，请在下面手动填写项目目录'
      }
    }
  }

  function memberRow(m, self, isMeFallback) {
    var isMe = isMeFallback || (self && m.id === self.memberId)
    var noProject = !m.project
    var sub
    if (noProject) {
      sub =
        '<div class="dt-msub"><span class="dt-nop">未选择监测项目</span>' +
        (isMe ? '<span class="dt-last">· 点上方选择</span>' : '') +
        '</div>'
    } else {
      sub =
        '<div class="dt-msub">' +
        '<span title="' + esc(m.projectPath || m.project) + '">' + esc(m.project) + '</span>' +
        '<span class="dt-last" title="' + esc(fmtClock(m.lastUsedAt)) + '">· ' + esc(fmtRelative(m.lastUsedAt)) + '</span>' +
        '<span class="dt-last">· ' + fmtCost(m.cost) + '</span>' +
        '</div>'
    }
    return (
      '<div class="dt-member"' +
      (isMe ? ' data-me="1"' : '') +
      '>' +
      '<div class="dt-mrow">' +
      '<span class="dt-dot" data-on="' + (m.online ? '1' : '0') + '"></span>' +
      '<span class="dt-name" title="' + esc(m.name) + (m.machine ? ' @ ' + esc(m.machine) : '') + '">' + esc(m.name) + '</span>' +
      (isMe ? '<span class="dt-tag">我</span>' : '') +
      '<span class="dt-tok" title="' + Math.round(Number(m.tokens) || 0) + ' tokens">' + fmtTokens(m.tokens) + '</span>' +
      '</div>' +
      sub +
      '</div>'
    )
  }

  function renderPanel() {
    var team = (state && state.team) || {}
    var snap = team.snapshot
    var self = (state && state.self) || {}

    el.teamTitle.textContent = team.configured ? team.teamName || '未命名团队' : '未加入团队'
    el.teamSub.textContent = team.configured
      ? snap
        ? '在线 ' + snap.totals.online + '/' + snap.totals.members + ' 人 · ' + snap.totals.projects +
          ' 个项目 · 更新于 ' + fmtClock(team.fetchedAt)
        : '尚未获取到团队数据' + (team.error ? '：' + team.error : '')
      : '未加入团队也能看到本机数据；填地址 + 邀请码即可组队'

    renderPicker()

    var html = ''
    var members = (snap && snap.members) || []
    if (members.length) {
      html = members
        .map(function (m) {
          return memberRow(m, self, false)
        })
        .join('')
    } else {
      // 未加入团队时也把自己显示出来
      var myUsage = self.usage || {}
      html = memberRow(
        {
          id: self.memberId,
          name: self.displayName || '我',
          machine: self.machine || '',
          project: self.selectedProject ? self.selectedProject.title : '',
          projectPath: self.selectedProject ? self.selectedProject.path : '',
          tokens: myUsage.tokens || 0,
          cost: myUsage.cost || 0,
          lastUsedAt: myUsage.lastUsedAt || 0,
          online: true,
        },
        self,
        true,
      )
    }
    el.listWrap.innerHTML = html || '<div class="dt-empty">还没有成员数据</div>'

    if (snap && snap.totals) {
      el.sumBox.style.display = ''
      el.sumBox.innerHTML =
        '<span>全队合计</span><span><b>' + fmtTokens(snap.totals.tokens) + '</b> tokens · <b>' +
        fmtCost(snap.totals.cost) + '</b></span>'
    } else {
      el.sumBox.style.display = 'none'
    }

    if (document.activeElement !== el.inName) el.inName.value = self.displayName || ''
    if (document.activeElement !== el.inHub) el.inHub.value = team.hubUrl || ''
    if (document.activeElement !== el.inInvite) el.inInvite.value = team.inviteCode || ''

    var me = self.usage || {}
    var meta = [
      '本机累计 ' + fmtTokens(me.tokens || 0) + ' tokens（输入 ' + fmtTokens(me.input || 0) +
        ' / 缓存 ' + fmtTokens(me.cache || 0) + ' / 输出 ' + fmtTokens(me.output || 0) + '）',
      '调用 ' + (me.calls || 0) + ' 次' + (me.lastUsedAt ? ' · 最后 ' + fmtRelative(me.lastUsedAt) : ''),
      '成员 ID：' + (self.memberId || '—'),
    ]
    el.metaBox.innerHTML = meta
      .map(function (s) {
        return '<span>' + esc(s) + '</span>'
      })
      .join('')
  }

  function render() {
    renderPeak()
    renderBar()
    renderPanel()
  }

  function setExpanded(next, persist) {
    expanded = Boolean(next)
    el.toggleBtn.dataset.open = expanded ? '1' : '0'
    el.toggleBtn.title = expanded ? '收起团队详情' : '展开团队详情'
    dock.querySelector('.dt-panel').dataset.open = expanded ? '1' : '0'
    if (persist !== false) {
      post('/config', { expanded: expanded }).catch(function () {
        /* 展开态持久化失败无所谓，下次点击会重试 */
      })
    }
    schedulePoll()
  }

  function setSettingsOpen(next) {
    settingsOpen = Boolean(next)
    dock.querySelector('.dt-settings').dataset.open = settingsOpen ? '1' : '0'
    el.settingsBtn.textContent = settingsOpen ? '收起设置' : '设置'
  }

  function showNotice(node, kind, text) {
    node.style.display = ''
    node.dataset.kind = kind
    node.textContent = text
    var key = node === el.projectNotice ? 'project' : 'team'
    if (showNotice.timers === undefined) showNotice.timers = {}
    if (showNotice.timers[key]) clearTimeout(showNotice.timers[key])
    showNotice.timers[key] = setTimeout(function () {
      node.style.display = 'none'
    }, 5000)
  }

  // -------------------------------------------------------------------------
  // 网络
  // -------------------------------------------------------------------------
  function get(url) {
    return fetch(url, { headers: { Accept: 'application/json' } }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok || (j && j.ok === false)) throw new Error((j && j.error) || 'HTTP ' + r.status)
        return j
      })
    })
  }

  function post(path, body) {
    return fetch(API + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok || (j && j.ok === false)) throw new Error((j && j.error) || 'HTTP ' + r.status)
        return j
      })
    })
  }

  var refreshing = false
  function refresh() {
    if (refreshing) return
    refreshing = true
    get(API + '/state')
      .then(function (j) {
        state = j
        lastError = null
        if (j.ui && typeof j.ui.expanded === 'boolean' && !expandedTouched) {
          expandedTouched = true
          setExpanded(j.ui.expanded, false)
        }
        // 还没选监测项目：自动展开并把选择器摆到眼前（每次加载最多提示一次）
        if (!promptedForProject && j.self && !j.self.monitoring) {
          promptedForProject = true
          if (!expanded) setExpanded(true, false)
        }
        render()
      })
      .catch(function (err) {
        lastError = String((err && err.message) || err)
        el.warn.style.display = ''
        el.warn.textContent = '插件未就绪'
        el.warn.title = lastError
      })
      .then(function () {
        refreshing = false
      })
  }

  function schedulePoll() {
    if (pollTimer) clearInterval(pollTimer)
    pollTimer = setInterval(refresh, expanded ? POLL_OPEN : POLL_CLOSED)
  }

  // -------------------------------------------------------------------------
  // 事件绑定
  // -------------------------------------------------------------------------
  el.toggleBtn.addEventListener('click', function (e) {
    e.preventDefault()
    e.stopPropagation()
    expandedTouched = true
    setExpanded(!expanded)
  })

  el.peakBtn.addEventListener('click', function (e) {
    e.preventDefault()
    e.stopPropagation()
    // 峰/谷圆标只做指示，不改变折叠状态
    var peak = state && state.peak
    if (!peak) return
    var left = peak.nextChangeAt ? Math.round(peak.nextChangeAt - Date.now() / 1000) : 0
    showBarBubble('当前' + peak.text + (left > 0 ? '，' + fmtCountdown(left) + '后切换' : ''))
  })

  el.warn.addEventListener('click', function (e) {
    e.preventDefault()
    expandedTouched = true
    setExpanded(true)
    setSettingsOpen(true)
  })

  el.settingsBtn.addEventListener('click', function (e) {
    e.preventDefault()
    setSettingsOpen(!settingsOpen)
  })

  el.applyProjectBtn.addEventListener('click', function (e) {
    e.preventDefault()
    var p = el.selProject.value
    if (!p) return showNotice(el.projectNotice, 'err', '请先在下面的下拉框里选一个项目')
    el.applyProjectBtn.disabled = true
    post('/project', { path: p })
      .then(function () {
        showNotice(el.projectNotice, 'ok', '已开始监测该项目')
        return refresh()
      })
      .catch(function (err) {
        showNotice(el.projectNotice, 'err', String((err && err.message) || err).slice(0, 90))
      })
      .then(function () {
        el.applyProjectBtn.disabled = false
      })
  })

  el.stopProjectBtn.addEventListener('click', function (e) {
    e.preventDefault()
    post('/project', { path: '' })
      .then(function () {
        showNotice(el.projectNotice, 'ok', '已取消监测')
        return refresh()
      })
      .catch(function (err) {
        showNotice(el.projectNotice, 'err', String((err && err.message) || err).slice(0, 90))
      })
  })

  el.resetProjectBtn.addEventListener('click', function (e) {
    e.preventDefault()
    post('/reset', {})
      .then(function () {
        showNotice(el.projectNotice, 'ok', '该项目用量已清零')
        return refresh()
      })
      .catch(function (err) {
        showNotice(el.projectNotice, 'err', String((err && err.message) || err).slice(0, 90))
      })
  })

  el.manualToggle.addEventListener('click', function (e) {
    e.preventDefault()
    el.manualBox.dataset.open = el.manualBox.dataset.open === '1' ? '0' : '1'
  })

  el.manualApplyBtn.addEventListener('click', function (e) {
    e.preventDefault()
    var p = el.inManualPath.value.trim()
    if (!p) return showNotice(el.projectNotice, 'err', '请先填写目录路径')
    el.manualApplyBtn.disabled = true
    post('/project', { path: p })
      .then(function () {
        showNotice(el.projectNotice, 'ok', '已开始监测该目录')
        return refresh()
      })
      .catch(function (err) {
        showNotice(el.projectNotice, 'err', String((err && err.message) || err).slice(0, 90))
      })
      .then(function () {
        el.manualApplyBtn.disabled = false
      })
  })

  el.refreshBtn.addEventListener('click', function (e) {
    e.preventDefault()
    post('/sync', {})
      .then(function () {
        showNotice(el.notice, 'ok', '已同步')
        return refresh()
      })
      .catch(function (err) {
        showNotice(el.notice, 'err', String((err && err.message) || err).slice(0, 90))
      })
  })

  el.saveBtn.addEventListener('click', function (e) {
    e.preventDefault()
    post('/config', {
      displayName: el.inName.value,
      hubUrl: el.inHub.value,
      inviteCode: el.inInvite.value,
    })
      .then(function () {
        showNotice(el.notice, 'ok', '已保存')
        return refresh()
      })
      .catch(function (err) {
        showNotice(el.notice, 'err', String((err && err.message) || err).slice(0, 90))
      })
  })

  el.joinBtn.addEventListener('click', function (e) {
    e.preventDefault()
    el.joinBtn.disabled = true
    post('/join', {
      hubUrl: el.inHub.value,
      inviteCode: el.inInvite.value,
      displayName: el.inName.value,
    })
      .then(function (j) {
        showNotice(el.notice, 'ok', '已加入「' + (j.teamName || '') + '」')
        return refresh()
      })
      .catch(function (err) {
        showNotice(el.notice, 'err', String((err && err.message) || err).slice(0, 90))
      })
      .then(function () {
        el.joinBtn.disabled = false
      })
  })

  el.leaveBtn.addEventListener('click', function (e) {
    e.preventDefault()
    post('/leave', {})
      .then(function () {
        showNotice(el.notice, 'ok', '已退出团队')
        return refresh()
      })
      .catch(function (err) {
        showNotice(el.notice, 'err', String((err && err.message) || err).slice(0, 90))
      })
  })

  // 相对时间会变旧：本地重绘一次，不额外打网络
  setInterval(function () {
    if (expanded) renderPanel()
  }, 20000)
  // 峰谷圆标与倒计时
  setInterval(renderPeak, 30000)

  try {
    var mq = window.matchMedia('(prefers-color-scheme: dark)')
    if (mq && mq.addEventListener) mq.addEventListener('change', mount)
  } catch (e) {
    /* 老浏览器忽略 */
  }

  // -------------------------------------------------------------------------
  // 启动
  // -------------------------------------------------------------------------
  ensureStyle()
  if (document.body) document.body.appendChild(dock)
  mount()
  setInterval(mount, 700)
  refresh()
  schedulePoll()
})()
