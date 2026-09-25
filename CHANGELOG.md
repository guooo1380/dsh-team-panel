# Changelog

本文件记录本项目的所有重要变更。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.2.0] - 2026-09-25

### 新增

- **项目选择**：使用前必须先选定一个要监测的 DSH 项目，选项来自 DSH 的工作区注册表
  （`ctx.workspaceRegistry`），与左侧栏「工作区」同源；也支持手动填写目录路径兜底。
- **单选统计口径**：只统计所选项目（含其子目录）下会话产生的用量；其他项目一律不计、不上报。
- **团队可见**：团队页面上每个成员那一行显示他正在监测的项目名，悬停可看完整本地路径。
- **清零 / 取消监测**：可重置当前项目账本，或临时停止统计。
- 内置零依赖团队服务器（`lib/team-hub.mjs`）：邀请码加入、成员令牌（sha256 存储 + 常量时间比对）、
  网页管理台、成员在线状态。
- 联网工具链：
  - `scripts/hub-info.mjs` —— 后台任务没有控制台时的信息入口（邀请码 / 管理密钥 / 推荐地址）
  - `scripts/netcheck.mjs` —— 连通性自检（可达性 / 延迟 / 传输安全 / 加入→上报→退出往返）
  - `scripts/install-autostart.cmd` —— 装成开机自启 + 崩溃自动重启的计划任务
  - `scripts/allow-firewall.cmd` —— 放行入站端口
- 离线预览页 `scripts/preview.html`，不用重启 DSH 即可查看面板效果。
- 深色模式自适应；侧栏收起成图标轨（约 56px）时面板自动隐藏。

### 变更

- **面板挂载点从对话区底部移到左侧边栏底部**（「设置」行正上方），
  避免与右下角悬浮类插件（如小鲸鱼余额挂件）抢位置。
- 窄栏（264–420px）改用两行式成员列表，替代原来的表格布局。
- 入口由 `lib/index.js` 统一，`VERSION` 与 `package.json` 对齐。

### 修复

- **`.cmd` 脚本改为纯 ASCII**：cmd.exe 按控制台代码页解析批处理，UTF-8 中文会被当乱码字节，
  其中可能含 `&` `|` `>` 等控制字符，导致整行命令被读崩。中文提示改由 Node 输出。
- **`.cmd` 行尾改为 CRLF**：原先为裸 LF，会让 `goto`、标签与 `if (...)` 块解析出错。
- 修复 `os.networkInterfaces()` 的网卡名读取（名字是返回对象的 key，不是条目属性），
  并剔除 WSL / Hyper-V / VMware 等虚拟网卡，避免把连不上的地址推荐给队友。
- 修复「未选项目的成员会在项目聚合里凭空造出一个『未命名项目』条目」。
- 修复加入团队后首次上报为异步、短暂读到空快照的问题。

## [0.1.0] - 2026-09-25

### 新增

- 首个可用版本：侧栏底部常驻面板、折叠显示项目名与全队总 Token、展开显示成员用量与最后消耗时间、
  左下角峰/谷圆标（按 DeepSeek 官方峰谷计费规则判定，含法定节假日表）、右下角 ⊕ 展开。
- 宿主端通过 `ctx.on('session/event')` 采集真实 usage，按官方价目表估算人民币花费。
- 零依赖团队服务器与邀请码组队。

[Unreleased]: https://github.com/guooo1380/dsh-team-panel/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/guooo1380/dsh-team-panel/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/guooo1380/dsh-team-panel/releases/tag/v0.1.0
