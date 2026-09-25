# 工作原理

## 三个部件

```
┌─ 每个队友的电脑 ────────────────────────────────┐
│                                                 │
│  DSH Desktop / DSH Web                          │
│   ├─ lib/index.js     宿主端插件                 │
│   │    · 监听 session/event 抓真实 usage         │
│   │    · 只统计「选中的那一个项目」               │
│   │    · 暴露 /dsh-team/* 路由                   │
│   │    · 定时把用量上报给 hub、把全队快照拉回来    │
│   └─ lib/panel.js     注入浏览器的小面板          │
│        · 通过同源 /dsh-team/* 读写本机宿主        │
│        · 挂在左侧栏底部                          │
└─────────────────────────────────────────────────┘
                    │  http(s)
                    ▼
        ┌─ 团队服务器 lib/team-hub.mjs ─┐
        │  零依赖，只用 Node 内置模块     │
        │  · 团队 / 邀请码 / 成员令牌     │
        │  · 汇总各成员上报的用量          │
        │  · 网页管理台（管理密钥）        │
        └───────────────────────────────┘
```

**为什么前端要绕一圈走本机宿主，而不是直接连 hub？**

因为面板脚本与宿主是**同源**的（都在 `127.0.0.1:43120`），所以：

- 浏览器不需要处理 CORS
- 团队服务器只有 http、或浏览器有混合内容限制（https 页面调 http 接口）时，**都不影响面板工作**
- 成员令牌**只存在于宿主侧**，不会进入浏览器

代价是宿主端多了一次转发，但这在本机是微秒级的。

## 数据流

**采集（本机 → 本地账本）**

```
DSH 会话跑一轮
  → ctx.on('session/event', (session, event))
  → event.type === 'assistant/message' 且带 usage
  → 取 session.header.cwd，判断是否属于「选中项目」
  → 累加 tokens / cost / lastUsedAt 到 usage.byProject[选中项目]
  → 防抖 300ms 落盘到 %DSH_HOME%/team-panel/state.json
```

**上报 / 拉取（本地账本 ↔ hub）**

```
每轮对话结束   → 防抖 1.5s 上报一次
每 20 秒心跳   → 上报 + 拉快照（保持"在线"状态）
面板轮询 state → 展开时 3s / 折叠时 8s（宿主侧快照有 2s TTL，不会打爆 hub）
```

## 统计口径（最重要的部分）

### 先选项目，再统计

```
未选择项目           → handleSessionEvent 直接 return，一个 token 都不统计
已选择项目 A         → 只有 cwd 属于 A（含子目录）的会话才计入
切到项目 B           → B 从 0 开始；A 的账本保留但不再上报/显示
```

会话的项目归属取自 **DSH 会话头里的 `cwd`**，与左侧栏「工作区」是同一个来源。

### Token 计算

| 项 | 取值 |
|---|---|
| 未命中输入 | `usage.inputTokens` |
| 缓存 | `usage.cacheReadTokens + usage.cacheWriteTokens` |
| 输出 | `usage.outputTokens` |
| 合计 | 三者相加 |

> ⚠️ **`outputTokens` 已包含 reasoning token**，不要再单独累加 `reasoningTokens`，
> 否则输出侧会被重复计费（实测偏高约一倍）。

### 花费估算

按官方价目表（元 / 百万 token），索引 0 = 空闲(谷)、1 = 高峰(峰)：

| 模型 | 缓存命中 | 未命中输入 | 输出 |
|---|---|---|---|
| `deepseek-flash` | 0.02 / 0.04 | 1 / 2 | 4 / 8 |
| `deepseek-v4-pro` | 0.15 / 0.30 | 4.5 / 9.0 | 13.5 / 27.0 |

来源：<https://api-docs.deepseek.com/zh-cn/quick_start/pricing>

### 峰谷判定

```
高峰（峰）= 北京时间 周一~周五 且 非法定节假日 且 (9:00–12:00 或 14:00–18:00)
空闲（谷）= 其余全部时间（含周末、法定节假日全天、工作日的其它时段）
```

实现在 `lib/peak.mjs`，**宿主端与前端共用这一份**（前端通过 `/dsh-team/state` 拿到快照，
不自己维护日历）。

> ⚠️ **每年 11 月国务院公布次年放假安排后，需要往 `HOLIDAY_VALLEY` 里补下一年的日期。**

## 面板挂载点

面板插在**左侧边栏底部的「设置」行正上方**：

```
侧边栏 root (flex column)
  ├─ logoRow
  ├─ 新会话按钮
  ├─ nav.panelList（全局面板）
  ├─ div.regionArea（「工作区」列表，flex:1）
  └─ div.footArea (flex:none)
       ├─ div.footerActions ← [data-slot="sidebar.footer.action"]
       ├─ ★ 本插件插在这里
       └─ div.settingsArea  ← [data-slot="sidebar.settings"]  ←「设置」行
```

锚点是 `[data-slot="sidebar.settings"]` —— 由 `ui-renderer` 为每个槽位渲染的
`<div data-slot="…" style="display:contents">`，**与构建哈希无关**，DSH 改版也不会失效。

两个容易踩的点：

- 不要改用 `.footArea` 这类 CSS Modules 哈希类名（形如 `EXfQ3q_footArea`），每次构建都会变
- 该锚点 `display:contents` **没有布局盒**，`getBoundingClientRect()` 恒为 0；
  **量宽度必须量它的父级真实 div**（用来判断侧栏是否收起成 56px 图标轨）

`mount()` 每 700ms 跑一次做幂等校正：React 重渲染把节点挪走就搬回来，重复挂载不会产生多个面板。

## 团队服务器的数据模型

```jsonc
{
  "version": 1,
  "teams": {
    "<teamId>": {
      "id": "...", "name": "我的团队",
      "inviteCode": "H8JEY3S3",     // 8 位，去掉易混淆字符
      "adminKey": "...",            // 管理页面用
      "members": {
        "<memberId>": {
          "name": "小明的 DSH",
          "machine": "PC-A",
          "monitoring": true,
          "project": "teamplugin",
          "projectPath": "D:\\Project\\...",
          "tokenHash": "<sha256>",  // 成员令牌只存哈希
          "tokens": 1200000, "cost": 3.5,
          "lastUsedAt": 0, "lastReportAt": 0
        }
      }
    }
  }
}
```

- 成员令牌以 **sha256** 存储，用 `timingSafeEqual` 常量时间比对
- 「在线」的判定：`lastReportAt` 在 70 秒内（插件每 20 秒心跳一次）
- 项目聚合按**项目名**合并 —— 同一项目在不同机器、不同路径下会被合成一条

## 自检体系

这个项目没有人工回归流程，全靠 132 项断言（7 个套件）兜底。分四层：

| 脚本 | 手法 | 覆盖 |
|---|---|---|
| `entrycheck.mjs` | **真的 import 一次**各模块 | 入口能不能被宿主加载、接口是否齐全 |
| `mounttest.mjs` | **仿 DOM 跑真实 `panel.js`** | 锚点位置、插入顺序、幂等、窄栏隐藏 |
| `selftest.mjs` | 纯函数 + 起真 hub 打 HTTP | 峰谷边界/节假日、hub 全部接口与鉴权 |
| `plugintest.mjs` | **mock ctx 拉起真实 `lib/index.js`** | 路由、注入、统计口径、鉴权、与真 hub 联调 |

`scripts/ci.mjs` 把四层串起来，并**自己起一个临时 hub** 完成联调 —— 之所以不写在 CI 的 shell 里，
是为了让本地和 CI（Windows/Linux/macOS）跑的是同一份逻辑，不依赖 bash 的 `&` / `$!` / `seq`。
