import * as vscode from 'vscode';
import type { FixEdit, FixProposal } from '../ai/analyzer';
import { escAttr as escapeHtml, nonce as makeNonce } from './html';
import { m, fmt, resolveLanguage } from '../i18n';
import { DocumentPanel } from './documentPanel';

/** Inputs needed to drive the panel. */
export interface FixProposalRequest {
  rel: string;
  /** Stable identity for this finding within a review/head/signature. */
  cacheKey: string;
  fileUri: vscode.Uri;
  finding: { id: string; line: number; title: string; detail: string; suggestion?: string };
  /** Generates a fresh set of proposals against the **current** file content. */
  generate: (token: vscode.CancellationToken, userContext?: string) => Promise<FixProposal[]>;
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
  /** Reviewer's supplementary note used to steer (re)generation; persisted so it survives reloads. */
  supplement?: string;
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
  private state: PanelState = { kind: 'loading', message: m().fixPanel.generating };
  private generating?: vscode.CancellationTokenSource;
  private hasNotifiedApplied = false;
  /** Reviewer's current supplementary note; steers (re)generation and is persisted per cacheKey. */
  private currentSupplement = '';
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
    const title = `${m().fixPanel.titlePrefix}${request.finding.title}`.slice(0, 60);
    if (FixProposalPanel.instance) {
      FixProposalPanel.instance.replace(request, title);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'codereview.fixProposal',
      title,
      // Open in a stable column to the RIGHT of the code view, so the layout is
      // always workbench | code | fix-proposal — not wherever 「Beside」 lands
      // relative to whatever tab happened to be active.
      { viewColumn: fixProposalColumn(), preserveFocus: false },
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
   * Closes the panel only if it's showing a proposal for `rel`. Called when that
   * file is re-analyzed: the findings (and their ids) are replaced, so a proposal
   * tied to an old finding is stale and must not linger next to fresh results.
   */
  static closeIfFile(rel: string): void {
    if (FixProposalPanel.instance?.request.rel === rel) {
      FixProposalPanel.instance.panel.dispose();
    }
  }

  /** Re-renders the open panel in the current language (after a language switch). */
  static refreshIfOpen(): void {
    const inst = FixProposalPanel.instance;
    if (inst) {
      inst.panel.webview.html = inst.renderHtml();
    }
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
    FixProposalPanel.migrateLegacyKeys();
  }

  /**
   * One-time migration of pre-0.0.77 scope-scoped keys to the file-based format.
   *
   * Old key: "{repo}::{scopeId}::{headSha}::{rel}::{hash}" (5 segments)
   * New key: "{repo}::{rel}::{hash}"                       (3 segments)
   *
   * The {repo} and {hash} segments are identical between both formats — only the
   * middle {scopeId}::{headSha} was dropped — so we can rebuild the new key from
   * the old one WITHOUT re-deriving the finding hash (i.e. no LLM round-trip).
   * When several scopes produced an entry for the same file+finding, the most
   * recently generated one wins. Idempotent: legacy keys are deleted, so a second
   * pass finds nothing. Safe-by-omission: anything that is not exactly 5 segments
   * (the 3-segment new format, the 4-segment "global::…" one-click-fix keys, or a
   * repo/path that happens to contain "::") is left untouched — at worst the
   * proposal regenerates once instead of being mis-mapped.
   */
  private static migrateLegacyKeys(): void {
    let changed = false;
    for (const [oldKey, entry] of [...FixProposalPanel.cache.entries()]) {
      const parts = oldKey.split('::');
      if (parts.length !== 5) {
        continue;
      }
      const [repo, , , rel, hash] = parts;
      const newKey = `${repo}::${rel}::${hash}`;
      const existing = FixProposalPanel.cache.get(newKey);
      if (!existing || existing.generatedAt < entry.generatedAt) {
        FixProposalPanel.cache.set(newKey, entry);
      }
      FixProposalPanel.cache.delete(oldKey);
      changed = true;
    }
    if (changed) {
      FixProposalPanel.flush();
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

  private async run(options?: { force?: boolean; supplement?: string }): Promise<void> {
    this.cancelGeneration();
    const key = FixProposalPanel.keyOf(this.request);
    // Fast path: re-use cached proposals so users can navigate between findings
    // without paying the LLM round-trip every time.
    if (!options?.force) {
      const cached = FixProposalPanel.cache.get(key);
      if (cached) {
        // Restore the reviewer's prior supplement so it stays in the textarea.
        this.currentSupplement = cached.supplement ?? '';
      } else {
        // New finding with no cached context: do not leak the previous finding's
        // supplement into this textarea.
        this.currentSupplement = '';
      }
      this.syncSupplementInput();
      if (cached && cached.proposals.length > 0) {
        try {
          await this.restoreFromCache(cached);
          return;
        } catch {
          // Fall through to fresh generation if restoration fails.
        }
      }
    }
    // The supplement that should steer this generation: an explicit one from the
    // regenerate action, else whatever the reviewer last entered.
    const supplement = options?.supplement ?? this.currentSupplement;
    this.currentSupplement = supplement;
    this.syncSupplementInput();
    const cts = new vscode.CancellationTokenSource();
    this.generating = cts;
    this.setState({ kind: 'loading', message: m().fixPanel.generating });
    try {
      const proposals = await this.request.generate(cts.token, supplement || undefined);
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
        supplement: supplement || undefined,
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
      supplement: this.currentSupplement || undefined,
    });
  }

  private async onMessage(msg: { type: string; idx?: number; supplement?: string }): Promise<void> {
    if (msg.type === 'regenerate') {
      // Capture the reviewer's supplement (may be empty to clear it).
      this.currentSupplement = (msg.supplement ?? '').trim();
      // Explicit regenerate — drop the cached proposals so we actually call the
      // model again, but carry the supplement forward to steer it.
      FixProposalPanel.cache.delete(
        FixProposalPanel.keyOf(this.request),
      );
      FixProposalPanel.flush();
      void this.run({ force: true, supplement: this.currentSupplement });
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
      void vscode.window.showWarningMessage(fmt(m().fixPanel.mutexApplied, other.title));
      return;
    }
    const content = await this.currentFileText();
    // Every edit in the proposal must locate uniquely, or we apply none of them.
    for (const e of proposal.edits) {
      const matches = countOccurrences(content, e.oldText);
      if (matches === 0) {
        this.markProposalError(idx, m().fixPanel.locateGone);
        return;
      }
      if (matches > 1) {
        this.markProposalError(idx, fmt(m().fixPanel.locateAmbiguous, matches));
        return;
      }
    }
    const ok = await this.applyEdits(proposal.edits);
    if (!ok) {
      this.markProposalError(idx, m().fixPanel.applyRace);
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
    vscode.window.setStatusBarMessage(fmt(m().fixPanel.appliedStatus, proposal.title), 8000);
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
      // Locate via the layered matcher (NOT exact indexOf): the model's oldText
      // often differs from the file by indentation, so indexOf returns -1 and the
      // edit gets skipped — collapsing the choice back to edits[0] (typically a
      // top-of-block comment), which is exactly the "post-apply jumps to the
      // _comment line" bug. locateEditOffsets is whitespace/punct tolerant.
      const hits = locateEditOffsets(content, e.oldText);
      for (const hit of hits) {
        const startLine = content.slice(0, hit.start).split('\n').length; // 1-based
        const dist = Math.abs(startLine - targetLine);
        if (dist < bestDist) {
          bestDist = dist;
          best = e;
        }
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
        void vscode.window.showWarningMessage(m().fixPanel.undoGone);
        return;
      }
      if (matches > 1) {
        void vscode.window.showWarningMessage(fmt(m().fixPanel.undoAmbiguous, matches));
        return;
      }
    }
    // Reverse each edit (newText → oldText) and apply them as one undo step.
    const reversed = proposal.edits.map((e) => ({ oldText: e.newText, newText: e.oldText }));
    const ok = await this.applyEdits(reversed);
    if (!ok) {
      void vscode.window.showWarningMessage(m().fixPanel.undoRace);
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
    vscode.window.setStatusBarMessage(fmt(m().fixPanel.undoneStatus, proposal.title), 6000);
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
      // Strict placement first; on the indentation-tolerant fallback the
      // replacement is re-indented to the file so applying never eats indent.
      const r = resolveEditAt(text, e.oldText, e.newText);
      if (!r) {
        return false;
      }
      const start = doc.positionAt(r.start);
      const end = doc.positionAt(r.end);
      edit.replace(this.request.fileUri, new vscode.Range(start, end), r.replacement);
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

  /** Pushes the current supplement into the webview textarea when context switches. */
  private syncSupplementInput(): void {
    this.panel.webview.postMessage({
      type: 'supplement',
      value: this.currentSupplement,
    });
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
    if (!applied || applied.edits.length === 0) {
      return fallback;
    }
    try {
      const doc = await vscode.workspace.openTextDocument(this.request.fileUri);
      const text = doc.getText();
      // Among ALL applied edits' newText occurrences, show the one starting
      // nearest the finding line — NOT blindly edits[0], which for a multi-edit
      // fix is usually a top-of-block comment far from the real change (that made
      // the header jump to e.g. the _comment line 47 instead of the Path at 65).
      // Use the layered matcher so indentation/EOL drift after save still locates.
      const target = this.request.finding.line;
      let bestLine = -1;
      let bestDist = Number.POSITIVE_INFINITY;
      for (const e of applied.edits) {
        if (!e.newText) {
          continue;
        }
        for (const hit of locateEditOffsets(text, e.newText)) {
          const startLine = doc.positionAt(hit.start).line + 1;
          const dist = Math.abs(startLine - target);
          if (dist < bestDist) {
            bestDist = dist;
            bestLine = startLine;
          }
        }
      }
      return bestLine > 0 ? bestLine : fallback;
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
    const t = m().fixPanel;
    const T = JSON.stringify(t);
    const lang = resolveLanguage();
    return /* html */ `<!DOCTYPE html>
<html lang="${lang}">
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
  .supplement { margin: 12px 0 16px; }
  .supp-label { display:block; font-size:11px; color: var(--vscode-descriptionForeground); margin-bottom:4px; }
  .supp-input { width:100%; box-sizing:border-box; resize:vertical; min-height:38px; font-family: inherit; font-size:12px; line-height:1.5; padding:6px 8px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border:1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius:4px; outline:none; }
  .supp-input:focus { border-color: var(--vscode-focusBorder); }
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
    <h2>${escapeHtml(t.heading)}</h2>
    <span class="sub" id="subline">${escapeHtml(this.request.rel)} · ${escapeHtml(fmt(t.line, this.request.finding.line))}</span>
  </header>
  <div class="finding">
    <div class="title" id="f-title">${escapeHtml(this.request.finding.title)}</div>
    <div id="f-detail">${escapeHtml(this.request.finding.detail)}</div>
    <div class="meta" id="f-suggest"${this.request.finding.suggestion ? '' : ' style="display:none"'}>${this.request.finding.suggestion ? escapeHtml(t.suggestionPrefix) + escapeHtml(this.request.finding.suggestion) : ''}</div>
  </div>
  <div class="supplement">
    <label class="supp-label" for="supp">${escapeHtml(t.supplementLabel)}</label>
    <textarea id="supp" class="supp-input" rows="2" placeholder="${escapeHtml(t.supplementPlaceholder)}">${escapeHtml(this.currentSupplement)}</textarea>
    <div class="hint">${escapeHtml(t.supplementHint)}</div>
  </div>
  <div class="toolbar">
    <button id="regenerate" class="primary">${escapeHtml(t.regenerate)}</button>
    <button id="cancel">${escapeHtml(t.close)}</button>
  </div>
  <div id="body"></div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const T = ${T};
    const fmt = (s, ...a) => String(s).replace(/\\{(\\d+)\\}/g, (_, i) => a[Number(i)] ?? '');
    const body = document.getElementById('body');
    const suppEl = document.getElementById('supp');
    const regenBtn = document.getElementById('regenerate');
    function syncRegenLabel() {
      regenBtn.textContent = (suppEl && suppEl.value.trim()) ? T.regenerateWithSupplement : T.regenerate;
    }
    if (suppEl) { suppEl.addEventListener('input', syncRegenLabel); syncRegenLabel(); }
    regenBtn.addEventListener('click', () => vscode.postMessage({ type: 'regenerate', supplement: suppEl ? suppEl.value : '' }));
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
          body.innerHTML = '<div class="status error">' + esc(T.noProposals) + '</div>';
          return;
        }
        const banner = state.lastApplied
          ? '<div class="status applied">' + esc(T.appliedBannerPrefix) + '<strong>' + esc(state.lastApplied) + '</strong>' + esc(T.appliedBannerSuffix) + '</div>'
          : '';
        const anyApplied = state.proposals.some(function (p) { return p.applied; });
        const altNote = (state.proposals.length > 1 && !state.lastApplied)
          ? '<div class="hint">' + esc(T.mutexHint) + '</div>'
          : '';
        const cards = state.proposals.map((p, i) => {
          const editCount = (p.edits && p.edits.length) || 1;
          const multi = editCount > 1 ? fmt(T.editCount, editCount) : '';
          const lockedByOther = anyApplied && !p.applied;
          let badge;
          if (p.applied) {
            badge = '<span class="badge ok">' + esc(T.badgeApplied) + multi + '</span>';
          } else if (lockedByOther) {
            badge = '<span class="badge muted">' + esc(fmt(T.badgeAlternative, i + 1)) + multi + '</span>';
          } else if (p.applicable) {
            badge = '<span class="badge">' + esc(fmt(T.badgeProposal, i + 1)) + multi + '</span>';
          } else {
            // Diagnose precisely: 0 = snippet not found (file changed / drift),
            // >1 = ambiguous. The old "{bad}/{total}" read like a success count
            // ("1/1") and confused users. Show the worst edit's real状况 plus a
            // hover with every edit's match count.
            const ms = p.matches || [];
            const gone = ms.filter(function (m) { return m === 0; }).length;
            const ambig = ms.filter(function (m) { return m > 1; }).length;
            const label = gone > 0 ? T.badgeNotFound : T.badgeAmbiguous;
            const detail = ms.map(function (m, k) { return fmt(T.editMatchDetail, k + 1, m); }).join('\\n');
            badge = '<span class="badge bad-badge" title="' + esc(detail) + '">' + esc(label) + '</span>';
          }
          let btn;
          if (p.applied) {
            btn = '<button data-undo="' + i + '">' + esc(T.undoBtn) + '</button>';
          } else if (lockedByOther) {
            btn = '<button disabled title="' + esc(T.otherSelectedTitle) + '">' + esc(T.otherSelected) + '</button>';
          } else if (p.applicable) {
            btn = '<button class="primary" data-apply="' + i + '">' + esc(T.applyBtn) + '</button>';
          } else {
            btn = '<button disabled>' + esc(T.cannotApply) + '</button>';
          }
          const hint = (!p.applied && !lockedByOther && p.applicable)
            ? '<div class="hint">' + esc(T.applyHint) + '</div>'
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
      } else if (msg && msg.type === 'supplement') {
        if (suppEl) {
          suppEl.value = String(msg.value ?? '');
          syncRegenLabel();
        }
      } else if (msg && msg.type === 'header') {
        const el = document.getElementById('subline');
        if (el) el.textContent = msg.rel + ' · ' + fmt(T.line, msg.line);
        const t = document.getElementById('f-title');
        if (t) t.textContent = msg.title;
        const d = document.getElementById('f-detail');
        if (d) d.textContent = msg.detail;
        const s = document.getElementById('f-suggest');
        if (s) {
          if (msg.suggestion) { s.textContent = T.suggestionPrefix + msg.suggestion; s.style.display = ''; }
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
 * Chooses a stable editor column for the fix-proposal panel: the column right of
 * the document (code) view, so the layout is consistently workbench | code | fix.
 * Falls back to Beside when the document view's column is unknown.
 */
function fixProposalColumn(): vscode.ViewColumn {
  const docCol = DocumentPanel.viewColumn;
  if (typeof docCol === 'number') {
    return (docCol + 1) as vscode.ViewColumn;
  }
  return vscode.ViewColumn.Beside;
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
    rows.push(diffRow('ctx', ' ', m().fixPanel.emptyDiff));
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
  return locateEditOffsets(haystack, needle).length;
}

/**
 * Locates every occurrence of `needle` inside `haystack` tolerantly: comparison
 * is line-based with trailing whitespace and EOL (CRLF/LF) ignored, so a model
 * snippet whose indentation/line-endings differ slightly from the file still
 * matches. Returns character offset ranges into the ORIGINAL `haystack` (so the
 * exact bytes can be replaced). Leading/trailing blank lines in `needle` are
 * dropped so the match lands on real content.
 *
 * This fixes the "看得见却无法应用" case where exact `indexOf(oldText)` failed on
 * whitespace differences.
 */
function locateEditOffsets(haystack: string, needle: string): { start: number; end: number }[] {
  const strict = locateLinesBy(haystack, needle, trimEndOnly);
  if (strict.length > 0) {
    return strict;
  }
  const tolerant = locateLinesBy(haystack, needle, trimBothEnds);
  if (tolerant.length > 0) {
    return tolerant;
  }
  // Models frequently drop a trailing comma/semicolon on a JSON/JS boundary line
  // (file has "}," but the snippet has "}"), which breaks the exact line compare.
  const noPunct = locateLinesBy(haystack, needle, trimNoPunct);
  if (noPunct.length > 0) {
    return noPunct;
  }
  // Collapse internal whitespace runs — handles operator/comment/tab-vs-space
  // spacing differences inside a line (e.g. "a == b" vs "a  ==  b").
  const collapsed = locateLinesBy(haystack, needle, trimCollapse);
  if (collapsed.length > 0) {
    return collapsed;
  }
  // Last resort: ignore ALL whitespace and interior blank lines, so a multi-line
  // block that differs only by space-vs-nospace adjacency ("//x" vs "// x",
  // "( a )" vs "(a)") or a reflowed blank line still matches. The replacement
  // still rewrites the file's real byte span, so nothing is corrupted.
  return locateFlexibleBlock(haystack, needle);
}

/** Leading run of spaces/tabs on a line (its indentation). */
function leadingWhitespace(s: string): string {
  return (s.match(/^[ \t]*/) || [''])[0];
}

const trimEndOnly = (l: string) => l.replace(/\s+$/, '');
const trimBothEnds = (l: string) => l.trim();
/** Trim both ends, then drop a single trailing comma/semicolon (JSON/JS boundary drift). */
const trimNoPunct = (l: string) => l.trim().replace(/[,;]$/, '');
/** Collapse internal whitespace runs to one space (+ drop trailing , ;). */
const trimCollapse = (l: string) => l.trim().replace(/\s+/g, ' ').replace(/[,;]$/, '');
/** Remove ALL whitespace (+ drop trailing , ;) — the most lenient line compare. */
const stripAllWs = (l: string) => l.replace(/\s+/g, '').replace(/[,;]$/, '');

/**
 * Line-based matcher: returns char-offset ranges into the ORIGINAL `haystack`
 * for every place `needle` occurs, comparing lines through `norm` (callers pick
 * how tolerant). Leading/trailing blank needle lines are dropped so a match
 * lands on real content.
 */
function locateLinesBy(
  haystack: string,
  needle: string,
  norm: (l: string) => string,
): { start: number; end: number }[] {
  const lines: { start: number; end: number; text: string }[] = [];
  let pos = 0;
  for (const raw of haystack.split('\n')) {
    // raw excludes the '\n'; it may still carry a trailing '\r'.
    lines.push({ start: pos, end: pos + raw.length, text: norm(raw) });
    pos += raw.length + 1; // +1 for the '\n' we split on
  }
  let needleLines = needle.split(/\r?\n/).map(norm);
  while (needleLines.length > 0 && needleLines[0] === '') {
    needleLines.shift();
  }
  while (needleLines.length > 0 && needleLines[needleLines.length - 1] === '') {
    needleLines.pop();
  }
  if (needleLines.length === 0) {
    return [];
  }
  const out: { start: number; end: number }[] = [];
  for (let i = 0; i + needleLines.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < needleLines.length; j++) {
      if (lines[i + j].text !== needleLines[j]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      out.push({ start: lines[i].start, end: lines[i + needleLines.length - 1].end });
    }
  }
  return out;
}

/**
 * Most-lenient block matcher: compares only NON-BLANK lines with ALL whitespace
 * removed, so a snippet that differs from the file by space-vs-nospace adjacency,
 * operator/comment spacing, or an added/dropped interior blank line still
 * matches. The returned span covers the contiguous real bytes from the first to
 * the last matched line (interleaved blank lines included), so the caller can
 * replace the exact original block. Used only as the final fallback.
 */
function locateFlexibleBlock(
  haystack: string,
  needle: string,
): { start: number; end: number }[] {
  const hlines: { start: number; end: number; norm: string }[] = [];
  let pos = 0;
  for (const raw of haystack.split('\n')) {
    hlines.push({ start: pos, end: pos + raw.length, norm: stripAllWs(raw) });
    pos += raw.length + 1;
  }
  // Indices of non-blank haystack lines (after stripping all whitespace).
  const hIdx: number[] = [];
  for (let i = 0; i < hlines.length; i++) {
    if (hlines[i].norm !== '') {
      hIdx.push(i);
    }
  }
  const nNorm = needle.split(/\r?\n/).map(stripAllWs).filter((l) => l !== '');
  if (nNorm.length === 0) {
    return [];
  }
  const out: { start: number; end: number }[] = [];
  for (let a = 0; a + nNorm.length <= hIdx.length; a++) {
    let ok = true;
    for (let b = 0; b < nNorm.length; b++) {
      if (hlines[hIdx[a + b]].norm !== nNorm[b]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      out.push({ start: hlines[hIdx[a]].start, end: hlines[hIdx[a + nNorm.length - 1]].end });
    }
  }
  return out;
}

/**
 * Resolves one edit against the live file for application: the exact byte range
 * to replace plus the replacement text, or `null` when the edit cannot be placed
 * uniquely (zero or multiple matches — never guess). Walks the same tolerance
 * ladder as {@link locateEditOffsets}, least-aggressive first, refusing on
 * ambiguity at every rung. Beyond the strict rung the replacement is re-indented
 * to the file's actual indent so applying never strips indentation.
 */
function resolveEditAt(
  haystack: string,
  oldText: string,
  newText: string,
): { start: number; end: number; replacement: string } | null {
  // L1 strict: replacement verbatim (zero regression when the snippet matches).
  const strict = locateLinesBy(haystack, oldText, trimEndOnly);
  if (strict.length === 1) {
    return { start: strict[0].start, end: strict[0].end, replacement: newText };
  }
  if (strict.length > 1) {
    return null;
  }
  // L2 indentation-tolerant: reindent the replacement to the file's indent.
  const tolerant = locateLinesBy(haystack, oldText, trimBothEnds);
  if (tolerant.length === 1) {
    const hit = tolerant[0];
    return { start: hit.start, end: hit.end, replacement: reindentToFile(haystack, hit, newText) };
  }
  if (tolerant.length > 1) {
    return null;
  }
  // L3 trailing-punct, L4 collapsed-whitespace, L5 flexible block: each reindents
  // and preserves the file's own trailing , ; when newText dropped it. Try the
  // least-aggressive first; refuse on ambiguity at every rung (never guess).
  for (const hits of [
    locateLinesBy(haystack, oldText, trimNoPunct),
    locateLinesBy(haystack, oldText, trimCollapse),
    locateFlexibleBlock(haystack, oldText),
  ]) {
    if (hits.length > 1) {
      return null;
    }
    if (hits.length === 1) {
      const h = hits[0];
      let replacement = reindentToFile(haystack, h, newText);
      const filePunct = (haystack.slice(h.start, h.end).match(/[,;]\s*$/) || [''])[0].trim();
      if (filePunct && !/[,;]\s*$/.test(replacement)) {
        replacement += filePunct;
      }
      return { start: h.start, end: h.end, replacement };
    }
  }
  return null;
}

/**
 * Re-indents `newText` so its outermost indentation matches the file line at
 * `hit.start`, preserving `newText`'s internal relative indentation. Used only
 * on the tolerant-fallback path, where the model dropped/changed leading indent.
 */
function reindentToFile(
  haystack: string,
  hit: { start: number; end: number },
  newText: string,
): string {
  let nlPos = haystack.indexOf('\n', hit.start);
  if (nlPos === -1 || nlPos > hit.end) {
    nlPos = hit.end;
  }
  const origIndent = leadingWhitespace(haystack.slice(hit.start, nlPos));
  const lines = newText.split('\n');
  let minIndent = Infinity;
  for (const l of lines) {
    if (l.trim() === '') {
      continue;
    }
    minIndent = Math.min(minIndent, leadingWhitespace(l).length);
  }
  if (!isFinite(minIndent)) {
    minIndent = 0;
  }
  return lines.map((l) => (l.trim() === '' ? '' : origIndent + l.slice(minIndent))).join('\n');
}


