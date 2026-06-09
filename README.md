# AI Coding Review

> Distrust-driven code review: **every line must be looked at**. "Review = distrust" turned into a hard gate — read line-by-line + file-level AI analysis + dispose of every finding + cross-file global analysis. Only when all of that is done are you allowed to submit a conclusion.

[![VS Marketplace Version](https://img.shields.io/visual-studio-marketplace/v/changjian-wang.ai-coding-review?label=Marketplace&color=blue)](https://marketplace.visualstudio.com/items?itemName=changjian-wang.ai-coding-review)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/changjian-wang.ai-coding-review)](https://marketplace.visualstudio.com/items?itemName=changjian-wang.ai-coding-review)
[![Rating](https://img.shields.io/visual-studio-marketplace/r/changjian-wang.ai-coding-review)](https://marketplace.visualstudio.com/items?itemName=changjian-wang.ai-coding-review)

VS Code extension · powered by the GitHub CLI and Copilot models

English | [简体中文](README.zh-CN.md)

<img src="https://raw.githubusercontent.com/changjian-wang/codereview/main/docs/images/workbench-en.png" width="820" alt="AI Coding Review Workbench" />

## Core ideas

- **Review is distrust**: assume the author makes mistakes; no conclusion is allowed until the gate passes.
- **Per-line coverage is real**: based on a real VS Code editor + viewport tracking (`visibleRanges`) to judge that "the eyes actually scanned it", not a fake scroll; progress is bound to `headSha` — the moment the author pushes a new commit, old coverage is invalidated.
- **AI is a copilot, not a judge**: the model produces findings and fix proposals; whether to accept them is decided by a human, one finding at a time (fix / comment / ignore-with-reason).
- **Native first**: status bar, decorations, diagnostics use native VS Code APIs; the review workbench, document viewer, fix proposals, and global report use webviews for rich interaction.

## Features

### Review scope (workspace-first)

- The whole project folder (auto-skips `node_modules / .git / dist / out / bin / obj / .vs`)
- A self-built webview tree picker, locked to the project root, to pick any file subset
- The current branch's PR (via `gh`)
- Current branch vs base branch (pure git diff)
- Uncommitted working-tree changes (pure git)

### Review workbench

- File tree + per-file / overall coverage progress + findings summary + action buttons, all in one webview
- Can be popped out into a separate window (like "Open in Agents Window")
- Auto-restores the review and workbench after a window reload — no need to re-pick the scope
- **Token accounting (estimated)**: a HUD row shows estimated LLM tokens (↑input ↓output) with a per-operation breakdown on hover, accumulated over the review and persisted; estimated locally via `countTokens`, not the provider's billed counts

### Per-file review

- Per-line coverage tracking and "jump to next unseen line"
- File-level AI analysis → findings with severity levels
- Every finding must be disposed: **fixed / commented / ignored (reason required)**
- Fix proposals: Copilot generates mutually-exclusive "multi-edit = one complete solution" candidates, one-click apply + one-click undo, with applied snapshots persisted
- **Reviewer context before a fix**: when the model's read of a finding is off, add a supplementary note in the fix panel; it overrides the finding when generating proposals and is persisted per finding
- Selection translation / code explanation annotations

### Global analysis

- Cross-file logic analysis, optionally scoped to selected directories
- A dedicated global-report webview

### Gate and conclusion

- Gate: **every file is analyzed and all findings are disposed** + **the global conclusion is confirmed**
- Conclusion: Approve / Request Changes / Comment
- When the scope is a PR, one click writes the conclusion back to the GitHub PR (`gh`); otherwise it is recorded locally

## Gate model

```text
gatePassed = all files ready && global analysis confirmed
file ready  = file-level analysis done && every finding in the file disposed
```

Per-line coverage is shown as a live progress signal (per-file / overall `seen/total`) to push "actually read it", displayed alongside the gate verdict.

## Language (bilingual)

AI Coding Review is fully bilingual (English / 简体中文), **English by default**.

- `codereview.language` drives the **whole experience** — both the extension UI (status bar, prompts, webview panels) and all LLM output (findings, fix proposals, explanations, global conclusions).
  - `en` (default): everything in English
  - `zh-CN`: everything in Simplified Chinese
  - `auto`: follow the VS Code display language
- Switching the setting takes effect **live** — the status bar and any open webview panels re-render immediately, no reload needed.
- Command titles in the Command Palette follow the **VS Code display language** (a platform limitation for static contribution points), localized via `package.nls`.

## Commands and settings

### Commands

| Command | Description |
|---------|-------------|
| `codereview.openOrStart` | Open or start a review (status-bar entry) |
| `codereview.openInNewWindow` | Open the review workbench in a separate window |
| `codereview.startReview` | Pick a scope and start a review |
| `codereview.openWorkbench` | Open the review workbench |
| `codereview.analyzeFile` | Analyze the current file |
| `codereview.globalAnalysis` | Run global analysis |
| `codereview.showGlobalReport` | Show the global report |
| `codereview.submitConclusion` | Submit the review conclusion |
| `codereview.jumpToNextUnseen` | Jump to the next unseen line |
| `codereview.pickModel` | Select the analysis model |

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `codereview.language` | `en` | Language for the whole experience (UI + LLM output): `en` / `zh-CN` / `auto` |
| `codereview.focusedWorkbench` | `false` | When opening the workbench, hide the side bar / activity bar so it takes over the main editor area; restored on close |

## Architecture

```text
src/
  extension.ts          activation entry, command registration, orchestration, gate
  i18n/                 language resolver + English/Chinese message catalogs
  gh/                   GitHub CLI wrapper (auth / pr view / pr diff / write back review)
  scope/                review scopes: PR / branch diff / working tree / file selection + tree-picker webview
  review/               review session model + persistence (ReviewStore abstraction)
  ai/                   model selection + file-level / global analysis + fix proposals + language directive
  ui/                   workbench / document / fix-proposal / global-report webviews + status bar / toast / progress
```

## Persistence

- `workspaceState` (local), keyed by `repo + scopeId + headSha`.
- Applied-fix snapshots are persisted, so "undo fix" and "locate" still work after a reload.
- Progress is bound to `headSha`: old coverage is invalidated after the author pushes a new commit.
- Note: `workspaceState` **does not follow your GitHub account and is not cross-device**; cross-device capability is reserved via the `ReviewStore` interface for a future remote implementation.

## Model and language

- Lists the models currently authorized for Copilot via the VS Code Language Model API, supports `Auto`, and remembers the choice per workspace.
- `codereview.language` controls the language of the whole experience (UI + all LLM output); see [Language](#language-bilingual) above.

## Development and packaging

```bash
npm install
npm run compile            # or npm run watch; press F5 to launch the Extension Development Host
npm run package            # production build (esbuild --production)
npx @vscode/vsce package   # produce a .vsix
```

PR scope and writing back to a PR require the GitHub CLI installed and logged in: `gh auth login`.

## Roadmap

- [ ] Cross-device / account-following review progress (a remote `ReviewStore` implementation).
