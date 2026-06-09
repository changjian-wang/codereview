---
description: |
  Use when: Adding or changing behavior in the AI Coding Review extension — webview panels, host↔webview messaging, i18n strings, commands, activation, editor-group layout
  Don't use when:
    - Publishing to the Marketplace (use release-publish)
    - Pure docs/README edits with no code impact
  Inputs: A feature or bugfix request touching extension code under `src/`
  Outputs: Code that follows the project's webview/i18n/build conventions and actually compiles
  Success criteria: `npm run compile` passes (tsc --noEmit + esbuild), and webview behavior is verified in a real VS Code window (Extension Development Host), not just by `get_errors`
---

# VS Code Extension Conventions Skill

Project-specific conventions for the **AI Coding Review** extension (TypeScript, esbuild-bundled, webview-heavy).

## Build & verify

```bash
npm run compile     # = tsc --noEmit && node esbuild.js  (bundles src/extension.ts -> dist/extension.js)
npm run watch       # esbuild --watch for the F5 dev host
```

- `compile` validates types and bundles. It **does not** produce a vsix (that's the release-publish skill).
- The user tests via **F5 Extension Development Host** — source changes take effect on window reload, no install needed.
- **`get_errors` / `tsc` do NOT catch runtime webview-string bugs.** Anything wrong *inside* an injected webview script (bad regex escaping, a missing `postMessage` handler) compiles clean and only shows up at runtime. Verify webview behavior in a real window.

## Architecture (entry points)

- [`src/extension.ts`](../../../src/extension.ts) — `activate()` wires commands, the status-bar button, the token-usage sink, and webview-panel **serializers** (restore-after-reload). `deactivate()` exists (use it for flush-on-exit).
- **Webviews**: `WorkbenchPanel`, `DocumentPanel`, `FixProposalPanel`, `GlobalReportPanel`, `scopePickerPanel`. Each is a singleton-ish class that builds HTML and talks to its client via `postMessage`.
- **State**: `ReviewSession` (in-memory + persistence) over `ReviewStore` (`load`/`save`/`clear`), implemented by `WorkspaceStateReviewStore` (VS Code `workspaceState`). `persist()` is the single write funnel; `onDidChange` fires UI refreshes.
- `activationEvents` is **`onStartupFinished`**, not `*`. The only UI entry is the status-bar button created in `activate()`, so post-startup activation is correct and avoids the startup-perf hit. Don't revert to `*`.

## i18n (strict, bilingual)

- [`src/i18n/en.ts`](../../../src/i18n/en.ts) is the **single source of truth**; the `Messages` type is inferred from it.
- [`src/i18n/zh.ts`](../../../src/i18n/zh.ts) is typed `: Messages`, so a missing/mistyped key is a **compile error**. Add keys to both.
- Webview-facing groups use plain strings with `{0}` placeholders (so the whole group can be `JSON.stringify`'d into client JS). Non-webview groups may use functions.
- `fmt(template, ...args)` does positional `{0}` substitution for client JS. Server-side TS prefers function-valued entries.
- A webview gets its catalog via `const T = ${JSON.stringify(t)}` injected into the HTML. **Data-driven both ends from the same `t`** — don't hardcode parallel tables in client JS (see the token unit ladder pattern: `tokenUnits` lives in i18n, both host and webview read it).

## Webview host↔client messaging

- Host → client: `this.panel.webview.postMessage({ type: '...', ... })`. Client listens on `window.addEventListener('message', ...)` and switches on `msg.type`.
- On **context switch** (e.g. FixProposalPanel showing a different finding), the host must push *every* per-context field to the client, not assume the textarea/labels reset themselves. Pattern: dedicated messages like `type:'state'`, `type:'header'`, `type:'supplement'`. A field that's only set in initial HTML will go stale when the same panel is reused for a new context.
- **Template-literal regex escaping (high-value trap):** client JS written inside a backtick template literal eats one backslash level. A regex like `/\{(\d+)\}/g` must be written `/\\{(\\d+)\\}/g` in the source template, so it evaluates to the correct `/\{(\d+)\}/g` in the webview. Applies to every `\d \w \s \b \n` inside injected client JS. Compiles clean; only fails at runtime (placeholders show literally as `{0}`).

## Editor-group / window layout traps

- An **auxiliary (popped-out) window stays alive as long as it holds even one editor group** — including an empty one. Never pre-create an empty group via `setEditorLayout`; it lingers as a blank watermark window. Create the second group lazily (open a file `ViewColumn.Beside`), then size it.
- `workbench.action.moveEditorToNewWindow` must fire **only for a freshly created** panel. Moving an already-open panel relocates it and leaves the old window as an empty husk. Snapshot `isOpen` *before* `show()`.

## Data-model gotchas

- `finding.id` is a **positional `f${i}`** (analyzer order), not a content hash. It is **not stable across re-analysis** — don't assume a disposition keyed by `finding.id` maps to the same issue on a different machine/run.
- Token usage in the HUD is a **local `countTokens` estimate**, not billed counts. Accumulated per review and persisted; never present it as authoritative billing.
