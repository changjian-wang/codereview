import * as vscode from 'vscode';
import type { GlobalReport, FindingSeverity } from '../ai/types';

const SEVERITY_LABEL: Record<FindingSeverity, string> = {
  bug: '真 Bug',
  conditional: '条件性',
  suggestion: '建议',
};

const SEVERITY_ORDER: FindingSeverity[] = ['bug', 'conditional', 'suggestion'];

/** Message from the webview to the extension. */
type InboundMessage =
  | { type: 'locate'; file: string; line: number }
  | { type: 'confirm' };

/**
 * The single rich webview in the extension: shows the cross-file global
 * analysis report (conclusion + evidence chain + fix spots), with locate
 * buttons and a "confirm read" gate action.
 */
export class GlobalReportPanel {
  private static current?: GlobalReportPanel;
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private onLocate: (file: string, line: number) => void;
  private onConfirm: () => void;

  private constructor(
    panel: vscode.WebviewPanel,
    onLocate: (file: string, line: number) => void,
    onConfirm: () => void,
  ) {
    this.panel = panel;
    this.onLocate = onLocate;
    this.onConfirm = onConfirm;
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (msg: InboundMessage) => {
        if (msg.type === 'locate') {
          this.onLocate(msg.file, msg.line);
        } else if (msg.type === 'confirm') {
          this.onConfirm();
          void vscode.window.showInformationMessage('已确认阅读全局结论。');
        }
      },
      null,
      this.disposables,
    );
  }

  /** Creates or reveals the panel and renders the report. */
  static show(
    report: GlobalReport,
    confirmed: boolean,
    onLocate: (file: string, line: number) => void,
    onConfirm: () => void,
  ): GlobalReportPanel {
    const column = vscode.ViewColumn.Beside;
    if (GlobalReportPanel.current) {
      const existing = GlobalReportPanel.current;
      existing.onLocate = onLocate;
      existing.onConfirm = onConfirm;
      existing.panel.reveal(column);
      existing.update(report, confirmed);
      return existing;
    }
    const panel = vscode.window.createWebviewPanel(
      'codereview.globalReport',
      'Code Review · 全局结论',
      column,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    const instance = new GlobalReportPanel(panel, onLocate, onConfirm);
    GlobalReportPanel.current = instance;
    instance.update(report, confirmed);
    return instance;
  }

  private update(report: GlobalReport, confirmed: boolean): void {
    this.panel.webview.html = this.render(report, confirmed);
  }

  private render(report: GlobalReport, confirmed: boolean): string {
    const nonce = String(Math.random()).slice(2);
    const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    const evidence = report.evidence.length
      ? `<ol class="evidence">${report.evidence.map((e) => `<li>${esc(e)}</li>`).join('')}</ol>`
      : '<p class="muted">（无证据链）</p>';

    const spotsBySeverity = SEVERITY_ORDER.map((sev) => {
      const spots = report.fixSpots.filter((s) => s.severity === sev);
      if (!spots.length) {
        return '';
      }
      const cards = spots
        .map(
          (s) => `
        <div class="card sev-${s.severity}">
          <div class="card-head">
            <span class="tag">${SEVERITY_LABEL[s.severity]}</span>
            <span class="title">${esc(s.title)}</span>
          </div>
          <div class="loc">${esc(s.file)}:${s.line}</div>
          <p>${esc(s.detail)}</p>
          ${s.suggestion ? `<p class="suggest">建议：${esc(s.suggestion)}</p>` : ''}
          <button class="locate" data-file="${escAttr(s.file)}" data-line="${s.line}">定位</button>
        </div>`,
        )
        .join('');
      return `<h3>${SEVERITY_LABEL[sev]}</h3>${cards}`;
    }).join('');

    const fixSection = report.fixSpots.length
      ? spotsBySeverity
      : '<p class="muted">未发现需要修复的跨文件问题。</p>';

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 1rem 1.25rem; line-height: 1.55; }
  h1 { font-size: 1.15rem; margin: 0 0 .75rem; }
  h2 { font-size: 1rem; margin: 1.4rem 0 .5rem; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: .25rem; }
  h3 { font-size: .85rem; margin: 1rem 0 .4rem; opacity: .85; }
  .conclusion { background: var(--vscode-textBlockQuote-background); border-left: 3px solid var(--vscode-textLink-foreground); padding: .6rem .8rem; border-radius: 4px; }
  .evidence li { margin: .25rem 0; }
  .muted { opacity: .6; }
  .card { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: .6rem .75rem; margin: .5rem 0; }
  .card-head { display: flex; align-items: center; gap: .5rem; }
  .title { font-weight: 600; }
  .loc { font-family: var(--vscode-editor-font-family); font-size: .8rem; opacity: .7; margin: .3rem 0; }
  .suggest { color: var(--vscode-textLink-foreground); }
  .tag { font-size: .72rem; padding: .1rem .4rem; border-radius: 3px; color: #fff; }
  .sev-bug .tag { background: #d13438; }
  .sev-conditional .tag { background: #c97a16; }
  .sev-suggestion .tag { background: #2563eb; }
  button { font-family: inherit; cursor: pointer; border: none; border-radius: 4px; padding: .3rem .7rem; }
  .locate { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .confirm-bar { margin-top: 1.5rem; padding-top: 1rem; border-top: 1px solid var(--vscode-panel-border); }
  #confirm { background: var(--vscode-button-background); color: var(--vscode-button-foreground); padding: .45rem 1rem; }
  #confirm:disabled { opacity: .6; cursor: default; }
  .done { color: var(--vscode-testing-iconPassed); font-weight: 600; }
</style>
</head>
<body>
  <h1>跨文件全局结论</h1>
  <div class="conclusion">${esc(report.conclusion)}</div>

  <h2>证据链</h2>
  ${evidence}

  <h2>修复落点</h2>
  ${fixSection}

  <div class="confirm-bar">
    ${
      confirmed
        ? '<span class="done">✓ 已确认阅读全局结论</span>'
        : '<button id="confirm">确认读过全局结论</button>'
    }
  </div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  document.querySelectorAll('.locate').forEach((btn) => {
    btn.addEventListener('click', () => {
      vscode.postMessage({ type: 'locate', file: btn.dataset.file, line: Number(btn.dataset.line) });
    });
  });
  const confirm = document.getElementById('confirm');
  if (confirm) {
    confirm.addEventListener('click', () => {
      confirm.disabled = true;
      vscode.postMessage({ type: 'confirm' });
    });
  }
</script>
</body>
</html>`;
  }

  dispose(): void {
    GlobalReportPanel.current = undefined;
    this.panel.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escAttr(s: string): string {
  return esc(s).replace(/"/g, '&quot;');
}
