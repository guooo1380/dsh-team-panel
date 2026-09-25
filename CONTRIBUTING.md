# 贡献指南

感谢你愿意改进 dsh-team-panel。本文档说明开发环境、自检方式，以及几条**这个项目特有的硬约束**。

## 环境

- Node.js **>= 20**（用到内置 `fetch`、`AbortController`）
- **零运行时依赖**：请不要引入 npm 依赖。`lib/` 与 `scripts/` 只用 Node 内置模块。
- 不需要构建步骤：`lib/panel.js` 是直接注入浏览器的纯脚本，改完刷新页面即可生效。

```powershell
git clone <repo>
cd dsh-team-panel
node scripts/ci.mjs        # 跑全部自检，不需要装任何依赖
```

## 自检

本项目有 132 项自检，**提交前必须全绿**。

```powershell
node scripts/ci.mjs                  # 全套（含起一个临时 hub 做联调），推荐
node scripts/ci.mjs --offline        # 只跑不需要 hub 的部分
```

单独跑某一块：

| 脚本 | 覆盖范围 | 项数 |
|---|---|---|
| `scripts/entrycheck.mjs` | 各模块能否真的被 import / 执行 | 17 |
| `scripts/mounttest.mjs` | 用仿 DOM 跑真实 `panel.js`，验证锚点、插入顺序、窄栏隐藏 | 16 |
| `scripts/selftest.mjs` | 峰谷判定（边界 / 周末 / 法定节假日）+ hub API | 38 |
| `scripts/plugintest.mjs` | 宿主端插件（mock ctx）+ 真实 hub 联调 | 61 |

**加新功能时请同步加自检**——这个项目没有人工回归流程，全靠这些脚本。
新增自检请写进上面某个既有脚本，并同步更新本节与 README 里的项数。

## 这个项目的硬约束

这几条都是踩过坑总结出来的，**请勿为了方便而违反**：

### 1. `.cmd` 文件只能是 ASCII，且必须 CRLF

`cmd.exe` 按**控制台代码页**逐行解析批处理文件。本机代码页是 GBK，而文件是 UTF-8，
中文会被当成乱码字节，其中某些字节恰好是 `&` `|` `>` —— 整行命令被读崩。最小复现：

```bat
@echo off
echo 中文输出探测      <-- 报错: 'cho' is not recognized as an internal or external command
```

所以：**中文提示一律交给 Node 脚本输出**，`.cmd` 里先 `chcp 65001 >nul` 再启动 Node。
行尾必须是 CRLF（`.gitattributes` 已强制），裸 LF 会让 `goto`、标签、`if (...)` 块解析出错。

### 2. `lib/panel.js` 不引入模块系统

它是通过 `<script defer src="/dsh-team/panel.js">` 注入的**普通浏览器脚本**：

- 不能出现 `import` / `export`（自检会检查）
- 不能用构建期语法（保持 ES2017 级别即可，避免可选链等新语法）
- 所有中文来自这个文件时是安全的（浏览器按 UTF-8 解析），编码约束只针对 `.cmd`

### 3. 面板的挂载锚点不要换成 class 名

锚点是 `[data-slot="sidebar.settings"]` —— 由 `ui-renderer` 为每个槽位渲染的
`<div data-slot="…" style="display:contents">`，**与构建哈希无关**，改版也不会失效。

不要改用 `.footArea` 这类 CSS Modules 哈希类名（形如 `EXfQ3q_footArea`），它们每次构建都会变。
另外注意该锚点 `display:contents` 没有布局盒，`getBoundingClientRect()` 恒为 0，
**要量宽度必须量它的父级真实 div**（`mounttest.mjs` 覆盖了这一点）。

### 4. 统计口径不能绕过"先选项目"

`handleSessionEvent()` 里有两条必须保留的早退：

```js
if (!STATE.selectedProject) return                              // 没选项目 → 不统计
if (!underProject(cwd, STATE.selectedProject.path)) return       // 不属于所选项目 → 不统计
```

这是产品的核心承诺（只监测单一项目），不要在重构中"顺手"改成全量统计。

### 5. Token 口径：`outputTokens` 已含 reasoning

```js
output: num(usage.outputTokens)   // 不要再单独加 reasoningTokens，否则输出侧重复计费
```

## 本地联调插件

```powershell
# 装进 profile（插件源码目录必须 ASCII 且之后不要移动）
dsh plugin --profile desktop add link:<本目录绝对路径>
dsh --profile desktop --dump-config | Select-String 'dsh-team-panel'   # 以产物为准验证
```

**装完必须重启 DSH Desktop**（宿主端不会热加载），再 `Ctrl+F5` 刷新前端。

改 `lib/panel.js` **不需要重启**（宿主端每次请求现读磁盘），刷新浏览器即可；
改 `lib/index.js` 需要重启。

## 提交规范

采用 [约定式提交](https://www.conventionalcommits.org/zh-hans/)：

```
feat: 支持按成员查看所选项目
fix: 修复 .cmd 裸 LF 导致 goto 解析失败
docs: 补充 Tailscale 短周期建议
test: 补 3 项未选项目时的聚合断言
refactor: 抽出 net-addresses.mjs 共用
```

- 一个 PR 只做一件事；大改动请先开 Issue 讨论
- 变更请同步更新 `CHANGELOG.md` 的 `[Unreleased]` 段
- 安全相关改动请阅读 `SECURITY.md`，不要在公开 Issue 里讨论细节

## PR 检查清单

- [ ] `node scripts/ci.mjs` 全绿
- [ ] 新增行为已补自检，并更新了项数说明
- [ ] `CHANGELOG.md` 已更新
- [ ] 若改了 `.cmd`：确认仍是纯 ASCII + CRLF
- [ ] 若改了统计口径：确认核心承诺（先选项目、只统计单一项目）未被破坏
- [ ] 未提交 `data/`、`team-hub-data.json` 或任何令牌
