import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ReviewSession } from '../review/reviewSession';

/** A line must stay visible this long before it counts as "seen" (strict mode). */
const DWELL_MS = 300;

/**
 * Tracks which source lines the reviewer has actually looked at, using the real
 * editor's visible ranges. A line only counts once it has dwelled in view for
 * DWELL_MS, so fast scrolling does not falsely mark lines as reviewed.
 */
export class CoverageTracker implements vscode.Disposable {
  private readonly seenDecoration: vscode.TextEditorDecorationType;
  private readonly disposables: vscode.Disposable[] = [];
  private dwellTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly session: ReviewSession,
    private readonly cwd: string,
  ) {
    this.seenDecoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      borderWidth: '0 0 0 2px',
      borderStyle: 'solid',
      borderColor: new vscode.ThemeColor('charts.green'),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
      overviewRulerColor: new vscode.ThemeColor('charts.green'),
    });

    this.disposables.push(
      this.seenDecoration,
      vscode.window.onDidChangeActiveTextEditor((e) => this.onActiveEditor(e)),
      vscode.window.onDidChangeTextEditorVisibleRanges((e) => this.onVisibleRanges(e.textEditor)),
      this.session.onDidChange(() => this.refreshVisible()),
    );

    if (vscode.window.activeTextEditor) {
      this.onActiveEditor(vscode.window.activeTextEditor);
    }
  }

  /** Returns the review-set relative path for an editor, or undefined if not in scope. */
  private relPathFor(editor: vscode.TextEditor): string | undefined {
    if (editor.document.uri.scheme !== 'file') {
      return undefined;
    }
    const rel = path.relative(this.cwd, editor.document.uri.fsPath).split(path.sep).join('/');
    if (!rel || rel.startsWith('..')) {
      return undefined;
    }
    return this.session.fileState(rel) ? rel : undefined;
  }

  private onActiveEditor(editor?: vscode.TextEditor): void {
    if (!editor) {
      return;
    }
    const rel = this.relPathFor(editor);
    if (!rel) {
      return;
    }
    this.session.setTotalLines(rel, editor.document.lineCount);
    this.applyDecoration(editor, rel);
    this.scheduleDwell(editor);
  }

  private onVisibleRanges(editor: vscode.TextEditor): void {
    if (!this.relPathFor(editor)) {
      return;
    }
    this.scheduleDwell(editor);
  }

  private scheduleDwell(editor: vscode.TextEditor): void {
    if (this.dwellTimer) {
      clearTimeout(this.dwellTimer);
    }
    this.dwellTimer = setTimeout(() => this.captureVisible(editor), DWELL_MS);
  }

  /** After the dwell delay, mark the still-visible lines as seen. */
  private captureVisible(editor: vscode.TextEditor): void {
    if (vscode.window.activeTextEditor !== editor) {
      return;
    }
    const rel = this.relPathFor(editor);
    if (!rel) {
      return;
    }
    const lines: number[] = [];
    for (const range of editor.visibleRanges) {
      for (let line = range.start.line; line <= range.end.line; line++) {
        lines.push(line + 1); // store 1-based
      }
    }
    if (this.session.markSeen(rel, lines)) {
      this.applyDecoration(editor, rel);
    }
  }

  private applyDecoration(editor: vscode.TextEditor, rel: string): void {
    const state = this.session.fileState(rel);
    const ranges = (state?.seenLines ?? []).map((l) => new vscode.Range(l - 1, 0, l - 1, 0));
    editor.setDecorations(this.seenDecoration, ranges);
  }

  private refreshVisible(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      const rel = this.relPathFor(editor);
      if (rel) {
        this.applyDecoration(editor, rel);
      }
    }
  }

  dispose(): void {
    if (this.dwellTimer) {
      clearTimeout(this.dwellTimer);
    }
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
