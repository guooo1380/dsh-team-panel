// ============================================================================
// lib/net-addresses.mjs —— 本机 IPv4 地址分类（hub 与 hub-info 共用）
// ============================================================================
// 用途：算出「队友该填哪个地址」。关键点有两个：
//   1) 网卡名是 os.networkInterfaces() 返回对象的 key，不是条目属性；
//   2) 虚拟网卡（WSL / Hyper-V / VMware / Docker…）的地址队友通常连不上，
//      不能拿去当推荐地址。
// ============================================================================

import os from 'node:os'

/** 虚拟网卡名特征：这些网卡的地址不作为对外推荐地址。 */
const VIRTUAL_ADAPTER_RE = /vEthernet|WSL|Virtual|VMware|VirtualBox|Hyper-V|Docker|Loopback|Bluetooth|Npcap/i

/**
 * 分类本机 IPv4 地址。
 * @returns {{lan: Array<{addr: string, name: string}>, tailscale: Array<{addr: string, name: string}>, other: Array<{addr: string, name: string}>}}
 *   lan = 局域网（已剔除虚拟网卡）；tailscale = 100.64.0.0/10 段；other = 其余（含虚拟网卡）
 */
export function classifyAddresses() {
  const out = { lan: [], tailscale: [], other: [] }
  try {
    for (const [name, list] of Object.entries(os.networkInterfaces())) {
      for (const ni of list || []) {
        if (!ni || ni.family !== 'IPv4' || ni.internal) continue
        const m = /^(\d+)\.(\d+)\./.exec(ni.address)
        if (!m) continue
        const a = Number(m[1])
        const b = Number(m[2])
        const isTailscale = a === 100 && b >= 64 && b <= 127 // Tailscale / CGNAT 段
        const isLan = a === 10 || a === 192 || (a === 172 && b >= 16 && b <= 31)
        const entry = { addr: ni.address, name }
        if (isTailscale) out.tailscale.push(entry)
        else if (isLan && !VIRTUAL_ADAPTER_RE.test(name)) out.lan.push(entry)
        else out.other.push(entry)
      }
    }
  } catch (err) {
    /* 取不到网卡信息不影响调用方 */
  }
  return out
}

/**
 * 推荐给队友的地址列表（按优先级排序）。
 * @param {number} port
 * @returns {string[]}
 */
export function teammateUrls(port) {
  const a = classifyAddresses()
  const urls = []
  for (const x of a.tailscale) urls.push(`http://${x.addr}:${port}`)
  for (const x of a.lan) urls.push(`http://${x.addr}:${port}`)
  return urls
}
