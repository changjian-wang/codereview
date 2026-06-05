import * as vscode from 'vscode';
import type { FindingSeverity } from '../ai/types';
import { esc, escAttr, nonce as makeNonce } from './html';

export type FindingDispositionKind = 'fixed' | 'commented' | 'ignored';

/** A file row in the workbench sidebar. */
export interface WorkbenchFile {
  path: string;
  name: string;
  dir: string;
  seen: number;
  total: number;
  analyzed: boolean;
  ready: boolean;
  fullySeen: boolean;
  unconfirmed: number;
  findings: number;
  change?: 'add' | 'del' | 'role';
  active: boolean;
  /** True while an LLM analysis request for this file is in flight. */
  analyzing: boolean;
}

/** A finding shown in the inspector for the selected file. */
export interface WorkbenchFinding {
  id: string;
  line: number;
  severity: FindingSeverity;
  title: string;
  detail: string;
  suggestion?: string;
  disposition?: FindingDispositionKind;
  dispositionReason?: string;
}

/** Serializable snapshot the webview renders. */
export interface WorkbenchState {
  /** True when a review has been started and we have a review set loaded. */
  hasReviewSet: boolean;
  label: string;
  files: WorkbenchFile[];
  selected?: string;
  findings: WorkbenchFinding[];
  coverage: { seen: number; total: number; filesReady: number; filesTotal: number };
  gatePassed: boolean;
  globalDone: boolean;
  hasGlobalReport: boolean;
  modelLabel: string;
  conclusion?: {
    label: string;
    target: 'pr' | 'local';
    prNumber?: number;
    submittedAt: number;
  };
}

/** Actions the workbench can trigger in the extension host. */
export interface WorkbenchActions {
  open(path: string): void;
  disposeFinding(path: string, id: string, kind: FindingDispositionKind): void;
  locate(path: string, line: number): void;
  globalAnalysis(): void;
  cancelGlobalAnalysis(): void;
  showGlobal(): void;
  submit(): void;
  pickModel(): void;
  /** Opens the scope picker (used both for first-time review and for switching). */
  pickScope(): void;
}

interface FilePatch {
  path: string;
  active: boolean;
  ready: boolean;
  dotClass: 'done' | 'analyzing' | 'partial' | 'none';
  dotTitle: string;
  unconfirmed: number;
  analyzed: boolean;
  findings: number;
  seen: number;
  total: number;
  analyzing: boolean;
}

interface FolderPatch {
  path: string;
  dotClass: 'done' | 'partial' | 'none';
  ready: number;
  filesTotal: number;
}

interface WorkbenchPatchSnapshot {
  files: Map<string, FilePatch>;
  folders: Map<string, FolderPatch>;
  selected?: string;
  coverage: WorkbenchState['coverage'];
  gatePassed: boolean;
  globalDone: boolean;
  hasGlobalReport: boolean;
  modelLabel: string;
  conclusion?: WorkbenchState['conclusion'];
}

type InboundMessage =
  | { type: 'select'; path: string }
  | { type: 'dispose'; path: string; id: string; kind: FindingDispositionKind }
  | { type: 'locate'; path: string; line: number }
  | { type: 'global' }
  | { type: 'cancelGlobal' }
  | { type: 'showGlobal' }
  | { type: 'submit' }
  | { type: 'pickModel' }
  | { type: 'pickScope' }
  | { type: 'toggleFolder'; path: string };

/**
 * The Review Workbench: a full webview panel that renders the prototype-style
 * left sidebar (file tree + coverage HUD + gate) and right inspector (findings
 * cards). Source code stays in the real editor opened beside this panel.
 */
export class WorkbenchPanel {
  private static current?: WorkbenchPanel;
  /** Folder expand/collapse state, kept static so it survives panel close/reopen. */
  private static readonly expandedFolders = new Set<string>();
  private static folderInit = false;
  /** Last selected path whose ancestors were auto-expanded, so we only do it on selection change. */
  private static lastAutoExpandedSelection?: string;
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private get expandedFolders(): Set<string> {
    return WorkbenchPanel.expandedFolders;
  }
  private refreshTimer?: ReturnType<typeof setTimeout>;
  /** Whether the full HTML shell has been rendered at least once into the live webview. */
  private rendered = false;
  /** Signature of the file set last rendered as full HTML; a change forces a full rebuild. */
  private lastStructureSig?: string;
  /** Last dynamic snapshot used to compute incremental tree / HUD patches. */
  private lastSnapshot?: WorkbenchPatchSnapshot;

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly getState: () => WorkbenchState,
    private readonly actions: WorkbenchActions,
  ) {
    this.panel = panel;
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (msg: InboundMessage) => this.handle(msg),
      null,
      this.disposables,
    );
  }

  static show(getState: () => WorkbenchState, actions: WorkbenchActions): WorkbenchPanel {
    if (WorkbenchPanel.current) {
      WorkbenchPanel.current.refresh();
      // Pass `undefined` to keep the panel in its current view column / window
      // (it may have been moved to an auxiliary window via "move editor to new window").
      WorkbenchPanel.current.panel.reveal(undefined, /* preserveFocus */ true);
      return WorkbenchPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      'codereview.workbench',
      'Code Review · 工作台',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    const instance = new WorkbenchPanel(panel, getState, actions);
    WorkbenchPanel.current = instance;
    instance.refresh();
    void instance.applyFocusedMode();
    return instance;
  }

  /**
   * Adopts a panel that VS Code restored after a window reload (via the
   * webview-panel serializer) instead of creating a fresh one. Re-applies the
   * webview options the restored frame lost, wires handlers, and renders.
   */
  static adopt(
    panel: vscode.WebviewPanel,
    getState: () => WorkbenchState,
    actions: WorkbenchActions,
  ): WorkbenchPanel {
    WorkbenchPanel.current?.panel.dispose();
    panel.webview.options = { enableScripts: true };
    const instance = new WorkbenchPanel(panel, getState, actions);
    WorkbenchPanel.current = instance;
    instance.refresh();
    void instance.applyFocusedMode();
    return instance;
  }

  static get isOpen(): boolean {
    return !!WorkbenchPanel.current;
  }

  /** Re-renders the panel from current session state, if open. */
  static refreshIfOpen(): void {
    WorkbenchPanel.current?.scheduleRefresh();
  }

  /**
   * Drives the inline global-analysis progress strip in the workbench (instead
   * of a parent-window notification, which is easy to miss when the workbench
   * lives in its own auxiliary window). `active` toggles the busy state; the
   * optional `message` is the current step shown beneath the progress bar.
   */
  static setGlobalProgress(active: boolean, message?: string): void {
    void WorkbenchPanel.current?.panel.webview.postMessage({
      type: 'globalProgress',
      active,
      message: message ?? '',
    });
  }

  /** Clears persisted folder expand/collapse state so a new review re-initialises it. */
  static resetFolders(): void {
    WorkbenchPanel.expandedFolders.clear();
    WorkbenchPanel.folderInit = false;
    WorkbenchPanel.lastAutoExpandedSelection = undefined;
  }

  /**
   * Coalesces bursts of progress events (e.g. markSeen firing per scroll) into a
   * single re-render so the webview is not rebuilt dozens of times per second.
   */
  private scheduleRefresh(): void {
    if (this.refreshTimer) {
      return;
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this.refresh();
    }, 80);
  }

  refresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    const state = this.getState();
    const sig = state.hasReviewSet ? structureSig(state.files) : '__empty__';
    // Hot path: while the file set is unchanged (the common case during a
    // review — only progress / findings / selection change), patch the live
    // DOM in place via postMessage instead of reassigning `webview.html`, which
    // would force a full reload + re-parse + relayout of thousands of nodes.
    if (this.rendered && sig === this.lastStructureSig && state.hasReviewSet) {
      void this.panel.webview.postMessage({ type: 'patch', ...this.computePatch(state) });
      return;
    }
    this.lastStructureSig = sig;
    this.rendered = true;
    this.lastSnapshot = snapshotFor(state);
    this.panel.webview.html = this.render(state);
  }

  /**
   * Computes the minimal dynamic delta while the file-tree structure stays the
   * same: changed file rows, changed folder rollups, and footer/toolbar state.
   */
  private computePatch(state: WorkbenchState): {
    files: FilePatch[];
    folders: FolderPatch[];
    selected?: string;
    coverage: WorkbenchState['coverage'];
    gatePassed: boolean;
    globalDone: boolean;
    hasGlobalReport: boolean;
    modelLabel: string;
    conclusion?: WorkbenchState['conclusion'];
  } {
    const next = snapshotFor(state);
    const prev = this.lastSnapshot;
    this.lastSnapshot = next;
    if (!prev) {
      return {
        files: [...next.files.values()],
        folders: [...next.folders.values()],
        selected: next.selected,
        coverage: next.coverage,
        gatePassed: next.gatePassed,
        globalDone: next.globalDone,
        hasGlobalReport: next.hasGlobalReport,
        modelLabel: next.modelLabel,
        conclusion: next.conclusion,
      };
    }
    const files: FilePatch[] = [];
    for (const [path, patch] of next.files) {
      const before = prev.files.get(path);
      if (!before || !sameFilePatch(before, patch)) {
        files.push(patch);
      }
    }
    const folders: FolderPatch[] = [];
    for (const [path, patch] of next.folders) {
      const before = prev.folders.get(path);
      if (!before || !sameFolderPatch(before, patch)) {
        folders.push(patch);
      }
    }
    return {
      files,
      folders,
      selected: next.selected,
      coverage: next.coverage,
      gatePassed: next.gatePassed,
      globalDone: next.globalDone,
      hasGlobalReport: next.hasGlobalReport,
      modelLabel: next.modelLabel,
      conclusion: next.conclusion,
    };
  }

  private handle(msg: InboundMessage): void {
    switch (msg.type) {
      case 'select':
        this.actions.open(msg.path);
        break;
      case 'dispose':
        this.actions.disposeFinding(msg.path, msg.id, msg.kind);
        break;
      case 'locate':
        this.actions.locate(msg.path, msg.line);
        break;
      case 'global':
        this.actions.globalAnalysis();
        break;
      case 'cancelGlobal':
        this.actions.cancelGlobalAnalysis();
        break;
      case 'showGlobal':
        this.actions.showGlobal();
        break;
      case 'submit':
        this.actions.submit();
        break;
      case 'pickModel':
        this.actions.pickModel();
        break;
      case 'pickScope':
        this.actions.pickScope();
        break;
      case 'toggleFolder':
        // The webview already toggled the `collapsed` CSS class optimistically,
        // so the visual change is instant. We only record the state here for
        // future full re-renders — re-rendering now would replace the entire
        // webview HTML, reset scroll position, and cause visible jitter/drift.
        if (this.expandedFolders.has(msg.path)) {
          this.expandedFolders.delete(msg.path);
        } else {
          this.expandedFolders.add(msg.path);
        }
        break;
    }
  }

  private render(state: WorkbenchState): string {
    const nonce = makeNonce();
    const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;

    if (!state.hasReviewSet) {
      return this.renderEmpty(nonce, csp);
    }

    const pct = state.coverage.total > 0
      ? Math.round((state.coverage.seen / state.coverage.total) * 100)
      : 0;

    const treeRoot = compactTree(buildTree(state.files));

    if (!WorkbenchPanel.folderInit && (treeRoot.children?.length ?? 0) > 0) {
      WorkbenchPanel.folderInit = true;
      for (const child of treeRoot.children ?? []) {
        if (child.kind === 'folder') {
          this.expandedFolders.add(child.fullPath);
        }
      }
    }

    if (state.selected && state.selected !== WorkbenchPanel.lastAutoExpandedSelection) {
      WorkbenchPanel.lastAutoExpandedSelection = state.selected;
      let p = state.selected;
      while (p.includes('/')) {
        p = p.slice(0, p.lastIndexOf('/'));
        this.expandedFolders.add(p);
      }
    }

    const rows = flattenRows(treeRoot);
    const expanded = [...this.expandedFolders];

    const gateReason: string[] = [];
    if (state.coverage.filesReady < state.coverage.filesTotal) {
      gateReason.push(`${state.coverage.filesTotal - state.coverage.filesReady} 个文件未读完并确认`);
    }
    if (!state.globalDone) {
      gateReason.push('全局结论未确认');
    }
    const gateOk = state.gatePassed;

    const conclusionHtml = state.conclusion
      ? `<div class="conclusion">已提交结论：<b>${esc(state.conclusion.label)}</b>` +
        `<span class="conc-meta">${
          state.conclusion.target === 'pr' && state.conclusion.prNumber
            ? `已写回 PR #${state.conclusion.prNumber} · `
            : '本地记录 · '
        }${esc(formatTime(state.conclusion.submittedAt))}</span></div>`
      : '';

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style>
  :root {
    --purple:#c586c0; --purple-bg:rgba(197,134,192,.16);
    --red:#f14c4c; --red-bg:rgba(241,76,76,.14);
    --green:#4ec9b0; --green-bg:rgba(78,201,176,.14);
    --yellow:#d8c020; --yellow-bg:rgba(216,192,32,.12);
    --blue:#569cd6; --blue-bg:rgba(86,156,214,.16);
    --line:var(--vscode-panel-border);
    --elevated:var(--vscode-editorWidget-background, rgba(127,127,127,.07));
    --dim:var(--vscode-descriptionForeground);
    --row-h:26px;
  }
  * { box-sizing:border-box; }
  body { margin:0; font-family:var(--vscode-font-family); color:var(--vscode-foreground); font-size:13px; }
  .workbench { display:flex; flex-direction:column; height:100vh; }

  /* sidebar (now the whole panel) */
  .sidebar { flex:1; display:flex; flex-direction:column; min-height:0;
    background:linear-gradient(180deg, var(--purple-bg), transparent 220px); }
  .sb-head { padding:.7rem .85rem .55rem; border-bottom:1px solid var(--line); }
  .sb-title { font-size:.72rem; text-transform:uppercase; letter-spacing:.06em; color:var(--dim); }
  .sb-label { font-weight:700; margin-top:.15rem; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .sb-row { display:flex; align-items:center; gap:.5rem; margin-top:.15rem; }
  .sb-row .sb-label { flex:1; margin:0; }
  .sb-switch { font-size:.7rem; padding:.22rem .5rem; }

  .filter-row { padding:.4rem .55rem; border-bottom:1px solid var(--line); }
  .filter-row input { width:100%; box-sizing:border-box; font-family:inherit; font-size:.78rem;
    padding:.35rem .5rem; border-radius:5px; border:1px solid var(--line);
    background:var(--vscode-input-background, rgba(127,127,127,.08));
    color:var(--vscode-input-foreground, inherit); }
  .filter-row input:focus { outline:1px solid var(--vscode-focusBorder); }

  .tree { flex:1; overflow:auto; padding:0; min-height:0; position:relative; }
  .tree-sizer { position:relative; width:100%; }
  .trow { position:absolute; left:0; right:0; height:var(--row-h); display:flex;
    align-items:center; gap:.4rem; padding:0 .45rem; border-radius:6px; cursor:pointer; }
  .tfolder:hover, .tnode:hover { background:var(--vscode-list-hoverBackground); }
  .tfolder .caret { display:inline-block; width:11px; text-align:center;
    transition:transform .15s ease; transform:rotate(0deg); color:var(--dim); flex-shrink:0; }
  .tfolder.expanded .caret { transform:rotate(90deg); }
  .tfolder .ficon { flex-shrink:0; opacity:.85; }
  .tfolder .tname { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:500; }
  .tfolder .tcount { font-family:var(--vscode-editor-font-family); font-size:.68rem;
    color:var(--dim); flex-shrink:0; }

  .tnode.active { background:var(--purple-bg); box-shadow:inset 2px 0 0 var(--purple); }
  .tnode.ready { opacity:.72; }
  .seen-dot { width:8px; height:8px; border-radius:50%; flex-shrink:0; }
  .seen-dot.none { background:transparent; border:1.5px solid var(--vscode-charts-orange, #d89614); }
  .seen-dot.partial { background:var(--yellow); }
  .seen-dot.analyzing { background:var(--vscode-charts-blue, #3794ff); }
  .seen-dot.done { background:var(--green); }
  .seen-dot.working { background:var(--vscode-charts-blue, #3794ff);
    box-shadow:0 0 0 0 rgba(55,148,255,.6); animation:dotPulse 1s ease-out infinite; }
  @keyframes dotPulse {
    0% { box-shadow:0 0 0 0 rgba(55,148,255,.55); }
    70% { box-shadow:0 0 0 5px rgba(55,148,255,0); }
    100% { box-shadow:0 0 0 0 rgba(55,148,255,0); }
  }
  .tnode.ready .tname { color:var(--green); }
  .tname { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .chg { font-family:var(--vscode-editor-font-family); font-size:.7rem; padding:0 .3rem; border-radius:4px; flex-shrink:0; }
  .chg.add { background:var(--green-bg); color:var(--green); }
  .chg.del { background:var(--red-bg); color:var(--red); }
  .chg.role { background:var(--blue-bg); color:var(--blue); }
  .fix-flag { font-size:.66rem; min-width:15px; height:15px; padding:0 4px; border-radius:8px; background:var(--red); color:#fff; display:inline-flex; align-items:center; justify-content:center; flex-shrink:0; }
  .ok-flag { color:var(--green); flex-shrink:0; }
  .tcov { font-family:var(--vscode-editor-font-family); font-size:.68rem; color:var(--dim); flex-shrink:0; }

  /* coverage HUD + gate (sidebar footer) */
  .hud { padding:.7rem .85rem; border-top:1px solid var(--line); background:var(--elevated); }
  .hud-row { display:flex; align-items:center; gap:.5rem; margin-bottom:.5rem; }
  .hud-row .lbl { font-size:.72rem; color:var(--dim); }
  .hud-row .val { margin-left:auto; font-weight:700; }
  .cov-track { height:8px; border-radius:5px; background:var(--vscode-progressBar-background, rgba(127,127,127,.25)); overflow:hidden; }
  .cov-fill { height:100%; border-radius:5px; background:linear-gradient(90deg, var(--green), var(--blue)); transition:width .3s; }
  .gate-chip { margin-top:.6rem; display:flex; align-items:center; gap:.5rem; padding:.45rem .6rem; border-radius:7px; font-size:.78rem; }
  .gate-chip.locked { background:var(--yellow-bg); border:1px solid rgba(216,192,32,.35); color:var(--yellow); }
  .gate-chip.ok { background:var(--green-bg); border:1px solid rgba(78,201,176,.4); color:var(--green); }
  .gate-reason { font-size:.7rem; color:var(--dim); margin-top:.4rem; line-height:1.5; }
  .conclusion { margin-top:.6rem; padding:.5rem .6rem; border-radius:7px; font-size:.76rem; background:var(--green-bg); border:1px solid rgba(78,201,176,.4); color:var(--green); }
  .conclusion .conc-meta { display:block; margin-top:.25rem; font-size:.68rem; color:var(--dim); }

  /* sidebar action toolbar */
  .toolbar { display:flex; flex-direction:column; gap:.4rem; padding:.55rem .7rem; border-top:1px solid var(--line); background:var(--elevated); }
  .toolbar .grp-label { font-size:.64rem; text-transform:uppercase; letter-spacing:.06em; color:var(--dim); margin:.2rem 0 -.05rem; }
  .toolbar .row { display:flex; gap:.4rem; }
  .toolbar .row button { flex:1; }
  /* inline global-analysis progress */
  .global-prog { display:flex; flex-direction:column; gap:.32rem; margin:.1rem 0 .15rem; }
  .global-prog[hidden] { display:none; }
  .gp-bar { position:relative; height:3px; border-radius:3px; overflow:hidden; background:var(--line); }
  .gp-fill { position:absolute; top:0; left:0; height:100%; width:36%; border-radius:3px; background:var(--blue); animation:gpSlide 1.1s ease-in-out infinite; }
  @keyframes gpSlide { 0% { left:-40%; } 100% { left:100%; } }
  .gp-foot { display:flex; align-items:center; gap:.5rem; }
  .gp-msg { flex:1; font-size:.7rem; color:var(--dim); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .gp-cancel { flex:none; font-size:.68rem; padding:.18rem .45rem; }
  /* busy global button: inline spinner */
  #global.busy { display:inline-flex; align-items:center; justify-content:center; gap:.4rem; cursor:progress; }
  .btn-spin { width:11px; height:11px; flex:none; border-radius:50%; border:2px solid color-mix(in srgb, var(--vscode-button-secondaryForeground, #ccc) 35%, transparent); border-top-color:var(--vscode-button-secondaryForeground, #ccc); animation:gpSpin .7s linear infinite; }
  @keyframes gpSpin { to { transform:rotate(360deg); } }
  .model-row { display:flex; align-items:center; gap:.4rem; margin-top:.3rem; padding-top:.5rem; border-top:1px dashed var(--line); }
  .model-label { flex:1; font-size:.74rem; color:var(--dim); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .model-label b { color:var(--blue); font-weight:600; }
  .model-row button { flex:none; }
  button { font-family:inherit; font-size:.78rem; cursor:pointer; border:1px solid var(--line); border-radius:5px; padding:.34rem .5rem; background:var(--vscode-button-secondaryBackground); color:var(--vscode-button-secondaryForeground); white-space:nowrap; }
  button:hover { background:var(--vscode-toolbar-hoverBackground); }
  button.primary { background:var(--vscode-button-background); color:var(--vscode-button-foreground); border-color:transparent; }
  button:disabled { opacity:.5; cursor:default; }
  .empty { color:var(--dim); text-align:center; margin-top:18vh; line-height:1.8; }
  .confirmed-tag { color:var(--green); font-size:.76rem; }
</style>
</head>
<body>
  <div class="workbench">
    <div class="sidebar">
      <div class="sb-head">
        <div class="sb-title">审查范围</div>
        <div class="sb-row">
          <div class="sb-label" title="${escAttr(state.label)}">${esc(state.label)}</div>
          <button id="pickScope" class="sb-switch" title="选择其他代码范围进行审查">切换范围…</button>
        </div>
      </div>
      <div class="filter-row">
        <input id="filter" type="search" placeholder="过滤文件路径…" autocomplete="off" />
      </div>
      <div class="tree" id="tree"><div class="tree-sizer" id="treeSizer"></div></div>
      <div class="toolbar">
        <div class="grp-label">整体审查</div>
        <div class="row">
          <button id="global">全局逻辑分析</button>
          <button id="showGlobal" ${state.hasGlobalReport ? '' : 'disabled'}>查看全局结论</button>
        </div>
        <div class="global-prog" id="globalProg" hidden>
          <div class="gp-bar"><div class="gp-fill"></div></div>
          <div class="gp-foot">
            <span class="gp-msg" id="globalProgMsg"></span>
            <button class="gp-cancel" id="globalCancel">取消</button>
          </div>
        </div>
        <div class="model-row">
          <span id="modelLabel" class="model-label" title="${escAttr(state.modelLabel)}">模型：<b>${esc(state.modelLabel)}</b></span>
          <button id="pickModel">切换</button>
        </div>
      </div>
      <div class="hud">
        <div class="hud-row"><span class="lbl">行覆盖</span><span id="covPct" class="val">${pct}%</span></div>
        <div class="cov-track"><div id="covFill" class="cov-fill" style="width:${pct}%"></div></div>
        <div class="hud-row" style="margin-top:.55rem; margin-bottom:0;">
          <span class="lbl">文件就绪</span><span id="filesReady" class="val">${state.coverage.filesReady}/${state.coverage.filesTotal}</span>
        </div>
        <div id="gateChip" class="gate-chip ${gateOk ? 'ok' : 'locked'}">
          <span id="gateIcon">${gateOk ? '✓' : '🔒'}</span>
          <span id="gateText">${gateOk ? '门禁已通过，可提交结论' : '门禁未通过'}</span>
        </div>
        <div id="gateReason" class="gate-reason" ${gateOk ? 'style="display:none"' : ''}>${gateOk ? '' : gateReason.map(esc).join('；')}</div>
        <button class="primary" id="submit" style="width:100%; margin-top:.6rem;" ${gateOk ? '' : 'disabled'}>提交审查结论</button>
        <div id="conclusionWrap">${conclusionHtml}</div>
      </div>
    </div>
  </div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const send = (m) => vscode.postMessage(m);
  const byId = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  const formatTime = (ms) => {
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  };

  // ---- Virtualized file tree -------------------------------------------------
  // The full row model is shipped once from the host; the webview keeps it in
  // memory and only ever renders the rows inside the current viewport window.
  // For a 4800-file review this keeps the live DOM at ~40 nodes instead of
  // thousands, so first paint and every patch stay cheap.
  const ROW_H = 26;
  const OVERSCAN = 8;
  const ROWS = ${JSON.stringify(rows)};
  const EXPANDED = new Set(${JSON.stringify(expanded)});
  const rowByPath = new Map();
  for (const r of ROWS) rowByPath.set(r.path, r);
  let selectedPath = ${JSON.stringify(state.selected ?? null)};
  let visible = [];

  const treeEl = byId('tree');
  const sizer = byId('treeSizer');
  const filterInput = byId('filter');
  const reviewKey = ${JSON.stringify(state.label)};

  function computeVisible() {
    const q = (filterInput.value || '').trim().toLowerCase();
    if (q) {
      const matched = new Set();
      const ancestors = new Set();
      for (const r of ROWS) {
        if (r.kind === 'file' && r.path.toLowerCase().includes(q)) {
          matched.add(r.path);
          let p = r.path;
          while (p.includes('/')) { p = p.slice(0, p.lastIndexOf('/')); ancestors.add(p); }
        }
      }
      visible = ROWS.filter((r) => r.kind === 'file' ? matched.has(r.path) : ancestors.has(r.path));
    } else {
      visible = [];
      let collapsedDepth = -1;
      for (const r of ROWS) {
        if (collapsedDepth >= 0 && r.depth > collapsedDepth) continue;
        collapsedDepth = -1;
        visible.push(r);
        if (r.kind === 'folder' && !EXPANDED.has(r.path)) collapsedDepth = r.depth;
      }
    }
  }

  function rowHtml(row, i) {
    const indent = row.depth * 12 + 8;
    const top = i * ROW_H;
    if (row.kind === 'folder') {
      const exp = EXPANDED.has(row.path);
      return '<div class="trow tfolder' + (exp ? ' expanded' : '') + '" data-kind="folder" data-path="' + esc(row.path) + '" style="top:' + top + 'px; padding-left:' + indent + 'px">'
        + '<span class="caret">\u25B8</span>'
        + '<span class="seen-dot ' + row.dotClass + '"></span>'
        + '<span class="ficon">\uD83D\uDCC1</span>'
        + '<span class="tname" title="' + esc(row.path) + '">' + esc(row.name) + '</span>'
        + '<span class="tcount">' + row.readyCount + '/' + row.filesTotal + '</span>'
        + '</div>';
    }
    const chg = row.change
      ? '<span class="chg ' + row.change + '">' + (row.change === 'add' ? '+' : row.change === 'del' ? '\u2212' : '~') + '</span>'
      : '';
    const dotClass = row.analyzing ? 'working' : row.dotClass;
    const dotTitle = row.analyzing ? '正在分析…' : row.dotTitle;
    const fix = row.unconfirmed > 0
      ? '<span class="fix-flag" title="' + row.unconfirmed + ' 个未确认发现">' + row.unconfirmed + '</span>'
      : (row.analyzed && row.findings === 0 ? '<span class="ok-flag" title="无发现">\u2713</span>' : '');
    const cov = row.total > 0 ? (row.seen + '/' + row.total) : '\u2014';
    return '<div class="trow tnode' + (row.active ? ' active' : '') + (row.ready ? ' ready' : '') + '" data-kind="file" data-path="' + esc(row.path) + '" style="top:' + top + 'px; padding-left:' + indent + 'px">'
      + '<span class="seen-dot ' + dotClass + '" title="' + esc(dotTitle) + '"></span>'
      + '<span class="tname" title="' + esc(row.path) + '">' + esc(row.name) + '</span>'
      + chg + fix
      + '<span class="tcov">' + cov + '</span>'
      + '</div>';
  }

  function renderWindow() {
    const total = visible.length;
    if (total === 0) {
      sizer.style.height = 'auto';
      sizer.innerHTML = '<div class="empty">' + (filterInput.value.trim() ? '无匹配文件' : '无文件') + '</div>';
      return;
    }
    sizer.style.height = (total * ROW_H) + 'px';
    const st = treeEl.scrollTop;
    const h = treeEl.clientHeight || 0;
    const start = Math.max(0, Math.floor(st / ROW_H) - OVERSCAN);
    const end = Math.min(total, Math.ceil((st + h) / ROW_H) + OVERSCAN);
    let html = '';
    for (let i = start; i < end; i++) html += rowHtml(visible[i], i);
    sizer.innerHTML = html;
  }

  function renderConclusion(c) {
    if (!c) return '';
    const target = c.target === 'pr' && c.prNumber ? ('已写回 PR #' + c.prNumber + ' · ') : '本地记录 · ';
    return '<div class="conclusion">已提交结论：<b>' + esc(c.label) + '</b>' +
      '<span class="conc-meta">' + target + esc(formatTime(c.submittedAt)) + '</span></div>';
  }

  function updateHud(msg) {
    const total = msg.coverage.total || 0;
    const pct = total > 0 ? Math.round((msg.coverage.seen / total) * 100) : 0;
    const covPct = byId('covPct'); if (covPct) covPct.textContent = pct + '%';
    const covFill = byId('covFill'); if (covFill) covFill.style.width = pct + '%';
    const filesReady = byId('filesReady'); if (filesReady) filesReady.textContent = msg.coverage.filesReady + '/' + msg.coverage.filesTotal;
    const gateChip = byId('gateChip'); if (gateChip) gateChip.className = 'gate-chip ' + (msg.gatePassed ? 'ok' : 'locked');
    const gateIcon = byId('gateIcon'); if (gateIcon) gateIcon.textContent = msg.gatePassed ? '✓' : '🔒';
    const gateText = byId('gateText'); if (gateText) gateText.textContent = msg.gatePassed ? '门禁已通过，可提交结论' : '门禁未通过';
    const gateReason = byId('gateReason');
    if (gateReason) {
      const reasons = [];
      if (msg.coverage.filesReady < msg.coverage.filesTotal) reasons.push((msg.coverage.filesTotal - msg.coverage.filesReady) + ' 个文件未读完并确认');
      if (!msg.globalDone) reasons.push('全局结论未确认');
      gateReason.textContent = reasons.join('；');
      gateReason.style.display = msg.gatePassed ? 'none' : '';
    }
    const submit = byId('submit'); if (submit) submit.disabled = !msg.gatePassed;
    const showGlobal = byId('showGlobal'); if (showGlobal) showGlobal.disabled = !msg.hasGlobalReport;
    const modelLabel = byId('modelLabel');
    if (modelLabel) { modelLabel.title = msg.modelLabel; modelLabel.innerHTML = '模型：<b>' + esc(msg.modelLabel) + '</b>'; }
    const conclusionWrap = byId('conclusionWrap'); if (conclusionWrap) conclusionWrap.innerHTML = renderConclusion(msg.conclusion);
  }

  // Event delegation: one listener handles every (virtualized) row.
  treeEl.addEventListener('click', (e) => {
    const el = e.target.closest('[data-kind]');
    if (!el) return;
    const path = el.dataset.path;
    if (el.dataset.kind === 'folder') {
      if (EXPANDED.has(path)) EXPANDED.delete(path); else EXPANDED.add(path);
      computeVisible();
      renderWindow();
      send({ type:'toggleFolder', path });
    } else {
      for (const r of ROWS) if (r.kind === 'file') r.active = (r.path === path);
      selectedPath = path;
      renderWindow();
      send({ type:'select', path });
    }
  });

  let scrollRaf = 0;
  treeEl.addEventListener('scroll', () => {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = 0;
      renderWindow();
      const s = vscode.getState() || {};
      s.treeScroll = treeEl.scrollTop;
      vscode.setState(s);
    });
  }, { passive: true });

  filterInput.addEventListener('input', () => {
    const s = vscode.getState() || {};
    s.filterScope = reviewKey;
    s.filter = filterInput.value;
    vscode.setState(s);
    computeVisible();
    treeEl.scrollTop = 0;
    renderWindow();
  });

  byId('global')?.addEventListener('click', () => {
    const btn = byId('global');
    // Guard against double-submit: disable on the spot, before the host round
    // trip. The host drives the real busy animation via globalProgress, and
    // always re-enables (even on an early return) so the button can't get stuck.
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    send({ type:'global' });
  });
  byId('globalCancel')?.addEventListener('click', () => send({ type:'cancelGlobal' }));
  byId('showGlobal')?.addEventListener('click', () => send({ type:'showGlobal' }));
  byId('pickModel')?.addEventListener('click', () => send({ type:'pickModel' }));
  byId('pickScope')?.addEventListener('click', () => send({ type:'pickScope' }));
  byId('submit')?.addEventListener('click', () => send({ type:'submit' }));

  function setGlobalProgress(active, message) {
    const wrap = byId('globalProg');
    const btn = byId('global');
    const cancel = byId('globalCancel');
    if (btn) {
      btn.disabled = !!active;
      btn.classList.toggle('busy', !!active);
      btn.innerHTML = active
        ? '<span class="btn-spin" aria-hidden="true"></span><span>分析中…</span>'
        : '全局逻辑分析';
    }
    if (cancel) cancel.disabled = false;
    if (wrap) wrap.hidden = !active;
    if (active) { const m = byId('globalProgMsg'); if (m) m.textContent = message || ''; }
  }

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg && msg.type === 'globalProgress') { setGlobalProgress(msg.active, msg.message); return; }
    if (!msg || msg.type !== 'patch') return;
    (msg.files || []).forEach((p) => {
      const r = rowByPath.get(p.path);
      if (!r || r.kind !== 'file') return;
      r.active = p.active; r.ready = p.ready; r.dotClass = p.dotClass; r.dotTitle = p.dotTitle;
      r.unconfirmed = p.unconfirmed; r.analyzed = p.analyzed; r.findings = p.findings;
      r.seen = p.seen; r.total = p.total; r.analyzing = p.analyzing;
    });
    (msg.folders || []).forEach((p) => {
      const r = rowByPath.get(p.path);
      if (!r || r.kind !== 'folder') return;
      r.dotClass = p.dotClass; r.readyCount = p.ready; r.filesTotal = p.filesTotal;
    });
    selectedPath = (typeof msg.selected === 'string') ? msg.selected : null;
    renderWindow();
    updateHud(msg);
  });

  // ---- Initial paint ---------------------------------------------------------
  const savedState = vscode.getState() || {};
  if (savedState.filterScope === reviewKey && typeof savedState.filter === 'string') {
    filterInput.value = savedState.filter;
  }
  computeVisible();
  renderWindow();
  if (typeof savedState.treeScroll === 'number') {
    treeEl.scrollTop = savedState.treeScroll;
    renderWindow();
  }
</script>
</body>
</html>`;
  }

  /** Empty hero shown when the workbench is open but no review has been started yet. */
  private renderEmpty(nonce: string, csp: string): string {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style>
  * { box-sizing:border-box; }
  body { margin:0; height:100vh; display:flex; align-items:center; justify-content:center;
    font-family:var(--vscode-font-family); color:var(--vscode-foreground);
    background:var(--vscode-editor-background); }
  .hero { max-width:520px; padding:32px 40px; text-align:center; }
  .hero h1 { font-size:1.4rem; margin:0 0 .8rem; font-weight:600; }
  .hero p { font-size:.92rem; line-height:1.6; color:var(--vscode-descriptionForeground); margin:0 0 1.5rem; }
  .hero button { font-family:inherit; font-size:.95rem; padding:.65rem 1.4rem; border-radius:6px;
    background:var(--vscode-button-background); color:var(--vscode-button-foreground);
    border:1px solid transparent; cursor:pointer; }
  .hero button:hover { background:var(--vscode-button-hoverBackground); }
  .hero .hint { font-size:.78rem; color:var(--vscode-descriptionForeground); margin-top:1.2rem; }
</style>
</head>
<body>
  <div class="hero">
    <h1>Code Review · 工作台</h1>
    <p>选择要审查的范围（本地文件 / 文件夹，或当前分支的 PR），开始一次审查。</p>
    <button id="pickScope" autofocus>选择审查范围…</button>
    <div class="hint">范围确定后即可在此窗口逐文件审查与全局分析。</div>
  </div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  document.getElementById('pickScope').addEventListener('click', () => vscode.postMessage({ type:'pickScope' }));
</script>
</body>
</html>`;
  }

  dispose(): void {
    WorkbenchPanel.current = undefined;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    this.panel.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  /**
   * Closes the side bar so the workbench panel feels like a dedicated app shell.
   * The activity bar is left alone so the user can still switch views.
   * Controlled by `codereview.focusedWorkbench`.
   */
  private async applyFocusedMode(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('codereview');
    if (!cfg.get<boolean>('focusedWorkbench', true)) {
      return;
    }
    await vscode.commands.executeCommand('workbench.action.closeSidebar').then(undefined, () => undefined);
  }
}

interface FolderStats {
  seen: number;
  total: number;
  ready: number;
  filesTotal: number;
  findings: number;
  unconfirmed: number;
}

interface TreeNode {
  kind: 'folder' | 'file';
  name: string;
  fullPath: string;
  children?: TreeNode[];
  file?: WorkbenchFile;
  stats?: FolderStats;
}

function buildTree(files: WorkbenchFile[]): TreeNode {
  const root: TreeNode = { kind: 'folder', name: '', fullPath: '', children: [] };
  for (const f of files) {
    const segments = f.path.split('/');
    let node: TreeNode = root;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const isLast = i === segments.length - 1;
      const segPath = segments.slice(0, i + 1).join('/');
      const wantKind: TreeNode['kind'] = isLast ? 'file' : 'folder';
      let child = node.children?.find((c) => c.name === seg && c.kind === wantKind);
      if (!child) {
        child = isLast
          ? { kind: 'file', name: seg, fullPath: segPath, file: f }
          : { kind: 'folder', name: seg, fullPath: segPath, children: [] };
        node.children!.push(child);
      }
      node = child;
    }
  }
  sortTree(root);
  computeStats(root);
  return root;
}

function sortTree(node: TreeNode): void {
  if (!node.children) return;
  node.children.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  node.children.forEach(sortTree);
}

function computeStats(node: TreeNode): FolderStats {
  if (node.kind === 'file' && node.file) {
    return {
      seen: node.file.seen,
      total: node.file.total,
      ready: node.file.ready ? 1 : 0,
      filesTotal: 1,
      findings: node.file.findings,
      unconfirmed: node.file.unconfirmed,
    };
  }
  const acc: FolderStats = { seen: 0, total: 0, ready: 0, filesTotal: 0, findings: 0, unconfirmed: 0 };
  for (const child of node.children ?? []) {
    const s = computeStats(child);
    acc.seen += s.seen;
    acc.total += s.total;
    acc.ready += s.ready;
    acc.filesTotal += s.filesTotal;
    acc.findings += s.findings;
    acc.unconfirmed += s.unconfirmed;
  }
  node.stats = acc;
  return acc;
}

function compactTree(node: TreeNode): TreeNode {
  if (node.kind === 'file') return node;
  const compactedChildren = (node.children ?? []).map(compactTree);
  if (
    node.fullPath !== '' &&
    compactedChildren.length === 1 &&
    compactedChildren[0].kind === 'folder'
  ) {
    const child = compactedChildren[0];
    return {
      kind: 'folder',
      name: `${node.name}/${child.name}`,
      fullPath: child.fullPath,
      children: child.children,
      stats: child.stats,
    };
  }
  return { ...node, children: compactedChildren };
}

function structureSig(files: WorkbenchFile[]): string {
  return files.map((f) => f.path).join('\n');
}

/** A flat row in the virtualized file tree (pre-order, depth-tagged). */
interface TreeRow {
  kind: 'file' | 'folder';
  path: string;
  name: string;
  depth: number;
  dotClass: 'done' | 'analyzing' | 'partial' | 'none';
  dotTitle?: string;
  change?: 'add' | 'del' | 'role';
  unconfirmed?: number;
  analyzed?: boolean;
  findings?: number;
  seen?: number;
  total?: number;
  ready?: boolean;
  active?: boolean;
  analyzing?: boolean;
  readyCount?: number;
  filesTotal?: number;
}

/**
 * Walks the compacted tree in display order, emitting one flat row per node.
 * The webview keeps this array in memory and only renders the rows currently in
 * the viewport, so a multi-thousand-file review never materialises its full DOM.
 */
function flattenRows(root: TreeNode): TreeRow[] {
  const out: TreeRow[] = [];
  const walk = (node: TreeNode, depth: number): void => {
    for (const child of node.children ?? []) {
      if (child.kind === 'file' && child.file) {
        const p = filePatchOf(child.file);
        out.push({
          kind: 'file',
          path: child.file.path,
          name: child.file.name,
          depth,
          dotClass: p.dotClass,
          dotTitle: p.dotTitle,
          change: child.file.change,
          unconfirmed: p.unconfirmed,
          analyzed: p.analyzed,
          findings: p.findings,
          seen: p.seen,
          total: p.total,
          ready: p.ready,
          active: child.file.active,
          analyzing: p.analyzing,
        });
      } else {
        const stats = child.stats ?? { seen: 0, total: 0, ready: 0, filesTotal: 0, findings: 0, unconfirmed: 0 };
        out.push({
          kind: 'folder',
          path: child.fullPath,
          name: child.name,
          depth,
          dotClass: stats.filesTotal > 0 && stats.ready === stats.filesTotal
            ? 'done'
            : stats.ready > 0 || stats.seen > 0
              ? 'partial'
              : 'none',
          readyCount: stats.ready,
          filesTotal: stats.filesTotal,
        });
        walk(child, depth + 1);
      }
    }
  };
  walk(root, 0);
  return out;
}

function snapshotFor(state: WorkbenchState): WorkbenchPatchSnapshot {
  const files = new Map<string, FilePatch>();
  for (const file of state.files) {
    files.set(file.path, filePatchOf(file));
  }
  const root = compactTree(buildTree(state.files));
  const folders = new Map<string, FolderPatch>();
  collectFolderPatches(root, folders);
  return {
    files,
    folders,
    selected: state.selected,
    coverage: state.coverage,
    gatePassed: state.gatePassed,
    globalDone: state.globalDone,
    hasGlobalReport: state.hasGlobalReport,
    modelLabel: state.modelLabel,
    conclusion: state.conclusion,
  };
}

function filePatchOf(file: WorkbenchFile): FilePatch {
  return {
    path: file.path,
    active: file.active,
    ready: file.ready,
    dotClass: file.ready
      ? 'done'
      : file.fullySeen
        ? 'analyzing'
        : file.seen > 0
          ? 'partial'
          : 'none',
    dotTitle: file.ready
      ? '已就绪'
      : file.fullySeen
        ? file.analyzed ? '已读完，发现待确认' : '已读完，待分析'
        : file.seen > 0
          ? `已读 ${file.seen}/${file.total} 行`
          : '未开始',
    unconfirmed: file.unconfirmed,
    analyzed: file.analyzed,
    findings: file.findings,
    seen: file.seen,
    total: file.total,
    analyzing: file.analyzing,
  };
}

function collectFolderPatches(node: TreeNode, out: Map<string, FolderPatch>): void {
  if (node.kind === 'folder' && node.fullPath) {
    const stats = node.stats ?? { seen: 0, total: 0, ready: 0, filesTotal: 0, findings: 0, unconfirmed: 0 };
    out.set(node.fullPath, {
      path: node.fullPath,
      dotClass: stats.filesTotal > 0 && stats.ready === stats.filesTotal
        ? 'done'
        : stats.ready > 0 || stats.seen > 0
          ? 'partial'
          : 'none',
      ready: stats.ready,
      filesTotal: stats.filesTotal,
    });
  }
  for (const child of node.children ?? []) {
    collectFolderPatches(child, out);
  }
}

function sameFilePatch(a: FilePatch, b: FilePatch): boolean {
  return a.path === b.path
    && a.active === b.active
    && a.ready === b.ready
    && a.dotClass === b.dotClass
    && a.dotTitle === b.dotTitle
    && a.unconfirmed === b.unconfirmed
    && a.analyzed === b.analyzed
    && a.findings === b.findings
    && a.seen === b.seen
    && a.total === b.total
    && a.analyzing === b.analyzing;
}

function sameFolderPatch(a: FolderPatch, b: FolderPatch): boolean {
  return a.path === b.path
    && a.dotClass === b.dotClass
    && a.ready === b.ready
    && a.filesTotal === b.filesTotal;
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
