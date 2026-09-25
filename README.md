# dsh-team-panel

> DSH（DeepSeek Harness）的**团队 Token 面板**插件：常驻左侧边栏底部，
> 每个成员**先选定一个要监测的 DSH 项目**，插件只统计那一个项目的用量；
> 折叠时显示团队正在做的项目与全队总 Token，展开后逐人显示**他选了哪个项目**、
> 已消耗 Token 与最后消耗时间。左下角用「峰 / 谷」圆标标出 DeepSeek 当前计费时段，
> 右下角的 **⊕** 负责展开。内置一个零依赖的团队服务器，队友凭邀请码组队。

[![CI](https://github.com/guooo1380/dsh-team-panel/actions/workflows/ci.yml/badge.svg)](https://github.com/guooo1380/dsh-team-panel/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)
[![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](package.json)

---

## 特性

- **先选项目，再统计** —— 使用前必须选定一个 DSH 项目；**没选之前一个 token 都不统计**。
  选定后只统计该项目（含子目录）下会话的用量，你在别的项目里干活不会被计入、也不会被上报。
- **团队可见** —— 每个成员选了哪个项目，全队在面板上都能看到（悬停看完整本地路径）。
- **峰 / 谷实时圆标** —— 按 DeepSeek 官方峰谷计费规则判定，含周末与法定节假日，显示距下次切换的倒计时。
- **面板在你顺手的位置** —— 左侧边栏「设置」行正上方，不与右下角悬浮挂件抢位置；侧栏收起时自动隐藏。
- **零依赖团队服务器** —— 只用 Node 内置模块，邀请码加入、成员令牌鉴权、网页管理台，一条命令起服务。
- **开机自启 + 崩溃自动重启** —— 一条脚本装成 SYSTEM 后台任务，重启机器后队友无感。
- **只上报计数，不上报内容** —— 除成员名 / 项目名 / 用量数字外，其余一概不出本机。详见 [SECURITY.md](SECURITY.md)。
- **内置联网自检** —— 连通性、延迟、传输安全、端到端往返一次测完，直接告诉你卡在哪一步。

## 界面

挂在左侧边栏底部（「工作区」列表下方、「设置」行上方）：

```
┌────────────────────────────────────┐
│ 工作区                          ▾  │
│   teamplugin                       │
│   Kunlun_Cup                       │
│                                    │
│  ┌──────────────────────────────┐  │
│  │ (谷)  项目名 +2          (⊕) │  │  ← 折叠态
│  │ ● 总 Token 12.4M  ¥36.20 2/3 │  │
│  └──────────────────────────────┘  │
│  ⚙ 设置                            │
└────────────────────────────────────┘
```

展开后自上而下三块：

1. **① 选择要监测的 DSH 项目** —— 状态标签、项目下拉框、完整路径、开始监测 / 取消监测 / 清零
2. **成员列表** —— 每人两行：名字 + 消耗 Token；他监测的项目 · 最后消耗时间 · 花费
3. **② 加入团队** —— 我的 DSH 名字 / 服务器地址 / 邀请码

还没选项目时面板会换成琥珀色虚线边框并自动展开，提示你去选。
想看真实效果不用装插件：`npm run preview` 或直接用浏览器打开 `scripts/preview.html`。

## 快速开始

### 1. 装插件

要求 **Node.js >= 20**（DSH Desktop 自带 pnpm，不需要额外装依赖）。

```powershell
# 当前 GUI（DSH Desktop 界面）属于 desktop profile
dsh plugin --profile desktop add link:<本仓库的绝对路径>

# 独立 dsh web 服务器（可选）
dsh plugin --profile web add link:<本仓库的绝对路径>
```

验证**以产物为准**，别只看命令回显：

```powershell
dsh --profile desktop --dump-config | Select-String dsh-team-panel
```

然后**重启 DSH Desktop**（宿主端不会热加载），再按 `Ctrl+F5` 刷新界面。

> `link:` 安装后**不要移动本仓库目录**；真要移动，先 `remove` 再重新 `add link:<新路径>`。

### 2. 选一个要监测的项目

面板会因为「还没选项目」自动展开 → 下拉框选一个项目 → **开始监测**。

**这一步不做，就不会统计任何用量。**

### 3. 组队

服务器那台（常开机器）：

```powershell
# 装成开机自启 + 崩溃自动重启（需管理员）
scripts\install-autostart.cmd 7801
# 放行入站端口（需管理员）
scripts\allow-firewall.cmd 7801
# 查邀请码和给队友的地址
node scripts\hub-info.mjs
```

队友：DSH 面板 → ⊕ 展开 → 填「服务器地址 + 邀请码」→ 加入团队。

```powershell
# 队友连不上时，在队友那台机器上跑
node scripts\netcheck.mjs http://服务器地址:7801 <邀请码>
```

## 联网方案怎么选

> **短周期（2–6 周，用完就散）直接用 Tailscale。**
> 短周期下判断标准不是月费，而是"中途会不会被打断"——
> Tailscale 免费版（最多 6 用户、设备不限）地址**永久固定**，
> 而 Cloudflare 快速隧道的 URL 每次重启都变、官方也不给可用性保证。
> 中途换一次地址的代价，比开局每人多花 10 分钟安装大得多。

| 场景 | 推荐 |
|---|---|
| 队友在同一间办公室 | `scripts\start-hub-public.cmd`，把横幅里 `👉 队友填：` 那行抄给队友 |
| **异地、短期（≤6 周）** | **Tailscale**：每人装一次客户端，地址永久固定，免费 |
| 异地、长期 / 人多 | 公网 VPS + Caddy 自动 HTTPS（国内服务器注意 ICP 备案） |
| 临时试用、队友零安装 | Cloudflare 快速隧道（**地址会变**，别用于长期） |
| 已有域名 | Cloudflare 命名隧道 + Access（队友零安装、地址固定、真邮箱鉴权） |

**完整步骤、逐条命令、排查顺序、中国大陆特有的坑** → [docs/networking.md](docs/networking.md)

## 文档

| 文档 | 内容 |
|---|---|
| [docs/networking.md](docs/networking.md) | 联网方案详解：三条路线、Tailscale 逐步操作、排查顺序、国内注意事项 |
| [docs/architecture.md](docs/architecture.md) | 工作原理：部件、数据流、统计口径、面板挂载点、自检体系 |
| [docs/troubleshooting.md](docs/troubleshooting.md) | 常见问题：看不到面板、Token 为 0、连不上、乱码…… |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 开发环境、自检方式、**本项目特有的硬约束** |
| [SECURITY.md](SECURITY.md) | 信任模型、凭据说明、部署加固清单、漏洞报告方式 |
| [CHANGELOG.md](CHANGELOG.md) | 版本变更记录 |

## 自检

**132 项断言 / 7 个套件**，**零依赖**，克隆下来直接跑：

```powershell
node scripts\ci.mjs              # 全套（会自己起一个临时 hub 做联调）
node scripts\ci.mjs --offline    # 只跑不需要 hub 的部分
```

单独跑某一块：

| 脚本 | 手法 | 项数 |
|---|---|---|
| `scripts/entrycheck.mjs` | 真的 import 一次各模块 | 17 |
| `scripts/mounttest.mjs` | 仿 DOM 跑真实 `panel.js`，验证锚点与窄栏隐藏 | 16 |
| `scripts/selftest.mjs` | 峰谷边界 / 周末 / 法定节假日 + hub 全部接口与鉴权 | 38 |
| `scripts/plugintest.mjs` | mock ctx 拉起真实 `lib/index.js` + 真 hub 联调 | 61 |

插件还提供一个运行时自检接口：`http://127.0.0.1:43120/dsh-team/ping`。

## 隐私

**上报的只有计数**：成员名、机器名、项目名与路径、Token 数、估算花费、最后消耗时间。

**绝不上报**：提示词、模型回复、文件内容、会话标题、代码、任何凭据。

本机状态落在 `%DSH_HOME%/team-panel/state.json` —— **该文件含成员令牌（等同密码），不要提交或分享。**

详见 [SECURITY.md](SECURITY.md)。

## 目录结构

```
dsh-team-panel/
├─ lib/
│  ├─ index.js            宿主端插件：token 采集、/dsh-team/* 路由、团队同步、界面注入
│  ├─ panel.js            注入浏览器的面板脚本（纯 JS，零依赖，无需构建）
│  ├─ peak.mjs            峰谷时段判定（唯一真源，含法定节假日表）
│  ├─ net-addresses.mjs   本机 IPv4 分类（局域网 / Tailscale / 其它，剔除虚拟网卡）
│  └─ team-hub.mjs        团队服务器（零依赖）
├─ scripts/
│  ├─ ci.mjs              全量自检入口（本地与 CI 共用）
│  ├─ entrycheck.mjs      入口冒烟测试
│  ├─ mounttest.mjs       挂载逻辑自检（仿 DOM）
│  ├─ selftest.mjs        峰谷 + hub API 自检
│  ├─ plugintest.mjs      宿主端插件自检
│  ├─ hub-info.mjs        服务器信息速查（邀请码 / 管理密钥 / 推荐地址）
│  ├─ netcheck.mjs        联网连通性自检
│  ├─ set-repo.mjs        回填仓库地址（替换 OWNER 占位符）
│  ├─ serve-preview.mjs   本地静态预览服务
│  ├─ preview.html        离线预览页
│  ├─ start-hub.cmd       启动 hub：本机模式
│  ├─ start-hub-public.cmd  启动 hub：对外监听
│  ├─ install-autostart.cmd  装成开机自启（需管理员）
│  ├─ uninstall-autostart.cmd  卸载自启
│  └─ allow-firewall.cmd  放行入站端口（需管理员）
├─ docs/                  联网方案 / 工作原理 / 常见问题
├─ cordis.patch.yml       bundle patch：把插件挂进 profile 配置树
└─ package.json
```

> `.cmd` 脚本一律**纯 ASCII + CRLF** —— 这不是风格偏好，是踩过的坑：
> `cmd.exe` 按控制台代码页解析批处理，UTF-8 中文会让整行命令读崩。
> 中文提示统一由 Node 输出。详见 [CONTRIBUTING.md](CONTRIBUTING.md#1-cmd-文件只能是-ascii且必须-crlf)。

## 许可

[MIT](LICENSE)
