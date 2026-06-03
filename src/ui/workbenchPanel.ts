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
  analyze(path: string): void;
  disposeFinding(path: string, id: string, kind: FindingDispositionKind): void;
  locate(path: string, line: number): void;
  jumpNext(): void;
  globalAnalysis(): void;
  showGlobal(): void;
  submit(): void;
  pickModel(): void;
  /** Opens the scope picker (used both for first-time review and for switching). */
  pickScope(): void;
}

type InboundMessage =
  | { type: 'select'; path: string }
  | { type: 'analyze'; path: string }
  | { type: 'dispose'; path: string; id: string; kind: FindingDispositionKind }
  | { type: 'locate'; path: string; line: number }
  | { type: 'jumpNext' }
  | { type: 'global' }
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
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private get expandedFolders(): Set<string> {
    return WorkbenchPanel.expandedFolders;
  }
  private refreshTimer?: ReturnType<typeof setTimeout>;

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

  static get isOpen(): boolean {
    return !!WorkbenchPanel.current;
  }

  /** Re-renders the panel from current session state, if open. */
  static refreshIfOpen(): void {
    WorkbenchPanel.current?.scheduleRefresh();
  }

  /** Clears persisted folder expand/collapse state so a new review re-initialises it. */
  static resetFolders(): void {
    WorkbenchPanel.expandedFolders.clear();
    WorkbenchPanel.folderInit = false;
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
    this.panel.webview.html = this.render(this.getState());
  }

  private handle(msg: InboundMessage): void {
    switch (msg.type) {
      case 'select':
        this.actions.open(msg.path);
        break;
      case 'analyze':
        this.actions.analyze(msg.path);
        break;
      case 'dispose':
        this.actions.disposeFinding(msg.path, msg.id, msg.kind);
        break;
      case 'locate':
        this.actions.locate(msg.path, msg.line);
        break;
      case 'jumpNext':
        this.actions.jumpNext();
        break;
      case 'global':
        this.actions.globalAnalysis();
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
        if (this.expandedFolders.has(msg.path)) {
          this.expandedFolders.delete(msg.path);
        } else {
          this.expandedFolders.add(msg.path);
        }
        this.refresh();
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

    if (state.selected) {
      let p = state.selected;
      while (p.includes('/')) {
        p = p.slice(0, p.lastIndexOf('/'));
        this.expandedFolders.add(p);
      }
    }

    const tree = (treeRoot.children ?? [])
      .map((c) => this.renderNode(c, 0))
      .join('') || '<div class="empty">无文件</div>';

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

  .tree { flex:1; overflow:auto; padding:.35rem .25rem; min-height:0; }
  .folder-group.collapsed > .children { display:none; }
  .folder-group.collapsed > .tfolder .caret { transform:rotate(0deg); }
  .tfolder { display:flex; align-items:center; gap:.4rem; padding:.28rem .45rem;
    cursor:pointer; border-radius:6px; }
  .tfolder:hover { background:var(--vscode-list-hoverBackground); }
  .tfolder .caret { display:inline-block; width:11px; text-align:center;
    transition:transform .15s ease; transform:rotate(90deg); color:var(--dim); flex-shrink:0; }
  .tfolder .ficon { flex-shrink:0; opacity:.85; }
  .tfolder .tname { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:500; }
  .tfolder .tcount { font-family:var(--vscode-editor-font-family); font-size:.68rem;
    color:var(--dim); flex-shrink:0; }

  .tnode { display:flex; align-items:center; gap:.45rem; padding:.32rem .45rem; border-radius:6px; cursor:pointer; }
  .tnode:hover { background:var(--vscode-list-hoverBackground); }
  .tnode.active { background:var(--purple-bg); box-shadow:inset 2px 0 0 var(--purple); }
  .tnode.ready { opacity:.72; }
  .seen-dot { width:8px; height:8px; border-radius:50%; flex-shrink:0; }
  .seen-dot.none { background:transparent; border:1.5px solid var(--vscode-charts-orange, #d89614); }
  .seen-dot.partial { background:var(--yellow); }
  .seen-dot.analyzing { background:var(--vscode-charts-blue, #3794ff); }
  .seen-dot.done { background:var(--green); }
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
      <div class="tree" id="tree">${tree || '<div class="empty">无文件</div>'}</div>
      <div class="toolbar">
        <div class="grp-label">当前文件</div>
        <div class="row">
          <button class="primary" id="analyze" ${state.selected ? '' : 'disabled'}>分析此文件</button>
          <button id="jumpNext" ${state.selected ? '' : 'disabled'}>跳到下一处未看</button>
        </div>
        <div class="grp-label">整体审查</div>
        <div class="row">
          <button id="global">全局逻辑分析</button>
          <button id="showGlobal" ${state.hasGlobalReport ? '' : 'disabled'}>查看全局结论</button>
        </div>
        <div class="model-row">
          <span class="model-label" title="${escAttr(state.modelLabel)}">模型：<b>${esc(state.modelLabel)}</b></span>
          <button id="pickModel">切换</button>
        </div>
      </div>
      <div class="hud">
        <div class="hud-row"><span class="lbl">行覆盖</span><span class="val">${pct}%</span></div>
        <div class="cov-track"><div class="cov-fill" style="width:${pct}%"></div></div>
        <div class="hud-row" style="margin-top:.55rem; margin-bottom:0;">
          <span class="lbl">文件就绪</span><span class="val">${state.coverage.filesReady}/${state.coverage.filesTotal}</span>
        </div>
        <div class="gate-chip ${gateOk ? 'ok' : 'locked'}">
          <span>${gateOk ? '✓' : '🔒'}</span>
          <span>${gateOk ? '门禁已通过，可提交结论' : '门禁未通过'}</span>
        </div>
        ${gateOk ? '' : `<div class="gate-reason">${gateReason.map(esc).join('；')}</div>`}
        <button class="primary" id="submit" style="width:100%; margin-top:.6rem;" ${gateOk ? '' : 'disabled'}>提交审查结论</button>
        ${conclusionHtml}
      </div>
    </div>
  </div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const send = (m) => vscode.postMessage(m);
  document.querySelectorAll('.tnode').forEach((n) => {
    n.addEventListener('click', () => send({ type:'select', path:n.dataset.path }));
  });
  document.querySelectorAll('.tfolder').forEach((f) => {
    f.addEventListener('click', () => {
      const group = f.parentElement;
      if (!group) return;
      const wasCollapsed = group.classList.contains('collapsed');
      group.classList.toggle('collapsed');
      group.dataset.serverCollapsed = wasCollapsed ? 'false' : 'true';
      send({ type:'toggleFolder', path:group.dataset.path });
    });
  });
  const filterInput = document.getElementById('filter');
  function applyFilter() {
    const q = filterInput.value.trim().toLowerCase();
    const ancestors = new Set();
    document.querySelectorAll('.tnode').forEach((r) => {
      const path = (r.dataset.path || '').toLowerCase();
      const m = q === '' || path.includes(q);
      r.style.display = m ? '' : 'none';
      if (m && q !== '') {
        let p = r.dataset.path || '';
        while (p.includes('/')) {
          p = p.slice(0, p.lastIndexOf('/'));
          ancestors.add(p);
        }
      }
    });
    document.querySelectorAll('.folder-group').forEach((g) => {
      const path = g.dataset.path;
      if (q === '') {
        g.style.display = '';
        if (g.dataset.serverCollapsed === 'true') g.classList.add('collapsed');
        else g.classList.remove('collapsed');
      } else if (ancestors.has(path)) {
        g.style.display = '';
        g.classList.remove('collapsed');
      } else {
        g.style.display = 'none';
      }
    });
  }
  filterInput.addEventListener('input', applyFilter);
  const sel = ${JSON.stringify(state.selected ?? null)};
  const byId = (id) => document.getElementById(id);
  byId('analyze')?.addEventListener('click', () => sel && send({ type:'analyze', path:sel }));
  byId('jumpNext')?.addEventListener('click', () => send({ type:'jumpNext' }));
  byId('global')?.addEventListener('click', () => send({ type:'global' }));
  byId('showGlobal')?.addEventListener('click', () => send({ type:'showGlobal' }));
  byId('pickModel')?.addEventListener('click', () => send({ type:'pickModel' }));
  byId('pickScope')?.addEventListener('click', () => send({ type:'pickScope' }));
  byId('submit')?.addEventListener('click', () => send({ type:'submit' }));
  document.querySelectorAll('.locate').forEach((b) => {
    b.addEventListener('click', () => send({ type:'locate', path:b.dataset.path, line:Number(b.dataset.line) }));
  });
  document.querySelectorAll('.confirm-btn').forEach((b) => {
    b.addEventListener('click', () => send({ type:'confirm', path:b.dataset.path, id:b.dataset.id }));
  });
  const treeEl = document.getElementById('tree');
  if (treeEl) {
    // The tree is fully re-rendered on every progress event (select / markSeen /
    // toggle). Persist and restore its scroll offset so the view stays exactly
    // where the user left it — no jumping to the active node or to the bottom.
    const saved = vscode.getState() || {};
    if (typeof saved.treeScroll === 'number') treeEl.scrollTop = saved.treeScroll;
    let raf = 0;
    treeEl.addEventListener('scroll', () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const s = vscode.getState() || {};
        s.treeScroll = treeEl.scrollTop;
        vscode.setState(s);
      });
    }, { passive: true });
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

  private renderNode(node: TreeNode, depth: number): string {
    const indent = depth * 12 + 8;
    if (node.kind === 'file' && node.file) {
      const f = node.file;
      // A single status dot encodes the file's overall review progress:
      //   green  = ready (read through + analyzed + every finding dispositioned)
      //   blue   = fully read, analysis/disposition still pending
      //   yellow = partially read
      //   orange = untouched
      const dotClass = f.ready
        ? 'done'
        : f.fullySeen
          ? 'analyzing'
          : f.seen > 0
            ? 'partial'
            : 'none';
      const dotTitle = f.ready
        ? '已就绪'
        : f.fullySeen
          ? f.analyzed ? '已读完，发现待确认' : '已读完，待分析'
          : f.seen > 0
            ? `已读 ${f.seen}/${f.total} 行`
            : '未开始';
      const chg = f.change
        ? `<span class="chg ${f.change}">${f.change === 'add' ? '+' : f.change === 'del' ? '−' : '~'}</span>`
        : '';
      const fixFlag = f.unconfirmed > 0
        ? `<span class="fix-flag" title="${f.unconfirmed} 个未确认发现">${f.unconfirmed}</span>`
        : f.analyzed && f.findings === 0
          ? '<span class="ok-flag" title="无发现">✓</span>'
          : '';
      const cov = f.total > 0 ? `${f.seen}/${f.total}` : '—';
      return `<div class="tnode ${f.active ? 'active' : ''} ${f.ready ? 'ready' : ''}" data-path="${escAttr(f.path)}" style="padding-left:${indent}px">
        <span class="seen-dot ${dotClass}" title="${escAttr(dotTitle)}"></span>
        <span class="tname" title="${escAttr(f.path)}">${esc(f.name)}</span>
        ${chg}
        ${fixFlag}
        <span class="tcov">${cov}</span>
      </div>`;
    }
    const isExpanded = this.expandedFolders.has(node.fullPath);
    const stats = node.stats ?? { seen: 0, total: 0, ready: 0, filesTotal: 0, findings: 0, unconfirmed: 0 };
    const folderDot = stats.filesTotal > 0 && stats.ready === stats.filesTotal
      ? 'done'
      : stats.ready > 0 || stats.seen > 0
        ? 'partial'
        : 'none';
    const childrenHtml = (node.children ?? []).map((c) => this.renderNode(c, depth + 1)).join('');
    return `<div class="folder-group ${isExpanded ? '' : 'collapsed'}" data-path="${escAttr(node.fullPath)}" data-server-collapsed="${isExpanded ? 'false' : 'true'}">
      <div class="tfolder" style="padding-left:${indent}px">
        <span class="caret">▸</span>
        <span class="seen-dot ${folderDot}"></span>
        <span class="ficon">📁</span>
        <span class="tname" title="${escAttr(node.fullPath)}">${esc(node.name)}</span>
        <span class="tcount">${stats.ready}/${stats.filesTotal}</span>
      </div>
      <div class="children">${childrenHtml}</div>
    </div>`;
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

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escAttr(s: string): string {
  return esc(s).replace(/"/g, '&quot;');
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
