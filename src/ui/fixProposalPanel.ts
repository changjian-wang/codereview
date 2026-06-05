import * as vscode from 'vscode';
import type { FixEdit, FixProposal } from '../ai/analyzer';
import { escAttr as escapeHtml, nonce as makeNonce } from './html';

/** Inputs needed to drive the panel. */
export interface FixProposalRequest {
  rel: string;
  /** Stable identity for this finding within a review/head/signature. */
  cacheKey: string;
  fileUri: vscode.Uri;
  finding: { id: string; line: number; title: string; detail: string; suggestion?: string };
  /** Generates a fresh set of proposals against the **current** file content. */
  generate: (token: vscode.CancellationToken) => Promise<FixProposal[]>;
  /** Called after a proposal is successfully applied (so disposition can flip). */
  onApplied: (edit: { oldText: string; newText: string }) => void;
  /** Called whenever the file content changes via this panel (apply or undo). */
  onFileChanged?: () => void;
  /** Called when the user reverts via the panel's own undo button. */
  onUndone?: () => void;
}

interface ProposalView {
  title: string;
  rationale: string;
  /** One or more edits applied together as a single solution. */
  edits: FixEdit[];
  /** Per-edit occurrence count of the text we'd search for (oldText, or newText once applied). */
  matches: number[];
  /** True when every edit can be uniquely located, so the whole proposal is applicable. */
  applicable: boolean;
  applied: boolean;
  /** Pre-rendered HTML showing a minimal +/- diff for every edit in this proposal. */
  diffHtml: string;
}

type PanelState =
  | { kind: 'loading'; message: string }
  | { kind: 'ready'; proposals: ProposalView[]; lastApplied?: string }
  | { kind: 'error'; message: string; canRetry: boolean };

/** Persisted form of a proposal — strips runtime fields (matches/diffHtml/applicable) that we recompute on restore. */
interface CachedProposal {
  title: string;
  rationale: string;
  edits: FixEdit[];
  applied: boolean;
}

/** Cached entry per stable finding cache key. Persists across reloads via workspaceState. */
interface CachedEntry {
  proposals: CachedProposal[];
  lastApplied?: string;
  generatedAt: number;
}

const CACHE_MEMENTO_KEY = 'codereview.fixProposals.v1';
const CACHE_MAX_ENTRIES = 200;

/**
 * Side-by-side webview listing LLM fix proposals for one finding. Applying a single
 * proposal writes to the file (Ctrl+Z to undo) and keeps the other proposals visible.
 */
export class FixProposalPanel {
  private static instance?: FixProposalPanel;
  /** Session cache of proposals per stable finding key — lets users navigate between findings without re-generating. */
  private static cache = new Map<string, CachedEntry>();
  /** Backing store for cross-reload persistence. Wired by {@link FixProposalPanel.init}. */
  private static memento?: vscode.Memento;
  private state: PanelState = { kind: 'loading', message: '正在生成修复方案…' };
  private generating?: vscode.CancellationTokenSource;
  private hasNotifiedApplied = false;
  private readonly disposables: vscode.Disposable[] = [];

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private request: FixProposalRequest,
  ) {
    this.panel.webview.html = this.renderHtml();
    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((msg) => void this.onMessage(msg)),
      this.panel.onDidDispose(() => this.dispose()),
    );
  }

  static show(request: FixProposalRequest): void {
    const title = `修复方案：${request.finding.title}`.slice(0, 60);
    if (FixProposalPanel.instance) {
      FixProposalPanel.instance.replace(request, title);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'codereview.fixProposal',
      title,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true },
    );
    FixProposalPanel.instance = new FixProposalPanel(panel, request);
    void FixProposalPanel.instance.run();
  }

  /**
   * Closes the fix-proposal panel if it's open. Called when the reviewer switches
   * to a different file, since a proposal is scoped to one finding in one file and
   * is no longer relevant once that file is left.
   */
  static closeIfOpen(): void {
    FixProposalPanel.instance?.panel.dispose();
  }

  /**
   * Wires the workspace-scoped memento used to persist fix-proposal caches
   * across reloads. Safe to call multiple times — last call wins.
   */
  static init(memento: vscode.Memento): void {
    FixProposalPanel.memento = memento;
    try {
      const stored = memento.get<Record<string, CachedEntry>>(CACHE_MEMENTO_KEY) ?? {};
      FixProposalPanel.cache = new Map(Object.entries(stored));
    } catch {
      FixProposalPanel.cache = new Map();
    }
  }

  private static keyOf(request: FixProposalRequest): string {
    return request.cacheKey;
  }

  private static saveCache(key: string, entry: CachedEntry): void {
    FixProposalPanel.cache.set(key, entry);
    // Cap size: evict oldest (by generatedAt) once we exceed the budget.
    if (FixProposalPanel.cache.size > CACHE_MAX_ENTRIES) {
      const sorted = [...FixProposalPanel.cache.entries()].sort(
        (a, b) => a[1].generatedAt - b[1].generatedAt,
      );
      const drop = sorted.slice(0, FixProposalPanel.cache.size - CACHE_MAX_ENTRIES);
      for (const [k] of drop) {
        FixProposalPanel.cache.delete(k);
      }
    }
    FixProposalPanel.flush();
  }

  private static flush(): void {
    if (!FixProposalPanel.memento) return;
    const obj: Record<string, CachedEntry> = {};
    for (const [k, v] of FixProposalPanel.cache) {
      obj[k] = v;
    }
    void FixProposalPanel.memento.update(CACHE_MEMENTO_KEY, obj);
  }

  private replace(request: FixProposalRequest, title: string): void {
    this.cancelGeneration();
    // Snapshot the outgoing finding's state before swapping so we can restore it
    // instantly if the user navigates back.
    this.snapshotCurrent();
    this.request = request;
    this.panel.title = title;
    this.panel.reveal(undefined, false);
    void this.run();
  }

  private async run(options?: { force?: boolean }): Promise<void> {
    this.cancelGeneration();
    const key = FixProposalPanel.keyOf(this.request);
    // Fast path: re-use cached proposals so users can navigate between findings
    // without paying the LLM round-trip every time.
    if (!options?.force) {
      const cached = FixProposalPanel.cache.get(key);
      if (cached && cached.proposals.length > 0) {
        try {
          await this.restoreFromCache(cached);
          return;
        } catch {
          // Fall through to fresh generation if restoration fails.
        }
      }
    }
    const cts = new vscode.CancellationTokenSource();
    this.generating = cts;
    this.setState({ kind: 'loading', message: '正在生成修复方案…' });
    try {
      const proposals = await this.request.generate(cts.token);
      if (cts.token.isCancellationRequested) {
        return;
      }
      const content = await this.currentFileText();
      const views: ProposalView[] = proposals.map((p) => buildView(p, content, false));
      this.setState({ kind: 'ready', proposals: views });
      FixProposalPanel.saveCache(key, {
        proposals: views.map(toCached),
        lastApplied: undefined,
        generatedAt: Date.now(),
      });
    } catch (err) {
      if (cts.token.isCancellationRequested) {
        return;
      }
      const message = (err as Error)?.message ?? String(err);
      this.setState({ kind: 'error', message, canRetry: true });
    } finally {
      if (this.generating === cts) {
        this.generating = undefined;
      }
      cts.dispose();
    }
  }

  /** Rebuilds runtime ProposalView state from a cached entry against the current file content. */
  private async restoreFromCache(entry: CachedEntry): Promise<void> {
    const content = await this.currentFileText();
    const views: ProposalView[] = entry.proposals.map((cached) => {
      const p = normaliseCached(cached);
      if (p.applied) {
        // Treat as still applied only when every edit's replacement is present;
        // otherwise the change was undone externally — show it as re-appliable.
        const allPresent = p.edits.every((e) => countOccurrences(content, e.newText) >= 1);
        return buildView(p, content, allPresent);
      }
      return buildView(p, content, false);
    });
    const lastApplied = views.find((p) => p.applied)?.title;
    this.setState({ kind: 'ready', proposals: views, lastApplied });
  }

  /** Snapshots the current panel state into the cache (no-op if not yet ready). */
  private snapshotCurrent(): void {
    if (this.state.kind !== 'ready') {
      return;
    }
    const key = FixProposalPanel.keyOf(this.request);
    const generatedAt = FixProposalPanel.cache.get(key)?.generatedAt ?? Date.now();
    FixProposalPanel.saveCache(key, {
      proposals: this.state.proposals.map(toCached),
      lastApplied: this.state.lastApplied,
      generatedAt,
    });
  }

  private async onMessage(msg: { type: string; idx?: number }): Promise<void> {
    if (msg.type === 'regenerate') {
      // Explicit regenerate — drop the cache so we actually call the model again.
      FixProposalPanel.cache.delete(
        FixProposalPanel.keyOf(this.request),
      );
      FixProposalPanel.flush();
      void this.run({ force: true });
      return;
    }
    if (msg.type === 'cancel') {
      this.cancelGeneration();
      this.panel.dispose();
      return;
    }
    if (msg.type === 'apply' && typeof msg.idx === 'number' && this.state.kind === 'ready') {
      const proposal = this.state.proposals[msg.idx];
      if (proposal) {
        await this.applyProposal(msg.idx, proposal);
      }
      return;
    }
    if (msg.type === 'undo' && typeof msg.idx === 'number' && this.state.kind === 'ready') {
      const proposal = this.state.proposals[msg.idx];
      if (proposal && proposal.applied) {
        await this.undoProposal(msg.idx, proposal);
      }
    }
  }

  /** Applies the proposal directly to the file (visible editor, no auto-save) so Ctrl+Z works. */
  private async applyProposal(idx: number, proposal: ProposalView): Promise<void> {
    if (this.state.kind !== 'ready') {
      return;
    }
    if (proposal.applied) {
      return;
    }
    // These proposals are mutually-exclusive alternatives: at most one may be
    // applied at a time. If another is already applied, refuse and tell the user
    // to undo it first (rather than silently stacking two alternatives).
    const other = this.state.proposals.find((p, i) => i !== idx && p.applied);
    if (other) {
      void vscode.window.showWarningMessage(
        `已应用「${other.title}」。这些是互斥的备选方案，如需改用此方案，请先撤销已应用的方案。`,
      );
      return;
    }
    const content = await this.currentFileText();
    // Every edit in the proposal must locate uniquely, or we apply none of them.
    for (const e of proposal.edits) {
      const matches = countOccurrences(content, e.oldText);
      if (matches === 0) {
        this.markProposalError(idx, '无法定位：方案中有一处原代码片段在当前文件中已不存在（文件可能被修改了）。请「重新生成」。');
        return;
      }
      if (matches > 1) {
        this.markProposalError(idx, `方案中有一处原代码出现了 ${matches} 次，无法唯一定位。请「重新生成」以获得更具上下文的方案。`);
        return;
      }
    }
    const ok = await this.applyEdits(proposal.edits);
    if (!ok) {
      this.markProposalError(idx, '应用失败：文件在写入瞬间发生了变化，请「重新生成」。');
      return;
    }
    // Mutate the proposal view in place so other proposals stay visible.
    if (this.state.kind === 'ready') {
      const after = await this.currentFileText();
      const updated = this.state.proposals.map((p, i) =>
        i === idx ? buildView(p, after, true) : (p.applied ? p : buildView(p, after, false)),
      );
      this.setState({ kind: 'ready', proposals: updated, lastApplied: proposal.title });
    }
    this.snapshotCurrent();
    if (!this.hasNotifiedApplied) {
      this.hasNotifiedApplied = true;
    }
    // Anchor downstream locate/revert to the edit nearest the finding — not
    // blindly edits[0], which for a multi-segment fix is usually a top-of-file
    // `using`/import far from the actual problem. This keeps post-apply focus on
    // the code the finding is about.
    const anchorEdit = this.anchorEditFor(proposal.edits, content);
    this.request.onApplied({ oldText: anchorEdit.oldText, newText: anchorEdit.newText });
    this.request.onFileChanged?.();
    vscode.window.setStatusBarMessage(`已应用：${proposal.title}（点击「撤销修改」可还原）`, 8000);
  }

  /**
   * Picks which edit of a (possibly multi-segment) proposal to anchor the
   * post-apply locate on. We score each edit by the 1-based line where its
   * `oldText` begins in the pre-apply `content` and choose the one closest to
   * the finding's line. This avoids anchoring to a top-of-file `using`/import
   * edit when the real fix is elsewhere. Falls back to the first edit.
   */
  private anchorEditFor(edits: FixEdit[], content: string): FixEdit {
    if (edits.length <= 1) {
      return edits[0];
    }
    const targetLine = this.request.finding.line;
    let best = edits[0];
    let bestDist = Number.POSITIVE_INFINITY;
    for (const e of edits) {
      const idx = content.indexOf(e.oldText);
      if (idx < 0) {
        continue;
      }
      const startLine = content.slice(0, idx).split('\n').length; // 1-based
      const dist = Math.abs(startLine - targetLine);
      if (dist < bestDist) {
        bestDist = dist;
        best = e;
      }
    }
    return best;
  }

  /** Reverts a previously-applied proposal by swapping every edit's newText back to oldText. */
  private async undoProposal(idx: number, proposal: ProposalView): Promise<void> {
    if (this.state.kind !== 'ready') {
      return;
    }
    const content = await this.currentFileText();
    for (const e of proposal.edits) {
      const matches = countOccurrences(content, e.newText);
      if (matches === 0) {
        void vscode.window.showWarningMessage('无法撤销：文件中已找不到之前应用的某处片段（文件可能被手动改动过了）。');
        return;
      }
      if (matches > 1) {
        void vscode.window.showWarningMessage(`之前应用的某处片段现在出现了 ${matches} 次，无法唯一定位，不敢自动撤销。请手动 Ctrl+Z。`);
        return;
      }
    }
    // Reverse each edit (newText → oldText) and apply them as one undo step.
    const reversed = proposal.edits.map((e) => ({ oldText: e.newText, newText: e.oldText }));
    const ok = await this.applyEdits(reversed);
    if (!ok) {
      void vscode.window.showWarningMessage('撤销失败：文件在写入瞬间发生了变化。');
      return;
    }
    if (this.state.kind === 'ready') {
      const after = await this.currentFileText();
      const updated = this.state.proposals.map((p, i) =>
        i === idx ? buildView(p, after, false) : (p.applied ? p : buildView(p, after, false)),
      );
      const stillAppliedTitle = updated.find((p) => p.applied)?.title;
      this.setState({ kind: 'ready', proposals: updated, lastApplied: stillAppliedTitle });
    }
    this.snapshotCurrent();
    this.request.onFileChanged?.();
    this.request.onUndone?.();
    vscode.window.setStatusBarMessage(`已撤销：${proposal.title}`, 6000);
  }

  private markProposalError(_idx: number, message: string): void {
    if (this.state.kind !== 'ready') {
      return;
    }
    // Surface the error as a banner without trashing the list.
    this.setState({ kind: 'ready', proposals: this.state.proposals, lastApplied: undefined });
    void vscode.window.showWarningMessage(message);
  }

  /**
   * Applies a set of edits as a single workspace edit (one undo step). Every
   * `oldText` must locate uniquely in the current file, or nothing is applied.
   */
  private async applyEdits(edits: FixEdit[]): Promise<boolean> {
    const doc = await vscode.workspace.openTextDocument(this.request.fileUri);
    const text = doc.getText();
    const edit = new vscode.WorkspaceEdit();
    for (const e of edits) {
      const idx = text.indexOf(e.oldText);
      if (idx < 0 || text.indexOf(e.oldText, idx + 1) >= 0) {
        return false;
      }
      const start = doc.positionAt(idx);
      const end = doc.positionAt(idx + e.oldText.length);
      edit.replace(this.request.fileUri, new vscode.Range(start, end), e.newText);
    }
    const ok = await vscode.workspace.applyEdit(edit);
    if (ok) {
      // Auto-save so downstream tools (linters, watchers, the next analysis pass)
      // see the change immediately. Users can still revert via 「撤销修改」 or VCS.
      try {
        await doc.save();
      } catch {
        // ignore save failures; leaving the file dirty is the prior behaviour.
      }
    }
    return ok;
  }

  private async currentFileText(): Promise<string> {
    const open = vscode.workspace.textDocuments.find(
      (d) => d.uri.fsPath === this.request.fileUri.fsPath,
    );
    if (open) {
      return open.getText();
    }
    const doc = await vscode.workspace.openTextDocument(this.request.fileUri);
    return doc.getText();
  }

  private setState(state: PanelState): void {
    this.state = state;
    this.panel.webview.postMessage({ type: 'state', state });
    // Keep the header's line label in sync with the (possibly fix-shifted) content.
    void this.refreshHeader();
  }

  /**
   * Updates the header's `rel · 第 N 行` label. When a proposal has been applied,
   * N follows the live content by anchoring to the **last line** of the applied
   * snippet; otherwise it falls back to the finding's original line.
   */
  private async refreshHeader(): Promise<void> {
    const line = await this.computeDisplayLine();
    this.panel.webview.postMessage({
      type: 'header',
      rel: this.request.rel,
      line,
      title: this.request.finding.title,
      detail: this.request.finding.detail,
      suggestion: this.request.finding.suggestion ?? '',
    });
  }

  /** Resolves the line number to show in the header (see {@link refreshHeader}). */
  private async computeDisplayLine(): Promise<number> {
    const fallback = this.request.finding.line;
    if (this.state.kind !== 'ready') {
      return fallback;
    }
    const applied = this.state.proposals.find((p) => p.applied);
    if (!applied) {
      return fallback;
    }
    try {
      const doc = await vscode.workspace.openTextDocument(this.request.fileUri);
      const text = doc.getText();
      const anchor = applied.edits[0]?.newText ?? '';
      const idx = anchor ? text.indexOf(anchor) : -1;
      if (idx < 0) {
        return fallback;
      }
      // Anchor to the last line of the applied content. positionAt points just
      // past the snippet; if it ends with a newline, step back to the real末行.
      const end = doc.positionAt(idx + anchor.length);
      let zeroBased = end.line;
      if (end.character === 0 && zeroBased > 0) {
        zeroBased -= 1;
      }
      return zeroBased + 1;
    } catch {
      return fallback;
    }
  }

  private cancelGeneration(): void {
    this.generating?.cancel();
    this.generating?.dispose();
    this.generating = undefined;
  }

  private dispose(): void {
    this.cancelGeneration();
    // Final snapshot so the next time the panel opens for this finding we restore
    // its state from cache rather than re-calling the model.
    this.snapshotCurrent();
    for (const d of this.disposables) {
      d.dispose();
    }
    if (FixProposalPanel.instance === this) {
      FixProposalPanel.instance = undefined;
    }
  }

  private renderHtml(): string {
    const initial = JSON.stringify(this.state);
    const nonce = makeNonce();
    const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    return /* html */ `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"/>
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style>
  :root { color-scheme: light dark; }
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; padding: 16px 20px 40px; }
  header { display:flex; align-items:baseline; justify-content:space-between; gap:12px; margin-bottom:12px; }
  header h2 { font-size:14px; font-weight:600; margin:0; }
  header .sub { color: var(--vscode-descriptionForeground); font-size:12px; }
  .finding { background: var(--vscode-textBlockQuote-background); border-left: 3px solid var(--vscode-textLink-foreground); padding:8px 12px; border-radius:4px; font-size:12px; margin-bottom:16px; }
  .finding .title { font-weight:600; margin-bottom:4px; }
  .finding .meta { color: var(--vscode-descriptionForeground); }
  .proposal { border:1px solid var(--vscode-panel-border); border-radius:6px; padding:12px 14px; margin-bottom:12px; background: var(--vscode-editorWidget-background); }
  .proposal h3 { font-size:13px; margin:0 0 6px; font-weight:600; }
  .proposal p.rationale { font-size:12px; line-height:1.55; color: var(--vscode-foreground); margin:0 0 10px; white-space: pre-wrap; }
  .proposal .actions { display:flex; gap:8px; }
  .proposal .badge { display:inline-block; font-size:11px; padding:1px 6px; border-radius:10px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); margin-left:6px; vertical-align:middle; }
  .proposal.bad { opacity:.7; }
  .proposal.bad .badge { background: var(--vscode-inputValidation-warningBackground); color: var(--vscode-inputValidation-warningForeground); border:1px solid var(--vscode-inputValidation-warningBorder); }
  .proposal.done { opacity:.65; border-color: var(--vscode-charts-green, #4caf50); }
  .proposal.done .badge.ok { background: var(--vscode-charts-green, #4caf50); color: var(--vscode-editor-background); border:1px solid transparent; }
  .proposal.locked { opacity:.5; }
  .proposal .badge.muted { background: transparent; color: var(--vscode-descriptionForeground); border:1px solid var(--vscode-panel-border); }
  button { font: inherit; padding: 4px 12px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 3px; cursor: pointer; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button[disabled] { opacity:.5; cursor: not-allowed; }
  .toolbar { display:flex; gap:8px; margin-bottom:16px; }
  .status { padding:14px; border-radius:6px; font-size:12px; line-height:1.6; }
  .status.loading { background: var(--vscode-editorWidget-background); border:1px dashed var(--vscode-panel-border); }
  .status.error { background: var(--vscode-inputValidation-errorBackground); color: var(--vscode-inputValidation-errorForeground); border:1px solid var(--vscode-inputValidation-errorBorder); }
  .status.applied { background: var(--vscode-editorGutter-addedBackground, var(--vscode-editorWidget-background)); border:1px solid var(--vscode-panel-border); margin-bottom:12px; }
  .status.applied kbd { background: var(--vscode-keybindingLabel-background, rgba(128,128,128,.2)); border:1px solid var(--vscode-keybindingLabel-border, rgba(128,128,128,.4)); border-radius:3px; padding:0 4px; font-family: var(--vscode-editor-font-family, monospace); font-size:11px; }
  .hint { font-size:11px; color: var(--vscode-descriptionForeground); margin-top:4px; }
  .diff { font-family: var(--vscode-editor-font-family, ui-monospace, monospace); font-size: 12px; line-height: 1.5; background: var(--vscode-textCodeBlock-background, var(--vscode-editor-background)); border:1px solid var(--vscode-panel-border); border-radius:4px; margin:0 0 10px; overflow:auto; max-height: 360px; }
  .diff .row { display:flex; padding:0 8px; white-space: pre; }
  .diff .row.add { background: var(--vscode-diffEditor-insertedTextBackground, rgba(0,160,0,.12)); }
  .diff .row.del { background: var(--vscode-diffEditor-removedTextBackground, rgba(220,0,0,.12)); }
  .diff .row.ctx { color: var(--vscode-descriptionForeground); }
  .diff .sign { width: 1.2em; flex: 0 0 auto; user-select: none; opacity:.8; }
  .diff .text { flex: 1 1 auto; }
</style>
</head>
<body>
  <header>
    <h2>修复方案</h2>
    <span class="sub" id="subline">${escapeHtml(this.request.rel)} · 第 ${this.request.finding.line} 行</span>
  </header>
  <div class="finding">
    <div class="title" id="f-title">${escapeHtml(this.request.finding.title)}</div>
    <div id="f-detail">${escapeHtml(this.request.finding.detail)}</div>
    <div class="meta" id="f-suggest"${this.request.finding.suggestion ? '' : ' style="display:none"'}>${this.request.finding.suggestion ? '建议：' + escapeHtml(this.request.finding.suggestion) : ''}</div>
  </div>
  <div class="toolbar">
    <button id="regenerate" class="primary">重新生成</button>
    <button id="cancel">关闭</button>
  </div>
  <div id="body"></div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const body = document.getElementById('body');
    document.getElementById('regenerate').addEventListener('click', () => vscode.postMessage({ type: 'regenerate' }));
    document.getElementById('cancel').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));

    function esc(s) {
      return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    function render(state) {
      if (state.kind === 'loading') {
        body.innerHTML = '<div class="status loading">' + esc(state.message) + '</div>';
        return;
      }
      if (state.kind === 'error') {
        body.innerHTML = '<div class="status error">' + esc(state.message) + '</div>';
        return;
      }
      if (state.kind === 'ready') {
        if (!state.proposals.length) {
          body.innerHTML = '<div class="status error">模型没有返回任何方案。请「重新生成」。</div>';
          return;
        }
        const banner = state.lastApplied
          ? '<div class="status applied">已应用：<strong>' + esc(state.lastApplied) + '</strong>。改动已同步到左侧文件查看器；点击「撤销修改」可还原。</div>'
          : '';
        const anyApplied = state.proposals.some(function (p) { return p.applied; });
        const altNote = (state.proposals.length > 1 && !state.lastApplied)
          ? '<div class="hint">以下是互斥的备选方案，任选其一应用即可修复，不需要全部应用。</div>'
          : '';
        const cards = state.proposals.map((p, i) => {
          const editCount = (p.edits && p.edits.length) || 1;
          const multi = editCount > 1 ? ' · ' + editCount + ' 处改动' : '';
          const lockedByOther = anyApplied && !p.applied;
          let badge;
          if (p.applied) {
            badge = '<span class="badge ok">已应用' + multi + '</span>';
          } else if (lockedByOther) {
            badge = '<span class="badge muted">备选方案 ' + (i + 1) + multi + '</span>';
          } else if (p.applicable) {
            badge = '<span class="badge">方案 ' + (i + 1) + multi + '</span>';
          } else {
            const bad = (p.matches || []).filter(function (m) { return m !== 1; }).length;
            badge = '<span class="badge">无法唯一定位（' + bad + '/' + editCount + ' 处）</span>';
          }
          let btn;
          if (p.applied) {
            btn = '<button data-undo="' + i + '">撤销修改</button>';
          } else if (lockedByOther) {
            btn = '<button disabled title="已应用其他方案，撤销后可改用此方案">已选其他方案</button>';
          } else if (p.applicable) {
            btn = '<button class="primary" data-apply="' + i + '">应用此方案</button>';
          } else {
            btn = '<button disabled>无法应用</button>';
          }
          const hint = (!p.applied && !lockedByOther && p.applicable)
            ? '<div class="hint">应用后会直接写入文件（未保存），左侧文件查看器会立即刷新。</div>'
            : '';
          const cls = p.applied ? ' done' : (lockedByOther ? ' locked' : (p.applicable ? '' : ' bad'));
          return [
            '<div class="proposal' + cls + '">',
            '<h3>', esc(p.title), badge, '</h3>',
            p.rationale ? '<p class="rationale">' + esc(p.rationale) + '</p>' : '',
            p.diffHtml || '',
            '<div class="actions">', btn, '</div>',
            hint,
            '</div>',
          ].join('');
        }).join('');
        body.innerHTML = banner + altNote + cards;
        body.querySelectorAll('button[data-apply]').forEach((b) => {
          b.addEventListener('click', () => {
            vscode.postMessage({ type: 'apply', idx: Number(b.getAttribute('data-apply')) });
          });
        });
        body.querySelectorAll('button[data-undo]').forEach((b) => {
          b.addEventListener('click', () => {
            vscode.postMessage({ type: 'undo', idx: Number(b.getAttribute('data-undo')) });
          });
        });
      }
    }

    window.addEventListener('message', (e) => {
      const msg = e.data;
      if (msg && msg.type === 'state') {
        render(msg.state);
      } else if (msg && msg.type === 'header') {
        const el = document.getElementById('subline');
        if (el) el.textContent = msg.rel + ' · 第 ' + msg.line + ' 行';
        const t = document.getElementById('f-title');
        if (t) t.textContent = msg.title;
        const d = document.getElementById('f-detail');
        if (d) d.textContent = msg.detail;
        const s = document.getElementById('f-suggest');
        if (s) {
          if (msg.suggestion) { s.textContent = '建议：' + msg.suggestion; s.style.display = ''; }
          else { s.textContent = ''; s.style.display = 'none'; }
        }
      }
    });

    render(${initial});
  </script>
</body>
</html>`;
  }
}

/** Strips runtime-only fields from a ProposalView for cache storage. */
function toCached(p: ProposalView): CachedProposal {
  return {
    title: p.title,
    rationale: p.rationale,
    edits: p.edits,
    applied: p.applied,
  };
}

/**
 * Normalises a cached proposal that may predate multi-edit support: older
 * entries carried a single top-level `oldText`/`newText` instead of an `edits`
 * array. Guarantees a non-empty `edits` array for {@link buildView}.
 */
function normaliseCached(
  p: CachedProposal & { oldText?: string; newText?: string },
): { title: string; rationale: string; edits: FixEdit[]; applied: boolean } {
  let edits = Array.isArray(p.edits) ? p.edits : [];
  if (edits.length === 0 && typeof p.oldText === 'string') {
    edits = [{ oldText: p.oldText, newText: typeof p.newText === 'string' ? p.newText : '' }];
  }
  return { title: p.title, rationale: p.rationale, edits, applied: p.applied };
}

/**
 * Builds a runtime ProposalView from a proposal's edits against the current file
 * content. `applied` controls whether we search for each edit's replacement
 * (newText) or its original (oldText) when computing match counts. A proposal is
 * applicable only when it is not yet applied and every edit locates uniquely.
 */
function buildView(
  p: { title: string; rationale: string; edits: FixEdit[] },
  content: string,
  applied: boolean,
): ProposalView {
  const matches = p.edits.map((e) => countOccurrences(content, applied ? e.newText : e.oldText));
  return {
    title: p.title,
    rationale: p.rationale,
    edits: p.edits,
    matches,
    applicable: !applied && matches.length > 0 && matches.every((m) => m === 1),
    applied,
    diffHtml: p.edits.map((e) => renderInlineDiff(e.oldText, e.newText)).join(''),
  };
}

/**
 * Renders a minimal inline diff: deletions then additions, each as a row with a
 * sign column. Trailing empty lines are dropped so deletions like "X\n" don't
 * print a spurious blank red line.
 */
function renderInlineDiff(oldText: string, newText: string): string {
  const split = (t: string) => {
    const lines = t.split(/\r?\n/);
    while (lines.length > 1 && lines[lines.length - 1] === '') {
      lines.pop();
    }
    return lines;
  };
  const oldLines = split(oldText);
  const newLines = split(newText);
  const rows: string[] = [];
  for (const line of oldLines) {
    rows.push(diffRow('del', '-', line));
  }
  for (const line of newLines) {
    rows.push(diffRow('add', '+', line));
  }
  if (rows.length === 0) {
    rows.push(diffRow('ctx', ' ', '（空差异）'));
  }
  return `<pre class="diff">${rows.join('')}</pre>`;
}

function diffRow(cls: 'add' | 'del' | 'ctx', sign: string, text: string): string {
  return `<div class="row ${cls}"><span class="sign">${sign}</span><span class="text">${escapeHtml(text) || '&nbsp;'}</span></div>`;
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) {
    return 0;
  }
  let n = 0;
  let i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) {
    n++;
    i += needle.length;
  }
  return n;
}


