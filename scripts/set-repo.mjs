#!/usr/bin/env node
// ============================================================================
// scripts/set-repo.mjs —— 把仓库地址回填进所有占位符
// ============================================================================
// 项目里原本用 `OWNER/dsh-team-panel` 占位（package.json 的 repository/bugs/homepage、
// CHANGELOG 的比较链接、Issue 模板里的链接、README 的徽章与文档链接）。
// 设置好 git remote 之后跑一次本脚本，全部替换成真实地址，省得手工找漏。
//
// 注意：本脚本会**跳过自身**，否则它自己的占位符常量会被一起替换掉，
// 再跑第二次就找不到目标了（这个坑已经踩过一次）。
//
// 用法：
//   git remote add origin git@github.com:你的名字/dsh-team-panel.git
//   node scripts/set-repo.mjs                 # 自动读 git remote get-url origin
//   node scripts/set-repo.mjs <仓库地址>       # 或直接给地址
// ============================================================================

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SELF = fileURLToPath(import.meta.url)
const PLACEHOLDER = ['OWNER', 'dsh-team-panel'].join('/')

function detectRemote() {
  const arg = process.argv[2]
  if (arg) return arg
  const r = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: ROOT, encoding: 'utf8' })
  if (r.status === 0 && r.stdout.trim()) return r.stdout.trim()
  return ''
}

/** 把各种写法统一成 { owner, repo, https, git }。 */
function parseRemote(raw) {
  let s = String(raw).trim()
  if (!s) return null
  s = s.replace(/\.git$/, '')
  let m = /^git@([^:]+):(.+)$/.exec(s) // git@github.com:owner/repo
  if (m) return build(m[2])
  m = /^https?:\/\/[^/]+\/(.+)$/.exec(s) // https://github.com/owner/repo
  if (m) return build(m[1])
  m = /^ssh:\/\/git@[^/]+\/(.+)$/.exec(s)
  if (m) return build(m[1])
  if (/^[\w.-]+\/[\w.-]+$/.test(s)) return build(s) // 直接给 owner/repo
  return null
}

function build(slug) {
  const parts = slug.split('/').filter(Boolean)
  if (parts.length < 2) return null
  const owner = parts[parts.length - 2]
  const repo = parts[parts.length - 1]
  return {
    slug: `${owner}/${repo}`,
    https: `https://github.com/${owner}/${repo}`,
    git: `git+https://github.com/${owner}/${repo}.git`,
  }
}

const remote = detectRemote()
const info = parseRemote(remote)

if (!info) {
  console.log(`
用法：node scripts/set-repo.mjs <仓库地址>

  没读到可用的 git remote。可以：
    git remote add origin git@github.com:你的名字/dsh-team-panel.git
    node scripts/set-repo.mjs

  或者直接指定：
    node scripts/set-repo.mjs https://github.com/你的名字/dsh-team-panel
`)
  process.exit(1)
}

console.log(`\n仓库：${info.https}\n`)

// 收集所有含占位符的文本文件
const targets = []
const SKIP_DIRS = new Set(['node_modules', 'data', '.git'])
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full)
    else if (/\.(md|json|yml|yaml|mjs|js|html)$/.test(entry.name)) {
      if (path.resolve(full) === path.resolve(SELF)) continue // 别改自己
      targets.push(full)
    }
  }
}
walk(ROOT)

let changed = 0
for (const file of targets) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    continue
  }
  if (!text.includes(PLACEHOLDER)) continue
  const next = text.split(PLACEHOLDER).join(info.slug)
  if (next !== text) {
    fs.writeFileSync(file, next, 'utf8')
    changed++
    console.log(`  已更新  ${path.relative(ROOT, file)}`)
  }
}

// package.json 的 repository.url 要用 git+ 形式
const pkgPath = path.join(ROOT, 'package.json')
try {
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  if (pkg.repository) pkg.repository.url = info.git
  if (pkg.bugs) pkg.bugs.url = `${info.https}/issues`
  if (pkg.homepage) pkg.homepage = `${info.https}#readme`
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
  console.log('  已更新  package.json（repository / bugs / homepage）')
} catch (err) {
  console.log(`  ⚠️  package.json 处理失败：${(err && err.message) || err}`)
}

console.log(`
完成，共改动 ${changed} 个文件。

建议接着跑一次自检确认没改坏东西：
  node scripts/ci.mjs
`)
