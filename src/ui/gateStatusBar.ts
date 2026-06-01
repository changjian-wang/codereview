import * as vscode from 'vscode';
import type { ReviewSession } from '../review/reviewSession';

/**
 * Status-bar indicator of the review gate: shows coverage progress and whether
 * the gate is locked or ready to submit a conclusion.
 */
export class GateStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly session: ReviewSession) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
    this.item.command = 'codereview.submitConclusion';
    this.disposables.push(this.session.onDidChange(() => this.refresh()));
    this.refresh();
  }

  refresh(): void {
    if (!this.session.reviewSet) {
      this.item.hide();
      return;
    }
    const c = this.session.totalCoverage();
    const passed = this.session.gatePassed();
    if (passed) {
      this.item.text = '$(unlock) 审查就绪';
      this.item.tooltip = '所有文件已读完并分析，全局结论已确认。点击提交结论。';
      this.item.backgroundColor = undefined;
    } else {
      this.item.text = `$(lock) 审查 ${c.filesReady}/${c.filesTotal}`;
      const parts = [`文件就绪 ${c.filesReady}/${c.filesTotal}`, `行覆盖 ${c.seen}/${c.total}`];
      if (!this.session.globalConfirmed) {
        parts.push('待确认全局结论');
      }
      this.item.tooltip = `审查门禁未通过：${parts.join('，')}。`;
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    }
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
