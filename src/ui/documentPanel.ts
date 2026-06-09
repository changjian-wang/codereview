import * as vscode from 'vscode';
import { nonce as makeNonce } from './html';
import { m, resolveLanguage } from '../i18n';

export type DocFindingDisposition = 'fixed' | 'commented' | 'ignored';

/** A finding shown inline against a source line. */
export interface DocFinding {
  id: string;
  line: number;
  endLine?: number;
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
  /** True while this file is currently being analyzed (drives the topbar button). */
  analyzing: boolean;
}

/** Actions the document panel triggers in the extension host. */
export interface DocActions {
  seen(path: string, lines: number[]): void;
  translate(path: string, startLine: number, endLine: number, text: string): void;
  explain(path: string, startLine: number, endLine: number, text: string): void;
  note(path: string, startLine: number, endLine: number, text: string): void;
  removeAnnotation(path: string, id: string): void;
  /** Re-runs the model for an AI annotation (translate/explain), replacing it. */
  regenerateAnnotation(path: string, id: string): void;
  /** Converts an AI annotation (translate/explain) into an editable note. */
  convertAnnotationToNote(path: string, id: string): void;
  /** Saves an edited note's content. */
  editAnnotation(path: string, id: string, content: string): void;
  disposeFinding(path: string, id: string, kind: DocFindingDisposition): void;
  /** Opens the fix-proposal panel for a finding to *view* it, without changing its disposition. */
  viewFix(path: string, id: string): void;
  locate(path: string, line: number, endLine?: number, findingId?: string): void;
  analyze(path: string): void;
  jumpNext(path: string): void;
  /** Hands keyboard focus back to the workbench file tree. */
  focusTree(): void;
}

type Inbound =
  | { type: 'ready' }
  | { type: 'seen'; lines: number[] }
  | { type: 'translate'; startLine: number; endLine: number; text: string }
  | { type: 'explain'; startLine: number; endLine: number; text: string }
  | { type: 'note'; startLine: number; endLine: number; text: string }
  | { type: 'removeAnnotation'; id: string }
  | { type: 'regenerateAnnotation'; id: string }
  | { type: 'convertToNote'; id: string }
  | { type: 'editAnnotation'; id: string; content: string }
  | { type: 'dispose'; id: string; kind: DocFindingDisposition }
  | { type: 'viewFix'; id: string }
  | { type: 'locate'; line: number; endLine?: number; id?: string }
  | { type: 'analyze' }
  | { type: 'jumpNext' }
  | { type: 'focusTree' };

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
        m().documentPanel.title,
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

  /** The editor column the document view occupies, if open. Lets companion
   * panels (e.g. the global report) open as a TAB in the same group instead of
   * splitting into a separate column. */
  static get viewColumn(): vscode.ViewColumn | undefined {
    return DocumentPanel.current?.panel.viewColumn;
  }

  /**
   * Disposes the current document panel, if any. Used when the workbench moves
   * to another window so the next file opens beside it instead of being stranded
   * in the window where the panel was first created.
   */
  static closeIfOpen(): void {
    DocumentPanel.current?.panel.dispose();
  }

  /** Re-renders the open document panel in the current language (after a language switch). */
  static refreshIfOpen(): void {
    const inst = DocumentPanel.current;
    if (inst) {
      inst.ready = false;
      inst.panel.webview.html = inst.shell();
    }
  }

  /** Switches to source view and scrolls a line (or line range) into view. */
  static scrollTo(line: number, endLine?: number): void {
    const inst = DocumentPanel.current;
    if (inst?.ready) {
      void inst.panel.webview.postMessage({ type: 'scrollTo', line, endLine });
    }
  }

  /** Reveals the document view and moves keyboard focus into it. */
  static focus(): void {
    const inst = DocumentPanel.current;
    if (!inst) {
      return;
    }
    inst.panel.reveal(undefined, /* preserveFocus */ false);
    void inst.panel.webview.postMessage({ type: 'focusContent' });
  }

  /**
   * Reflects analysis progress on the topbar "分析此文件" button. Only the panel
   * currently showing `path` reacts. When `on` is false, `ok` controls whether a
   * brief "完成" flash is shown.
   */
  static setAnalyzing(path: string, on: boolean, ok = true): void {
    const inst = DocumentPanel.current;
    if (inst?.ready && inst.model?.path === path) {
      void inst.panel.webview.postMessage({ type: 'analyzing', on, ok });
    }
  }

  /**
   * Flashes a short notice strip inside the document view (current window),
   * replacing parent-window notifications for per-file analysis results/errors.
   * Only the panel currently showing `path` reacts. Returns whether it was shown
   * so callers can fall back to a normal notification when it isn't.
   */
  static flashNotice(path: string, message: string, kind: 'info' | 'error' = 'info', ms = 4000): boolean {
    const inst = DocumentPanel.current;
    if (inst?.ready && inst.model?.path === path) {
      void inst.panel.webview.postMessage({ type: 'docNotice', message, kind, ms });
      return true;
    }
    return false;
  }

  /**
   * Toggles the in-place "calling the model" bubble for translate / explain on
   * the panel showing `path`. Used to clear the bubble when the call finishes
   * (success arrives via a reload; errors clear it explicitly).
   */
  static setAiBusy(path: string, on: boolean): void {
    const inst = DocumentPanel.current;
    if (inst?.ready && inst.model?.path === path) {
      void inst.panel.webview.postMessage({ type: 'aiBusy', on });
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
      case 'regenerateAnnotation':
        this.actions.regenerateAnnotation(path, m.id);
        break;
      case 'convertToNote':
        this.actions.convertAnnotationToNote(path, m.id);
        break;
      case 'editAnnotation':
        this.actions.editAnnotation(path, m.id, m.content);
        break;
      case 'dispose':
        this.actions.disposeFinding(path, m.id, m.kind);
        break;
      case 'viewFix':
        this.actions.viewFix(path, m.id);
        break;
      case 'locate':
        this.actions.locate(path, m.line, m.endLine, m.id);
        break;
      case 'analyze':
        this.actions.analyze(path);
        break;
      case 'jumpNext':
        this.actions.jumpNext(path);
        break;
      case 'focusTree':
        this.actions.focusTree();
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
    const t = m().documentPanel;
    const lang = resolveLanguage();
    return `<!DOCTYPE html>
<html lang="${lang}">
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
    transition:background .12s ease, transform .08s ease, box-shadow .12s ease, border-color .12s ease;
  }
  button:hover { background:var(--vscode-button-secondaryHoverBackground, rgba(127,127,127,.24)); }
  button:active { transform:translateY(1px); }
  button:focus-visible { outline:none; border-color:var(--vscode-focusBorder, var(--blue)); box-shadow:0 0 0 2px color-mix(in srgb, var(--vscode-focusBorder, #569cd6) 35%, transparent); }

  /* Topbar action buttons */
  .topbar #act-jump, .topbar #act-analyze {
    position:relative; font-weight:600; padding:4px 12px;
  }
  .topbar #act-jump:hover, .topbar #act-analyze:hover {
    transform:translateY(-1px); box-shadow:0 2px 8px rgba(0,0,0,.18);
  }
  .topbar #act-jump:active, .topbar #act-analyze:active {
    transform:translateY(0); box-shadow:none;
  }
  .topbar #act-analyze {
    background:var(--vscode-button-background); color:var(--vscode-button-foreground); border-color:transparent;
  }
  .topbar #act-analyze:hover {
    background:var(--vscode-button-hoverBackground, var(--vscode-button-background));
  }
  /* analyze button: state transitions (icon stays put; progress shown by the
     bottom bar, not a spinner) */
  #act-analyze { display:inline-flex; align-items:center; gap:6px; }
  #act-analyze.analyzing { cursor:progress; pointer-events:none; }
  #act-analyze.analyzing:hover { transform:none; box-shadow:none; }
  /* indeterminate progress bar along the button bottom while analyzing */
  #act-analyze { overflow:hidden; }
  #act-analyze.analyzing::after {
    content:''; position:absolute; left:0; bottom:0; height:2px; width:40%;
    background:var(--vscode-button-foreground, #fff); opacity:.85; border-radius:2px;
    animation:anBar 1.1s ease-in-out infinite;
  }
  @keyframes anBar { 0% { left:-40%; } 100% { left:100%; } }
  /* in-document notice strip (replaces parent-window notifications) */
  .doc-notice {
    flex:none; padding:5px 12px; font-size:12px; line-height:1.5;
    border-bottom:1px solid var(--line);
    background:var(--vscode-inputValidation-infoBackground, rgba(86,156,214,.12));
    color:var(--vscode-foreground);
  }
  .doc-notice[hidden] { display:none; }
  .doc-notice.error {
    background:var(--vscode-inputValidation-errorBackground, rgba(241,76,76,.14));
    color:var(--vscode-inputValidation-errorForeground, var(--red));
    border-bottom-color:var(--vscode-inputValidation-errorBorder, rgba(241,76,76,.4));
  }
  #act-analyze.done {
    background:var(--green); color:var(--vscode-editor-background, #1e1e1e);
    box-shadow:0 0 0 3px color-mix(in srgb, var(--green) 28%, transparent);
  }
  #act-analyze.done:hover { transform:none; }
  /* keyboard-shortcut badge shown after a button label */
  .kbd {
    margin-left:7px; padding:0 5px; min-width:15px; height:15px; line-height:15px;
    display:inline-block; text-align:center; font-size:10px; font-weight:600;
    border-radius:3px; border:1px solid var(--line);
    background:color-mix(in srgb, var(--vscode-foreground, #ccc) 10%, transparent);
    color:var(--dim); vertical-align:middle;
  }
  #act-analyze .kbd { border-color:color-mix(in srgb, var(--vscode-button-foreground,#fff) 40%, transparent); color:var(--vscode-button-foreground, #fff); }
  .topbar .ico { margin-right:5px; }
  .content { flex:1; overflow:auto; position:relative; }

  /* Source view */
  .src { font-family:var(--vscode-editor-font-family, monospace); font-size:var(--vscode-editor-font-size, 13px); padding:6px 0 40vh; }
  .ln { display:flex; align-items:flex-start; padding:0 12px 0 0; white-space:pre; position:relative; }
  .ln:hover { background:rgba(127,127,127,.06); }
  .gutter { flex:none; width:52px; text-align:right; padding-right:12px; color:var(--dim); user-select:none; opacity:.6; }
  .ln.seen .gutter { color:var(--green); opacity:1; }
  .ln.seen { box-shadow:inset 2px 0 0 var(--green); }
  .ln.locate-hit { background:rgba(197,134,192,.16); box-shadow:inset 3px 0 0 #c586c0; }
  .ln.locate-hit.seen { box-shadow:inset 3px 0 0 #c586c0, inset 5px 0 0 var(--green); }
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
  .anno-regen, .anno-tonote, .anno-edit, .anno-x { margin-left:auto; opacity:.6; padding:0 6px; cursor:pointer; }
  .anno-regen ~ .anno-tonote, .anno-regen ~ .anno-edit, .anno-regen ~ .anno-x,
  .anno-tonote ~ .anno-x, .anno-edit ~ .anno-x { margin-left:0; }
  .anno-regen:hover { opacity:1; color:var(--blue); }
  .anno-tonote:hover, .anno-edit:hover { opacity:1; }
  .anno-x:hover { opacity:1; color:var(--red); }
  .anno-editbox { padding:0 10px 10px; }
  .anno-edit-ta {
    width:100%; box-sizing:border-box; min-height:88px; resize:vertical;
    font-family:inherit; font-size:13px; line-height:1.6; padding:7px 9px;
    color:var(--vscode-input-foreground); background:var(--vscode-input-background);
    border:1px solid var(--vscode-input-border, var(--line)); border-radius:6px; outline:none;
  }
  .anno-edit-ta:focus { border-color:var(--vscode-focusBorder, var(--blue)); }
  .anno-editbar { display:flex; justify-content:flex-end; gap:6px; margin-top:6px; }
  .anno-editbar button { font-family:inherit; font-size:12px; padding:4px 12px; cursor:pointer; border-radius:5px; border:1px solid var(--line); background:var(--vscode-button-secondaryBackground); color:var(--vscode-button-secondaryForeground); }
  .anno-editbar button.primary { background:var(--vscode-button-background); color:var(--vscode-button-foreground); border-color:transparent; }
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
  .f-head { display:flex; align-items:center; gap:8px; padding:6px 10px; cursor:pointer; user-select:none; }
  .f-head:hover .f-title { text-decoration:underline; text-underline-offset:2px; }
  .f-caret { flex:none; width:10px; color:var(--dim); font-size:10px; transition:transform .12s; transform:rotate(90deg); }
  .finding.collapsed .f-caret { transform:rotate(0deg); }
  .f-tag { font-size:11px; padding:1px 7px; border-radius:4px; font-weight:600; flex:none; white-space:nowrap; }
  .finding.bug .f-tag { background:var(--red-bg, rgba(241,76,76,.14)); color:var(--red); }
  .finding.conditional .f-tag { background:rgba(216,192,32,.14); color:var(--yellow); }
  .finding.suggestion .f-tag { background:rgba(86,156,214,.16); color:var(--blue); }
  .f-title { font-weight:600; flex:none; max-width:100%; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .f-status { font-size:11px; color:var(--green); flex:1; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; display:none; }
  .finding.collapsed .f-status { display:inline; }
  .finding.collapsed .f-title { flex:none; }
  .f-spacer { flex:1; }
  .finding.collapsed .f-spacer { display:none; }
  .f-line { font-family:var(--vscode-editor-font-family, monospace); font-size:11px; color:var(--blue); flex:none; }
  .f-body { padding:0 10px 8px; }
  .finding.collapsed .f-body { display:none; }
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
  .pop-busy {
    position:fixed; z-index:51; display:none; align-items:center; gap:7px;
    padding:6px 11px; font-size:12px; color:var(--vscode-foreground);
    background:var(--vscode-editorWidget-background); border:1px solid var(--line);
    border-radius:8px; box-shadow:0 4px 16px rgba(0,0,0,.3);
  }
  .pop-busy .spin {
    width:12px; height:12px; flex:none; border-radius:50%;
    border:2px solid color-mix(in srgb, var(--blue) 35%, transparent);
    border-top-color:var(--blue); animation:popSpin .7s linear infinite;
  }
  @keyframes popSpin { to { transform:rotate(360deg); } }
  .hint { padding:6px 12px; color:var(--dim); font-size:11px; border-bottom:1px solid var(--line); background:rgba(197,134,192,.08); }
</style>
</head>
<body>
  <div class="topbar">
    <span class="fname" id="fname"></span>
    <span class="spacer"></span>
    <span class="seg" id="seg" style="display:none">
      <button id="m-read" class="on">${t.readView}</button>
      <button id="m-src">${t.sourceView}</button>
    </span>
    <button id="act-jump"><span class="ico">⤵</span>${t.jumpNextUnseen}</button>
    <button id="act-analyze"><span class="ico">🔬</span><span class="btn-label">${t.analyzeFile}</span><span class="kbd">A</span></button>
  </div>
  <div class="doc-notice" id="docNotice" hidden></div>
  <div class="findbar collapsed" id="findbar" style="display:none">
    <button class="findbar-toggle" id="findbar-toggle"></button>
    <div class="findlist" id="findlist"></div>
  </div>
  <div class="content" id="content"></div>
  <div class="pop" id="pop">
    <button id="pop-tr">${t.translate}</button>
    <button id="pop-explain">${t.explain}</button>
    <button id="pop-note">${t.note}</button>
  </div>
  <div class="pop-busy" id="pop-busy"><span class="spin"></span><span id="pop-busy-label"></span></div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const T = ${JSON.stringify(t)};
const SEV = ${JSON.stringify(m().severity)};
const DISP = ${JSON.stringify(m().disposition)};
const fmt = (s, ...a) => String(s).replace(/\\{(\\d+)\\}/g, (_, i) => a[Number(i)] ?? '');
let model = null;
let loadedPath = null;
let mode = 'source';
const seen = new Set();
let io = null;
const visible = new Set();
let seenTimer = null;
// Persistent 「定位」 highlight: stays lit until you locate elsewhere or switch
// files, instead of flashing and fading. Re-applied after every source render.
let locatedRange = null;

const $ = (id) => document.getElementById(id);
const contentEl = $('content');

function rawText() { return (model.raw || []).join('\\n'); }

function decodeEntities(s) {
  return s.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'");
}

const SEV_LABEL = SEV;
const DISP_LABEL = DISP;

function findingCard(f) {
  const div = document.createElement('div');
  div.className = 'finding ' + f.severity + (f.disposition ? ' disposed' : '');
  // Default-collapse anything already dealt with (fixed / commented / ignored)
  // so resolved findings stop splitting the code; keep open findings expanded.
  if (f.disposition) div.classList.add('collapsed');
  const head = document.createElement('div');
  head.className = 'f-head';
  head.title = T.toggleTitle;
  head.innerHTML =
    '<span class="f-caret">▸</span>' +
    '<span class="f-tag">' + (SEV_LABEL[f.severity] || f.severity) + '</span>' +
    '<span class="f-title"></span>' +
    '<span class="f-status"></span>' +
    '<span class="f-spacer"></span>' +
    '<span class="f-line">' + fmt(T.line, f.line) + '</span>';
  head.querySelector('.f-title').textContent = f.title;
  if (f.disposition) {
    head.querySelector('.f-status').textContent = '✓ ' + (DISP_LABEL[f.disposition] || f.disposition);
  }
  head.addEventListener('click', () => div.classList.toggle('collapsed'));
  const body = document.createElement('div');
  body.className = 'f-body';
  const detail = document.createElement('p');
  detail.className = 'f-detail';
  detail.textContent = f.detail;
  body.appendChild(detail);
  if (f.suggestion) {
    const sug = document.createElement('p');
    sug.className = 'f-suggest';
    sug.textContent = T.suggestionPrefix + f.suggestion;
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
  locate.textContent = T.locate;
  locate.addEventListener('click', () => vscode.postMessage({ type:'locate', line:f.line, endLine:f.endLine, id:f.id }));
  actions.appendChild(locate);

  function disposeBtn(kind, label, primary) {
    const b = document.createElement('button');
    b.textContent = (f.disposition === kind ? T.revertPrefix : '') + label;
    if (primary && f.disposition !== kind) b.className = 'primary';
    b.addEventListener('click', () => vscode.postMessage({ type:'dispose', id:f.id, kind:kind }));
    return b;
  }
  // The "fixed" disposition is produced *only* by applying a proposal inside the
  // fix panel, never by a manual toggle — so this is a pure entry point that
  // opens the panel for viewing / applying. The undo lives inside the panel.
  const fixBtn = document.createElement('button');
  const isFixed = f.disposition === 'fixed';
  fixBtn.textContent = isFixed ? T.fixedView : T.fixWithCopilot;
  if (!f.disposition) fixBtn.className = 'primary';
  fixBtn.addEventListener('click', () => vscode.postMessage({ type:'viewFix', id:f.id }));
  actions.appendChild(fixBtn);
  actions.appendChild(disposeBtn('commented', T.commentBtn, false));
  actions.appendChild(disposeBtn('ignored', T.ignoreBtn, false));

  body.appendChild(actions);
  div.appendChild(head);
  div.appendChild(body);
  return div;
}

function annoCard(a) {
  const where = a.startLine > 0 ? (a.endLine > a.startLine ? fmt(T.annoLineRange, a.startLine, a.endLine) : fmt(T.annoLine, a.startLine)) : T.annoSelection;
  const kind = a.kind === 'translate' ? T.annoTranslate : a.kind === 'explain' ? T.annoExplain : T.annoNote;
  const isAi = a.kind === 'translate' || a.kind === 'explain';
  const div = document.createElement('div');
  div.className = 'anno anno-' + a.kind;
  div.innerHTML =
    '<div class="anno-head"><span class="anno-kind">' + kind + '</span>' +
    '<span class="anno-where">' + where + '</span>' +
    (isAi ? '<span class="anno-regen" title="' + T.regenerate + '">⟳</span>' : '') +
    (isAi ? '<span class="anno-tonote" title="' + T.convertToNote + '">📝</span>' : '<span class="anno-edit" title="' + T.editNote + '">✎</span>') +
    '<span class="anno-x" title="' + T.delete + '">✕</span></div>' +
    '<div class="anno-body"></div>';
  const body = div.querySelector('.anno-body');
  body.textContent = a.content;

  function beginEdit() {
    if (div.querySelector('.anno-editbox')) return;
    div.classList.remove('collapsed');
    body.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'anno-editbox';
    const ta = document.createElement('textarea');
    ta.className = 'anno-edit-ta';
    ta.value = a.content;
    const bar = document.createElement('div');
    bar.className = 'anno-editbar';
    const save = document.createElement('button');
    save.className = 'primary';
    save.textContent = T.saveEdit;
    const cancel = document.createElement('button');
    cancel.textContent = T.cancelEdit;
    bar.appendChild(save);
    bar.appendChild(cancel);
    box.appendChild(ta);
    box.appendChild(bar);
    body.innerHTML = '';
    body.appendChild(box);
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    save.addEventListener('click', () => {
      const v = ta.value;
      a.content = v;
      vscode.postMessage({ type:'editAnnotation', id:a.id, content:v });
      body.textContent = v; // optimistic; a refresh will follow
    });
    cancel.addEventListener('click', () => { body.textContent = a.content; });
    ta.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') { body.textContent = a.content; }
      else if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { save.click(); }
    });
  }

  div.querySelector('.anno-head').addEventListener('click', (e) => {
    if (e.target.classList.contains('anno-x')) {
      vscode.postMessage({ type:'removeAnnotation', id:a.id });
    } else if (e.target.classList.contains('anno-regen')) {
      vscode.postMessage({ type:'regenerateAnnotation', id:a.id });
    } else if (e.target.classList.contains('anno-tonote')) {
      vscode.postMessage({ type:'convertToNote', id:a.id });
    } else if (e.target.classList.contains('anno-edit')) {
      beginEdit();
    } else {
      div.classList.toggle('collapsed');
    }
  });
  return div;
}

let srcCtx = null;

function buildSourceRow(i, marksByLine, cardsByLine, annosByLine, frag) {
  const lineNo = i + 1;
  const row = document.createElement('div');
  row.className = 'ln' + (seen.has(lineNo) ? ' seen' : '');
  row.dataset.line = String(lineNo);
  const ms = marksByLine[lineNo];
  const fmark = ms ? '<span class="fmark ' + ms[0].severity + '" title="' + ms.map(x=>x.title.replace(/"/g,'')).join(' / ') + '"></span>' : '';
  row.innerHTML = fmark + '<span class="gutter">' + lineNo + '</span><span class="code">' + (model.sourceLines[i] || '\\u200b') + '</span>';
  frag.appendChild(row);
  const cs = cardsByLine[lineNo];
  if (cs) { for (const f of cs) frag.appendChild(findingCard(f)); }
  if (annosByLine[lineNo]) { for (const a of annosByLine[lineNo]) frag.appendChild(annoCard(a)); }
  return row;
}

// The card hangs below the *last* line of the (possibly re-anchored) finding
// range so it never splits the signature from its body; the gutter dot still
// marks the finding's start line.
function findingAnchorLine(f) {
  return (f.endLine && f.endLine >= f.line) ? f.endLine : f.line;
}

function renderSource() {
  mode = 'source';
  // Cancel any in-flight incremental render from a previous file/mode switch.
  if (srcCtx && srcCtx.raf) cancelAnimationFrame(srcCtx.raf);
  const marksByLine = {};
  const cardsByLine = {};
  for (const f of model.findings) {
    (marksByLine[f.line] = marksByLine[f.line] || []).push(f);
    const anchor = findingAnchorLine(f);
    (cardsByLine[anchor] = cardsByLine[anchor] || []).push(f);
  }
  const annosByLine = {};
  const footAnnos = [];
  for (const a of model.annotations) {
    if (a.endLine > 0) { (annosByLine[a.endLine] = annosByLine[a.endLine] || []).push(a); }
    else { footAnnos.push(a); }
  }

  const wrap = document.createElement('div');
  wrap.className = 'src';
  contentEl.innerHTML = '';
  contentEl.appendChild(wrap);

  const total = model.sourceLines.length;

  // One shared observer; rows are observed as they are appended per chunk.
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

  const ctx = { i: 0, total, wrap, footDone: false, raf: 0, renderChunk: null };
  srcCtx = ctx;

  function appendFoot() {
    if (ctx.footDone) return;
    ctx.footDone = true;
    const oob = model.findings.filter((f) => { const a = findingAnchorLine(f); return a < 1 || a > total; });
    if (footAnnos.length || oob.length) {
      const foot = document.createElement('div');
      foot.className = 'notes-foot';
      if (oob.length) {
        foot.innerHTML = '<h4>' + T.otherFindings + '</h4>';
        for (const f of oob) foot.appendChild(findingCard(f));
      }
      if (footAnnos.length) {
        const h = document.createElement('h4'); h.textContent = T.unlocatedAnnotations; foot.appendChild(h);
        for (const a of footAnnos) foot.appendChild(annoCard(a));
      }
      wrap.appendChild(foot);
    }
  }

  ctx.renderChunk = function(limit) {
    const frag = document.createDocumentFragment();
    const rows = [];
    const stop = Math.min(ctx.i + limit, total);
    for (; ctx.i < stop; ctx.i++) {
      rows.push(buildSourceRow(ctx.i, marksByLine, cardsByLine, annosByLine, frag));
    }
    wrap.appendChild(frag);
    for (const r of rows) io.observe(r);
    if (ctx.i >= total) appendFoot();
  };

  // Render the first chunk synchronously (instant paint; small files finish
  // here), then stream the remainder across animation frames so the webview
  // never freezes on large files.
  const CHUNK = 600;
  ctx.renderChunk(CHUNK);
  function step() {
    ctx.raf = 0;
    if (ctx.i < total) { ctx.renderChunk(CHUNK); ctx.raf = requestAnimationFrame(step); }
  }
  if (ctx.i < total) ctx.raf = requestAnimationFrame(step);
}

/** Forces synchronous rendering up to (and including) a 1-based line, for locate/scrollTo. */
function ensureSrcRenderedThrough(line) {
  if (!srcCtx || srcCtx.i >= srcCtx.total) return;
  while (srcCtx.i < line && srcCtx.i < srcCtx.total) srcCtx.renderChunk(1000);
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
      const h = document.createElement('h4'); h.textContent = fmt(T.fileFindings, model.findings.length); foot.appendChild(h);
      for (const f of model.findings) foot.appendChild(findingCard(f));
    }
    if (rest.length) {
      const h = document.createElement('h4'); h.textContent = T.annotationsTranslations; foot.appendChild(h);
      for (const a of rest) foot.appendChild(annoCard(a));
    }
    wrap.appendChild(foot);
  }

  // Coverage in reading mode: rendered markdown blocks have no per-line rows,
  // so map source lines proportionally onto the top-level blocks and mark a
  // block's slice seen once it scrolls into view. Reaching the bottom marks the
  // whole file read, matching how a reviewer reads the rendered doc top-down.
  const total = model.sourceLines.length;
  const N = blocks.length;
  if (N && total) {
    const ranges = new Map();
    blocks.forEach((b, k) => {
      ranges.set(b, [Math.floor(k * total / N) + 1, Math.floor((k + 1) * total / N)]);
    });
    io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const r = ranges.get(e.target);
        if (r) for (let l = r[0]; l <= r[1]; l++) visible.add(l);
      }
      clearTimeout(seenTimer);
      seenTimer = setTimeout(flushSeen, 300);
    }, { root: contentEl, threshold: 0.3 });
    for (const b of blocks) io.observe(b);
  }
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
  // Switching to a different file should start at the top; refreshing the same
  // file (e.g. after re-analysis) should keep the reader where they were.
  const isNewFile = model.path !== loadedPath;
  loadedPath = model.path;
  // A located highlight belongs to the file it was set in; drop it on switch.
  if (isNewFile) locatedRange = null;
  // Drive the analyze button from this file's real state, so switching away from
  // an analyzing file shows the new file's (idle) button instead of a stuck
  // 分析中… left over from the previous file.
  setAnalyzing(!!model.analyzing, true, true);
  $('seg').style.display = model.isMarkdown ? 'flex' : 'none';
  seen.clear();
  for (const l of model.seen) seen.add(l);
  renderFindbar();
  if (model.isMarkdown && mode !== 'source') { setMode('reading', isNewFile); }
  else { setMode('source', isNewFile); }
}

function renderFindbar() {
  const fb = $('findbar');
  const fs = (model.findings || []);
  if (!fs.length) { fb.style.display = 'none'; return; }
  fb.style.display = 'block';
  const unconfirmed = fs.filter((f) => !f.disposition).length;
  $('findbar-toggle').innerHTML =
    '<span class="fb-count">' + fmt(T.findingCount, fs.length) + '</span>' +
    (unconfirmed ? '<span class="fb-warn">' + fmt(T.unconfirmedCount, unconfirmed) + '</span>' : '<span class="fb-ok">' + T.allConfirmed + '</span>') +
    '<span class="fb-caret">▾</span>';
  const list = $('findlist');
  list.innerHTML = '';
  for (const f of fs) {
    const item = document.createElement('div');
    item.className = 'finditem ' + f.severity + (f.disposition ? ' confirmed' : '');
    item.innerHTML =
      '<span class="fi-dot"></span><span class="fi-title"></span>' +
      '<span class="fi-line">' + fmt(T.line, f.line) + '</span>' +
      (f.disposition ? '<span class="fi-ok">✓</span>' : '');
    item.querySelector('.fi-title').textContent = f.title;
    item.addEventListener('click', () => vscode.postMessage({ type:'locate', line:f.line, endLine:f.endLine, id:f.id }));
    list.appendChild(item);
  }
}

function setMode(m, resetScroll) {
  $('m-read').classList.toggle('on', m === 'reading');
  $('m-src').classList.toggle('on', m === 'source');
  // Preserve scroll position when merely toggling the view mode; jump to the
  // top when loading a different file (resetScroll).
  const top = resetScroll ? 0 : contentEl.scrollTop;
  if (m === 'reading' && model.isMarkdown) renderReading(); else renderSource();
  contentEl.scrollTop = top;
  // A full source re-render drops per-row classes, so re-paint the persistent
  // locate highlight onto the (possibly freshly rendered) rows.
  applyLocateHighlight();
}

// Persistent locate highlight -------------------------------------------------
function clearLocateHighlight() {
  const prev = contentEl.querySelectorAll('.ln.locate-hit');
  for (const r of prev) r.classList.remove('locate-hit');
}

function applyLocateHighlight() {
  clearLocateHighlight();
  if (!locatedRange) return;
  // Rows stream in chunks on large files; force-render up to the target so the
  // highlight always lands even right after a mode toggle / re-render.
  ensureSrcRenderedThrough(locatedRange.end);
  for (let l = locatedRange.start; l <= locatedRange.end; l++) {
    const row = contentEl.querySelector('.ln[data-line="' + l + '"]');
    if (row) row.classList.add('locate-hit');
  }
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
$('pop-tr').addEventListener('click', () => { if (pendingSel) { showAiBusy(T.translatingInline); vscode.postMessage({ type:'translate', startLine:pendingSel.startLine, endLine:pendingSel.endLine, text:pendingSel.text }); pop.style.display='none'; } });
$('pop-explain').addEventListener('click', () => { if (pendingSel) { showAiBusy(T.explainingInline); vscode.postMessage({ type:'explain', startLine:pendingSel.startLine, endLine:pendingSel.endLine, text:pendingSel.text }); pop.style.display='none'; } });
$('pop-note').addEventListener('click', () => { if (pendingSel) { vscode.postMessage({ type:'note', startLine:pendingSel.startLine, endLine:pendingSel.endLine, text:pendingSel.text }); pop.style.display='none'; } });

// In-place "calling the model" feedback for translate / explain, anchored where
// the selection popover was, so the user sees work is happening without hunting
// for a parent-window notification.
const popBusy = $('pop-busy');
function showAiBusy(label) {
  const lbl = $('pop-busy-label');
  if (lbl) lbl.textContent = label || '';
  popBusy.style.left = pop.style.left || '50%';
  popBusy.style.top = pop.style.top || '50%';
  popBusy.style.display = 'flex';
}
function hideAiBusy() { popBusy.style.display = 'none'; }

// Toolbar -----------------------------------------------------------------
$('m-read').addEventListener('click', () => setMode('reading'));
$('m-src').addEventListener('click', () => setMode('source'));
$('act-analyze').addEventListener('click', () => { setAnalyzing(true); vscode.postMessage({ type:'analyze' }); });
$('act-jump').addEventListener('click', () => vscode.postMessage({ type:'jumpNext' }));
$('findbar-toggle').addEventListener('click', () => $('findbar').classList.toggle('collapsed'));

let doneTimer = 0;
function setAnalyzing(on, ok, silent) {
  const btn = $('act-analyze');
  if (!btn) return;
  const label = btn.querySelector('.btn-label');
  if (doneTimer) { clearTimeout(doneTimer); doneTimer = 0; }
  if (on) {
    btn.classList.add('analyzing');
    btn.classList.remove('done');
    if (label) label.textContent = T.analyzing;
  } else if (silent) {
    // Silent reset (e.g. switching files): straight back to idle, no 完成 flash.
    btn.classList.remove('analyzing');
    btn.classList.remove('done');
    if (label) label.textContent = T.analyzeFile;
  } else {
    btn.classList.remove('analyzing');
    if (ok !== false) {
      btn.classList.add('done');
      if (label) label.textContent = T.analyzeDone;
      doneTimer = setTimeout(() => {
        btn.classList.remove('done');
        if (label) label.textContent = T.analyzeFile;
        doneTimer = 0;
      }, 1800);
    } else if (label) {
      label.textContent = T.analyzeFile;
    }
  }
}

// In-document notice strip — replaces parent-window notifications so analysis
// results / errors are visible even when the workbench is full-screen.
let docNoticeTimer = 0;
function flashDocNotice(message, kind, ms) {
  const el = $('docNotice');
  if (!el) return;
  el.textContent = message || '';
  el.className = 'doc-notice' + (kind === 'error' ? ' error' : '');
  el.hidden = false;
  if (docNoticeTimer) clearTimeout(docNoticeTimer);
  docNoticeTimer = setTimeout(() => { el.hidden = true; docNoticeTimer = 0; }, ms || 4000);
}

window.addEventListener('message', (ev) => {
  const msg = ev.data;
  if (msg.type === 'load') { hideAiBusy(); model = msg.model; render(); }
  else if (msg.type === 'aiBusy') { if (!msg.on) hideAiBusy(); }
  else if (msg.type === 'docNotice') { flashDocNotice(msg.message, msg.kind, msg.ms); }
  else if (msg.type === 'focusContent') { contentEl.setAttribute('tabindex', '-1'); contentEl.focus(); }
  else if (msg.type === 'analyzing') { setAnalyzing(msg.on, msg.ok); }
  else if (msg.type === 'scrollTo') {
    if (mode !== 'source') setMode('source');
    const start = msg.line;
    const end = (msg.endLine && msg.endLine > start) ? msg.endLine : start;
    // The target line may not be rendered yet on a large file — flush up to it.
    ensureSrcRenderedThrough(end);
    // Persistent highlight: stays lit until the next locate or a file switch.
    locatedRange = { start: start, end: end };
    applyLocateHighlight();
    centerLine(start);
  }
});

/**
 * Scrolls the source view so the 1-based line sits at the vertical center of the
 * viewport. Uses the row's real offsetTop (not scrollIntoView, which mis-centers
 * while later finding/annotation cards are still streaming in and the document
 * height is still growing). Runs after a frame so layout is settled.
 */
function centerLine(line) {
  const doIt = () => {
    const row = contentEl.querySelector('.ln[data-line="' + line + '"]');
    if (!row) return;
    const target = row.offsetTop - (contentEl.clientHeight / 2) + (row.offsetHeight / 2);
    contentEl.scrollTop = Math.max(0, target);
  };
  // Two rAFs: first lets pending DOM (mode switch, flushed chunk) commit, the
  // second measures after layout so offsetTop is final.
  requestAnimationFrame(() => requestAnimationFrame(doIt));
}

// ---- Keyboard navigation (LOCAL ONLY — never triggers a paid model call
// except the explicit A = analyze) ------------------------------------------
let findingPtr = -1;
function findingNav() {
  // Findings sorted by line; J cycles through them.
  return (model && model.findings ? model.findings.slice() : []).sort((a, b) => a.line - b.line);
}
function jumpToFinding(idx) {
  const list = findingNav();
  if (list.length === 0) return;
  findingPtr = ((idx % list.length) + list.length) % list.length; // wrap both ways
  const f = list[findingPtr];
  if (mode !== 'source') setMode('source');
  const start = f.line;
  const end = (f.endLine && f.endLine > start) ? f.endLine : start;
  ensureSrcRenderedThrough(end);
  locatedRange = { start: start, end: end };
  applyLocateHighlight();
  centerLine(start);
}
function typingInField(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
}
window.addEventListener('keydown', (e) => {
  // Never hijack keys while editing a note or in any input.
  if (typingInField(e.target)) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key;
  if (k === 'j' || k === 'J') {
    e.preventDefault();
    jumpToFinding(findingPtr + 1); // wraps to first after the last
  } else if (k === 'a' || k === 'A') {
    // The ONLY shortcut that may cost tokens — mirrors the 分析此文件 button.
    const btn = $('act-analyze');
    if (btn && !btn.classList.contains('analyzing')) {
      e.preventDefault();
      setAnalyzing(true);
      vscode.postMessage({ type:'analyze' });
    }
  } else if (k === 'ArrowLeft' || k === 'Escape') {
    // Hand focus back to the file tree. Ignore ArrowLeft mid-text-selection.
    const sel = window.getSelection();
    if (k === 'ArrowLeft' && sel && !sel.isCollapsed) return;
    e.preventDefault();
    vscode.postMessage({ type:'focusTree' });
  }
  // ArrowUp/ArrowDown fall through to the browser → natural code scrolling.
});

vscode.postMessage({ type:'ready' });
</script>
</body>
</html>`;
  }
}
