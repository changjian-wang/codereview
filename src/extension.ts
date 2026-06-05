import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ReviewSession } from './review/reviewSession';
import { WorkspaceStateReviewStore, type Annotation } from './review/reviewStore';
import { pickModel } from './ai/modelPicker';
import { ModelProvider } from './ai/modelProvider';
import {
  analyzeFile,
  analyzeGlobal,
  generateFixDiff,
  generateFixProposals,
  translateToChinese,
  explainCode,
  AnalysisError,
  type GlobalContextFile,
} from './ai/analyzer';
import type { Finding } from './ai/types';
import { pickScope, buildFolderScope } from './scope/scopePicker';
import { submitPrReview, postPrLineComment, postPrComment } from './gh/ghClient';
import { GlobalReportPanel } from './ui/globalReportPanel';
import { runWithProgress } from './ui/progressSteps';
import { WorkbenchPanel, type WorkbenchState, type WorkbenchFile, type FindingDispositionKind } from './ui/workbenchPanel';
import { DocumentPanel, type DocModel } from './ui/documentPanel';
import { FixProposalPanel } from './ui/fixProposalPanel';
import { renderDocument, type DocumentRender } from './ui/documentRenderer';
import { transientInfo, transientWarning } from './ui/toast';

let session: ReviewSession;
const models = new ModelProvider();
let workbenchSelected: string | undefined;
/** Monotonic token for file-open requests; lets a newer click cancel a slower in-flight open. */
let openFileGeneration = 0;
/** Cache of rendered (highlighted) file content, keyed by relative path. */
const docRenderCache = new Map<string, DocumentRender>();
/** Most recently applied Copilot fix per finding: enables one-click revert from any UI. */
const appliedFixes = new Map<string, { oldText: string; newText: string }>();
/** Preferred default cwd for the next scope pick (set by openInNewWindow). */
let preferredDefaultCwd: string | undefined;
/** True once the 3:7 editor layout has been applied for the current review. */
let layoutAppliedForCurrentReview = false;
/** Relative paths with an in-flight single-file analysis, used to de-dupe concurrent runs. */
const analyzingPaths = new Set<string>();
/** Prevents duplicate global analysis calls for the same active review. */
let globalAnalysisInFlight = false;
/** Cancellation source for the in-flight global analysis, if any. */
let globalAnalysisCts: vscode.CancellationTokenSource | undefined;

function isReviewPath(relPath: string): boolean {
  return !!session.reviewSet?.files.some((f) => f.path === relPath);
}

function ensureReviewPath(relPath: string, action: string): boolean {
  if (isReviewPath(relPath)) {
    return true;
  }
  void vscode.window.showWarningMessage(`Code Review：${relPath} 不在当前审查范围内，已跳过${action}。`);
  return false;
}

function closeScopeBoundPanels(): void {
  DocumentPanel.closeIfOpen();
  FixProposalPanel.closeIfOpen();
  GlobalReportPanel.closeIfOpen();
}

function reviewFileStatus(relPath: string): string | undefined {
  return session.reviewSet?.files.find((f) => f.path === relPath)?.status;
}

function isDeletedReviewFile(relPath: string): boolean {
  return reviewFileStatus(relPath) === 'deleted';
}

function fixKey(rel: string, findingId: string): string {
  return `${rel}::${findingId}`;
}

/** Memento key for persisted applied-fix snapshots (enables locate-follow + revert across reloads). */
const APPLIED_FIXES_MEMENTO_KEY = 'codereview.appliedFixes.v1';
/** Workspace memento bound in activate(); backs the in-memory appliedFixes map. */
let appliedFixesMemento: vscode.Memento | undefined;

/** Memento key for the last folder loaded as a review (enables auto-restore after a window reload). */
const LAST_REVIEW_FOLDER_KEY = 'codereview.lastReviewFolder.v1';
/** Workspace memento bound in activate(); records the last review folder for restore. */
let workspaceMemento: vscode.Memento | undefined;

/** Hydrates appliedFixes from workspaceState so revert/locate survive window reloads. */
function hydrateAppliedFixes(memento: vscode.Memento): void {
  appliedFixesMemento = memento;
  const stored = memento.get<Record<string, { oldText: string; newText: string }>>(
    APPLIED_FIXES_MEMENTO_KEY,
  );
  if (stored) {
    for (const [key, edit] of Object.entries(stored)) {
      appliedFixes.set(key, edit);
    }
  }
}

/** Persists the current appliedFixes map to workspaceState. */
function flushAppliedFixes(): void {
  if (!appliedFixesMemento) {
    return;
  }
  const obj: Record<string, { oldText: string; newText: string }> = {};
  for (const [key, edit] of appliedFixes) {
    obj[key] = edit;
  }
  void appliedFixesMemento.update(APPLIED_FIXES_MEMENTO_KEY, obj);
}

function setAppliedFix(key: string, edit: { oldText: string; newText: string }): void {
  appliedFixes.set(key, edit);
  flushAppliedFixes();
}

function deleteAppliedFix(key: string): void {
  appliedFixes.delete(key);
  flushAppliedFixes();
}

/**
 * Re-syncs the in-memory applied-fix map from persisted storage. Used when
 * (re)loading a review so previously applied Copilot fixes survive a reload —
 * this does NOT erase the saved snapshots, which is what kept 「定位」/inline
 * cards following the fix content after a reload.
 */
function rehydrateAppliedFixes(): void {
  appliedFixes.clear();
  if (!appliedFixesMemento) {
    return;
  }
  const stored = appliedFixesMemento.get<Record<string, { oldText: string; newText: string }>>(
    APPLIED_FIXES_MEMENTO_KEY,
  );
  if (stored) {
    for (const [key, edit] of Object.entries(stored)) {
      appliedFixes.set(key, edit);
    }
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const repo = workspaceFolderName() ?? 'unknown';
  const store = new WorkspaceStateReviewStore(context.workspaceState);
  session = new ReviewSession(store, repo);

  // Wire the fix-proposal cache so previously generated suggestions persist
  // across reloads and rapid navigation between findings.
  FixProposalPanel.init(context.workspaceState);

  // Restore the per-workspace model choice so the workbench opens on the
  // model the user last picked for this project (instead of always "Auto").
  models.init(context.workspaceState);

  // Restore applied-fix snapshots so 「撤销修复」 and the fix-aware 「定位」
  // keep working after a window reload (they rely on the saved newText).
  hydrateAppliedFixes(context.workspaceState);
  workspaceMemento = context.workspaceState;

  // Older versions hid the activity bar globally and didn't always restore it.
  // If the global setting is still `hidden`, reset it once so the user gets
  // the activity bar back without having to fix it manually.
  void restoreGloballyHiddenActivityBar(context);

  context.subscriptions.push(
    session,
    vscode.commands.registerCommand('codereview.startReview', startReview),
    vscode.commands.registerCommand('codereview.openOrStart', openOrStartReview),
    vscode.commands.registerCommand('codereview.openInNewWindow', openInNewWindow),
    vscode.commands.registerCommand('codereview.pickModel', selectModel),
    vscode.commands.registerCommand('codereview.openWorkbench', openWorkbench),
    vscode.commands.registerCommand('codereview.openFile', openFileInPanel),
    vscode.commands.registerCommand('codereview.analyzeFile', analyzeCurrentFile),
    vscode.commands.registerCommand('codereview.globalAnalysis', runGlobalAnalysis),
    vscode.commands.registerCommand('codereview.showGlobalReport', showGlobalReport),
    vscode.commands.registerCommand('codereview.submitConclusion', submitConclusion),
    vscode.commands.registerCommand('codereview.locateFinding', locateInFile),
    vscode.commands.registerCommand('codereview.jumpToNextUnseen', jumpToNextUnseenCurrent),
    createStatusBarEntry(),
  );

  // Keep the workbench webview in sync with session progress.
  context.subscriptions.push(session.onDidChange(() => WorkbenchPanel.refreshIfOpen()));

  // Restore the workbench panel after a window reload: if VS Code kept the
  // popped-out review panel, this serializer hands it back. We reload the last
  // review folder so the panel has live data, then re-attach it — no need for
  // the user to click 「Open in Code Review」 again.
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer('codereview.workbench', {
      deserializeWebviewPanel: async (panel) => {
        await restoreWorkbenchInto(panel);
      },
    }),
  );

  // The document viewer is reconstructed on demand (when the user picks a file),
  // so a restored-but-empty frame would be misleading. Dispose it; the workbench
  // restore above brings back the review and the user reopens a file from there.
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer('codereview.document', {
      deserializeWebviewPanel: async (panel) => {
        panel.dispose();
      },
    }),
    vscode.window.registerWebviewPanelSerializer('codereview.fixProposal', {
      deserializeWebviewPanel: async (panel) => {
        panel.dispose();
      },
    }),
    vscode.window.registerWebviewPanelSerializer('codereview.globalReport', {
      deserializeWebviewPanel: async (panel) => {
        panel.dispose();
      },
    }),
  );

  // Activation setup is done; swap the status bar spinner for the real icon so
  // users only click once it can actually open the workbench.
  markStatusBarReady();
}

/** Status bar button; starts as a spinner during activation, then the real icon. */
let statusBarItem: vscode.StatusBarItem | undefined;

/** Adds a persistent status bar button that opens the workbench or starts a new review. */
function createStatusBarEntry(): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  item.name = 'Code Review';
  // Show a spinner until activation finishes; clicking before then would be a
  // no-op and confuse the user, so we signal "loading" explicitly.
  item.text = '$(loading~spin) Code Review 加载中…';
  item.tooltip = 'Code Review 正在加载，请稍候…';
  item.command = 'codereview.openInNewWindow';
  item.show();
  statusBarItem = item;
  return item;
}

/** Swaps the status bar entry from its loading spinner to the ready state. */
function markStatusBarReady(): void {
  if (!statusBarItem) {
    return;
  }
  statusBarReady = true;
  setStatusBarBusy(false);
}

/** Tracks whether activation finished, so busy toggles don't override "加载中". */
let statusBarReady = false;

/** Toggles the status bar button between its spinner and ready icon. */
function setStatusBarBusy(busy: boolean): void {
  if (!statusBarItem) {
    return;
  }
  if (!statusBarReady) {
    statusBarItem.text = '$(loading~spin) Code Review 加载中…';
    statusBarItem.tooltip = 'Code Review 正在加载，请稍候…';
    return;
  }
  if (busy) {
    statusBarItem.text = '$(loading~spin) 正在打开 Code Review…';
    statusBarItem.tooltip = 'Code Review 正在打开审查工作台，请稍候…';
  } else {
    statusBarItem.text = '$(checklist) Open in Code Review';
    statusBarItem.tooltip = 'Code Review：在独立窗口中打开审查工作台（可在窗口内选择审查范围）';
  }
}

/** Status-bar entry: open the workbench if a review is in progress, else start one. */
async function openOrStartReview(): Promise<void> {
  if (session.reviewSet) {
    await openWorkbench();
    return;
  }
  await startReview();
}

/**
 * "Open in Code Review" — the analogue of VS Code's "Open in Agents Window":
 * pick a workspace folder (in multi-root setups), pop the workbench into a
 * separate auxiliary window, and let the user pick the review scope inside it.
 *
 * Accepts a cwd in three forms because callers vary:
 *   - string fsPath (from the TreeItem's command.arguments)
 *   - WorkspaceFolder (when invoked as an inline action — VS Code injects it)
 *   - Uri (defensive, for arbitrary callers)
 */
async function openInNewWindow(
  cwdArg?: string | vscode.WorkspaceFolder | vscode.Uri,
): Promise<void> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  let chosenCwd: string | undefined = resolveCwdArg(cwdArg);
  if (!chosenCwd) {
    if (folders.length === 0) {
      void vscode.window.showErrorMessage('Code Review：请先打开一个工作区。');
      return;
    } else if (folders.length === 1) {
      chosenCwd = folders[0].uri.fsPath;
    } else {
      const pick = await vscode.window.showQuickPick(
        folders.map((f) => ({
          label: `$(folder) ${f.name}`,
          description: f.uri.fsPath,
          cwd: f.uri.fsPath,
        })),
        {
          title: 'Code Review · 选择要审查的项目',
          placeHolder: '选择在哪个工作区文件夹中开始审查',
        },
      );
      if (!pick) {
        return;
      }
      chosenCwd = pick.cwd;
    }
  }
  preferredDefaultCwd = chosenCwd;
  // Auto-load the chosen project as the initial review set (whole folder, skipping
  // node_modules / dist / bin / obj / ...). The user can still narrow down later
  // via the 「切换范围…」 button inside the workbench.
  setStatusBarBusy(true);
  try {
    await loadFolderAsReview(chosenCwd);
    // Open the workbench straight into its own auxiliary window. The webview API
    // can only create a panel in the current window, so we relocate it with
    // `moveEditorToNewWindow` — but we fire that the instant the panel exists,
    // before opening any file or applying the split layout, so the user never
    // sees the intermediate "tab in the current window" step.
    await openWorkbench({ moveToNewWindow: true });
  } finally {
    setStatusBarBusy(false);
  }
}

/** Loads the entire folder at `cwd` as the current review set. */
async function loadFolderAsReview(cwd: string): Promise<void> {
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Code Review：加载项目源码…' },
    async () => {
      try {
        const picked = await buildFolderScope(cwd);
        if (!picked) {
          transientWarning(
            '选中的项目没有可审查的文件（已跳过 node_modules / .git / dist / out / bin / obj / .vs 等目录）',
          );
          return;
        }
        const { scope: source, cwd: rootCwd } = picked;
        const reviewSet = await source.load(rootCwd);
        await session.start(reviewSet, rootCwd);
        closeScopeBoundPanels();
        workbenchSelected = undefined;
        docRenderCache.clear();
        rehydrateAppliedFixes();
        WorkbenchPanel.resetFolders();
        layoutAppliedForCurrentReview = false;
        // Remember this folder so a window reload can auto-restore the review.
        void workspaceMemento?.update(LAST_REVIEW_FOLDER_KEY, rootCwd);
        void vscode.commands.executeCommand('setContext', 'codereview.active', true);
        transientInfo(`已加载 ${reviewSet.label} · ${reviewSet.files.length} 个文件`);
      } catch (err) {
        const message = String((err as Error)?.message ?? err);
        void vscode.window.showErrorMessage(`Code Review：${message}`);
      }
    },
  );
}

function resolveCwdArg(arg?: string | vscode.WorkspaceFolder | vscode.Uri): string | undefined {
  if (!arg) return undefined;
  if (typeof arg === 'string') return arg.length > 0 ? arg : undefined;
  if (arg instanceof vscode.Uri) return arg.fsPath;
  if ('uri' in arg && arg.uri instanceof vscode.Uri) return arg.uri.fsPath;
  return undefined;
}

async function startReview(): Promise<void> {
  const defaultCwd = preferredDefaultCwd ?? workspaceFolderPath();
  if (!defaultCwd) {
    void vscode.window.showErrorMessage('Code Review：请先打开一个 Git 仓库工作区。');
    return;
  }

  const picked = await pickScope(defaultCwd);
  if (!picked) {
    return;
  }
  const { scope: source, cwd } = picked;
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Code Review：加载源码…' },
    async () => {
      try {
        const reviewSet = await source.load(cwd);
        await session.start(reviewSet, cwd);
        closeScopeBoundPanels();
        workbenchSelected = undefined;
        docRenderCache.clear();
        rehydrateAppliedFixes();
        WorkbenchPanel.resetFolders();
        layoutAppliedForCurrentReview = false;
        void vscode.commands.executeCommand('setContext', 'codereview.active', true);
        await openWorkbench();
        transientInfo(`已加载 ${reviewSet.label} · ${reviewSet.files.length} 个文件`);
      } catch (err) {
        const message = String((err as Error)?.message ?? err);
        void vscode.window.showErrorMessage(`Code Review：${message}`);
      }
    },
  );
}

async function selectModel(): Promise<void> {
  const choice = await pickModel();
  if (choice) {
    models.set(choice);
    WorkbenchPanel.refreshIfOpen();
    transientInfo(`分析模型已切换：${choice.label}`);
  }
}

/** Opens (or reveals) the Review Workbench webview. */
async function openWorkbench(opts: { moveToNewWindow?: boolean } = {}): Promise<void> {
  WorkbenchPanel.show(buildWorkbenchState, workbenchActions());
  // Relocate to a dedicated window immediately — before any file open or layout
  // work — so the panel appears to open directly in its own window rather than
  // flashing as a tab in the current one first.
  if (opts.moveToNewWindow) {
    try {
      await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow');
    } catch (err) {
      console.warn('[codereview] moveEditorToNewWindow failed:', err);
    }
    // A stale document panel in the previous window would otherwise steal the
    // Beside column; drop it so the next file opens beside the relocated panel.
    DocumentPanel.closeIfOpen();
  }
  // Intentionally do NOT open the first review file — leave the document column
  // blank so the user picks what to review. We still apply the split layout so
  // the empty editor group is visible beside the workbench.
  if (session.reviewSet && !layoutAppliedForCurrentReview) {
    layoutAppliedForCurrentReview = true;
    await applyWorkbenchLayout();
  }
}

/** Builds the action callbacks the workbench webview dispatches to. */
function workbenchActions(): import('./ui/workbenchPanel').WorkbenchActions {
  return {
    open: (path) => void openFileInPanel(path),
    disposeFinding: (path, id, kind) => void disposeFinding(path, id, kind),
    locate: (path, line) => void locateInFile(path, line),
    globalAnalysis: () => void runGlobalAnalysis(),
    cancelGlobalAnalysis: () => cancelGlobalAnalysis(),
    showGlobal: showGlobalReport,
    submit: () => void submitConclusion(),
    pickModel: () => void selectModel(),
    pickScope: () => void startReview(),
  };
}

/**
 * Re-attaches a workbench panel that VS Code restored after a window reload.
 * Reloads the last review folder (so the panel has live session data) and adopts
 * the restored panel. Falls back to disposing the panel when no prior review is
 * recorded, so the user is not left staring at an empty restored frame.
 */
async function restoreWorkbenchInto(panel: vscode.WebviewPanel): Promise<void> {
  const cwd = workspaceMemento?.get<string>(LAST_REVIEW_FOLDER_KEY);
  if (!cwd) {
    panel.dispose();
    return;
  }
  setStatusBarBusy(true);
  try {
    if (!session.reviewSet) {
      await loadFolderAsReview(cwd);
    }
    if (!session.reviewSet) {
      panel.dispose();
      return;
    }
    WorkbenchPanel.adopt(panel, buildWorkbenchState, workbenchActions());
    void vscode.commands.executeCommand('setContext', 'codereview.active', true);
  } finally {
    setStatusBarBusy(false);
  }
}

/**
 * Sets the editor group split ratio so the workbench sidebar (column 1) is
 * narrow enough to act as a tool window while the document viewer (column 2)
 * gets the bulk of the width. Only invoked when the workbench is first opened
 * — subsequent file switches keep whatever ratio the user dragged to.
 */
async function applyWorkbenchLayout(): Promise<void> {
  try {
    await vscode.commands.executeCommand('vscode.setEditorLayout', {
      orientation: 0,
      groups: [{ size: 0.3 }, { size: 0.7 }],
    });
  } catch {
    // Older VS Code versions or missing second group — ignore.
  }
}

/** Maps a ReviewFile's diff status to a workbench change badge. */
function changeBadge(status?: string, additions?: number, deletions?: number): WorkbenchFile['change'] {
  if (status === 'added') {
    return 'add';
  }
  if (status === 'deleted') {
    return 'del';
  }
  if (status === 'modified' || status === 'renamed') {
    return 'role';
  }
  if (additions && !deletions) {
    return 'add';
  }
  if (deletions && !additions) {
    return 'del';
  }
  if (additions || deletions) {
    return 'role';
  }
  return undefined;
}

/** Snapshots the current session into the serializable workbench state. */
function buildWorkbenchState(): WorkbenchState {
  const reviewSet = session.reviewSet;
  const files: WorkbenchFile[] = (reviewSet?.files ?? []).map((f) => {
    const { seen, total } = session.coverage(f.path);
    const findings = session.findings(f.path);
    const fileState = session.fileState(f.path);
    return {
      path: f.path,
      name: f.path.split('/').pop() ?? f.path,
      dir: f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '',
      seen,
      total,
      analyzed: !!fileState?.analyzed,
      ready: session.fileReady(f.path),
      fullySeen: session.fileFullySeen(f.path),
      unconfirmed: session.unconfirmedCount(f.path),
      findings: findings.length,
      change: changeBadge(f.status, f.additions, f.deletions),
      active: workbenchSelected === f.path,
      analyzing: analyzingPaths.has(f.path),
    };
  });

  const selectedFindings = workbenchSelected
    ? session.findings(workbenchSelected).map((f) => {
        const d = session.findingDisposition(workbenchSelected!, f.id);
        return {
          id: f.id,
          line: f.line,
          severity: f.severity,
          title: f.title,
          detail: f.detail,
          suggestion: f.suggestion,
          disposition: d?.kind,
          dispositionReason: d?.reason,
        };
      })
    : [];

  return {
    hasReviewSet: !!reviewSet,
    label: reviewSet?.label ?? '（未开始）',
    files,
    selected: workbenchSelected,
    findings: selectedFindings,
    coverage: session.totalCoverage(),
    gatePassed: session.gatePassed(),
    globalDone: session.globalConfirmed,
    hasGlobalReport: !!session.globalReport,
    modelLabel: models.label,
    conclusion: session.conclusion
      ? {
          label: session.conclusion.label,
          target: session.conclusion.target,
          prNumber: session.conclusion.prNumber,
          submittedAt: session.conclusion.submittedAt,
        }
      : undefined,
  };
}

/** Opens a review file in the document webview beside the workbench. */
async function openFileInPanel(relPath: string): Promise<void> {
  if (!ensureReviewPath(relPath, '打开')) {
    return;
  }
  // Switching to a different file invalidates any open fix-proposal panel
  // (it's scoped to one finding in the file we're leaving).
  if (workbenchSelected !== relPath) {
    FixProposalPanel.closeIfOpen();
  }
  workbenchSelected = relPath;
  // Race guard: rapid clicks must not pile up heavy renders or let a slow,
  // already-superseded open overwrite the panel. Each call claims a token; after
  // every await we bail if a newer click has taken over.
  const myGeneration = ++openFileGeneration;
  const text = await readReviewFileText(relPath);
  if (myGeneration !== openFileGeneration) {
    return; // a newer click superseded us — skip the expensive render + show.
  }
  const render = renderFor(relPath, text);
  if (myGeneration !== openFileGeneration) {
    return; // rendering may have yielded; bail before overwriting the panel.
  }
  session.setTotalLines(relPath, render.totalLines);
  const anchors = await computeFindingAnchors(relPath);
  if (myGeneration !== openFileGeneration) {
    return; // anchoring may have yielded; bail before overwriting the panel.
  }
  DocumentPanel.show(buildDocModel(relPath, render, anchors), docActions());
  WorkbenchPanel.refreshIfOpen();
}

/** Renders (and caches) the highlighted/markdown content for a file. */
function renderFor(relPath: string, text: string): DocumentRender {
  const cached = docRenderCache.get(relPath);
  if (cached) {
    return cached;
  }
  const languageId = languageIdFor(relPath);
  const render = renderDocument(text, languageId, relPath.split('/').pop() ?? relPath);
  docRenderCache.set(relPath, render);
  return render;
}

/** Guesses a VS Code-style languageId from a file extension. */
function languageIdFor(relPath: string): string {
  const ext = relPath.includes('.') ? relPath.slice(relPath.lastIndexOf('.') + 1).toLowerCase() : '';
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescriptreact', js: 'javascript', jsx: 'javascriptreact',
    cs: 'csharp', cpp: 'cpp', cc: 'cpp', c: 'c', h: 'cpp', py: 'python', java: 'java',
    go: 'go', rs: 'rust', rb: 'ruby', php: 'php', sh: 'shellscript', ps1: 'powershell',
    sql: 'sql', json: 'json', jsonc: 'jsonc', yml: 'yaml', yaml: 'yaml', xml: 'xml',
    html: 'html', vue: 'vue', css: 'css', scss: 'scss', less: 'less', md: 'markdown',
    markdown: 'markdown', ini: 'ini', toml: 'toml',
  };
  return map[ext] ?? ext;
}

/** Builds the serializable model the document webview renders. */
function buildDocModel(
  relPath: string,
  render: DocumentRender,
  anchors?: Map<string, { line: number; endLine: number }>,
): DocModel {
  const state = session.fileState(relPath);
  const rawLines = deHighlight(render.sourceLines);
  return {
    path: relPath,
    name: relPath.split('/').pop() ?? relPath,
    isMarkdown: render.isMarkdown,
    readingHtml: render.readingHtml,
    sourceLines: render.sourceLines,
    raw: rawLines,
    seen: state?.seenLines ?? [],
    findings: session.findings(relPath).map((f) => {
      const d = session.findingDisposition(relPath, f.id);
      // If a Copilot fix was applied, the finding's snapshot line is stale — the
      // edit shifted the file. Re-anchor the inline card to the fix's current
      // content (start + last line), so the card follows the modified code
      // instead of staying pinned to the old line number. `anchors` is computed
      // from the live document (same source as the locate action), so card and
      // locate always agree.
      const a = anchors?.get(f.id);
      return {
        id: f.id,
        line: a?.line ?? f.line,
        endLine: a?.endLine ?? f.endLine,
        severity: f.severity,
        title: f.title,
        detail: f.detail,
        suggestion: f.suggestion,
        disposition: d?.kind,
        dispositionReason: d?.reason,
      };
    }),
    annotations: session.annotations(relPath).map((a) => ({
      id: a.id,
      kind: a.kind,
      startLine: a.startLine,
      endLine: a.endLine,
      sourceText: a.sourceText,
      content: a.content,
    })),
  };
}

/**
 * Computes live-document anchors for every finding that has an applied Copilot
 * fix. Reads the file text once and locates each fix's `newText`, returning a
 * map of findingId → 1-based start/last line. Findings without an applied fix
 * (or whose snippet can no longer be found) are omitted, so callers fall back to
 * the stored snapshot lines. This mirrors {@link reanchorToAppliedFix} but
 * batches a whole file in a single read.
 */
async function computeFindingAnchors(
  relPath: string,
): Promise<Map<string, { line: number; endLine: number }>> {
  const anchors = new Map<string, { line: number; endLine: number }>();
  const findings = session.findings(relPath);
  const pending = findings.filter((f) => appliedFixes.has(fixKey(relPath, f.id)));
  if (pending.length === 0) {
    return anchors;
  }
  const cwd = activeCwd();
  if (!cwd) {
    return anchors;
  }
  try {
    const fileUri = vscode.Uri.joinPath(vscode.Uri.file(cwd), relPath);
    const doc = await vscode.workspace.openTextDocument(fileUri);
    const docLines = doc.getText().split(/\r?\n/);
    for (const f of pending) {
      const edit = appliedFixes.get(fixKey(relPath, f.id));
      if (!edit) {
        continue;
      }
      const hit = locateSnippetLines(docLines, edit.newText);
      if (hit) {
        anchors.set(f.id, hit);
      }
    }
  } catch (err) {
    console.warn('[codereview] computeFindingAnchors failed:', err);
  }
  return anchors;
}

/**
 * Locates a multi-line snippet inside a document by *line* content, returning
 * its 1-based start and last line. Matching is EOL- and trailing-whitespace
 * insensitive (each line is `trimEnd`-compared), which is essential because
 * `applyEdit` inserts the proposal's `\n`-terminated text but a subsequent
 * `save()` may normalise the file to CRLF — making a raw `indexOf(newText)`
 * fail forever. Leading/trailing blank lines in the snippet are ignored so the
 * anchor lands on real content. Returns undefined when no unambiguous match
 * exists.
 */
function locateSnippetLines(
  docLines: string[],
  snippet: string,
): { line: number; endLine: number } | undefined {
  const needle = snippet
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l, i, arr) => {
      // drop leading/trailing blank lines but keep interior ones
      const before = arr.slice(0, i).every((x) => x === '');
      const after = arr.slice(i + 1).every((x) => x === '');
      return !(l === '' && (before || after));
    });
  if (needle.length === 0) {
    return undefined;
  }
  const hay = docLines.map((l) => l.replace(/\s+$/, ''));
  for (let i = 0; i + needle.length <= hay.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      return { line: i + 1, endLine: i + needle.length };
    }
  }
  return undefined;
}

/** Recovers raw source lines by stripping highlight markup. */
function deHighlight(lines: string[]): string[] {
  return lines.map((l) =>
    l
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&'),
  );
}

/** Pushes an updated model into the document panel if it shows this file. */
async function refreshDocPanel(relPath: string): Promise<void> {
  const render = docRenderCache.get(relPath);
  if (render && DocumentPanel.currentPath === relPath) {
    const anchors = await computeFindingAnchors(relPath);
    if (DocumentPanel.currentPath !== relPath) {
      return;
    }
    DocumentPanel.update(buildDocModel(relPath, render, anchors));
  }
}

/**
 * Re-reads the file from disk / dirty editor, re-renders, and refreshes the
 * document panel so the user sees the new content immediately after an edit
 * (e.g. a Copilot fix was applied).
 */
async function reloadDocPanel(relPath: string): Promise<void> {
  if (!isReviewPath(relPath)) {
    docRenderCache.delete(relPath);
    return;
  }
  if (DocumentPanel.currentPath !== relPath) {
    docRenderCache.delete(relPath);
    return;
  }
  docRenderCache.delete(relPath);
  const text = await readReviewFileText(relPath);
  const render = renderFor(relPath, text);
  session.setTotalLines(relPath, render.totalLines);
  const anchors = await computeFindingAnchors(relPath);
  if (DocumentPanel.currentPath !== relPath) {
    return;
  }
  DocumentPanel.update(buildDocModel(relPath, render, anchors));
}

/**
 * Reverts an applied Copilot fix by replacing newText with oldText in the file.
 * Falls back to a warning when the snippet can no longer be uniquely located
 * (file was edited by hand after applying). Returns whether the revert happened.
 */
async function revertAppliedFix(rel: string, findingId: string): Promise<boolean> {
  if (!ensureReviewPath(rel, '撤销修复')) {
    return false;
  }
  const edit = appliedFixes.get(fixKey(rel, findingId));
  if (!edit) {
    return false;
  }
  const cwd = activeCwd();
  if (!cwd) {
    return false;
  }
  const fileUri = vscode.Uri.joinPath(vscode.Uri.file(cwd), rel);
  try {
    const doc = await vscode.workspace.openTextDocument(fileUri);
    const text = doc.getText();
    const idx = text.indexOf(edit.newText);
    if (idx < 0) {
      void vscode.window.showWarningMessage(
        '无法自动撤销 Copilot 修复：文件中已找不到之前应用的片段（可能被手动改动过）。',
      );
      return false;
    }
    if (text.indexOf(edit.newText, idx + 1) >= 0) {
      void vscode.window.showWarningMessage(
        '之前应用的片段在文件里出现多次，无法唯一定位以自动撤销，请手动还原。',
      );
      return false;
    }
    const start = doc.positionAt(idx);
    const end = doc.positionAt(idx + edit.newText.length);
    const we = new vscode.WorkspaceEdit();
    we.replace(fileUri, new vscode.Range(start, end), edit.oldText);
    const ok = await vscode.workspace.applyEdit(we);
    if (ok) {
      deleteAppliedFix(fixKey(rel, findingId));
      await reloadDocPanel(rel);
    }
    return ok;
  } catch (err) {
    console.warn('[codereview] revertAppliedFix failed:', err);
    return false;
  }
}

/** Wires the document webview's actions back to the session / model. */
function docActions() {
  return {
    seen: (path: string, lines: number[]) => session.markSeen(path, lines),
    translate: (path: string, startLine: number, endLine: number, text: string) =>
      void annotateWithTranslation(path, startLine, endLine, text),
    explain: (path: string, startLine: number, endLine: number, text: string) =>
      void annotateWithExplanation(path, startLine, endLine, text),
    note: (path: string, startLine: number, endLine: number, text: string) =>
      void annotateWithNote(path, startLine, endLine, text),
    removeAnnotation: (path: string, id: string) => {
      session.removeAnnotation(path, id);
      refreshDocPanel(path);
    },
    disposeFinding: (path: string, id: string, kind: FindingDispositionKind) => {
      void disposeFinding(path, id, kind);
    },
    viewFix: (path: string, id: string) => void viewFixProposal(path, id),
    locate: (path: string, line: number, endLine?: number, findingId?: string) =>
      void locateInFile(path, line, endLine, findingId),
    analyze: (path: string) => void analyzeByPath(path),
    jumpNext: (path: string) => jumpToNextUnseen(path),
  };
}

function newAnnotationId(): string {
  return `anno-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Translates the selected text and stores it as a persisted annotation. */
async function annotateWithTranslation(
  path: string,
  startLine: number,
  endLine: number,
  text: string,
): Promise<void> {
  const model = await models.resolve();
  if (!model) {
    void vscode.window.showErrorMessage('Code Review：未找到可用的 Copilot 模型。');
    return;
  }
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Code Review：翻译中…', cancellable: true },
    async (_p, token) => {
      try {
        const content = await translateToChinese(model, text, token);
        const annotation: Annotation = {
          id: newAnnotationId(),
          kind: 'translate',
          startLine,
          endLine,
          sourceText: text,
          content,
          createdAt: Date.now(),
        };
        session.addAnnotation(path, annotation);
        refreshDocPanel(path);
      } catch (err) {
        reportError(err);
      }
    },
  );
}

/** Explains the selected code and stores it as a persisted annotation. */
async function annotateWithExplanation(
  path: string,
  startLine: number,
  endLine: number,
  text: string,
): Promise<void> {
  const model = await models.resolve();
  if (!model) {
    void vscode.window.showErrorMessage('Code Review：未找到可用的 Copilot 模型。');
    return;
  }
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Code Review：解释中…', cancellable: true },
    async (_p, token) => {
      try {
        const content = await explainCode(model, text, token);
        const annotation: Annotation = {
          id: newAnnotationId(),
          kind: 'explain',
          startLine,
          endLine,
          sourceText: text,
          content,
          createdAt: Date.now(),
        };
        session.addAnnotation(path, annotation);
        refreshDocPanel(path);
      } catch (err) {
        reportError(err);
      }
    },
  );
}

/** Prompts for note text and stores it as a persisted annotation. */
async function annotateWithNote(
  path: string,
  startLine: number,
  endLine: number,
  text: string,
): Promise<void> {
  const note = await vscode.window.showInputBox({
    title: 'Code Review · 添加批注',
    prompt: startLine > 0 ? `第 ${startLine}${endLine > startLine ? `–${endLine}` : ''} 行` : '选区批注',
    placeHolder: '输入批注内容…',
  });
  if (!note) {
    return;
  }
  const annotation: Annotation = {
    id: newAnnotationId(),
    kind: 'note',
    startLine,
    endLine,
    sourceText: text,
    content: note,
    createdAt: Date.now(),
  };
  session.addAnnotation(path, annotation);
  refreshDocPanel(path);
}

/**
 * Reads the current text of a review file, preferring an already-open document
 * (which includes unsaved edits) over the on-disk copy.
 */
async function readReviewFileText(relPath: string): Promise<string> {
  if (!ensureReviewPath(relPath, '读取')) {
    return '';
  }
  if (isDeletedReviewFile(relPath)) {
    return '（文件已删除，当前分支中不存在源内容；请在整体审查中确认删除影响。）';
  }
  const cwd = activeCwd();
  if (!cwd) {
    return '';
  }
  const uri = vscode.Uri.joinPath(vscode.Uri.file(cwd), relPath);
  const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath);
  if (open) {
    return open.getText();
  }
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    return doc.getText();
  } catch {
    return '';
  }
}

async function analyzeCurrentFile(): Promise<void> {
  const rel = DocumentPanel.currentPath ?? workbenchSelected;
  if (!rel) {
    transientWarning('请先在工作台中选择要分析的文件');
    return;
  }
  await analyzeByPath(rel);
}

/** Analyzes a specific review file by its relative path. */
async function analyzeByPath(rel: string): Promise<void> {
  if (!ensureReviewPath(rel, '分析')) {
    return;
  }
  if (isDeletedReviewFile(rel)) {
    transientInfo(`${rel} 是删除文件，已作为无需源文件分析处理`);
    return;
  }
  if (analyzingPaths.has(rel)) {
    transientInfo(`${rel} 正在分析中，请稍候`);
    return;
  }
  const cwd = activeCwd();
  if (!cwd) {
    return;
  }
  const model = await models.resolve();
  if (!model) {
    void vscode.window.showErrorMessage('Code Review：未找到可用的 Copilot 模型。');
    return;
  }

  let document: vscode.TextDocument;
  try {
    const uri = vscode.Uri.joinPath(vscode.Uri.file(cwd), rel);
    document = await vscode.workspace.openTextDocument(uri);
  } catch {
    void vscode.window.showWarningMessage(`Code Review：无法打开 ${rel}`);
    return;
  }

  // Capture the review identity so a result computed against an older review set
  // (the user may switch scope mid-analysis) is discarded instead of overwriting
  // the current session's findings.
  const reviewSet = session.reviewSet;
  const fileName = rel.split('/').pop() ?? rel;
  analyzingPaths.add(rel);
  WorkbenchPanel.refreshIfOpen();
  DocumentPanel.setAnalyzing(rel, true);
  let ok = false;
  try {
    await runWithProgress(`Code Review：分析 ${rel}`, async (token, report) => {
      try {
        report(`调用模型分析 ${fileName}…`);
        const findings = await analyzeFile(model, document, token);
        if (session.reviewSet !== reviewSet) {
          return;
        }
        report('写入发现…');
        session.setFindings(rel, findings);
        refreshDocPanel(rel);
        ok = true;
        transientInfo(
          findings.length
            ? `${rel} 发现 ${findings.length} 个问题`
            : `${rel} 未发现问题`,
        );
      } catch (err) {
        reportError(err);
      }
    });
  } finally {
    analyzingPaths.delete(rel);
    WorkbenchPanel.refreshIfOpen();
    DocumentPanel.setAnalyzing(rel, false, ok);
  }
}

/**
 * Opens (or reveals) the fix-proposal panel for a finding. Cached proposals are
 * restored automatically; applying one flips the finding's disposition to
 * `fixed`. This does NOT itself change the disposition — it's a pure entry point
 * shared by the "Copilot 修复" button and the clickable finding header.
 */
async function openFixProposal(rel: string, finding: Finding): Promise<void> {
  const cwd = activeCwd();
  if (!cwd) {
    return;
  }
  const findingId = finding.id;
  await locateInFile(rel, finding.line, finding.endLine, finding.id);
  const fileUri = vscode.Uri.joinPath(vscode.Uri.file(cwd), rel);
  FixProposalPanel.show({
    rel,
    cacheKey: fixProposalCacheKey(rel, finding),
    fileUri,
    finding: {
      id: finding.id,
      line: finding.line,
      title: finding.title,
      detail: finding.detail,
      suggestion: finding.suggestion,
    },
    generate: async (token) => {
      const model = await models.resolve();
      if (!model) {
        const prompt = composeFixPrompt(finding);
        try {
          await vscode.env.clipboard.writeText(prompt);
        } catch {
          // ignore clipboard failures
        }
        throw new Error('未找到可用的 Copilot 模型；已把修复提示词复制到剪贴板，可粘到 Copilot Chat 使用。');
      }
      const content = await readReviewFileText(rel);
      return generateFixProposals(
        model,
        rel,
        content,
        {
          title: finding.title,
          detail: finding.detail,
          suggestion: finding.suggestion,
          line: finding.line,
          endLine: finding.endLine,
          anchor: finding.anchor,
        },
        token,
      );
    },
    onApplied: (edit) => {
      setAppliedFix(fixKey(rel, findingId), edit);
      session.setFindingDisposition(rel, findingId, { kind: 'fixed', at: Date.now() });
      WorkbenchPanel.refreshIfOpen();
      // Reload the changed file, then re-center on THIS finding's fixed code so
      // collapsing the now-disposed card (which shifts layout) doesn't make the
      // view jump elsewhere. Keep focus exactly where the reviewer was working.
      void (async () => {
        await reloadDocPanel(rel);
        await locateInFile(rel, finding.line, finding.endLine, findingId);
      })();
      transientInfo('修复已应用，已标记为「已 Copilot 修复」');
    },
    onUndone: () => {
      deleteAppliedFix(fixKey(rel, findingId));
      session.setFindingDisposition(rel, findingId, null);
      WorkbenchPanel.refreshIfOpen();
      // Reload the reverted file, then re-center on the finding again so the
      // undo keeps focus in place instead of jumping.
      void (async () => {
        await reloadDocPanel(rel);
        await locateInFile(rel, finding.line, finding.endLine, findingId);
      })();
    },
  });
}

/**
 * Opens the fix-proposal panel for *viewing* a finding's proposals (cached or
 * freshly generated) without altering its disposition. Wired to the clickable
 * finding header so reviewers can re-inspect a proposal even after the finding
 * has been disposed.
 */
async function viewFixProposal(rel: string, findingId: string): Promise<void> {
  if (!session.reviewSet) {
    return;
  }
  if (!ensureReviewPath(rel, '查看修复方案')) {
    return;
  }
  const finding = session.findings(rel).find((f) => f.id === findingId);
  if (!finding) {
    return;
  }
  await openFixProposal(rel, finding);
}

/**
 * Routes the reviewer's disposition for a finding to the appropriate side effect
 * (invoke Copilot inline chat, post PR line comment, or capture an ignore reason)
 * and persists the result so the gate can advance.
 */
async function disposeFinding(rel: string, findingId: string, kind: FindingDispositionKind): Promise<void> {
  const reviewSet = session.reviewSet;
  if (!reviewSet) {
    return;
  }
  if (!ensureReviewPath(rel, '处置问题')) {
    return;
  }
  const current = session.findingDisposition(rel, findingId);
  if (current?.kind === kind) {
    // Toggling off. If the user is removing the 'fixed' mark and we still have
    // the applied edit on record, also revert the file change — that's the
    // intuitive meaning of "undo Copilot fix" from the document panel.
    if (kind === 'fixed') {
      await revertAppliedFix(rel, findingId);
    }
    session.setFindingDisposition(rel, findingId, null);
    transientInfo(`已撤销 ${rel} 的处置`);
    WorkbenchPanel.refreshIfOpen();
    refreshDocPanel(rel);
    return;
  }
  const finding = session.findings(rel).find((f) => f.id === findingId);
  if (!finding) {
    return;
  }

  const cwd = activeCwd();
  if (!cwd) {
    return;
  }

  if (kind === 'fixed') {
    await openFixProposal(rel, finding);
    return;
  } else if (kind === 'commented') {
    const prMatch = reviewSet.scopeId.match(/^pr-(\d+)$/);
    const body = composeCommentBody(finding);
    if (prMatch) {
      const prNumber = Number(prMatch[1]);
      try {
        const result = await postPrLineComment(
          cwd,
          prNumber,
          reviewSet.headSha,
          rel,
          finding.line,
          body,
        );
        session.setFindingDisposition(rel, findingId, {
          kind: 'commented',
          ref: String(result.id),
          at: Date.now(),
        });
        transientInfo(`已写为 PR #${prNumber} 行评论`);
      } catch (err) {
        try {
          const fallbackBody = `**${rel}:${finding.line}**\n\n${body}`;
          await postPrComment(cwd, prNumber, fallbackBody);
          session.setFindingDisposition(rel, findingId, {
            kind: 'commented',
            ref: `pr-${prNumber}:comment`,
            at: Date.now(),
          });
          transientInfo(`行评论不可用，已写为 PR #${prNumber} 普通评论`);
        } catch (fallbackErr) {
          void vscode.window.showErrorMessage(
            `Code Review：发送 PR 评论失败 — ${(fallbackErr as Error).message || (err as Error).message}`,
          );
          return;
        }
      }
    } else {
      try {
        const filePath = await appendLocalFindingNote(cwd, reviewSet.scopeId, rel, finding, body);
        session.setFindingDisposition(rel, findingId, {
          kind: 'commented',
          ref: filePath,
          at: Date.now(),
        });
        transientInfo(`已记入 ${path.relative(cwd, filePath)}`);
      } catch (err) {
        void vscode.window.showErrorMessage(`Code Review：写入本地评论失败 — ${(err as Error).message}`);
        return;
      }
    }
  } else if (kind === 'ignored') {
    const reason = await vscode.window.showInputBox({
      title: `Code Review · 忽略：${finding.title}`,
      prompt: '请输入忽略此发现的理由（会持久化到本地审查记录）',
      placeHolder: '例：误报 / 当前迭代不处理 / 已在 issue #123 跟进',
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim().length >= 4 ? null : '至少 4 个字符'),
    });
    if (!reason) {
      return;
    }
    session.setFindingDisposition(rel, findingId, {
      kind: 'ignored',
      reason: reason.trim(),
      at: Date.now(),
    });
    transientInfo('已忽略');
  }

  WorkbenchPanel.refreshIfOpen();
  refreshDocPanel(rel);
}

function composeFixPrompt(finding: { title: string; detail: string; suggestion?: string; line: number }): string {
  const lines: string[] = [
    `修复以下代码审查问题（第 ${finding.line} 行附近）：`,
    `标题：${finding.title}`,
    `问题：${finding.detail}`,
  ];
  if (finding.suggestion) {
    lines.push(`建议：${finding.suggestion}`);
  }
  lines.push('请直接给出可应用的最小改动。');
  return lines.join('\n');
}

function hashString(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function fixProposalCacheKey(rel: string, finding: Finding): string {
  const reviewSet = session.reviewSet;
  const reviewPart = reviewSet
    ? `${session.getRepoName()}::${reviewSet.scopeId}::${reviewSet.headSha}`
    : 'no-review';
  const findingPart = [
    finding.id,
    finding.line,
    finding.endLine ?? '',
    finding.title,
    finding.detail,
    finding.suggestion ?? '',
  ].join('\0');
  return `${reviewPart}::${rel}::${hashString(findingPart)}`;
}

function composeCommentBody(finding: { title: string; detail: string; suggestion?: string }): string {
  const parts = [`**${finding.title}**`, '', finding.detail];
  if (finding.suggestion) {
    parts.push('', `**建议**：${finding.suggestion}`);
  }
  parts.push('', '_via Code Review Gate_');
  return parts.join('\n');
}

async function appendLocalFindingNote(
  cwd: string,
  scopeId: string,
  rel: string,
  finding: { line: number; title: string; detail: string; suggestion?: string },
  body: string,
): Promise<string> {
  const dir = path.join(cwd, '.codereview');
  await fs.mkdir(dir, { recursive: true });
  const safeScope = scopeId.replace(/[^\w.-]+/g, '_');
  const target = path.join(dir, `findings-${safeScope}.md`);
  const stamp = new Date().toISOString();
  const block = `\n---\n\n## ${rel}:${finding.line}\n\n${body}\n\n<sub>${stamp}</sub>\n`;
  await fs.appendFile(target, block, 'utf8');
  return target;
}

async function runGlobalAnalysis(): Promise<void> {
  const reviewSet = session.reviewSet;
  if (!reviewSet) {
    WorkbenchPanel.setGlobalProgress(false);
    transientWarning('尚未开始审查');
    return;
  }
  if (globalAnalysisInFlight) {
    // Already running — re-assert busy so the button stays disabled, then bail.
    WorkbenchPanel.setGlobalProgress(true, '全局分析正在进行中…');
    transientInfo('全局分析正在进行中，请稍候');
    return;
  }
  const unready = reviewSet.files.filter((f) => !session.fileFullySeen(f.path));
  if (unready.length) {
    const pick = await vscode.window.showWarningMessage(
      `还有 ${unready.length} 个文件未读完，仍要进行全局分析吗？`,
      '继续',
      '取消',
    );
    if (pick !== '继续') {
      WorkbenchPanel.setGlobalProgress(false);
      return;
    }
  }
  const model = await models.resolve();
  if (!model) {
    WorkbenchPanel.setGlobalProgress(false);
    void vscode.window.showErrorMessage('Code Review：未找到可用的 Copilot 模型。');
    return;
  }

  // Drive progress inline inside the workbench (where the reviewer is looking)
  // instead of a parent-window notification, which is easy to miss when the
  // workbench is in its own auxiliary window.
  globalAnalysisInFlight = true;
  globalAnalysisCts = new vscode.CancellationTokenSource();
  const token = globalAnalysisCts.token;
  const total = reviewSet.files.length;
  WorkbenchPanel.setGlobalProgress(true, `准备分析 ${total} 个文件…`);
  try {
    const context: GlobalContextFile[] = [];
    let read = 0;
    for (const f of reviewSet.files) {
      if (token.isCancellationRequested) {
        return;
      }
      read++;
      WorkbenchPanel.setGlobalProgress(true, `读取源码 (${read}/${total}) ${f.path}…`);
      context.push({
        path: f.path,
        findings: session.findings(f.path),
        content: await readReviewFileText(f.path),
      });
    }
    WorkbenchPanel.setGlobalProgress(
      true,
      `已读取 ${total} 个文件，正在调用模型进行跨文件分析…`,
    );
    const globalReport = await analyzeGlobal(model, context, token);
    if (session.reviewSet !== reviewSet || token.isCancellationRequested) {
      return;
    }
    session.setGlobalReport(globalReport);
    showGlobalReport();
  } catch (err) {
    if (!token.isCancellationRequested) {
      reportError(err);
    }
  } finally {
    globalAnalysisInFlight = false;
    globalAnalysisCts?.dispose();
    globalAnalysisCts = undefined;
    WorkbenchPanel.setGlobalProgress(false);
  }
}

/** Cancels the in-flight global analysis, if any. */
function cancelGlobalAnalysis(): void {
  if (globalAnalysisCts) {
    globalAnalysisCts.cancel();
    WorkbenchPanel.setGlobalProgress(false);
    transientInfo('已取消全局分析');
  }
}

function showGlobalReport(): void {
  const report = session.globalReport;
  if (!report) {
    transientInfo('尚无全局结论，请先运行全局分析');
    return;
  }
  const cov = session.totalCoverage();
  const reviewSet = session.reviewSet;
  const findingsCount = reviewSet
    ? reviewSet.files.reduce((sum, f) => sum + session.findings(f.path).length, 0)
    : 0;
  GlobalReportPanel.show(
    report,
    session.globalConfirmed,
    locateInFile,
    () => session.confirmGlobal(),
    generateCandidateDiff,
    {
      seen: cov.seen,
      total: cov.total,
      filesReady: cov.filesReady,
      filesTotal: cov.filesTotal,
      findings: findingsCount,
    },
    () => void vscode.commands.executeCommand('codereview.openWorkbench'),
  );
}

/** Generates a candidate unified diff for a fix spot and opens it in an editor. */
async function generateCandidateDiff(fix: {
  file: string;
  line: number;
  title: string;
  detail: string;
  suggestion?: string;
}): Promise<void> {
  const cwd = activeCwd();
  if (!cwd) {
    return;
  }
  // The fix spot comes from the model's global report; only act on files that
  // are actually part of the current review set to avoid reading arbitrary paths.
  if (!session.reviewSet?.files.some((f) => f.path === fix.file)) {
    void vscode.window.showWarningMessage(`Code Review：${fix.file} 不在当前审查范围内，已跳过。`);
    return;
  }
  const model = await models.resolve();
  if (!model) {
    void vscode.window.showErrorMessage('Code Review：未找到可用的 Copilot 模型。');
    return;
  }
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Code Review：生成 ${fix.file} 候选 diff…`,
      cancellable: true,
    },
    async (_p, token) => {
      try {
        const content = await readReviewFileText(fix.file);
        const diff = await generateFixDiff(model, fix.file, content, fix, token);
        const diffDoc = await vscode.workspace.openTextDocument({
          language: 'diff',
          content: diff || '（模型未返回 diff）',
        });
        await vscode.window.showTextDocument(diffDoc, { preview: true, viewColumn: vscode.ViewColumn.Active });
      } catch (err) {
        reportError(err);
      }
    },
  );
}

async function locateInFile(
  relPath: string,
  line: number,
  endLine?: number,
  findingId?: string,
): Promise<void> {
  if (!ensureReviewPath(relPath, '定位')) {
    return;
  }
  if (DocumentPanel.currentPath !== relPath) {
    await openFileInPanel(relPath);
  }
  const total = session.fileState(relPath)?.totalLines ?? 0;
  let startLine = Math.max(1, Math.floor(Number.isFinite(line) ? line : 1));
  let stopLine = endLine && endLine > startLine ? Math.floor(endLine) : startLine;

  // Prefer content-based anchoring over the (drift-prone) line numbers:
  //   1. an applied Copilot fix → locate its current text in the live document;
  //   2. otherwise the finding's verbatim `anchor` snippet from analysis;
  //   3. only fall back to the stored line numbers when neither resolves.
  const reanchored = findingId ? await reanchorToAppliedFix(relPath, findingId) : undefined;
  if (reanchored) {
    startLine = reanchored.startLine;
    stopLine = reanchored.endLine;
  } else if (findingId) {
    const byContent = await locateByFindingAnchor(relPath, findingId);
    if (byContent) {
      startLine = byContent.startLine;
      stopLine = byContent.endLine;
    }
  }

  if (total > 0) {
    startLine = Math.min(startLine, total);
    stopLine = Math.min(stopLine, total);
  }
  DocumentPanel.scrollTo(startLine, stopLine);
}

/**
 * Locates a finding by its verbatim `anchor` snippet in the live document,
 * returning 1-based start/end lines. Content-based, so it survives line drift
 * from edits or earlier fixes. Returns undefined when the finding has no anchor
 * or the snippet can no longer be found uniquely (caller falls back to lines).
 */
async function locateByFindingAnchor(
  rel: string,
  findingId: string,
): Promise<{ startLine: number; endLine: number } | undefined> {
  const finding = session.findings(rel).find((f) => f.id === findingId);
  if (!finding?.anchor) {
    return undefined;
  }
  const cwd = activeCwd();
  if (!cwd) {
    return undefined;
  }
  try {
    const fileUri = vscode.Uri.joinPath(vscode.Uri.file(cwd), rel);
    const doc = await vscode.workspace.openTextDocument(fileUri);
    const hit = locateSnippetLines(doc.getText().split(/\r?\n/), finding.anchor);
    if (!hit) {
      return undefined;
    }
    return { startLine: hit.line, endLine: hit.endLine };
  } catch (err) {
    console.warn('[codereview] locateByFindingAnchor failed:', err);
    return undefined;
  }
}

/**
 * Locates the current line range of an applied fix by searching the live
 * document for its `newText`. Returns 1-based start/end lines, or undefined when
 * no applied fix exists or the snippet can no longer be found uniquely.
 */
async function reanchorToAppliedFix(
  rel: string,
  findingId: string,
): Promise<{ startLine: number; endLine: number } | undefined> {
  const edit = appliedFixes.get(fixKey(rel, findingId));
  if (!edit) {
    return undefined;
  }
  const cwd = activeCwd();
  if (!cwd) {
    return undefined;
  }
  try {
    const fileUri = vscode.Uri.joinPath(vscode.Uri.file(cwd), rel);
    const doc = await vscode.workspace.openTextDocument(fileUri);
    const hit = locateSnippetLines(doc.getText().split(/\r?\n/), edit.newText);
    if (!hit) {
      return undefined;
    }
    return { startLine: hit.line, endLine: hit.endLine };
  } catch (err) {
    console.warn('[codereview] reanchorToAppliedFix failed:', err);
    return undefined;
  }
}


/** Computes the next not-yet-seen line in a file and scrolls the panel to it. */
function jumpToNextUnseen(relPath: string): void {
  if (!ensureReviewPath(relPath, '跳转')) {
    return;
  }
  const state = session.fileState(relPath);
  if (!state) {
    return;
  }
  const total = state.totalLines;
  if (total <= 0) {
    transientInfo('文件尚未加载完成');
    return;
  }
  const seen = new Set(state.seenLines);
  let target = -1;
  for (let l = 1; l <= total; l++) {
    if (!seen.has(l)) {
      target = l;
      break;
    }
  }
  if (target < 0) {
    transientInfo('本文件已全部通读');
    return;
  }
  DocumentPanel.scrollTo(target);
}

/** Jumps to the next unseen line in the file currently shown in the panel. */
function jumpToNextUnseenCurrent(): void {
  const rel = DocumentPanel.currentPath ?? workbenchSelected;
  if (!rel) {
    transientWarning('请先在工作台中选择一个文件');
    return;
  }
  jumpToNextUnseen(rel);
}

async function submitConclusion(): Promise<void> {
  if (!session.reviewSet) {
    transientWarning('尚未开始审查');
    return;
  }
  if (!session.gatePassed()) {
    const c = session.totalCoverage();
    const reasons: string[] = [];
    if (c.filesReady < c.filesTotal) {
      reasons.push(`还有 ${c.filesTotal - c.filesReady} 个文件未读完并分析`);
    }
    if (!session.globalConfirmed) {
      reasons.push('尚未确认全局结论');
    }
    void vscode.window.showWarningMessage(`Code Review 门禁未通过：${reasons.join('；')}。`);
    return;
  }

  const choice = await vscode.window.showQuickPick(
    [
      { label: '$(check) 通过（Approve）', value: 'approve' as const },
      { label: '$(request-changes) 要求修改（Request Changes）', value: 'changes' as const },
      { label: '$(comment) 仅评论（Comment）', value: 'comment' as const },
    ],
    { title: 'Code Review · 提交结论', placeHolder: '选择本次审查的结论' },
  );
  if (!choice) {
    return;
  }

  const cleanLabel = choice.label.replace(/\$\([^)]+\)\s*/, '');
  const conclusionVerdict =
    choice.value === 'approve' ? 'approve' : choice.value === 'changes' ? 'request-changes' : 'comment';
  const prMatch = session.reviewSet.scopeId.match(/^pr-(\d+)$/);
  if (prMatch) {
    const prNumber = Number(prMatch[1]);
    const confirm = await vscode.window.showWarningMessage(
      `将把审查结论写回 PR #${prNumber}：${cleanLabel}。确认提交？`,
      { modal: true },
      '提交到 GitHub',
    );
    if (confirm !== '提交到 GitHub') {
      return;
    }
    const cwd = activeCwd();
    if (!cwd) {
      return;
    }
    const c = session.totalCoverage();
    const body = `Reviewed via Code Review Gate — ${c.filesReady}/${c.filesTotal} 文件已逐行通读并确认，全局结论已核对。`;
    try {
      await submitPrReview(cwd, prNumber, conclusionVerdict, body);
      session.setConclusion({
        verdict: conclusionVerdict,
        label: cleanLabel,
        target: 'pr',
        prNumber,
        submittedAt: Date.now(),
      });
      transientInfo(`已写回 PR #${prNumber}（${cleanLabel}）`);
    } catch (err) {
      reportError(err);
    }
    return;
  }

  session.setConclusion({
    verdict: conclusionVerdict,
    label: cleanLabel,
    target: 'local',
    submittedAt: Date.now(),
  });
  transientInfo(`审查结论已记录：${cleanLabel}`);
}

function reportError(err: unknown): void {
  const message =
    err instanceof AnalysisError ? err.message : String((err as Error)?.message ?? err);
  void vscode.window.showErrorMessage(`Code Review：${message}`);
}

function workspaceFolderPath(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function workspaceFolderName(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.name;
}

/** Active review's cwd, falling back to the first workspace folder when no review is loaded. */
function activeCwd(): string | undefined {
  return session.getCwd();
}

/**
 * Older versions hid `workbench.activityBar.location` globally and didn't always
 * restore it. If we still see that lingering value, clear it once per machine so
 * the activity bar reappears for the user.
 */
async function restoreGloballyHiddenActivityBar(context: vscode.ExtensionContext): Promise<void> {
  const FLAG = 'codereview.activityBarRestored.v1';
  if (context.globalState.get<boolean>(FLAG)) {
    return;
  }
  try {
    const wb = vscode.workspace.getConfiguration('workbench');
    if (wb.inspect<string>('activityBar.location')?.globalValue === 'hidden') {
      await wb.update('activityBar.location', undefined, vscode.ConfigurationTarget.Global);
    }
  } catch (err) {
    console.warn('[codereview] activity bar restore failed:', err);
  } finally {
    await context.globalState.update(FLAG, true);
  }
}

export function deactivate(): void {
  // nothing to clean up beyond context.subscriptions
}
