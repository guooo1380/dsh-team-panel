#!/usr/bin/env node
// ============================================================================
// scripts/serve-preview.mjs —— 本地静态预览服务
// ============================================================================
// 用途：`scripts/preview.html` 也可以用 file:// 直接打开，但有些浏览器对
// file:// 下的脚本加载有额外限制。这个零依赖小服务把仓库根目录静态托管出来，
// 由 http 打开预览页，行为与真实环境一致。
//
// 用法：
//   node scripts/serve-preview.mjs            # 默认 7788 端口
//   node scripts/serve-preview.mjs 9000
// 然后浏览器打开打印出来的地址。
// ============================================================================

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.argv[2] || 7788)

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.gif': 'image/gif',
}

const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url || '/', 'http://x').pathname)
  if (pathname === '/') {
    res.writeHead(302, { Location: '/scripts/preview.html' })
    res.end()
    return
  }
  // 只允许读仓库内的文件，挡掉 ../ 越界
  const target = path.resolve(ROOT, '.' + pathname)
  if (!target.startsWith(ROOT)) {
    res.writeHead(403)
    res.end('forbidden')
    return
  }
  fs.readFile(target, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('not found: ' + pathname)
      return
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    })
    res.end(buf)
  })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log('')
  console.log('  面板预览已就绪：')
  console.log(`    折叠态        http://127.0.0.1:${PORT}/scripts/preview.html`)
  console.log(`    展开态        http://127.0.0.1:${PORT}/scripts/preview.html?open`)
  console.log(`    未选项目态    http://127.0.0.1:${PORT}/scripts/preview.html?noproj`)
  console.log(`    深色          http://127.0.0.1:${PORT}/scripts/preview.html?open&dark`)
  console.log('')
  console.log('  Ctrl+C 停止。')
  console.log('')
})
