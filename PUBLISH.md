# 发布指南

> 适用于 `@panpan2026/opencode-pty` 0.4.0+

## 发布前检查

> 纯 bug 修复 / 内部重构 / 中间 commit 不需要改文档。**只在改 API / 架构 / 工作流时才动**。

### `README.md` — 用户面对

更新场景:
- 工具签名/参数变了
- 新增/删除了 `pty_*` 工具
- Web UI 行为变化
- 新增/修改了环境变量
- fork notice 顶部块里的版本号

### `AGENTS.md` — 后续 session 面对

更新场景:
- 新增/删除了 npm script
- 构建/测试/lint 命令变了
- 架构边界变了 (新加一层、新换依赖、入口文件移动)
- 新增了开发者需要知道的约定 (e.g. Windows PATHEXT、prepack 行为、CI 触发条件)
- 工作流结构变化 (CI 矩阵、新增 workflow)

> 本 fork **没有** `CHANGELOG.md` — release notes 由 `release.yml` 自动从 git log 生成,commit message 写清楚就够了。

---

## 两种场景

### 1. 跑 CI 验证 (不发版)

```bash
git commit ...
git push origin main
```

- `ci.yml` 跑 (lint + test + build)
- `release.yml` 也会触发,但检测到 `package.json` 版本没变 → **自动跳过 publish**
- 不会发到 npm,不会创建 GitHub Release

适合: 普通 commit、PR 验证、修 bug 累积等中间态。

### 2. 发新版

```bash
# 1. 确保本地全部通过
bun run typecheck && bun run lint && bun run format && bun run unittest

# 2. 版本号 + 推送
npm version patch   # 或 minor / major
git push origin main
```

`npm version` 自动: 改 `package.json` + `git commit` + `git tag vX.Y.Z`。

- `ci.yml` 跑
- `release.yml` 先跑**质量门禁** (typecheck + lint + format + unittest)，全部通过后才继续:
  - `bun build:prod`
  - `npm publish --access public --provenance`
  - `gh release create vX.Y.Z` (含自动 changelog)
- CI / release.yml 任一环节失败 → 不发版

## `npm version` 选择

| 命令 | 变化 | 用途 |
|---|---|---|
| `npm version patch` | 0.4.0 → 0.4.1 | bug 修复 |
| `npm version minor` | 0.4.0 → 0.5.0 | 新功能 |
| `npm version major` | 0.4.0 → 1.0.0 | 破坏性变更 |

## 跳过 / 重新发布的边界

- CI 失败 → `release.yml` 不触发 (依赖 `workflow_run` 成功完成)
- 版本没变 → 跳过 publish,但 `release.yml` 本身仍会跑
- tag 已存在 → 跳过 publish (避免重复发)
- 手动 `workflow_dispatch` 也会受 "版本没变" 检查约束

## 前置条件 (一次性)

1. **npm Automation token**: https://www.npmjs.com/settings/panpan2026/tokens
   - Type: **Automation** (只能 publish,不能改账号)
2. **GitHub secret**: https://github.com/pan17/opencode-pty/settings/secrets/actions/new
   - Name: `NPM_TOKEN`
   - Value: 上面的 token

## 故障排查

| 现象 | 原因 | 修复 |
|---|---|---|
| `npm publish` 401 Unauthorized | `NPM_TOKEN` 没配 / 名字错 | 重配 secret,确认名字是 `NPM_TOKEN` |
| `npm publish` 403 Forbidden | token 没 Automation 权限 / package 权限错 | 重新生成 token;到 npm 包 settings 把 `panpan2026` 加为 maintainer |
| release.yml 跑了但没 publish | 版本没变 (正常) 或 tag 已存在 (正常) | 想要发版就 `npm version patch` 再 push |
| 推送后 release.yml 完全没触发 | CI 失败 | 查 `ci.yml` 日志修测试/lint/build |
