#!/usr/bin/env node
// ============================================================================
// scripts/ci.mjs —— 全量自检（本地与 CI 共用同一个入口）
// ============================================================================
// 做法：先跑四个不需要 hub 的套件；再起一个临时 hub，把需要联调的两个套件
// 带上「地址 + 邀请码」跑一遍；最后清理。
//
// 用法：
//   node scripts/ci.mjs              全套
//   node scripts/ci.mjs --offline    只跑不需要 hub 的部分
//
// 之所以自己起 hub 而不是写在 CI 的 shell 里，是为了**跨平台**：
// 同一份逻辑在 Windows / Linux / macOS 与本地开发机上完全一致，
// 不依赖 bash 的 & / $! / seq 这些平台差异。
// ============================================================================

import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OFFLINE = process.argv.includes('--offline')
const CI_DATA = path.join(ROOT, 'data', 'ci-hub.json')

const suites = []
function run(name, args) {
  process.stdout.write(`\n──── ${name} ────\n`)
  const r = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' })
  const ok = r.status === 0
  suites.push({ name, ok, status: r.status })
  return ok
}

/** 对所有 JS/MJS 做一次语法门禁：能挡住绝大多数低级错误，且不依赖任何工具链。 */
function syntaxCheckAll() {
  process.stdout.write('\n──── 语法检查（全部 .js / .mjs）────\n')
  const files = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'data' || entry.name.startsWith('.')) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.m?js$/.test(entry.name)) files.push(full)
    }
  }
  walk(ROOT)
  let bad = 0
  for (const f of files) {
    const r = spawnSync(process.execPath, ['--check', f], { stdio: 'ignore' })
    if (r.status !== 0) {
      bad++
      console.log(`  ✗ ${path.relative(ROOT, f)}`)
    }
  }
  if (bad === 0) console.log(`  ✓ ${files.length} 个文件语法正确`)
  suites.push({ name: `语法检查（${files.length} 个文件）`, ok: bad === 0, status: bad })
  return bad === 0
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port
      srv.close(() => resolve(port))
    })
  })
}

async function waitForHealth(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), 1500)
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: ctrl.signal })
      clearTimeout(t)
      if (res.ok) return true
    } catch (err) {
      /* 还没起来，继续等 */
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
}

async function readInviteCode(timeoutMs = 6000) {
  // hub 的数据落盘有 400ms 防抖，刚起来时文件可能还没写出来 —— 要重试。
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const data = JSON.parse(fs.readFileSync(CI_DATA, 'utf8'))
      const team = Object.values(data.teams || {})[0]
      if (team && team.inviteCode) return team.inviteCode
    } catch (err) {
      /* 还没写出来 */
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  return ''
}

console.log('dsh-team-panel 全量自检' + (OFFLINE ? '（离线模式）' : ''))

// ---- 第一段：不需要 hub ----
syntaxCheckAll()
run('入口冒烟测试', ['scripts/entrycheck.mjs'])
run('挂载逻辑自检', ['scripts/mounttest.mjs'])
run('峰谷 + hub API 自检（离线部分）', ['scripts/selftest.mjs'])
run('宿主端插件自检（离线部分）', ['scripts/plugintest.mjs'])

// ---- 第二段：起临时 hub 做联调 ----
if (OFFLINE) {
  console.log('\n已跳过联调（--offline）')
} else {
  let hub = null
  let port = 0
  try {
    try {
      fs.rmSync(CI_DATA, { force: true })
    } catch (err) {
      /* 首次运行时文件本来就不存在 */
    }
    fs.mkdirSync(path.dirname(CI_DATA), { recursive: true })

    port = await findFreePort()
    console.log(`\n──── 启动临时 hub（127.0.0.1:${port}）────`)
    // stdio:'ignore' 是刻意的：本机沙箱禁止子进程走管道 stdio；ignore 在本地与 CI 都能用。
    hub = spawn(process.execPath, ['lib/team-hub.mjs', '--port', String(port), '--data', CI_DATA], {
      cwd: ROOT,
      stdio: 'ignore',
    })

    if (!(await waitForHealth(port))) {
      suites.push({ name: '临时 hub 启动', ok: false, status: 'timeout' })
      console.log('  ✗ 临时 hub 在 15 秒内没有就绪')
    } else {
      const invite = await readInviteCode()
      if (!invite) {
        suites.push({ name: '读取邀请码', ok: false, status: 'missing' })
      } else {
        const url = `http://127.0.0.1:${port}`
        run('峰谷 + hub API 自检（含联调）', ['scripts/selftest.mjs', url, invite])
        run('宿主端插件自检（含联调）', ['scripts/plugintest.mjs', url, invite])
      }
    }
  } catch (err) {
    suites.push({ name: '联调阶段', ok: false, status: String((err && err.message) || err) })
    console.log(`  ✗ 联调阶段出错：${(err && err.message) || err}`)
  } finally {
    if (hub) {
      try {
        hub.kill()
      } catch (err) {
        /* 已经退出了 */
      }
    }
    try {
      fs.rmSync(CI_DATA, { force: true })
    } catch (err) {
      /* 清理失败不影响结果 */
    }
  }
}

// ---- 汇总 ----
const failed = suites.filter((s) => !s.ok)
console.log('\n════════════════ 汇总 ════════════════')
for (const s of suites) {
  console.log(`  ${s.ok ? '✓' : '✗'} ${s.name}${s.ok ? '' : `  (exit ${s.status})`}`)
}
console.log(`\n${suites.length - failed.length}/${suites.length} 个套件通过`)
process.exit(failed.length === 0 ? 0 : 1)
