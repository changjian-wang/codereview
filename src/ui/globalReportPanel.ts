import * as vscode from 'vscode';
import type {
  GlobalRecommendation,
  GlobalReport,
  FindingSeverity,
  VerdictKind,
} from '../ai/types';
import { transientInfo } from './toast';
import { esc, escAttr, nonce as makeNonce } from './html';

const SEVERITY_LABEL: Record<FindingSeverity, string> = {
  bug: '真 Bug',
  conditional: '条件性',
  suggestion: '建议',
};

const SEVERITY_ORDER: FindingSeverity[] = ['bug', 'conditional', 'suggestion'];

const VERDICT_LABEL: Record<VerdictKind, string> = {
  flip: '翻转',
  found: '新发现',
  confirmed: '确证',
};

const RECOMMENDATION_LABEL: Record<GlobalRecommendation, string> = {
  approve: '建议批准',
  request_changes: '建议请求修改',
  comment: '建议仅评论',
};

/** Message from the webview to the extension. */
type InboundMessage =
  | { type: 'locate'; file: string; line: number }
  | { type: 'gendiff'; file: string; line: number; title: string; detail: string; suggestion?: string }
  | { type: 'confirm' }
  | { type: 'gotoFiles' };

/** Coverage / findings stats shown in the report hero. */
export interface GlobalReportStats {
  seen: number;
  total: number;
  filesReady: number;
  filesTotal: number;
  findings: number;
}

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
  private onGenDiff?: (fix: { file: string; line: number; title: string; detail: string; suggestion?: string }) => void;
  private onGotoFiles?: () => void;
  private stats?: GlobalReportStats;

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
        } else if (msg.type === 'gendiff') {
          this.onGenDiff?.({
            file: msg.file,
            line: msg.line,
            title: msg.title,
            detail: msg.detail,
            suggestion: msg.suggestion,
          });
        } else if (msg.type === 'confirm') {
          this.onConfirm();
          transientInfo('已确认阅读全局结论');
        } else if (msg.type === 'gotoFiles') {
          this.onGotoFiles?.();
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
    onGenDiff?: (fix: { file: string; line: number; title: string; detail: string; suggestion?: string }) => void,
    stats?: GlobalReportStats,
    onGotoFiles?: () => void,
  ): GlobalReportPanel {
    const column = vscode.ViewColumn.Beside;
    if (GlobalReportPanel.current) {
      const existing = GlobalReportPanel.current;
      existing.onLocate = onLocate;
      existing.onConfirm = onConfirm;
      existing.onGenDiff = onGenDiff;
      existing.onGotoFiles = onGotoFiles;
      existing.stats = stats;
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
    instance.onGenDiff = onGenDiff;
    instance.onGotoFiles = onGotoFiles;
    instance.stats = stats;
    GlobalReportPanel.current = instance;
    instance.update(report, confirmed);
    return instance;
  }

  private update(report: GlobalReport, confirmed: boolean): void {
    this.panel.webview.html = this.render(report, confirmed);
  }

  private render(report: GlobalReport, confirmed: boolean): string {
    const nonce = makeNonce();
    const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    const evidence = report.evidence.length
      ? `<div class="evidence-steps">${report.evidence
          .map(
            (e, i) =>
              `<div class="estep"><span class="enum">${i + 1}</span><span class="etext">${esc(e)}</span></div>`,
          )
          .join('')}</div>`
      : '<p class="muted">（无证据链）</p>';

    // Decision panel counts derived from verdicts + fix spots.
    const realBugs =
      report.verdicts.filter((v) => v.kind === 'found').length +
      report.fixSpots.filter((s) => s.severity === 'bug').length;
    const flips = report.verdicts.filter((v) => v.kind === 'flip').length;
    const fixPaths = report.fixSpots.length;
    const recClass =
      report.recommendation === 'request_changes'
        ? 'block'
        : report.recommendation === 'approve'
          ? 'ok'
          : '';

    const s = this.stats;
    const pct = s && s.total > 0 ? Math.round((s.seen / s.total) * 100) : 0;
    const heroStats = s
      ? `<div class="hero-stats">
          <span class="hstat"><b>${pct}%</b> 行覆盖</span>
          <span class="hstat"><b>${s.filesReady}/${s.filesTotal}</b> 文件就绪</span>
          <span class="hstat"><b>${s.findings}</b> 文件级发现</span>
        </div>`
      : '';
    const hero = `
    <div class="hero">
      <div class="tabs">
        <button class="tab" id="tab-files">① 文件级审查</button>
        <span class="tab active">② 全局逻辑分析</span>
      </div>
      <div class="hero-title">跨文件全局结论</div>
      ${heroStats}
    </div>`;

    const decisionPanel = `
    <div class="decision ${recClass}">
      <div class="decision-main">
        <div class="kicker">全局结论</div>
        <div class="decision-title">${esc(RECOMMENDATION_LABEL[report.recommendation])}</div>
        <div class="decision-copy">${esc(report.conclusion)}</div>
      </div>
      <div class="metrics">
        <div class="metric"><div class="n red">${realBugs}</div><div class="l">确证真 bug</div></div>
        <div class="metric"><div class="n purple">${flips}</div><div class="l">推翻误报</div></div>
        <div class="metric"><div class="n green">${fixPaths}</div><div class="l">修复落点</div></div>
      </div>
    </div>`;

    const verdictSection = report.verdicts.length
      ? report.verdicts
          .map(
            (v) => `
        <div class="verdict-card vk-${v.kind}">
          <div class="vc-head">
            <span class="vk-tag vk-${v.kind}">${VERDICT_LABEL[v.kind]}</span>
            <span class="title">${esc(v.title)}</span>
          </div>
          <div class="vc-body">
            <div class="vc-grid">
              <div class="vc-col before">
                <div class="lab">文件级说（片面）</div>
                <p>${esc(v.before)}</p>
              </div>
              <div class="vc-arrow">→</div>
              <div class="vc-col after">
                <div class="lab">全局求解</div>
                <p>${esc(v.after)}</p>
              </div>
            </div>
            ${v.evidence ? `<div class="vc-evidence">${esc(v.evidence)}</div>` : ''}
            ${
              v.file
                ? `<div class="card-actions"><button class="locate" data-file="${escAttr(v.file)}" data-line="${v.line ?? 1}">定位</button></div>`
                : ''
            }
          </div>
        </div>`,
          )
          .join('')
      : '<p class="muted">（无翻转 / 新发现，文件级判断均成立）</p>';

    const spotsBySeverity = SEVERITY_ORDER.map((sev) => {
      const spots = report.fixSpots.filter((s) => s.severity === sev);
      if (!spots.length) {
        return '';
      }
      const cards = spots
        .map(
          (s) => `
        <div class="fixitem sev-${s.severity}">
          <div class="fixitem-h">
            <span class="sev-dot"></span>
            <span class="tag">${SEVERITY_LABEL[s.severity]}</span>
            <span class="title">${esc(s.title)}</span>
            <span class="where">${esc(s.file)}:${s.line}</span>
          </div>
          <div class="fixitem-b">
            <p class="why">${esc(s.detail)}</p>
            ${s.suggestion ? `<p class="suggest">建议：${esc(s.suggestion)}</p>` : ''}
            <div class="card-actions">
              <button class="locate" data-file="${escAttr(s.file)}" data-line="${s.line}">定位</button>
              <button class="gendiff" data-file="${escAttr(s.file)}" data-line="${s.line}" data-title="${escAttr(s.title)}" data-detail="${escAttr(s.detail)}" data-suggestion="${escAttr(s.suggestion ?? '')}">让 AI 生成候选 diff</button>
            </div>
          </div>
        </div>`,
        )
        .join('');
      return `<h3>${SEVERITY_LABEL[sev]}</h3>${cards}`;
    }).join('');

    const fixSection = report.fixSpots.length
      ? spotsBySeverity
      : '<p class="muted">未发现需要修复的跨文件问题。</p>';

    // Call graph: caller → callee chain.
    const callGraphSection = report.callGraph.length
      ? `<div class="callgraph">${report.callGraph
          .map(
            (n, i) =>
              `${i > 0 ? '<span class="cg-arrow">→</span>' : ''}<span class="cg-node${n.changed ? ' changed' : ''}"><b>${esc(n.name)}</b>${n.role ? `<span class="cg-role">${esc(n.role)}</span>` : ''}${n.lifetime ? `<span class="cg-life">${esc(n.lifetime)}</span>` : ''}</span>`,
          )
          .join('')}</div>`
      : '<p class="muted">（无调用图信息）</p>';

    // Architecture / intent conformance checks.
    const archSection = report.architectureChecks.length
      ? `<ul class="glist">${report.architectureChecks
          .map(
            (c) =>
              `<li class="arch-${c.status}"><span class="gi gi-${c.status}">${c.status === 'ok' ? '✓' : c.status === 'warn' ? '▲' : 'ⓘ'}</span><span><b>${esc(c.label)}</b>：${esc(c.detail)}</span></li>`,
          )
          .join('')}</ul>`
      : '<p class="muted">（无架构 / 意图核对）</p>';

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style>
  :root {
    --purple: #c586c0; --purple-bg: rgba(197,134,192,.14);
    --red: #f14c4c; --red-bg: rgba(241,76,76,.12);
    --green: #4ec9b0; --green-bg: rgba(78,201,176,.12);
    --yellow: #d8c020; --yellow-bg: rgba(216,192,32,.1);
    --blue: #569cd6; --blue-bg: rgba(86,156,214,.14);
    --line: var(--vscode-panel-border);
    --elevated: var(--vscode-editorWidget-background, rgba(127,127,127,.06));
  }
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 0 1.25rem 2rem; line-height: 1.55; }
  h2 { font-size: 1rem; margin: 1.6rem 0 .55rem; padding-bottom: .25rem; border-bottom: 1px solid var(--line); }
  h3 { font-size: .8rem; margin: 1rem 0 .45rem; opacity: .8; text-transform: uppercase; letter-spacing: .04em; }
  .muted { opacity: .55; }
  code { font-family: var(--vscode-editor-font-family); background: var(--vscode-textCodeBlock-background); padding: 0 4px; border-radius: 3px; font-size: .9em; }

  /* Hero with file/global tabs + stats */
  .hero { position: sticky; top: 0; z-index: 5; background: var(--vscode-editor-background); padding: .85rem 0 .7rem; border-bottom: 1px solid var(--line); margin-bottom: 1rem; }
  .tabs { display: flex; gap: .4rem; margin-bottom: .65rem; }
  .tab { font-family: inherit; font-size: .78rem; padding: .3rem .8rem; border-radius: 6px 6px 0 0; border: 1px solid var(--line); border-bottom: none; background: var(--elevated); color: var(--vscode-descriptionForeground); cursor: pointer; }
  .tab.active { background: var(--purple-bg); color: var(--purple); border-color: rgba(197,134,192,.4); cursor: default; font-weight: 600; }
  #tab-files:hover { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-foreground); }
  .hero-title { font-size: 1.18rem; font-weight: 700; }
  .hero-stats { display: flex; gap: 1.1rem; margin-top: .5rem; }
  .hstat { font-size: .76rem; opacity: .75; } .hstat b { color: var(--blue); font-size: .9rem; }

  /* Decision panel */
  .decision { display: grid; grid-template-columns: 1fr auto; gap: 1rem; border: 1px solid var(--line); border-left: 4px solid var(--vscode-descriptionForeground); border-radius: 8px; padding: .9rem 1.1rem; margin-bottom: 1rem; background: linear-gradient(90deg, var(--elevated), transparent); }
  .decision.block { border-left-color: var(--red); background: linear-gradient(90deg, var(--red-bg), transparent); }
  .decision.ok { border-left-color: var(--green); background: linear-gradient(90deg, var(--green-bg), transparent); }
  .kicker { font-size: .68rem; text-transform: uppercase; letter-spacing: .07em; opacity: .6; }
  .decision-title { font-size: 1.05rem; font-weight: 700; margin: .2rem 0 .4rem; }
  .decision-copy { font-size: .85rem; opacity: .9; }
  .metrics { display: flex; gap: 1rem; align-items: center; }
  .metric { text-align: center; min-width: 3.4rem; }
  .metric .n { font-size: 1.5rem; font-weight: 700; line-height: 1; }
  .metric .n.red { color: var(--red); }
  .metric .n.purple { color: var(--purple); }
  .metric .n.green { color: var(--green); }
  .metric .l { font-size: .66rem; opacity: .65; margin-top: .25rem; }

  /* Evidence steps */
  .evidence-steps { display: grid; gap: .55rem; }
  .estep { display: grid; grid-template-columns: 22px 1fr; gap: .55rem; align-items: start; border: 1px solid var(--line); border-radius: 7px; padding: .55rem .7rem; background: var(--elevated); font-size: .85rem; }
  .estep .enum { display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; border-radius: 50%; background: var(--blue-bg); color: var(--blue); font-weight: 700; font-size: .72rem; }

  /* Verdict cards: before(yellow) -> after(green) */
  .verdict-card { border: 1px solid var(--line); border-radius: 8px; margin: .55rem 0; overflow: hidden; }
  .vc-head { display: flex; align-items: center; gap: .5rem; padding: .55rem .75rem; background: var(--elevated); border-left: 3px solid var(--vscode-descriptionForeground); }
  .verdict-card.vk-flip .vc-head { border-left-color: var(--purple); }
  .verdict-card.vk-found .vc-head { border-left-color: var(--red); }
  .verdict-card.vk-confirmed .vc-head { border-left-color: var(--green); }
  .vk-tag { font-size: .68rem; padding: .12rem .5rem; border-radius: 8px; font-weight: 600; }
  .vk-tag.vk-flip { background: var(--purple-bg); color: var(--purple); }
  .vk-tag.vk-found { background: var(--red-bg); color: var(--red); }
  .vk-tag.vk-confirmed { background: var(--green-bg); color: var(--green); }
  .vc-body { padding: .7rem .75rem; }
  .vc-grid { display: grid; grid-template-columns: 1fr auto 1fr; gap: .55rem; align-items: stretch; }
  .vc-col { border-radius: 6px; padding: .5rem .65rem; }
  .vc-col.before { background: var(--yellow-bg); border: 1px solid rgba(216,192,32,.3); }
  .vc-col.after { background: var(--green-bg); border: 1px solid rgba(78,201,176,.35); }
  .vc-col .lab { font-size: .66rem; text-transform: uppercase; letter-spacing: .04em; margin-bottom: .3rem; font-weight: 600; }
  .vc-col.before .lab { color: var(--yellow); }
  .vc-col.after .lab { color: var(--green); }
  .vc-col p { font-size: .82rem; margin: 0; }
  .vc-arrow { display: grid; place-items: center; color: var(--purple); font-size: 1.2rem; }
  .vc-evidence { font-family: var(--vscode-editor-font-family); font-size: .76rem; background: var(--vscode-textCodeBlock-background); border-radius: 5px; padding: .45rem .6rem; margin-top: .55rem; white-space: pre-wrap; opacity: .9; }

  /* Fix items */
  .fixitem { border: 1px solid var(--line); border-radius: 8px; margin: .55rem 0; overflow: hidden; }
  .fixitem-h { display: flex; align-items: center; gap: .5rem; padding: .55rem .75rem; background: var(--elevated); }
  .sev-dot { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; }
  .sev-bug .sev-dot { background: var(--red); }
  .sev-conditional .sev-dot { background: var(--yellow); }
  .sev-suggestion .sev-dot { background: var(--blue); }
  .tag { font-size: .68rem; padding: .1rem .45rem; border-radius: 4px; font-weight: 600; }
  .sev-bug .tag { background: var(--red-bg); color: var(--red); }
  .sev-conditional .tag { background: var(--yellow-bg); color: var(--yellow); }
  .sev-suggestion .tag { background: var(--blue-bg); color: var(--blue); }
  .fixitem-h .title { font-weight: 600; font-size: .85rem; }
  .fixitem-h .where { margin-left: auto; font-family: var(--vscode-editor-font-family); font-size: .74rem; color: var(--blue); background: var(--blue-bg); padding: .12rem .5rem; border-radius: 5px; flex-shrink: 0; }
  .fixitem-b { padding: .65rem .75rem; }
  .fixitem-b .why { font-size: .84rem; opacity: .85; margin: 0 0 .5rem; }
  .suggest { color: var(--vscode-textLink-foreground); font-size: .84rem; margin: 0 0 .5rem; }
  .title { font-weight: 600; }

  button { font-family: inherit; cursor: pointer; border: 1px solid transparent; border-radius: 5px; padding: .32rem .75rem; font-size: .8rem; }
  .card-actions { display: flex; gap: .5rem; flex-wrap: wrap; margin-top: .3rem; }
  .locate { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .gendiff { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 1px solid rgba(86,156,214,.4); }
  .gendiff:disabled { opacity: .6; cursor: wait; }

  /* Call graph */
  .callgraph { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; margin: .4rem 0 .2rem; }
  .cg-node { display: inline-flex; flex-direction: column; border: 1px solid var(--line); border-radius: 7px; padding: .4rem .65rem; background: var(--elevated); font-family: var(--vscode-editor-font-family); font-size: .8rem; }
  .cg-node.changed { border-color: var(--purple); box-shadow: 0 0 0 1px var(--purple-bg); }
  .cg-node .cg-role { font-size: .66rem; opacity: .6; font-family: var(--vscode-font-family); margin-top: .15rem; }
  .cg-node .cg-life { display: inline-block; margin-top: .25rem; font-size: .64rem; padding: 0 .4rem; border-radius: 6px; background: var(--blue-bg); color: var(--blue); font-family: var(--vscode-font-family); }
  .cg-arrow { color: var(--vscode-descriptionForeground); opacity: .6; }

  /* Architecture / intent list */
  .glist { list-style: none; padding: 0; margin: .3rem 0; }
  .glist li { display: flex; gap: .6rem; padding: .45rem 0; border-bottom: 1px solid var(--line); font-size: .85rem; align-items: flex-start; }
  .glist li:last-child { border-bottom: none; }
  .gi { flex-shrink: 0; margin-top: .05rem; }
  .gi-ok { color: var(--green); }
  .gi-warn { color: var(--yellow); }
  .gi-info { color: var(--blue); }

  .confirm-bar { margin-top: 1.6rem; padding-top: 1rem; border-top: 1px solid var(--line); }
  #confirm { background: var(--vscode-button-background); color: var(--vscode-button-foreground); padding: .5rem 1.1rem; }
  #confirm:disabled { opacity: .6; cursor: default; }
  .done { color: var(--green); font-weight: 600; }
</style>
</head>
<body>
  ${hero}
  ${decisionPanel}

  <h2>证据链：文件级判断为何被全局事实修正</h2>
  ${evidence}
  ${verdictSection}

  <h2>修复落点</h2>
  ${fixSection}

  <h2>调用图</h2>
  ${callGraphSection}

  <h2>架构层 & PR 意图核对</h2>
  ${archSection}

  <div class="confirm-bar">
    ${
      confirmed
        ? '<span class="done">✓ 已确认阅读全局结论</span>'
        : '<button id="confirm">确认读过全局结论</button>'
    }
  </div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const tabFiles = document.getElementById('tab-files');
  if (tabFiles) {
    tabFiles.addEventListener('click', () => vscode.postMessage({ type: 'gotoFiles' }));
  }
  document.querySelectorAll('.locate').forEach((btn) => {
    btn.addEventListener('click', () => {
      vscode.postMessage({ type: 'locate', file: btn.dataset.file, line: Number(btn.dataset.line) });
    });
  });
  document.querySelectorAll('.gendiff').forEach((btn) => {
    btn.addEventListener('click', () => {
      btn.disabled = true;
      btn.textContent = '生成中…';
      vscode.postMessage({
        type: 'gendiff',
        file: btn.dataset.file,
        line: Number(btn.dataset.line),
        title: btn.dataset.title,
        detail: btn.dataset.detail,
        suggestion: btn.dataset.suggestion || undefined,
      });
      setTimeout(() => { btn.disabled = false; btn.textContent = '让 AI 生成候选 diff'; }, 4000);
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


