# Code Review Gate

> 不信任驱动的代码审查：**每一行都必须被看过**。把 “Review = 不信任” 做成硬门禁——逐行通读 + 文件级 AI 分析 + 逐条处置每个问题 + 跨文件全局分析，全部完成才允许给出审查结论。

[![VS Marketplace Version](https://img.shields.io/visual-studio-marketplace/v/codereview-dev.codereview?label=Marketplace&color=blue)](https://marketplace.visualstudio.com/items?itemName=codereview-dev.codereview)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/codereview-dev.codereview)](https://marketplace.visualstudio.com/items?itemName=codereview-dev.codereview)
[![Rating](https://img.shields.io/visual-studio-marketplace/r/codereview-dev.codereview)](https://marketplace.visualstudio.com/items?itemName=codereview-dev.codereview)

VS Code 扩展 · 由 GitHub CLI 与 Copilot 模型驱动

[English](README.md) | 简体中文

<img src="https://raw.githubusercontent.com/changjian-wang/codereview/main/docs/images/workbench-zh.png" width="820" alt="代码审查工作台" />

## 核心理念

- **审查即不信任**：默认作者会犯错，门禁不通过就不允许下结论。
- **逐行覆盖是真实的**：基于 VS Code 真实编辑器 + 可见区域追踪（`visibleRanges`）判断「眼睛真的扫过」，不是假滚动；进度绑定 `headSha`——作者一旦 push 新 commit，旧覆盖立即失效。
- **AI 是副驾不是法官**：模型给出 findings 与修复方案，是否采纳由人逐条处置（修复 / 评论 / 忽略并写理由）。
- **原生优先**：状态栏、装饰、诊断用 VS Code 原生能力；审查工作台、文档查看、修复方案、全局报告这些富文本交互用 Webview。

## 功能特性

### 审查范围（workspace-first）

- 整个项目文件夹（自动跳过 `node_modules / .git / dist / out / bin / obj / .vs`）
- 自建 Webview 树形选择器，锁定项目根，挑选任意文件子集
- 当前分支 PR（经 `gh`）
- 当前分支 vs 基线分支（纯 git diff）
- 未提交的工作树改动（纯 git）

### 审查工作台

- 文件树 + 每文件 / 整体覆盖进度 + findings 汇总 + 动作按钮，集中在一个 Webview
- 可弹出到独立窗口（类似 “Open in Agents Window”）
- 窗口重载后自动恢复审查与工作台，无需重新选范围
- **Token 统计（估算）**：HUD 一行展示估算的 LLM token（↑输入 ↓输出），hover 看按操作分桶明细，随审查累计并持久化；由 `countTokens` 本地估算，非服务商计费 token

### 逐文件审查

- 逐行覆盖追踪与「跳到下一处未读行」
- 文件级 AI 分析 → 带严重级别的 findings
- 每条 finding 必须处置：**已修复 / 已评论 / 已忽略（需理由）**
- 修复方案：Copilot 生成互斥的「多处编辑 = 一个完整方案」候选，一键应用 + 一键撤销，应用快照持久化
- **修复前补充信息**：当模型对某条 finding 判断偏了，在修复面板里写一段补充说明；生成方案时它优先于原 finding，且按 finding 持久化
- 选区翻译 / 代码讲解标注

### 全局分析

- 跨文件逻辑分析，可限定到选定目录
- 独立的全局报告 Webview

### 门禁与结论

- 门禁：**每个文件都已分析且所有 finding 都已处置** + **全局结论已确认**
- 结论：通过（Approve） / 要求修改（Request Changes） / 仅评论（Comment）
- 范围是 PR 时可一键写回 GitHub PR（`gh`），否则本地记录

## 门禁模型

```text
gatePassed = 所有文件就绪 && 全局分析已确认
文件就绪    = 已做文件级分析 && 该文件每条 finding 都已处置
```

逐行覆盖率作为实时进度信号展示（每文件 / 整体 `seen/total`），鞭策「真的读过」，与门禁判定并列呈现。

## 语言（双语）

Code Review Gate 全面双语（English / 简体中文），**默认英文**。

- `codereview.language` 驱动**整体体验**——既包括扩展 UI（状态栏、提示、Webview 面板），也包括所有 LLM 输出（findings、修复方案、讲解、全局结论）。
  - `en`（默认）：全部英文
  - `zh-CN`：全部简体中文
  - `auto`：跟随 VS Code 显示语言
- 切换设置**实时生效**——状态栏与已打开的 Webview 面板立即重渲染，无需重载。
- 命令面板中的命令标题跟随 **VS Code 显示语言**（静态贡献点的平台限制），通过 `package.nls` 本地化。

## 命令与配置

### 命令

| 命令 | 说明 |
|------|------|
| `codereview.openOrStart` | 打开或开始审查（状态栏入口） |
| `codereview.openInNewWindow` | 在独立窗口打开审查工作台 |
| `codereview.startReview` | 选择范围并开始审查 |
| `codereview.openWorkbench` | 打开审查工作台 |
| `codereview.analyzeFile` | 分析当前文件 |
| `codereview.globalAnalysis` | 运行全局分析 |
| `codereview.showGlobalReport` | 查看全局报告 |
| `codereview.submitConclusion` | 提交审查结论 |
| `codereview.jumpToNextUnseen` | 跳到下一处未读行 |
| `codereview.pickModel` | 选择分析模型 |

### 配置

| 配置项 | 默认 | 说明 |
|--------|------|------|
| `codereview.language` | `en` | 整体体验（UI + LLM 输出）的语言：`en` / `zh-CN` / `auto` |
| `codereview.focusedWorkbench` | `false` | 打开工作台时隐藏侧栏 / 活动栏占满主编辑区，关闭后恢复 |

## 架构分层

```text
src/
  extension.ts          激活入口、命令注册、编排、门禁
  i18n/                 语言解析器 + 中英文消息 catalog
  gh/                   GitHub CLI 封装（auth / pr view / pr diff / 写回 review）
  scope/                审查范围：PR / 分支对比 / 工作树 / 文件选择 + 树形选择器 Webview
  review/               审查会话模型 + 持久化（ReviewStore 抽象）
  ai/                   模型选择 + 文件级 / 全局分析 + 修复方案 + 语言指令
  ui/                   工作台 / 文档 / 修复方案 / 全局报告 Webview + 状态栏 / toast / 进度
```

## 持久化

- `workspaceState`（本机），按 `repo + scopeId + headSha` 存。
- 已应用的修复快照持久化，重载后「撤销修复」与「定位」仍可用。
- 进度绑定 `headSha`：作者 push 新 commit 后旧覆盖失效。
- 注意：`workspaceState` **不跟随 GitHub 账号、不跨设备**；跨设备能力通过 `ReviewStore` 接口预留，将来由远端实现提供。

## 模型与语言

- 通过 VS Code Language Model API 列出当前 Copilot 授权的模型，支持 `Auto`，按工作区记住选择。
- `codereview.language` 控制整体体验（UI + 所有 LLM 输出）的语言；详见上文[语言](#语言双语)。

## 开发与打包

```bash
npm install
npm run compile            # 或 npm run watch；按 F5 启动扩展开发宿主
npm run package            # 生产构建（esbuild --production）
npx @vscode/vsce package   # 生成 .vsix
```

PR 范围与写回 PR 需要本机已安装并登录 GitHub CLI：`gh auth login`。

## 路线图

- [ ] 跨设备 / 跟随账号的审查进度（远端 `ReviewStore` 实现）。
