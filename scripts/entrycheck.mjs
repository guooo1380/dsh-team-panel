#!/usr/bin/env node
// ============================================================================
// scripts/entrycheck.mjs —— 入口冒烟测试
// ============================================================================
// 只做一件事：**真的 import 一次**两个入口模块，证明它们能被 DSH 宿主加载。
// 比「安装命令没报错」可靠得多 —— 缺少构建产物 / ESM 语法问题 / 顶层抛错
// 都会在这里立刻暴露。
//
// 用法：node scripts/entrycheck.mjs
// ============================================================================

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let fail = 0

function ok(name, detail) {
  console.log(`  ✓ ${name}${detail ? '  → ' + detail : ''}`)
}
function bad(name, detail) {
  fail++
  console.log(`  ✗ ${name}${detail ? '  → ' + detail : ''}`)
}

console.log('\n[1] 宿主端入口 lib/index.js')
try {
  const mod = await import(pathToFileURL(path.join(ROOT, 'lib', 'index.js')).href)
  const plugin = mod.default
  ok('import 成功', `exports=[${Object.keys(mod).join(', ')}]`)
  if (plugin && plugin.name === 'dsh-team-panel') ok('插件名正确', plugin.name)
  else bad('插件名正确', JSON.stringify(plugin && plugin.name))
  const inject = (plugin && plugin.inject) || []
  if (inject.includes('webServer') && inject.includes('connection')) ok('依赖声明完整', inject.join(', '))
  else bad('依赖声明完整', inject.join(', '))
  if (typeof (plugin && plugin.apply) === 'function') ok('apply 是函数')
  else bad('apply 是函数', typeof (plugin && plugin.apply))
} catch (err) {
  bad('import 成功', String((err && err.stack) || err))
}

console.log('\n[2] 峰谷模块 lib/peak.mjs')
try {
  const peak = await import(pathToFileURL(path.join(ROOT, 'lib', 'peak.mjs')).href)
  ok('import 成功', `exports=[${Object.keys(peak).join(', ')}]`)
  const snap = peak.peakSnapshot()
  if (typeof snap.isPeak === 'boolean' && (snap.label === '峰' || snap.label === '谷')) {
    ok('peakSnapshot() 可用', `${snap.label}（${snap.text}）`)
  } else {
    bad('peakSnapshot() 可用', JSON.stringify(snap))
  }
  if (peak.nextPeakChangeAt(Date.now() / 1000)) ok('能算出下一次切换时刻')
  else bad('能算出下一次切换时刻')
} catch (err) {
  bad('import 成功', String((err && err.stack) || err))
}

console.log('\n[3] 团队服务器模块 lib/team-hub.mjs')
try {
  // 注意：本机沙箱禁止子进程走管道 stdio（会 EPERM），所以这里用 stdio:'ignore'
  // 只看退出码，另外用静态检查补上“接口确实存在”这一点。
  const { spawnSync } = await import('node:child_process')
  const r = spawnSync(process.execPath, [path.join(ROOT, 'lib', 'team-hub.mjs'), '--help'], { stdio: 'ignore' })
  if (r.status === 0) ok('以 --help 启动可正常退出')
  else bad('以 --help 启动可正常退出', `status=${r.status} signal=${r.signal} error=${r.error && r.error.message}`)

  const fs = await import('node:fs')
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'team-hub.mjs'), 'utf8')
  const routes = ['/api/health', '/api/join', '/api/report', '/api/snapshot', '/api/profile', '/api/leave', '/admin']
  const missing = routes.filter((x) => !src.includes(x))
  if (missing.length === 0) ok('全部接口都在', routes.join(' '))
  else bad('全部接口都在', '缺少 ' + missing.join(' '))
  if (src.includes('timingSafeEqual') && src.includes('createHash')) ok('成员令牌以哈希存储并常量时间比对')
  else bad('成员令牌以哈希存储并常量时间比对')
  if (src.includes("from './net-addresses.mjs'")) ok('地址分类已抽成共用模块')
  else bad('地址分类已抽成共用模块')
} catch (err) {
  bad('团队服务器模块检查', String((err && err.message) || err))
}

console.log('\n[3b] 网络地址分类 lib/net-addresses.mjs')
try {
  const net = await import(pathToFileURL(path.join(ROOT, 'lib', 'net-addresses.mjs')).href)
  const a = net.classifyAddresses()
  if (a && Array.isArray(a.lan) && Array.isArray(a.tailscale) && Array.isArray(a.other)) {
    ok('classifyAddresses() 可用', `lan=${a.lan.length} tailscale=${a.tailscale.length} other=${a.other.length}`)
  } else {
    bad('classifyAddresses() 可用', JSON.stringify(a))
  }
  const virtualInLan = a.lan.filter((x) => /vEthernet|WSL|Hyper-V|VMware|VirtualBox|Docker/i.test(x.name))
  if (virtualInLan.length === 0) ok('虚拟网卡没被算进局域网推荐里')
  else bad('虚拟网卡没被算进局域网推荐里', JSON.stringify(virtualInLan))
  if (Array.isArray(net.teammateUrls(7801))) ok('teammateUrls() 可用')
  else bad('teammateUrls() 可用')
} catch (err) {
  bad('网络地址分类模块检查', String((err && err.message) || err))
}

console.log('\n[4] 前端面板 lib/panel.js')
try {
  const fs = await import('node:fs')
  const js = fs.readFileSync(path.join(ROOT, 'lib', 'panel.js'), 'utf8')
  if (/^\s*(import|export)\s/m.test(js)) bad('不含 ESM 语法（浏览器直接执行）')
  else ok('不含 ESM 语法（浏览器直接执行）')
  if (js.includes('[data-slot="sidebar.settings"]')) ok('锚定左侧边栏底部的「设置」槽位')
  else bad('锚定左侧边栏底部的「设置」槽位')
  if (js.includes('[data-composer-seat]')) bad('已脱离对话区底部（避免与鲸鱼插件相撞）')
  else ok('已脱离对话区底部（避免与鲸鱼插件相撞）')
  if (/__DSH_TEAM_PANEL__/.test(js)) ok('带重复注入防护')
  else bad('带重复注入防护')
} catch (err) {
  bad('读取 panel.js', String((err && err.message) || err))
}

console.log(`\n结果：${fail === 0 ? '全部通过 ✓' : fail + ' 项失败 ✗'}\n`)
process.exit(fail === 0 ? 0 : 1)
