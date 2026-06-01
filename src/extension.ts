import * as vscode from 'vscode';
import { ReviewSession } from './review/reviewSession';
import { WorkspaceStateReviewStore } from './review/reviewStore';
import { pickModel } from './ai/modelPicker';
import { ModelProvider } from './ai/modelProvider';
import { analyzeFile, analyzeGlobal, AnalysisError, type GlobalContextFile } from './ai/analyzer';
import { pickScope } from './scope/scopePicker';
import { ChangedFilesProvider } from './ui/tree/changedFilesProvider';
import { CoverageTracker } from './ui/coverageTracker';
import { FindingRenderer } from './ui/findingRenderer';
import { GlobalReportPanel } from './ui/globalReportPanel';
import { GateStatusBar } from './ui/gateStatusBar';

let session: ReviewSession;
const models = new ModelProvider();
let findingRenderer: FindingRenderer;

export function activate(context: vscode.ExtensionContext): void {
  const repo = workspaceFolderName() ?? 'unknown';
  const store = new WorkspaceStateReviewStore(context.workspaceState);
  session = new ReviewSession(store, repo);
  findingRenderer = new FindingRenderer();

  const treeProvider = new ChangedFilesProvider(session);
  context.subscriptions.push(
    session,
    findingRenderer,
    new GateStatusBar(session),
    vscode.window.createTreeView('codereview.changedFiles', { treeDataProvider: treeProvider }),
    vscode.commands.registerCommand('codereview.startReview', startReview),
    vscode.commands.registerCommand('codereview.pickModel', selectModel),
    vscode.commands.registerCommand('codereview.openFile', openChangedFile),
    vscode.commands.registerCommand('codereview.analyzeFile', analyzeActiveFile),
    vscode.commands.registerCommand('codereview.globalAnalysis', runGlobalAnalysis),
    vscode.commands.registerCommand('codereview.showGlobalReport', showGlobalReport),
    vscode.commands.registerCommand('codereview.submitConclusion', submitConclusion),
  );

  const cwd = workspaceFolderPath();
  if (cwd) {
    context.subscriptions.push(new CoverageTracker(session, cwd));
  }
}

async function startReview(): Promise<void> {
  const cwd = workspaceFolderPath();
  if (!cwd) {
    void vscode.window.showErrorMessage('Code Review：请先打开一个 Git 仓库工作区。');
    return;
  }

  const source = await pickScope(cwd);
  if (!source) {
    return;
  }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Code Review：加载源码…' },
    async () => {
      try {
        const reviewSet = await source.load(cwd);
        await session.start(reviewSet);
        void vscode.window.showInformationMessage(
          `Code Review：${reviewSet.label} · ${reviewSet.files.length} 个文件`,
        );
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
    void vscode.window.showInformationMessage(`Code Review 分析模型：${choice.label}`);
  }
}

/** Maps a document to its repository-relative path within the review set. */
function relPathInScope(document: vscode.TextDocument): string | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder || document.uri.scheme !== 'file') {
    return undefined;
  }
  const rel = vscode.workspace.asRelativePath(document.uri, false).replace(/\\/g, '/');
  return session.reviewSet?.files.some((f) => f.path === rel) ? rel : undefined;
}

async function analyzeActiveFile(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showWarningMessage('Code Review：请先打开要分析的源码文件。');
    return;
  }
  const rel = relPathInScope(editor.document);
  if (!rel) {
    void vscode.window.showWarningMessage('Code Review：当前文件不在审查范围内。');
    return;
  }
  const model = await models.resolve();
  if (!model) {
    void vscode.window.showErrorMessage('Code Review：未找到可用的 Copilot 模型。');
    return;
  }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Code Review：分析 ${rel}…` },
    async (_p, token) => {
      try {
        const findings = await analyzeFile(model, editor.document, token);
        session.setFindings(rel, findings);
        findingRenderer.render(editor.document, findings);
        void vscode.window.showInformationMessage(
          findings.length
            ? `Code Review：${rel} 发现 ${findings.length} 个问题。`
            : `Code Review：${rel} 未发现问题。`,
        );
      } catch (err) {
        reportError(err);
      }
    },
  );
}

async function runGlobalAnalysis(): Promise<void> {
  const reviewSet = session.reviewSet;
  if (!reviewSet) {
    void vscode.window.showWarningMessage('Code Review：尚未开始审查。');
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
      return;
    }
  }
  const model = await models.resolve();
  if (!model) {
    void vscode.window.showErrorMessage('Code Review：未找到可用的 Copilot 模型。');
    return;
  }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Code Review：全局逻辑分析…' },
    async (_p, token) => {
      try {
        const context: GlobalContextFile[] = reviewSet.files.map((f) => ({
          path: f.path,
          findings: session.findings(f.path),
        }));
        const report = await analyzeGlobal(model, context, token);
        session.setGlobalReport(report);
        showGlobalReport();
      } catch (err) {
        reportError(err);
      }
    },
  );
}

function showGlobalReport(): void {
  const report = session.globalReport;
  if (!report) {
    void vscode.window.showInformationMessage('Code Review：尚无全局结论，请先运行全局分析。');
    return;
  }
  GlobalReportPanel.show(
    report,
    session.globalConfirmed,
    locateInFile,
    () => session.confirmGlobal(),
  );
}

async function locateInFile(relPath: string, line: number): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    return;
  }
  const uri = vscode.Uri.joinPath(folder.uri, relPath);
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    const target = new vscode.Position(Math.max(0, line - 1), 0);
    editor.selection = new vscode.Selection(target, target);
    editor.revealRange(new vscode.Range(target, target), vscode.TextEditorRevealType.InCenter);
  } catch {
    void vscode.window.showWarningMessage(`Code Review：无法定位 ${relPath}:${line}`);
  }
}

async function submitConclusion(): Promise<void> {
  if (!session.reviewSet) {
    void vscode.window.showWarningMessage('Code Review：尚未开始审查。');
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
  void vscode.window.showInformationMessage(`Code Review 结论已记录：${choice.label.replace(/\$\([^)]+\)\s*/, '')}`);
}

function reportError(err: unknown): void {
  const message =
    err instanceof AnalysisError ? err.message : String((err as Error)?.message ?? err);
  void vscode.window.showErrorMessage(`Code Review：${message}`);
}

async function openChangedFile(relPath: string): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    return;
  }
  const uri = vscode.Uri.joinPath(folder.uri, relPath);
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: false });
  } catch {
    void vscode.window.showWarningMessage(`Code Review：无法打开 ${relPath}`);
  }
}

function workspaceFolderPath(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function workspaceFolderName(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.name;
}

export function deactivate(): void {
  // nothing to clean up beyond context.subscriptions
}
