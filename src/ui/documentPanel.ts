import * as vscode from 'vscode';
import { nonce as makeNonce } from './html';

export type DocFindingDisposition = 'fixed' | 'commented' | 'ignored';

/** A finding shown inline against a source line. */
export interface DocFinding {
  id: string;
  line: number;
  severity: string;
  title: string;
  detail: string;
  suggestion?: string;
  disposition?: DocFindingDisposition;
  dispositionReason?: string;
}

/** A persisted annotation (translation, explanation, or note) anchored to a file. */
export interface DocAnnotation {
  id: string;
  kind: 'translate' | 'explain' | 'note';
  startLine: number;
  endLine: number;
  sourceText: string;
  content: string;
}

/** Everything the document webview needs to render one file. */
export interface DocModel {
  path: string;
  name: string;
  isMarkdown: boolean;
  readingHtml?: string;
  /** Per-line highlighted HTML, index 0 = line 1. */
  sourceLines: string[];
  /** Raw source lines, index 0 = line 1 (used for selection anchoring). */
  raw: string[];
  seen: number[];
  findings: DocFinding[];
  annotations: DocAnnotation[];
}

/** Actions the document panel triggers in the extension host. */
export interface DocActions {
  seen(path: string, lines: number[]): void;
  translate(path: string, startLine: number, endLine: number, text: string): void;
  explain(path: string, startLine: number, endLine: number, text: string): void;
  note(path: string, startLine: number, endLine: number, text: string): void;
  removeAnnotation(path: string, id: string): void;
  disposeFinding(path: string, id: string, kind: DocFindingDisposition): void;
  /** Opens the fix-proposal panel for a finding to *view* it, without changing its disposition. */
  viewFix(path: string, id: string): void;
  locate(path: string, line: number): void;
  analyze(path: string): void;
  jumpNext(path: string): void;
}

type Inbound =
  | { type: 'ready' }
  | { type: 'seen'; lines: number[] }
  | { type: 'translate'; startLine: number; endLine: number; text: string }
  | { type: 'explain'; startLine: number; endLine: number; text: string }
  | { type: 'note'; startLine: number; endLine: number; text: string }
  | { type: 'removeAnnotation'; id: string }
  | { type: 'dispose'; id: string; kind: DocFindingDisposition }
  | { type: 'viewFix'; id: string }
  | { type: 'locate'; line: number }
  | { type: 'analyze' }
  | { type: 'jumpNext' };

/**
 * The Document Viewer: a webview that renders a review file in either a
 * reading-friendly view (rendered markdown, no syntax) or a line-numbered
 * source view used for per-line coverage. Lets the reviewer select text and
 * attach persisted translations / notes shown inline below the selection.
 */
export class DocumentPanel {
  private static current?: DocumentPanel;
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private model?: DocModel;
  private ready = false;

  private constructor(panel: vscode.WebviewPanel, private actions: DocActions) {
    this.panel = panel;
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage((m: Inbound) => this.handle(m), null, this.disposables);
    this.panel.webview.html = this.shell();
  }

  static show(model: DocModel, actions: DocActions): void {
    if (!DocumentPanel.current) {
      const panel = vscode.window.createWebviewPanel(
        'codereview.document',
        '文件查看',
        // Open beside the active group (the workbench), so it lands in the same
        // window the workbench currently lives in — including a popped-out window.
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
        { enableScripts: true, retainContextWhenHidden: true },
      );
      DocumentPanel.current = new DocumentPanel(panel, actions);
    }
    const inst = DocumentPanel.current;
    inst.actions = actions;
    inst.model = model;
    inst.panel.title = `📄 ${model.name}`;
    inst.panel.reveal(undefined, true);
    if (inst.ready) {
      inst.post();
    }
  }

  /** Pushes an updated model (e.g. after an annotation changes) into the panel. */
  static update(model: DocModel): void {
    const inst = DocumentPanel.current;
    if (!inst || inst.model?.path !== model.path) {
      return;
    }
    inst.model = model;
    if (inst.ready) {
      inst.post();
    }
  }

  static get currentPath(): string | undefined {
    return DocumentPanel.current?.model?.path;
  }

  static get isOpen(): boolean {
    return !!DocumentPanel.current;
  }

  /**
   * Disposes the current document panel, if any. Used when the workbench moves
   * to another window so the next file opens beside it instead of being stranded
   * in the window where the panel was first created.
   */
  static closeIfOpen(): void {
    DocumentPanel.current?.panel.dispose();
  }

  /** Switches to source view and scrolls a line into view. */
  static scrollTo(line: number): void {
    const inst = DocumentPanel.current;
    if (inst?.ready) {
      void inst.panel.webview.postMessage({ type: 'scrollTo', line });
    }
  }

  private post(): void {
    if (this.model) {
      void this.panel.webview.postMessage({ type: 'load', model: this.model });
    }
  }

  private handle(m: Inbound): void {
    const path = this.model?.path;
    if (!path) {
      return;
    }
    switch (m.type) {
      case 'ready':
        this.ready = true;
        this.post();
        break;
      case 'seen':
        this.actions.seen(path, m.lines);
        break;
      case 'translate':
        this.actions.translate(path, m.startLine, m.endLine, m.text);
        break;
      case 'explain':
        this.actions.explain(path, m.startLine, m.endLine, m.text);
        break;
      case 'note':
        this.actions.note(path, m.startLine, m.endLine, m.text);
        break;
      case 'removeAnnotation':
        this.actions.removeAnnotation(path, m.id);
        break;
      case 'dispose':
        this.actions.disposeFinding(path, m.id, m.kind);
        break;
      case 'viewFix':
        this.actions.viewFix(path, m.id);
        break;
      case 'locate':
        this.actions.locate(path, m.line);
        break;
      case 'analyze':
        this.actions.analyze(path);
        break;
      case 'jumpNext':
        this.actions.jumpNext(path);
        break;
    }
  }

  private dispose(): void {
    DocumentPanel.current = undefined;
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  private shell(): string {
    const nonce = makeNonce();
    const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style>
  :root {
    --purple:#c586c0; --red:#f14c4c; --green:#4ec9b0;
    --yellow:#d8c020; --blue:#569cd6;
    --line:var(--vscode-panel-border);
    --elevated:var(--vscode-editorWidget-background, rgba(127,127,127,.07));
    --dim:var(--vscode-descriptionForeground);
  }
  * { box-sizing:border-box; }
  html,body { height:100%; margin:0; }
  body {
    font-family:var(--vscode-font-family);
    color:var(--vscode-foreground);
    background:var(--vscode-editor-background);
    display:flex; flex-direction:column; height:100vh;
  }
  .topbar {
    display:flex; align-items:center; gap:8px;
    padding:8px 12px; border-bottom:1px solid var(--line);
    background:var(--elevated); flex:none;
  }
  .fname { font-weight:600; font-size:13px; }
  .spacer { flex:1; }
  .seg { display:flex; border:1px solid var(--line); border-radius:6px; overflow:hidden; }
  .seg button { border:0; }
  .seg button.on { background:var(--vscode-button-background); color:var(--vscode-button-foreground); }
  button {
    font-family:inherit; font-size:12px; padding:4px 10px; cursor:pointer;
    background:var(--vscode-button-secondaryBackground, rgba(127,127,127,.14));
    color:var(--vscode-foreground); border:1px solid var(--line); border-radius:6px;
  }
  button:hover { background:var(--vscode-button-secondaryHoverBackground, rgba(127,127,127,.24)); }
  .content { flex:1; overflow:auto; position:relative; }

  /* Source view */
  .src { font-family:var(--vscode-editor-font-family, monospace); font-size:var(--vscode-editor-font-size, 13px); padding:6px 0 40vh; }
  .ln { display:flex; align-items:flex-start; padding:0 12px 0 0; white-space:pre; position:relative; }
  .ln:hover { background:rgba(127,127,127,.06); }
  .gutter { flex:none; width:52px; text-align:right; padding-right:12px; color:var(--dim); user-select:none; opacity:.6; }
  .ln.seen .gutter { color:var(--green); opacity:1; }
  .ln.seen { box-shadow:inset 2px 0 0 var(--green); }
  .code { flex:1; }
  .fmark { position:absolute; left:2px; width:6px; height:6px; border-radius:50%; top:.45em; }
  .fmark.bug { background:var(--red); }
  .fmark.conditional { background:var(--yellow); }
  .fmark.suggestion { background:var(--blue); }

  /* Syntax highlighting (highlight.js classes) — VS Code Dark+ palette,
     remapped for light themes via the body.vscode-light class VS Code adds. */
  .hljs-comment, .hljs-quote { color:#6a9955; font-style:italic; }
  .hljs-keyword, .hljs-built_in, .hljs-literal, .hljs-meta .hljs-keyword { color:#569cd6; }
  .hljs-string, .hljs-regexp, .hljs-meta .hljs-string { color:#ce9178; }
  .hljs-number, .hljs-meta { color:#b5cea8; }
  .hljs-title, .hljs-title.function_ { color:#dcdcaa; }
  .hljs-title.class_, .hljs-type, .hljs-class .hljs-title { color:#4ec9b0; }
  .hljs-attr, .hljs-attribute, .hljs-property, .hljs-variable, .hljs-template-variable { color:#9cdcfe; }
  .hljs-tag, .hljs-name, .hljs-selector-tag { color:#569cd6; }
  .hljs-symbol, .hljs-bullet, .hljs-link { color:#d7ba7d; }
  .hljs-doctag, .hljs-section { color:#608b4e; }
  .hljs-params { color:var(--vscode-foreground); }
  .hljs-deletion { color:#f14c4c; }
  .hljs-addition { color:#4ec9b0; }
  .hljs-emphasis { font-style:italic; }
  .hljs-strong { font-weight:600; }

  body.vscode-light .hljs-comment, body.vscode-light .hljs-quote { color:#008000; }
  body.vscode-light .hljs-keyword, body.vscode-light .hljs-built_in, body.vscode-light .hljs-literal { color:#0000ff; }
  body.vscode-light .hljs-string, body.vscode-light .hljs-regexp { color:#a31515; }
  body.vscode-light .hljs-number, body.vscode-light .hljs-meta { color:#098658; }
  body.vscode-light .hljs-title, body.vscode-light .hljs-title.function_ { color:#795e26; }
  body.vscode-light .hljs-title.class_, body.vscode-light .hljs-type { color:#267f99; }
  body.vscode-light .hljs-attr, body.vscode-light .hljs-attribute, body.vscode-light .hljs-property, body.vscode-light .hljs-variable { color:#001080; }
  body.vscode-light .hljs-tag, body.vscode-light .hljs-name, body.vscode-light .hljs-selector-tag { color:#800000; }
  body.vscode-light .hljs-symbol, body.vscode-light .hljs-bullet, body.vscode-light .hljs-link { color:#811f3f; }
  body.vscode-light .hljs-doctag, body.vscode-light .hljs-section { color:#008000; }

  /* Findings index bar */
  .findbar { flex:none; border-bottom:1px solid var(--line); background:var(--vscode-editor-background); }
  .findbar-toggle { display:flex; align-items:center; gap:10px; width:100%; justify-content:flex-start; border:0; border-radius:0; padding:6px 12px; background:transparent; }
  .findbar-toggle:hover { background:rgba(127,127,127,.08); }
  .fb-count { font-weight:600; }
  .fb-warn { color:var(--yellow); font-size:11px; }
  .fb-ok { color:var(--green); font-size:11px; }
  .fb-caret { margin-left:auto; transition:transform .15s; opacity:.7; }
  .findbar.collapsed .fb-caret { transform:rotate(-90deg); }
  .findlist { max-height:34vh; overflow:auto; padding:2px 0 6px; }
  .findbar.collapsed .findlist { display:none; }
  .finditem { display:flex; align-items:center; gap:8px; padding:4px 12px 4px 14px; cursor:pointer; font-size:12px; }
  .finditem:hover { background:rgba(127,127,127,.1); }
  .finditem.confirmed { opacity:.5; }
  .fi-dot { width:8px; height:8px; border-radius:50%; flex:none; }
  .finditem.bug .fi-dot { background:var(--red); }
  .finditem.conditional .fi-dot { background:var(--yellow); }
  .finditem.suggestion .fi-dot { background:var(--blue); }
  .fi-title { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .fi-line { font-family:var(--vscode-editor-font-family, monospace); font-size:11px; color:var(--blue); flex:none; }
  .fi-ok { color:var(--green); flex:none; }

  /* Reading view */
  .reading { padding:24px 40px 40vh; max-width:900px; margin:0 auto; line-height:1.7; font-size:14px; }
  .reading h1,.reading h2,.reading h3 { border-bottom:1px solid var(--line); padding-bottom:.2em; }
  .reading code { background:var(--elevated); padding:.1em .35em; border-radius:4px; font-family:var(--vscode-editor-font-family, monospace); }
  .reading pre { background:var(--elevated); padding:12px 14px; border-radius:8px; overflow:auto; }
  .reading pre.frontmatter { border-left:3px solid var(--purple); opacity:.92; }
  .reading pre code { background:none; padding:0; }
  .reading a { color:var(--blue); }
  .reading table { border-collapse:collapse; }
  .reading th,.reading td { border:1px solid var(--line); padding:4px 8px; }
  .reading blockquote { border-left:3px solid var(--purple); margin:0; padding-left:12px; color:var(--dim); }

  /* Annotation card */
  .anno {
    margin:6px 12px; border:1px solid var(--line); border-left:3px solid var(--purple);
    border-radius:8px; background:var(--elevated); font-family:var(--vscode-font-family); font-size:12px;
  }
  .reading .anno { margin:10px 0; }
  .anno-head { display:flex; align-items:center; gap:8px; padding:6px 10px; cursor:pointer; }
  .anno-kind { color:var(--purple); font-weight:600; }
  .anno-where { color:var(--dim); font-size:11px; }
  .anno-x { margin-left:auto; opacity:.6; padding:0 6px; }
  .anno-x:hover { opacity:1; color:var(--red); }
  .anno-body { padding:0 10px 10px; line-height:1.6; white-space:pre-wrap; }
  .anno.collapsed .anno-body { display:none; }
  .anno.anno-explain { border-left-color:var(--green); }
  .anno.anno-explain .anno-kind { color:var(--green); }
  .anno.anno-note { border-left-color:var(--blue); }
  .anno.anno-note .anno-kind { color:var(--blue); }

  /* Inline finding card */
  .finding {
    margin:6px 12px; border:1px solid var(--line); border-radius:8px; overflow:hidden;
    font-family:var(--vscode-font-family); font-size:12px; background:var(--elevated);
  }
  .reading .finding { margin:10px 0; }
  .finding.bug { border-left:3px solid var(--red); }
  .finding.conditional { border-left:3px solid var(--yellow); }
  .finding.suggestion { border-left:3px solid var(--blue); }
  .finding.confirmed { opacity:.55; }
  .f-head { display:flex; align-items:center; gap:8px; padding:6px 10px; }
  .f-tag { font-size:11px; padding:1px 7px; border-radius:4px; font-weight:600; flex:none; }
  .finding.bug .f-tag { background:var(--red-bg, rgba(241,76,76,.14)); color:var(--red); }
  .finding.conditional .f-tag { background:rgba(216,192,32,.14); color:var(--yellow); }
  .finding.suggestion .f-tag { background:rgba(86,156,214,.16); color:var(--blue); }
  .f-title { font-weight:600; flex:1; }
  .f-head.viewable { cursor:pointer; }
  .f-head.viewable:hover .f-title { text-decoration:underline; text-underline-offset:2px; }
  .f-head .f-fix-hint { font-size:11px; color:var(--vscode-descriptionForeground, #999); flex:none; opacity:0; transition:opacity .1s; }
  .f-head.viewable:hover .f-fix-hint { opacity:1; }
  .f-line { font-family:var(--vscode-editor-font-family, monospace); font-size:11px; color:var(--blue); flex:none; }
  .f-body { padding:0 10px 8px; }
  .f-detail { margin:0 0 6px; line-height:1.6; opacity:.9; }
  .f-suggest { margin:0 0 8px; color:var(--vscode-textLink-foreground, var(--blue)); line-height:1.6; }
  .f-actions { display:flex; gap:6px; }
  .f-actions .done { color:var(--green); align-self:center; font-size:11px; }
  button.primary { background:var(--vscode-button-background); color:var(--vscode-button-foreground); border-color:transparent; }

  .notes-foot { margin:24px 12px; }
  .notes-foot h4 { color:var(--dim); font-weight:600; margin:0 0 6px; }

  /* Selection popover */
  .pop {
    position:fixed; z-index:50; display:none; gap:4px; padding:4px;
    background:var(--vscode-editorWidget-background); border:1px solid var(--line);
    border-radius:8px; box-shadow:0 4px 16px rgba(0,0,0,.3);
  }
  .pop button { font-size:12px; }
  .hint { padding:6px 12px; color:var(--dim); font-size:11px; border-bottom:1px solid var(--line); background:rgba(197,134,192,.08); }
</style>
</head>
<body>
  <div class="topbar">
    <span class="fname" id="fname"></span>
    <span class="spacer"></span>
    <span class="seg" id="seg" style="display:none">
      <button id="m-read" class="on">阅读视图</button>
      <button id="m-src">源码视图</button>
    </span>
    <button id="act-jump">跳到下一处未看</button>
    <button id="act-analyze">分析此文件</button>
  </div>
  <div class="findbar collapsed" id="findbar" style="display:none">
    <button class="findbar-toggle" id="findbar-toggle"></button>
    <div class="findlist" id="findlist"></div>
  </div>
  <div class="content" id="content"></div>
  <div class="pop" id="pop">
    <button id="pop-tr">译成中文</button>
    <button id="pop-explain">解释</button>
    <button id="pop-note">批注</button>
  </div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
let model = null;
let mode = 'source';
const seen = new Set();
let io = null;
const visible = new Set();
let seenTimer = null;

const $ = (id) => document.getElementById(id);
const contentEl = $('content');

function rawText() { return (model.raw || []).join('\\n'); }

function decodeEntities(s) {
  return s.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'");
}

const SEV_LABEL = { bug:'真 Bug', conditional:'条件性', suggestion:'建议' };
const DISP_LABEL = { fixed:'已 Copilot 修复', commented:'已写为评论', ignored:'已忽略' };

function findingCard(f) {
  const div = document.createElement('div');
  div.className = 'finding ' + f.severity + (f.disposition ? ' disposed' : '');
  const head = document.createElement('div');
  head.className = 'f-head';
  head.classList.add('viewable');
  head.title = '查看 Copilot 修复方案';
  head.innerHTML =
    '<span class="f-tag">' + (SEV_LABEL[f.severity] || f.severity) + '</span>' +
    '<span class="f-title"></span>' +
    '<span class="f-fix-hint">🪄 查看修复方案</span>' +
    '<span class="f-line">第 ' + f.line + ' 行</span>';
  head.querySelector('.f-title').textContent = f.title;
  head.addEventListener('click', () => vscode.postMessage({ type:'viewFix', id:f.id }));
  const body = document.createElement('div');
  body.className = 'f-body';
  const detail = document.createElement('p');
  detail.className = 'f-detail';
  detail.textContent = f.detail;
  body.appendChild(detail);
  if (f.suggestion) {
    const sug = document.createElement('p');
    sug.className = 'f-suggest';
    sug.textContent = '建议：' + f.suggestion;
    body.appendChild(sug);
  }
  if (f.disposition) {
    const tag = document.createElement('div');
    tag.className = 'disp-badge disp-' + f.disposition;
    var label = DISP_LABEL[f.disposition] || f.disposition;
    tag.textContent = '✓ ' + label + (f.dispositionReason ? '：' + f.dispositionReason : '');
    body.appendChild(tag);
  }
  const actions = document.createElement('div');
  actions.className = 'f-actions';
  const locate = document.createElement('button');
  locate.textContent = '定位';
  locate.addEventListener('click', () => vscode.postMessage({ type:'locate', line:f.line }));
  actions.appendChild(locate);

  function disposeBtn(kind, label, primary) {
    const b = document.createElement('button');
    b.textContent = (f.disposition === kind ? '撤销 ' : '') + label;
    if (primary && f.disposition !== kind) b.className = 'primary';
    b.addEventListener('click', () => vscode.postMessage({ type:'dispose', id:f.id, kind:kind }));
    return b;
  }
  // The "fixed" disposition is produced *only* by applying a proposal inside the
  // fix panel, never by a manual toggle — so this is a pure entry point that
  // opens the panel for viewing / applying. The undo lives inside the panel.
  const fixBtn = document.createElement('button');
  const isFixed = f.disposition === 'fixed';
  fixBtn.textContent = isFixed ? '🪄 已修复（查看）' : '🪄 Copilot 修复';
  if (!f.disposition) fixBtn.className = 'primary';
  fixBtn.addEventListener('click', () => vscode.postMessage({ type:'viewFix', id:f.id }));
  actions.appendChild(fixBtn);
  actions.appendChild(disposeBtn('commented', '💬 写为评论', false));
  actions.appendChild(disposeBtn('ignored', '🚫 忽略', false));

  body.appendChild(actions);
  div.appendChild(head);
  div.appendChild(body);
  return div;
}

function annoCard(a) {
  const where = a.startLine > 0 ? ('第 ' + a.startLine + (a.endLine > a.startLine ? ('–' + a.endLine) : '') + ' 行') : '选区';
  const kind = a.kind === 'translate' ? '译文' : a.kind === 'explain' ? '解释' : '批注';
  const div = document.createElement('div');
  div.className = 'anno anno-' + a.kind;
  div.innerHTML =
    '<div class="anno-head"><span class="anno-kind">' + kind + '</span>' +
    '<span class="anno-where">' + where + '</span>' +
    '<span class="anno-x" title="删除">✕</span></div>' +
    '<div class="anno-body"></div>';
  div.querySelector('.anno-body').textContent = a.content;
  div.querySelector('.anno-head').addEventListener('click', (e) => {
    if (e.target.classList.contains('anno-x')) {
      vscode.postMessage({ type:'removeAnnotation', id:a.id });
    } else {
      div.classList.toggle('collapsed');
    }
  });
  return div;
}

function renderSource() {
  mode = 'source';
  const findingsByLine = {};
  for (const f of model.findings) { (findingsByLine[f.line] = findingsByLine[f.line] || []).push(f); }
  const annosByLine = {};
  const footAnnos = [];
  for (const a of model.annotations) {
    if (a.endLine > 0) { (annosByLine[a.endLine] = annosByLine[a.endLine] || []).push(a); }
    else { footAnnos.push(a); }
  }

  const wrap = document.createElement('div');
  wrap.className = 'src';
  for (let i = 0; i < model.sourceLines.length; i++) {
    const lineNo = i + 1;
    const row = document.createElement('div');
    row.className = 'ln' + (seen.has(lineNo) ? ' seen' : '');
    row.dataset.line = String(lineNo);
    const fs = findingsByLine[lineNo];
    const fmark = fs ? '<span class="fmark ' + fs[0].severity + '" title="' + fs.map(x=>x.title.replace(/"/g,'')).join(' / ') + '"></span>' : '';
    row.innerHTML = fmark + '<span class="gutter">' + lineNo + '</span><span class="code">' + (model.sourceLines[i] || '\\u200b') + '</span>';
    wrap.appendChild(row);
    if (findingsByLine[lineNo]) { for (const f of findingsByLine[lineNo]) wrap.appendChild(findingCard(f)); }
    if (annosByLine[lineNo]) { for (const a of annosByLine[lineNo]) wrap.appendChild(annoCard(a)); }
  }
  // Findings whose line falls outside the rendered range.
  const oob = model.findings.filter((f) => f.line < 1 || f.line > model.sourceLines.length);
  if (footAnnos.length || oob.length) {
    const foot = document.createElement('div');
    foot.className = 'notes-foot';
    if (oob.length) {
      foot.innerHTML = '<h4>其他发现</h4>';
      for (const f of oob) foot.appendChild(findingCard(f));
    }
    if (footAnnos.length) {
      const h = document.createElement('h4'); h.textContent = '未定位批注'; foot.appendChild(h);
      for (const a of footAnnos) foot.appendChild(annoCard(a));
    }
    wrap.appendChild(foot);
  }
  contentEl.innerHTML = '';
  contentEl.appendChild(wrap);
  observeLines();
}

function renderReading() {
  mode = 'reading';
  if (io) { io.disconnect(); visible.clear(); }
  const wrap = document.createElement('div');
  wrap.className = 'reading';
  wrap.innerHTML = model.readingHtml || '';
  contentEl.innerHTML = '';
  contentEl.appendChild(wrap);

  // Anchor annotations after the block whose text contains the selection.
  const blocks = Array.from(wrap.children);
  const placed = new Set();
  for (const a of model.annotations) {
    const needle = (a.sourceText || '').trim().slice(0, 40);
    let host = null;
    if (needle) { host = blocks.find((b) => b.textContent && b.textContent.indexOf(needle) >= 0) || null; }
    if (host) { host.after(annoCard(a)); placed.add(a.id); }
  }
  const rest = model.annotations.filter((a) => !placed.has(a.id));
  if (rest.length || model.findings.length) {
    const foot = document.createElement('div');
    foot.className = 'notes-foot';
    if (model.findings.length) {
      const h = document.createElement('h4'); h.textContent = '文件级发现（' + model.findings.length + '）'; foot.appendChild(h);
      for (const f of model.findings) foot.appendChild(findingCard(f));
    }
    if (rest.length) {
      const h = document.createElement('h4'); h.textContent = '批注 / 译文'; foot.appendChild(h);
      for (const a of rest) foot.appendChild(annoCard(a));
    }
    wrap.appendChild(foot);
  }
}

function observeLines() {
  if (io) io.disconnect();
  visible.clear();
  io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const ln = Number(e.target.dataset.line);
      if (e.isIntersecting) visible.add(ln); else visible.delete(ln);
    }
    clearTimeout(seenTimer);
    seenTimer = setTimeout(flushSeen, 300);
  }, { root: contentEl, threshold: 0.5 });
  for (const el of contentEl.querySelectorAll('.ln')) io.observe(el);
}

function flushSeen() {
  const fresh = [...visible].filter((l) => !seen.has(l));
  if (!fresh.length) return;
  for (const l of fresh) {
    seen.add(l);
    const row = contentEl.querySelector('.ln[data-line="' + l + '"]');
    if (row) row.classList.add('seen');
  }
  vscode.postMessage({ type:'seen', lines: fresh });
}

function render() {
  $('fname').textContent = model.name;
  $('seg').style.display = model.isMarkdown ? 'flex' : 'none';
  seen.clear();
  for (const l of model.seen) seen.add(l);
  renderFindbar();
  if (model.isMarkdown && mode !== 'source') { setMode('reading'); }
  else { setMode('source'); }
}

function renderFindbar() {
  const fb = $('findbar');
  const fs = (model.findings || []);
  if (!fs.length) { fb.style.display = 'none'; return; }
  fb.style.display = 'block';
  const unconfirmed = fs.filter((f) => !f.confirmed).length;
  $('findbar-toggle').innerHTML =
    '<span class="fb-count">发现 ' + fs.length + '</span>' +
    (unconfirmed ? '<span class="fb-warn">' + unconfirmed + ' 未确认</span>' : '<span class="fb-ok">全部已确认</span>') +
    '<span class="fb-caret">▾</span>';
  const list = $('findlist');
  list.innerHTML = '';
  for (const f of fs) {
    const item = document.createElement('div');
    item.className = 'finditem ' + f.severity + (f.confirmed ? ' confirmed' : '');
    item.innerHTML =
      '<span class="fi-dot"></span><span class="fi-title"></span>' +
      '<span class="fi-line">第 ' + f.line + ' 行</span>' +
      (f.confirmed ? '<span class="fi-ok">✓</span>' : '');
    item.querySelector('.fi-title').textContent = f.title;
    item.addEventListener('click', () => vscode.postMessage({ type:'locate', line:f.line }));
    list.appendChild(item);
  }
}

function setMode(m) {
  $('m-read').classList.toggle('on', m === 'reading');
  $('m-src').classList.toggle('on', m === 'source');
  const top = contentEl.scrollTop;
  if (m === 'reading' && model.isMarkdown) renderReading(); else renderSource();
  contentEl.scrollTop = top;
}

// Selection popover -------------------------------------------------------
const pop = $('pop');
let pendingSel = null;

function lineOf(node) {
  let el = node && node.nodeType === 3 ? node.parentElement : node;
  while (el && el !== contentEl) { if (el.classList && el.classList.contains('ln')) return Number(el.dataset.line); el = el.parentElement; }
  return 0;
}

function captureSelection() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) { pop.style.display = 'none'; pendingSel = null; return; }
  const text = sel.toString();
  if (!text.trim()) { pop.style.display = 'none'; pendingSel = null; return; }
  let startLine = 0, endLine = 0;
  if (mode === 'source') {
    const a = lineOf(sel.anchorNode), b = lineOf(sel.focusNode);
    startLine = Math.min(a, b) || a || b;
    endLine = Math.max(a, b);
  } else {
    const idx = rawText().indexOf(text.trim().slice(0, 30));
    if (idx >= 0) { startLine = rawText().slice(0, idx).split('\\n').length; endLine = startLine; }
  }
  pendingSel = { startLine, endLine, text };
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  pop.style.display = 'flex';
  pop.style.left = Math.max(8, rect.left) + 'px';
  pop.style.top = Math.max(8, rect.top - 40) + 'px';
}

contentEl.addEventListener('mouseup', () => setTimeout(captureSelection, 0));
$('pop-tr').addEventListener('click', () => { if (pendingSel) { vscode.postMessage({ type:'translate', startLine:pendingSel.startLine, endLine:pendingSel.endLine, text:pendingSel.text }); pop.style.display='none'; } });
$('pop-explain').addEventListener('click', () => { if (pendingSel) { vscode.postMessage({ type:'explain', startLine:pendingSel.startLine, endLine:pendingSel.endLine, text:pendingSel.text }); pop.style.display='none'; } });
$('pop-note').addEventListener('click', () => { if (pendingSel) { vscode.postMessage({ type:'note', startLine:pendingSel.startLine, endLine:pendingSel.endLine, text:pendingSel.text }); pop.style.display='none'; } });

// Toolbar -----------------------------------------------------------------
$('m-read').addEventListener('click', () => setMode('reading'));
$('m-src').addEventListener('click', () => setMode('source'));
$('act-analyze').addEventListener('click', () => vscode.postMessage({ type:'analyze' }));
$('act-jump').addEventListener('click', () => vscode.postMessage({ type:'jumpNext' }));
$('findbar-toggle').addEventListener('click', () => $('findbar').classList.toggle('collapsed'));

window.addEventListener('message', (ev) => {
  const msg = ev.data;
  if (msg.type === 'load') { model = msg.model; render(); }
  else if (msg.type === 'scrollTo') {
    if (mode !== 'source') setMode('source');
    const row = contentEl.querySelector('.ln[data-line="' + msg.line + '"]');
    if (row) { row.scrollIntoView({ block:'center' }); row.style.transition='background .6s'; row.style.background='rgba(197,134,192,.3)'; setTimeout(()=>row.style.background='', 700); }
  }
});

vscode.postMessage({ type:'ready' });
</script>
</body>
</html>`;
  }
}
