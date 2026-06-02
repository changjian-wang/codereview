import * as vscode from 'vscode';

/**
 * Self-clearing status-bar message used in place of notification toasts for
 * routine "operation succeeded" / "nothing to do" feedback. The VS Code
 * notification queue is reserved for real errors and decisions the user must
 * see.
 */
export function transientInfo(message: string, ms = 3000): void {
  vscode.window.setStatusBarMessage(`$(info) ${message}`, ms);
}

export function transientWarning(message: string, ms = 4000): void {
  vscode.window.setStatusBarMessage(`$(warning) ${message}`, ms);
}
