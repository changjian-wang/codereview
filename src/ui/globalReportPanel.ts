import * as vscode from 'vscode';
import type {
  GlobalReport,
  GlobalFixSpot,
} from '../ai/types';
import { transientInfo } from './toast';
import { esc, escAttr, nonce as makeNonce } from './html';
import { m, resolveLanguage } from '../i18n';
import { DocumentPanel } from './documentPanel';

/** Disposition kind of a fix spot — mirrors {@link FindingDisposition.kind}. */
type SpotDispositionKind = 'fixed' | 'commented' | 'ignored';

/** Message from the webview to the extension. */
type InboundMessage =
  | { type: 'locate'; file: string; line: number }
  | { type: 'globalFix'; id: string; file: string; line: number }
  | { type: 'globalIgnore'; id: string; file: string; line: number }
  | { type: 'globalComment'; id: string; file: string; line: number }
  | { type: 'globalRevert'; id: string; file: string; line: number }
  | { type: 'confirm' }
  | { type: 'gotoFiles' };

/** Coverage / findings stats shown in the report hero. */
export interface GlobalReportStats {
  seen: number;
  total: number;
  filesReady: number;
  filesTotal: number;
  findings: number;
  /** The real review gate (files ready + global confirmed); the banner's single source of truth. */
  gatePassed?: boolean;
}

/**
 * Callbacks + state the panel needs, bundled into one object so the call site
 * isn't a long positional argument list (and so adding a handler doesn't shift
 * every other argument).
 */
export interface GlobalReportHandlers {
  onLocate: (file: string, line: number) => void;
  onConfirm: () => void;
  onGlobalFix?: (spotId: string, file: string, line: number) => void;
  onGlobalIgnore?: (spotId: string, file: string, line: number) => void;
  onGlobalComment?: (spotId: string, file: string, line: number) => void;
  onGlobalRevert?: (spotId: string, file: string, line: number) => void;
  onGotoFiles?: () => void;
  /** Current disposition of a fix spot, used to bucket it into pending vs handled. */
  fixDisposition?: (spotId: string, file: string, line: number) => SpotDispositionKind | undefined;
  stats?: GlobalReportStats;
}

/**
 * The single rich webview in the extension: shows the cross-file global analysis
 * as a to-do list — a dynamic conclusion banner with a progress bar, the pending
 * fix spots as actionable items, a collapsed "handled" section, and a collapsed
 * "analysis basis" (conclusion + evidence chain + verdict flips).
 */
export class GlobalReportPanel {
  private static current?: GlobalReportPanel;
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private disposed = false;
  private handlers: GlobalReportHandlers;
  private lastReport?: GlobalReport;
  private lastConfirmed = false;

  private constructor(panel: vscode.WebviewPanel, handlers: GlobalReportHandlers) {
    this.panel = panel;
    this.handlers = handlers;
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (msg: InboundMessage) => {
        const h = this.handlers;
        if (msg.type === 'locate') {
          h.onLocate(msg.file, msg.line);
        } else if (msg.type === 'globalFix') {
          h.onGlobalFix?.(msg.id, msg.file, msg.line);
        } else if (msg.type === 'globalIgnore') {
          h.onGlobalIgnore?.(msg.id, msg.file, msg.line);
        } else if (msg.type === 'globalComment') {
          h.onGlobalComment?.(msg.id, msg.file, msg.line);
        } else if (msg.type === 'globalRevert') {
          h.onGlobalRevert?.(msg.id, msg.file, msg.line);
        } else if (msg.type === 'confirm') {
          h.onConfirm();
          transientInfo(m().globalPanel.confirmedRead);
        } else if (msg.type === 'gotoFiles') {
          h.onGotoFiles?.();
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
    handlers: GlobalReportHandlers,
  ): GlobalReportPanel {
    // Open as a TAB in the SAME group as the code (document) view, so the report
    // and the file are tabs you switch between — not a split that has to be
    // resized. Falls back to the active column when no document is open.
    const column = DocumentPanel.viewColumn ?? vscode.ViewColumn.Active;
    if (GlobalReportPanel.current) {
      const existing = GlobalReportPanel.current;
      existing.handlers = handlers;
      existing.panel.reveal(column);
      existing.update(report, confirmed);
      return existing;
    }
    const panel = vscode.window.createWebviewPanel(
      'codereview.globalReport',
      m().globalPanel.title,
      column,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    const instance = new GlobalReportPanel(panel, handlers);
    GlobalReportPanel.current = instance;
    instance.update(report, confirmed);
    return instance;
  }

  static closeIfOpen(): void {
    GlobalReportPanel.current?.panel.dispose();
  }

  /** Re-renders the open report in the current language (after a language switch). */
  static refreshIfOpen(): void {
    const c = GlobalReportPanel.current;
    if (c && c.lastReport) {
      c.update(c.lastReport, c.lastConfirmed);
    }
  }

  private update(report: GlobalReport, confirmed: boolean): void {
    this.lastReport = report;
    this.lastConfirmed = confirmed;
    this.panel.webview.html = this.render(report, confirmed);
  }

  private render(report: GlobalReport, confirmed: boolean): string {
    const nonce = makeNonce();
    const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    const t = m().globalPanel;
    const sevLabel = m().severity;
    const verdictLabel = m().verdict;
    const recLabel = m().recommendation;
    const lang = resolveLanguage();
    const evidence = report.evidence.length
      ? `<div class="evidence-steps">${report.evidence
          .map(
            (e, i) =>
              `<div class="estep"><span class="enum">${i + 1}</span><span class="etext">${esc(e)}</span></div>`,
          )
          .join('')}</div>`
      : `<p class="muted">${esc(t.noEvidence)}</p>`;

    // ---- Partition fix spots into pending vs handled (by disposition kind) ----
    const dispositionOf = this.handlers.fixDisposition;
    const kindOf = (sp: GlobalFixSpot): SpotDispositionKind | undefined =>
      dispositionOf?.(sp.id, sp.file, sp.line);
    const pendingSpots = report.fixSpots.filter((sp) => !kindOf(sp));
    const handledSpots = report.fixSpots.filter((sp) => !!kindOf(sp));
    const total = report.fixSpots.length;
    const handledCount = handledSpots.length;
    const pendingCount = total - handledCount;
    const allHandled = total > 0 && pendingCount === 0;
    const progressPct = total > 0 ? Math.round((handledCount / total) * 100) : 100;

    // ---- Gate state: the SINGLE source of truth for "can I submit?" ----
    // The gate is files-ready + global-confirmed (mirrors session.gatePassed()).
    // Fix-spot handling is advisory (Option A) and deliberately NOT part of it.
    const s = this.handlers.stats;
    const filesReady = s?.filesReady ?? 0;
    const filesTotal = s?.filesTotal ?? 0;
    const filesAllReady = filesTotal > 0 ? filesReady >= filesTotal : true;
    const gatePassed = s?.gatePassed ?? (confirmed && filesAllReady);
    const filesBlocking = !filesAllReady;
    const globalBlocking = !confirmed;

    const recClass = gatePassed ? 'ok' : 'block';
    const gateTitle = gatePassed ? t.gatePassTitle : t.gateFailTitle;
    const covPct = s && s.total > 0 ? Math.round((s.seen / s.total) * 100) : 0;
    const heroStats = s
      ? `<div class="hero-stats">
          <span class="hstat"><b>${covPct}%</b> ${esc(t.lineCoverage)}</span>
          <span class="hstat"><b>${s.filesReady}/${s.filesTotal}</b> ${esc(t.filesReady)}</span>
          <span class="hstat"><b>${s.findings}</b> ${esc(t.fileFindings)}</span>
        </div>`
      : '';

    // Gate checklist mirrors the exact reasons submitConclusion() surfaces, so the
    // panel can never show "green" while the real gate is still closed.
    const gateRow = (done: boolean, text: string, action: string): string =>
      `<li class="gate-item ${done ? 'done' : 'todo'}">
        <span class="gate-mark">${done ? '✓' : '○'}</span>
        <span class="gate-text">${esc(text)}</span>
        ${action}
      </li>`;
    const filesAction = filesBlocking
      ? `<button class="gate-cta" id="goto-files-cta">${esc(t.gateGotoFiles)}</button>`
      : '';
    const confirmAction = globalBlocking
      ? `<button class="gate-cta primary" id="confirm">${esc(t.confirmReadBtn)}</button>`
      : `<span class="gate-done-badge">${esc(t.confirmedReadBadge)}</span>`;
    const gateChecklist = gatePassed
      ? `<div class="gate-pass">${esc(t.gateAllMet)}</div>`
      : `<ul class="gate-list">
          ${gateRow(filesAllReady, filesAllReady ? t.gateFilesDone : m().conclusion.gateFilesUnready(filesTotal - filesReady), filesAction)}
          ${gateRow(confirmed, confirmed ? t.gateGlobalDone : m().conclusion.gateGlobalUnconfirmed, confirmAction)}
        </ul>`;
    const banner = `
    <div class="hero">
      <div class="tabs">
        <button class="tab" id="tab-files">${esc(t.tabFiles)}</button>
        <span class="tab active">${esc(t.tabGlobal)}</span>
      </div>
    </div>
    <div class="decision ${recClass}">
      <div class="decision-main">
        <div class="kicker">${esc(t.kicker)}</div>
        <div class="decision-title">${esc(gateTitle)}</div>
        <div class="ai-verdict av-${report.recommendation}">${esc(t.aiVerdictPrefix)}${esc(recLabel[report.recommendation])}</div>
        <div class="decision-copy">${esc(report.conclusion)}</div>
        <div class="gate-wrap">${gateChecklist}</div>
      </div>
      ${heroStats}
    </div>`;

    // Advisory fix-spot progress — shown inside the fix-spots section, NOT the gate.
    const progressLine =
      total > 0
        ? `<div class="progress-wrap">
          <div class="progress-bar"><div class="progress-fill" style="width:${progressPct}%"></div></div>
          <div class="progress-text">
            <span class="ptotal">${esc(t.progressHandled(handledCount, total))}</span>
            <span class="phint${allHandled ? ' ok' : ''}">${esc(allHandled ? t.allHandledHint : t.pendingHint(pendingCount))}</span>
          </div>
        </div>`
        : '';

    // Promote the re-review verdicts: real cross-file finds (found) and overturned
    // false positives (flip) first, confirmations last.
    const verdictRank = (k: string): number => (k === 'found' ? 0 : k === 'flip' ? 1 : 2);
    const sortedVerdicts = [...report.verdicts].sort((a, b) => verdictRank(a.kind) - verdictRank(b.kind));
    const verdictSection = report.verdicts.length
      ? sortedVerdicts
          .map(
            (v) => `
        <div class="verdict-card vk-${v.kind}">
          <div class="vc-head">
            <span class="vk-tag vk-${v.kind}">${verdictLabel[v.kind]}</span>
            <span class="title">${esc(v.title)}</span>
          </div>
          <div class="vc-body">
            <div class="vc-grid">
              <div class="vc-col before">
                <div class="lab">${esc(t.fileLevelSays)}</div>
                <p>${esc(v.before)}</p>
              </div>
              <div class="vc-arrow">→</div>
              <div class="vc-col after">
                <div class="lab">${esc(t.globalResolves)}</div>
                <p>${esc(v.after)}</p>
              </div>
            </div>
            ${v.evidence ? `<div class="vc-evidence">${esc(v.evidence)}</div>` : ''}
            ${
              v.file
                ? `<div class="card-actions"><button class="locate" data-file="${escAttr(v.file)}" data-line="${v.line ?? 1}">${esc(t.locate)}</button></div>`
                : ''
            }
          </div>
        </div>`,
          )
          .join('')
      : `<p class="muted">${esc(t.noFlips)}</p>`;

    // ---- Pending to-dos: one actionable card per un-handled fix spot ----
    const todoCard = (sp: GlobalFixSpot): string => `
        <div class="fixitem sev-${sp.severity}">
          <div class="fixitem-h">
            <span class="sev-dot"></span>
            <span class="tag">${sevLabel[sp.severity]}</span>
            <span class="title">${esc(sp.title)}</span>
            <span class="where">${esc(sp.file)}:${sp.line}</span>
          </div>
          <div class="fixitem-b">
            <p class="why">${esc(sp.detail)}</p>
            ${sp.suggestion ? `<p class="suggest">${esc(t.suggestionPrefix)}${esc(sp.suggestion)}</p>` : ''}
            <div class="card-actions">
              <button class="locate" data-file="${escAttr(sp.file)}" data-line="${sp.line}">${esc(t.locate)}</button>
              <button class="globalfix" data-id="${escAttr(sp.id)}" data-file="${escAttr(sp.file)}" data-line="${sp.line}">${esc(t.fixWithCopilot)}</button>
              <button class="act act-comment" data-id="${escAttr(sp.id)}" data-file="${escAttr(sp.file)}" data-line="${sp.line}">${esc(t.actComment)}</button>
              <button class="act act-ignore" data-id="${escAttr(sp.id)}" data-file="${escAttr(sp.file)}" data-line="${sp.line}">${esc(t.actIgnore)}</button>
            </div>
          </div>
        </div>`;
    const pendingHtml = pendingSpots.length
      ? pendingSpots.map(todoCard).join('')
      : `<p class="muted">${esc(allHandled ? t.allHandledHint : t.noTodos)}</p>`;

    // ---- Handled (collapsed), bucketed fixed → commented → ignored ----
    const dispLabel = m().disposition;
    const handledRow = (sp: GlobalFixSpot, kind: SpotDispositionKind): string => `
        <div class="handled-row disp-${kind}">
          <span class="disp-badge disp-${kind}">${esc(dispLabel[kind])}</span>
          <span class="hrow-title">${esc(sp.title)}</span>
          <span class="where">${esc(sp.file)}:${sp.line}</span>
          <span class="hrow-actions">
            <button class="locate" data-file="${escAttr(sp.file)}" data-line="${sp.line}">${esc(t.locate)}</button>
            <button class="act act-revert" data-id="${escAttr(sp.id)}" data-file="${escAttr(sp.file)}" data-line="${sp.line}">${esc(t.revert)}</button>
          </span>
        </div>`;
    const handledOrder: SpotDispositionKind[] = ['fixed', 'commented', 'ignored'];
    const handledHtml = handledSpots.length
      ? handledOrder
          .map((kind) =>
            handledSpots
              .filter((sp) => kindOf(sp) === kind)
              .map((sp) => handledRow(sp, kind))
              .join(''),
          )
          .join('')
      : `<p class="muted">${esc(t.handledEmpty)}</p>`;

    return `<!DOCTYPE html>
<html lang="${lang}">
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
  .ai-verdict { display: inline-block; font-size: .72rem; font-weight: 600; padding: .12rem .55rem; border-radius: 10px; margin-bottom: .45rem; border: 1px solid transparent; }
  .ai-verdict.av-approve { background: var(--green-bg); color: var(--green); border-color: rgba(78,201,176,.35); }
  .ai-verdict.av-request_changes { background: var(--red-bg); color: var(--red); border-color: rgba(241,76,76,.35); }
  .ai-verdict.av-comment { background: var(--blue-bg); color: var(--blue); border-color: rgba(86,156,214,.35); }
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
  .globalfix { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 1px solid transparent; }
  .globalfix:hover { background: var(--vscode-button-hoverBackground, var(--vscode-button-background)); }
  .globalfix:disabled { opacity: .6; cursor: wait; }
  .fixed-badge { color: var(--vscode-charts-green, #4caf50); font-size: .8rem; font-weight: 600; align-self: center; }
  .fixitem.is-fixed { opacity: .7; }

  /* Progress bar in the conclusion banner */
  .progress-wrap { margin-top: .7rem; }
  .progress-bar { height: 6px; border-radius: 4px; background: var(--elevated); overflow: hidden; border: 1px solid var(--line); }
  .progress-fill { height: 100%; background: var(--green); transition: width .3s ease; }
  .progress-text { display: flex; gap: .8rem; align-items: center; margin-top: .35rem; font-size: .74rem; }
  .progress-text .ptotal { opacity: .7; }
  .progress-text .phint { opacity: .7; }
  .progress-text .phint.ok { color: var(--green); opacity: 1; font-weight: 600; }

  /* Gate checklist in the decision banner */
  .gate-wrap { margin-top: .7rem; }
  .gate-list { list-style: none; padding: 0; margin: 0; display: grid; gap: .45rem; }
  .gate-item { display: flex; align-items: center; gap: .5rem; font-size: .82rem; }
  .gate-item .gate-mark { width: 1rem; text-align: center; flex-shrink: 0; }
  .gate-item.done .gate-mark { color: var(--green); }
  .gate-item.todo .gate-mark { color: var(--yellow); }
  .gate-item .gate-text { opacity: .9; }
  .gate-cta { margin-left: auto; flex-shrink: 0; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .gate-cta.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .gate-cta:hover { background: var(--vscode-button-hoverBackground, var(--vscode-toolbar-hoverBackground)); }
  .gate-done-badge { margin-left: auto; flex-shrink: 0; color: var(--green); font-size: .76rem; font-weight: 600; }
  .gate-pass { color: var(--green); font-weight: 600; font-size: .9rem; }
  .section-sub { font-size: .76rem; margin: -.2rem 0 .55rem; }

  /* Action buttons on to-do / handled rows */
  .act { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .act:hover { background: var(--vscode-toolbar-hoverBackground); }

  /* Collapsible folds (handled / analysis basis) */
  details.fold { border: 1px solid var(--line); border-radius: 8px; margin: .7rem 0; padding: 0 .85rem; background: var(--elevated); }
  details.fold > summary { cursor: pointer; padding: .65rem 0; font-weight: 600; font-size: .9rem; list-style: none; user-select: none; }
  details.fold > summary::-webkit-details-marker { display: none; }
  details.fold > summary::before { content: '▸'; display: inline-block; margin-right: .5rem; opacity: .6; transition: transform .15s ease; }
  details.fold[open] > summary::before { transform: rotate(90deg); }
  details.fold > *:last-child { margin-bottom: .75rem; }
  details.fold .basis h3 { margin-top: .8rem; }

  /* Handled rows (compact) */
  .handled-row { display: flex; align-items: center; gap: .6rem; padding: .45rem 0; border-bottom: 1px solid var(--line); font-size: .84rem; }
  .handled-row:last-child { border-bottom: none; }
  .disp-badge { font-size: .68rem; padding: .12rem .5rem; border-radius: 6px; font-weight: 600; flex-shrink: 0; }
  .disp-badge.disp-fixed { background: var(--green-bg); color: var(--green); }
  .disp-badge.disp-commented { background: var(--blue-bg); color: var(--blue); }
  .disp-badge.disp-ignored { background: var(--yellow-bg); color: var(--yellow); }
  .handled-row .hrow-title { flex: 1; opacity: .85; }
  .handled-row .hrow-actions { display: flex; gap: .4rem; flex-shrink: 0; }

  .confirm-bar { margin-top: 1.6rem; padding-top: 1rem; border-top: 1px solid var(--line); }
  #confirm { background: var(--vscode-button-background); color: var(--vscode-button-foreground); padding: .5rem 1.1rem; }
  #confirm:disabled { opacity: .6; cursor: default; }
  .done { color: var(--green); font-weight: 600; }
</style>
</head>
<body>
  ${banner}

  <h2>${esc(t.sectionReview)}</h2>
  <p class="muted section-sub">${esc(t.reviewSubtitle)}</p>
  ${verdictSection}

  <h2>${esc(t.sectionFixAdvisory)}</h2>
  <p class="muted section-sub">${esc(t.fixSpotsAdvisoryNote)}</p>
  ${progressLine}
  ${pendingHtml}

  <details class="fold">
    <summary>${esc(t.sectionHandled)} (${handledCount})</summary>
    ${handledHtml}
  </details>

  <details class="fold">
    <summary>${esc(t.sectionBasis)}</summary>
    <div class="basis">
      <h3>${esc(t.basisEvidenceTitle)}</h3>
      ${evidence}
    </div>
  </details>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const T = ${JSON.stringify(t)};
  const tabFiles = document.getElementById('tab-files');
  if (tabFiles) {
    tabFiles.addEventListener('click', () => vscode.postMessage({ type: 'gotoFiles' }));
  }
  const gotoCta = document.getElementById('goto-files-cta');
  if (gotoCta) {
    gotoCta.addEventListener('click', () => vscode.postMessage({ type: 'gotoFiles' }));
  }
  document.querySelectorAll('.locate').forEach((btn) => {
    btn.addEventListener('click', () => {
      vscode.postMessage({ type: 'locate', file: btn.dataset.file, line: Number(btn.dataset.line) });
    });
  });
  document.querySelectorAll('.globalfix').forEach((btn) => {
    btn.addEventListener('click', () => {
      btn.disabled = true;
      vscode.postMessage({
        type: 'globalFix',
        id: btn.dataset.id,
        file: btn.dataset.file,
        line: Number(btn.dataset.line),
      });
      // Re-enable shortly in case the user dismisses the proposal panel.
      setTimeout(() => { btn.disabled = false; }, 3000);
    });
  });
  const wireSpotAction = (selector, type) => {
    document.querySelectorAll(selector).forEach((btn) => {
      btn.addEventListener('click', () => {
        vscode.postMessage({
          type: type,
          id: btn.dataset.id,
          file: btn.dataset.file,
          line: Number(btn.dataset.line),
        });
      });
    });
  };
  wireSpotAction('.act-ignore', 'globalIgnore');
  wireSpotAction('.act-comment', 'globalComment');
  wireSpotAction('.act-revert', 'globalRevert');
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

  private dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (GlobalReportPanel.current === this) {
      GlobalReportPanel.current = undefined;
    }
    for (const d of this.disposables.splice(0)) {
      d.dispose();
    }
  }
}


