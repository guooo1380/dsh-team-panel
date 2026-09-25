## 这个 PR 做了什么

<!-- 一句话说明；关联的 Issue 用 "Closes #123" -->

## 类型

- [ ] 修复 bug
- [ ] 新功能
- [ ] 重构（不改变行为）
- [ ] 文档
- [ ] 自检 / 工程化

## 检查清单

- [ ] `node scripts/ci.mjs` 全绿
- [ ] 新增行为**已补自检**，并更新了 README / CONTRIBUTING 里的项数说明
- [ ] `CHANGELOG.md` 的 `[Unreleased]` 段已更新
- [ ] 若改了 `.cmd`：确认仍是**纯 ASCII + CRLF**
- [ ] 若改了统计口径：确认核心承诺（**先选项目、只统计单一项目**）未被破坏
- [ ] 未提交 `data/`、`team-hub-data.json` 或任何令牌
- [ ] 若改了面板挂载点：确认仍锚定 `[data-slot="sidebar.settings"]`，没有改用哈希类名

## 怎么验证的

<!-- 贴关键的自检输出，或说明你手工验证的步骤与结果 -->

```
node scripts/ci.mjs
...
6/6 个套件通过
```
