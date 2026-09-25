# 联网方案：让异地队友连上团队服务器

> 插件自己**不解决连通性**。它只有一个要求：
> **所有队友的电脑都能访问到同一个地址**（就是面板里填的「团队服务器地址」）。
> 本文说明怎么满足这个要求，以及不同使用周期该怎么选。

## 目录

- [先决定：这个团队要用多久](#先决定这个团队要用多久)
- [路线 ①：Tailscale 虚拟局域网（推荐）](#路线--tailscale-虚拟局域网推荐)
- [路线 ②：公网 VPS + HTTPS](#路线--公网-vps--https)
- [路线 ③：Cloudflare 隧道](#路线--cloudflare-隧道)
- [连不上时的排查顺序](#连不上时的排查顺序)
- [中国大陆特有的坑](#中国大陆特有的坑)
- [为什么不用其它方案](#为什么不用其它方案)

---

## 先决定：这个团队要用多久

这一步比"哪个方案更好"重要得多，因为**短周期和长周期的答案不一样**。

### 短期（2–6 周，用完就散）→ 直接用 Tailscale，别折腾

短周期下判断标准不是月费，而是**"中途会不会被打断"**：

| 方案 | 队友安装 | 中途会断吗 | 4 周成本 | 结论 |
|---|---|---|---|---|
| **Tailscale** | 装一次，约 10 分钟 | **不会**（地址永久固定） | **0**（免费版最多 6 用户，设备不限） | ✅ **推荐** |
| Cloudflare 快速隧道 | 零 | **会**（URL 每次重启都变，官方无可用性保证） | 0 | ⚠️ 只适合"今天就要能用" |
| 境外 VPS + Caddy | 零 | 不会 | 一台月费 | 不如 Tailscale，除非你已有 VPS |
| 国内 VPS + ICP 备案 | 零 | 不会 | **备案周期比项目还长** | ❌ 排除 |
| 托管 BaaS（Supabase 等） | 零 | 不会 | 0 | ❌ 要改插件代码，短周期不值 |

**核心权衡**：项目只有 4 周时，**中途换一次地址的代价，比开局每人多花 10 分钟安装大得多**。
Tailscale 的地址是永久的，Cloudflare 快速隧道的地址是会变的——这就是分水岭。

> 如果你**已经有域名**，"Cloudflare 命名隧道 + Cloudflare Access"会比 Tailscale 更好：
> 队友零安装、地址固定，而且 Access 能做真正的邮箱鉴权（比 8 位邀请码更稳）。

### 长期（持续使用 / 人多 / 要随时在线）→ 公网 VPS + HTTPS

见[路线 ②](#路线--公网-vps--https)。稳定、队友零安装、不依赖任何人的电脑常开。

---

## 路线 ①：Tailscale 虚拟局域网（推荐）

原理：Tailscale 把所有机器组成一个加密虚拟局域网（基于 WireGuard）。**不需要端口映射、
不需要公网 IP、不用改路由器**，流量也不经过第三方明文转发。

### 服务器那台（常开的机器）

```powershell
# 1) 装 Tailscale 并登录：https://tailscale.com/download/windows
#    装完在托盘图标里能看到本机的 100.x.x.x 地址

# 2) 装成开机自启 + 崩溃自动重启的后台任务（只做一次，需管理员）
scripts\install-autostart.cmd 7801

# 3) 放行入站端口（只做一次，需管理员）
scripts\allow-firewall.cmd 7801

# 4) 查邀请码和给队友的地址
node scripts\hub-info.mjs
```

第 2 步会生成一个启动器，把 **node 的绝对路径写死进去** —— 因为计划任务以 SYSTEM 身份运行，
而 **SYSTEM 的 PATH 里没有你用户环境装的 node**，直接用 `node` 会启动失败。

第 4 步是这个方案的关键：装了自启之后 hub 在后台跑，**没有控制台可以看横幅**，
`hub-info.mjs` 就是唯一的邀请码入口。它的输出长这样：

```
  运行状态    ✅ 正在运行（127.0.0.1:7801，31ms）
  团队名称    我的团队

  ┌────────────────────────────────────────────────┐
  │  邀请码（发给队友）：  H8JEY3S3                 │
  └────────────────────────────────────────────────┘

  ── 队友「团队服务器地址」可以填 ──────────────────
   👉 http://100.101.102.103:7801         Tailscale（Tailscale）
      http://10.51.3.25:7801              局域网（以太网）
   另外还有（多半是虚拟网卡，队友连不上，仅供参考）：172.18.160.1(vEthernet (WSL))
```

**优先用 `100.x.x.x` 那行**（Tailscale 地址），它的可达性不受队友在哪个网络影响。

### 每个队友（含你自己）

1. 装 Tailscale，登录**同一个账号 / 同一个 Tailnet**
2. DSH 面板：侧栏底部 → ⊕ 展开 → 填「服务器地址 + 邀请码」→ **加入团队**
3. 连不上就自检：
   ```powershell
   node scripts\netcheck.mjs http://100.x.x.x:7801 <邀请码>
   ```

> 免费版额度：**最多 6 个用户、用户设备不限**（见 [Tailscale 定价](https://tailscale.com/pricing)）。
> 超过 6 人需要付费方案，或者所有人共用同一个账号登录（可行但不推荐）。
>
> 服务器那台务必**常开**，否则队友看到的一直是离线。

### 兜底：有人死活装不上 Tailscale

两个方案**可以同时开，互不冲突** —— hub 不关心请求是从 Tailscale 进来还是从隧道进来：

```powershell
# 服务器上额外开一个隧道，只给那一个人用
cloudflared tunnel --url http://127.0.0.1:7801
```

把这一个 `https://xxx.trycloudflare.com` 单独发给他即可。代价只是他那边地址可能会变，
不影响其他走 Tailscale 的人。

---

## 路线 ②：公网 VPS + HTTPS

适合长期使用、人数较多、或者不想依赖"某台个人电脑常开"的场景。

```bash
# VPS 上（Linux 也能跑，只需要 Node >= 20，零依赖）
node lib/team-hub.mjs --public --port 7801 --data /var/lib/dsh-team/team-hub-data.json
```

再套一层 Caddy（自动申请并续期 HTTPS 证书，两行配置）：

```
team.example.com {
    reverse_proxy 127.0.0.1:7801
}
```

安全组 / 防火墙放行 **80、443**（7801 不必对外开放，交给 Caddy 反代即可）。
队友填 `https://team.example.com`。

> **中国大陆的服务器**：对公网开放 80/443 需要 ICP 备案，周期可能比你的项目还长。
> 要么用境外 VPS（无需备案），要么走路线 ①/③。

---

## 路线 ③：Cloudflare 隧道

### 快速隧道（临时/试用，零注册）

```powershell
# 1) 本机起 hub（默认只监听 127.0.0.1 就够了，隧道从本机出去）
scripts\start-hub.cmd

# 2) 另开一个窗口
cloudflared tunnel --url http://127.0.0.1:7801
```

把打印出来的 `https://xxxx.trycloudflare.com` 给队友。

`cloudflared` 本机若未安装：去 <https://github.com/cloudflare/cloudflared/releases>
下 `cloudflared-windows-amd64.exe`，改名 `cloudflared.exe` 丢进 PATH 即可。

> ⚠️ **快速隧道是给测试用的**：域名每次重启都会变，且[官方不提供可用性保证](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)。
> 一变就得让所有队友重新填地址。**不适合长于一两周的项目**。

### 命名隧道（地址固定，推荐）

需要 Cloudflare 账号 + 一个自己的域名（都免费，域名本身要钱）：

```powershell
cloudflared tunnel login
cloudflared tunnel create dsh-team
cloudflared tunnel route dns dsh-team team.example.com
cloudflared tunnel run --url http://127.0.0.1:7801 dsh-team
```

配合 [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/)
可以限制只有指定邮箱能访问——这比 8 位邀请码强得多。

---

## 连不上时的排查顺序

**在队友那台机器上**跑连通性自检，它会把问题定位到具体一步：

```powershell
node scripts\netcheck.mjs http://服务器地址:7801 <邀请码>
```

自检报「连不上」时，按它列出的顺序查（也是实际最常见的顺序）：

1. **hub 只监听了 127.0.0.1**（最常见）
   → 用 `scripts\start-hub-public.cmd`（等价于 `--public`，监听 `0.0.0.0`）
2. **Windows 防火墙没放行入站端口**（第二常见）
   → 服务器那台跑 `scripts\allow-firewall.cmd 7801`（**需要管理员**）
3. **两台机器不在同一个网络**（局域网 / Tailscale 网络）
4. **端口写错**（默认 7801）
5. **跨公网**：域名解析、云安全组、反向代理是否转发到 7801

全部通过后，自检会打印 `这个地址从本机可用 ✅`。

**安全检查**：自检还会判断传输是否安全 —— 目标是私网/Tailscale 地址时明文 HTTP 可以接受
（链路本身已加密或不出公网）；目标是公网 IP 且用 `http://` 时会给出警告，
此时请改用 HTTPS 或走隧道。

---

## 中国大陆特有的坑

1. **家宽基本没有公网 IPv4**（运营商 NAT444）。打客服申请多半不给。
   IPv6 多数地区有，但队友也得有 IPv6 才能互访。
2. **国内云服务器对公网开放 80/443 需要 ICP 备案**，未备案会被拦截。
   用 7801 这类非标端口跑自建服务在实践中很常见，但云厂商可能按规则处理——
   这也是很多人宁可走隧道/组网的原因。
3. **Tailscale 的协调服务器在境外**，国内访问偶尔不稳（连上之后数据是 P2P 的，影响不大）。
   真在意就自建 [headscale](https://github.com/juanfont/headscale)，或改用 ZeroTier / 国内商业组网
   （蒲公英、花生壳）。
4. **公司网络可能有出站限制 / 深度包检测**，隧道类方案在严格管控的网络里可能被拦。
   这种情况虚拟组网（Tailscale/ZeroTier）通常比裸隧道更抗干扰。

---

## 为什么不用其它方案

| 方案 | 为什么在本项目里不选 |
|---|---|
| **对象存储 / 网盘同步 json** | 不是实时；并发写会互相覆盖。只适合"看个总量"的弱需求 |
| **BaaS（Supabase / Firebase）** | 要注册账号、填 API Key，而且**要把插件的同步层整体改写成直接调这些 API** |
| **MQTT / Redis pub-sub** | 适合推送，但"拉全队快照"这种查询还得另建一套；短周期不划算 |
| **P2P 打洞（WebRTC / libp2p）** | 面向浏览器之间直连，不适合"常驻服务 + 客户端轮询"这个形态 |
| **frp / nps 自建** | 本质上就是路线 ②，但要额外维护一个入口服务器，不如直接用 VPS + Caddy |
| **DDNS + 端口映射** | 前提是有公网 IP；且把服务直接暴露在公网，没有隧道/组网那样的一层隔离 |
