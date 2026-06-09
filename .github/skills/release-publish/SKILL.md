---
description: |
  Use when: Cutting and shipping a new version of the AI Coding Review extension to the VS Code Marketplace; setting up or refreshing the publish credential (PAT); diagnosing a failed `vsce publish`
  Don't use when:
    - Writing extension code or fixing behavior (use vscode-extension-conventions)
    - Only building/compiling locally with no intent to publish (`npm run compile`)
    - Editing README prose unrelated to release
  Inputs: A committed, compiling change you want live on the Marketplace
  Outputs: A new published version, README badges auto-updating, the version-bump commit pushed
  Success criteria: `vsce publish` prints `Published changjian-wang.ai-coding-review vX.Y.Z`, and `git push` syncs the bump commit
---

# Release & Publish Skill

Ships **AI Coding Review** to the VS Code Marketplace. Mirrors [`docs/RELEASING.md`](../../../docs/RELEASING.md) but is the agent-facing, step-driven version.

## Identity (do not change casually)

| Thing | Value | Source |
|------|-------|--------|
| Marketplace item id | `changjian-wang.ai-coding-review` | `publisher` + `name` in `package.json` |
| Publisher | `changjian-wang` | marketplace.visualstudio.com/manage |
| Store title | `AI Coding Review` | `displayName` |
| Repo | `changjian-wang/codereview` (public) | GitHub |

> The bare id `codereview` is taken on the Marketplace, so `name` is `ai-coding-review`. **Changing `name` or `publisher` rewrites the install id AND every README badge/link `itemName`** (`https://img.shields.io/visual-studio-marketplace/.../changjian-wang.ai-coding-review`). If you must change it, grep both READMEs for the old `itemName` and fix every occurrence or the badges/links die.

## Publish a new version (the happy path)

```bash
# 1. compile must pass (tsc --noEmit + esbuild). compile does NOT produce a vsix.
npm run compile

# 2. bump the version in package.json (e.g. 0.0.51 -> 0.0.52) and commit the
#    behavior change + bump together — one commit per release.

# 3. publish (vsce stays logged in across this machine once you've logged in)
npx --yes @vscode/vsce publish        # ships the version already in package.json

# 4. push the bump commit so GitHub and the Marketplace agree
git push
```

The README shows **live Marketplace badges** (version/installs/rating) — there is no hand-written version number to update; badges self-update once the new version is live (a few minutes).

## One-time credential setup (already done; redo when the PAT lapses)

1. **Azure DevOps PAT** — the publish credential (NOT a GitHub token):
   - org `changjian-wang` at https://dev.azure.com (reach it via `https://aex.dev.azure.com/me`; the bare `dev.azure.com` may bounce to the marketing page)
   - Scope: **Show all scopes → Marketplace → Manage**
   - **Expires 2026-07-07.** When it lapses, regenerate and re-login.
2. `npx --yes @vscode/vsce login changjian-wang` — paste the PAT into the terminal.
   **Never** route the PAT through chat / the question tool; the user types it directly.

## Gotchas (all observed in this repo)

- **`name` collision** → `ERROR The extension 'codereview' already exists`. Pick a hyphenated id and sync README `itemName`s.
- **`dist/extension.js is large (510 KB)`** is a *warning*, not an error — it does not block publishing.
- **Republishing the same version fails** — always bump first. Reinstalling a same-numbered vsix also won't refresh.
- **README screenshots use absolute `raw.githubusercontent.com` URLs** — these only resolve because the repo is **public**; relative paths do NOT render on the Marketplace detail page.
- **`.vscodeignore` excludes `docs/**` and `*.vsix`** — screenshots and stray local builds stay out of the package.
- **`git push` HTTP 400 on big PNGs**: default `http.postBuffer` is 1 MB; this repo is set to 500 MB locally (`git config http.postBuffer 524288000`). Verify a push really landed with `git rev-list --left-right --count origin/main...HEAD`, not the (sometimes misleading) CLI text.
- **`vsce login` 401 / verify-failed** → PAT scope is wrong (needs Marketplace → Manage) or the token was mis-copied.
- **`vsce` is not a dependency** — always invoke via `npx --yes @vscode/vsce`.

## Verify after publishing

```bash
# itemName page should become 200 within a few minutes
curl -s -o /dev/null -w "%{http_code}\n" \
  "https://marketplace.visualstudio.com/items?itemName=changjian-wang.ai-coding-review"
```
