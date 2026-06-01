# Code Review Gate

> 不信任驱动的代码审查：**每一行都必须被看过**。把 "Review = 不信任" 做成硬门禁——逐行覆盖 + 文件级 AI 分析 + 跨文件全局分析，四个维度都完成才允许给出结论。

## 设计原则

- **逐行覆盖是真实的**：用 VS Code 真实编辑器 + 可见区域追踪（`visibleRanges`）判断 "眼睛真的扫过"，不是假滚动。
- **原生优先**：左侧改动文件树用原生 `TreeView`，行覆盖/AI 提醒用 `TextEditorDecorationType` 与诊断，状态用 `StatusBar`。仅"全局逻辑分析报告"这一块富文本用 Webview。
- **模型可选**：通过 VS Code Language Model API 列出当前 Copilot 授权的模型，支持 `Auto`。
- **数据来自真实 PR**：通过 GitHub CLI（`gh`）拉取当前分支 PR 的元数据与 diff，复用用户已有的 `gh auth`。

## 架构分层

```
src/
  extension.ts          激活入口、命令注册
  gh/                   GitHub CLI 封装（auth / pr view / pr diff）
  review/               审查会话模型 + 持久化（ReviewStore 抽象）
  ai/                   模型选择 + 文件级/全局 LLM 分析（后续切片）
  ui/                   原生 UI：TreeView / 装饰 / 状态栏 / 全局报告 Webview
```

## 持久化

- 当前：`workspaceState`（本机，按 `repo + PR# + headSha` 存）。
- 注意：`workspaceState` **不跟随 GitHub 账号、不跨设备**。
- 跨设备能力通过 `ReviewStore` 接口预留，将来由远端实现（服务端或 PR 隐藏 comment）提供。
- 进度绑定 `headSha`：作者一旦 push 新 commit，旧覆盖率应失效。

## 开发

```bash
npm install
npm run compile      # 或 npm run watch
# 按 F5 启动扩展开发宿主
```

需要本机已安装并登录 GitHub CLI：`gh auth login`。

## 状态

切片 1（当前）：激活 + gh 拉取 PR 改动文件 + 原生 TreeView + 模型选择。
后续：逐行覆盖装饰、文件级 AI 分析、全局分析报告、门禁与结论提交。
