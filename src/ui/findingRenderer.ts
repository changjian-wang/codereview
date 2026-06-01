import * as vscode from 'vscode';
import type { Finding, FindingSeverity } from '../ai/types';

const DIAGNOSTIC_SOURCE = 'Code Review';

function toDiagnosticSeverity(s: FindingSeverity): vscode.DiagnosticSeverity {
  switch (s) {
    case 'bug':
      return vscode.DiagnosticSeverity.Error;
    case 'conditional':
      return vscode.DiagnosticSeverity.Warning;
    default:
      return vscode.DiagnosticSeverity.Information;
  }
}

const SEVERITY_LABEL: Record<FindingSeverity, string> = {
  bug: '真 Bug',
  conditional: '条件性',
  suggestion: '建议',
};

const SEVERITY_ICON: Record<FindingSeverity, string> = {
  bug: '🟥',
  conditional: '🟧',
  suggestion: '🟦',
};

/**
 * Renders file-level findings as native Diagnostics (Problems panel) plus an
 * inline after-line decoration showing the finding title.
 */
export class FindingRenderer implements vscode.Disposable {
  private readonly diagnostics: vscode.DiagnosticCollection;
  private readonly inline: vscode.TextEditorDecorationType;
  /** Findings keyed by document fsPath, so we can re-decorate on editor change. */
  private readonly byPath = new Map<string, Finding[]>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    this.diagnostics = vscode.languages.createDiagnosticCollection('codereview');
    this.inline = vscode.window.createTextEditorDecorationType({
      after: {
        margin: '0 0 0 1.5rem',
        color: new vscode.ThemeColor('editorCodeLens.foreground'),
      },
    });
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor) {
          this.decorate(editor);
        }
      }),
    );
  }

  /** Stores and renders findings for a document. */
  render(document: vscode.TextDocument, findings: Finding[]): void {
    this.byPath.set(document.uri.fsPath, findings);
    this.diagnostics.set(document.uri, findings.map((f) => this.toDiagnostic(document, f)));
    const editor = vscode.window.visibleTextEditors.find(
      (e) => e.document.uri.fsPath === document.uri.fsPath,
    );
    if (editor) {
      this.decorate(editor);
    }
  }

  /** Re-applies inline decorations for an editor from stored findings. */
  private decorate(editor: vscode.TextEditor): void {
    const findings = this.byPath.get(editor.document.uri.fsPath);
    if (!findings) {
      editor.setDecorations(this.inline, []);
      return;
    }
    const options: vscode.DecorationOptions[] = findings.map((f) => {
      const line = Math.min(f.line - 1, editor.document.lineCount - 1);
      return {
        range: editor.document.lineAt(Math.max(0, line)).range,
        renderOptions: {
          after: {
            contentText: `  ${SEVERITY_ICON[f.severity]} ${f.title}`,
          },
        },
      };
    });
    editor.setDecorations(this.inline, options);
  }

  private toDiagnostic(document: vscode.TextDocument, f: Finding): vscode.Diagnostic {
    const startLine = Math.max(0, Math.min(f.line - 1, document.lineCount - 1));
    const endLine = Math.max(startLine, Math.min((f.endLine ?? f.line) - 1, document.lineCount - 1));
    const range = new vscode.Range(
      document.lineAt(startLine).range.start,
      document.lineAt(endLine).range.end,
    );
    const message = f.suggestion
      ? `[${SEVERITY_LABEL[f.severity]}] ${f.title}\n${f.detail}\n建议：${f.suggestion}`
      : `[${SEVERITY_LABEL[f.severity]}] ${f.title}\n${f.detail}`;
    const diag = new vscode.Diagnostic(range, message, toDiagnosticSeverity(f.severity));
    diag.source = DIAGNOSTIC_SOURCE;
    return diag;
  }

  dispose(): void {
    this.diagnostics.dispose();
    this.inline.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
