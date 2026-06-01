import * as vscode from 'vscode';
import type { ReviewFile } from '../../scope/types';
import type { ReviewSession } from '../../review/reviewSession';

/** Native TreeView of the review set's files with per-file readiness icons. */
export class ChangedFilesProvider implements vscode.TreeDataProvider<FileNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly session: ReviewSession) {
    session.onDidChange(() => this._onDidChangeTreeData.fire());
  }

  getTreeItem(node: FileNode): vscode.TreeItem {
    return node;
  }

  getChildren(): FileNode[] {
    const reviewSet = this.session.reviewSet;
    if (!reviewSet) {
      return [];
    }
    return reviewSet.files.map((f) => {
      const { seen, total } = this.session.coverage(f.path);
      return new FileNode(f, {
        ready: this.session.fileReady(f.path),
        fullySeen: this.session.fileFullySeen(f.path),
        seen,
        total,
      });
    });
  }
}

interface FileNodeState {
  ready: boolean;
  fullySeen: boolean;
  seen: number;
  total: number;
}

class FileNode extends vscode.TreeItem {
  constructor(file: ReviewFile, state: FileNodeState) {
    super(file.path.split('/').pop() ?? file.path, vscode.TreeItemCollapsibleState.None);

    const dir = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '';
    const coverage = state.total > 0 ? `${state.seen}/${state.total}` : '';
    this.description = [dir, coverage].filter(Boolean).join('  ·  ');

    this.tooltip = state.total > 0 ? `${file.path}\n已看 ${state.seen}/${state.total} 行` : file.path;
    this.iconPath = new vscode.ThemeIcon(iconFor(state));
    this.contextValue = state.ready ? 'codereviewFile.ready' : 'codereviewFile.pending';
    this.command = {
      command: 'codereview.openFile',
      title: 'Open Source File',
      arguments: [file.path],
    };
  }
}

/** Icon reflects coverage progress (analysis is layered on in a later slice). */
function iconFor(state: FileNodeState): string {
  if (state.ready) {
    return 'pass-filled';
  }
  if (state.fullySeen) {
    return 'eye';
  }
  if (state.seen > 0) {
    return 'circle-large-filled';
  }
  return 'circle-large-outline';
}
