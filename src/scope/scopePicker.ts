import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  BranchVsBaseScope,
  FileSystemScope,
  PrScope,
  WorkingTreeScope,
} from './scopes';
import type { ReviewScope } from './types';

/** Lets the user choose how the set of source files under review is scoped. */
export async function pickScope(cwd: string): Promise<ReviewScope | undefined> {
  type Item = vscode.QuickPickItem & { build: () => Promise<ReviewScope | undefined> };
  const items: Item[] = [
    {
      label: '$(files) 选择源码文件/文件夹',
      description: '纯源码审查',
      detail: '直接挑选要审查的源文件或目录，不依赖任何 diff',
      build: buildFileSystemScope,
    },
    {
      label: '$(git-pull-request) 当前分支的 PR',
      description: 'gh pr view',
      detail: '把 PR 涉及的源文件纳入审查（需要 gh 已登录）',
      build: async () => new PrScope(),
    },
    {
      label: '$(git-compare) 当前分支 vs 默认分支',
      description: 'git diff <base>...HEAD',
      detail: '把分支差异涉及的源文件纳入审查',
      build: async () => new BranchVsBaseScope(),
    },
    {
      label: '$(git-commit) 未提交的改动',
      description: 'git diff HEAD',
      detail: '把工作区改动涉及的源文件纳入审查',
      build: async () => new WorkingTreeScope(),
    },
  ];

  const choice = await vscode.window.showQuickPick(items, {
    title: 'Code Review · 选择审查范围',
    placeHolder: '挑选要纳入审查的源码（diff 仅用于圈定文件，审查对象始终是源码本身）',
  });
  return choice?.build();

  async function buildFileSystemScope(): Promise<ReviewScope | undefined> {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: true,
      canSelectMany: true,
      defaultUri: vscode.Uri.file(cwd),
      openLabel: '纳入审查',
      title: 'Code Review · 选择源码文件或文件夹',
    });
    if (!picked || picked.length === 0) {
      return undefined;
    }
    const relPaths = await expandToRelPaths(picked, cwd);
    if (relPaths.length === 0) {
      void vscode.window.showWarningMessage('Code Review：所选范围内没有可审查的文件。');
      return undefined;
    }
    return new FileSystemScope(relPaths);
  }
}

/** Expands selected files/folders into a de-duplicated, sorted list of relative file paths. */
async function expandToRelPaths(uris: vscode.Uri[], cwd: string): Promise<string[]> {
  const out = new Set<string>();
  for (const uri of uris) {
    await collect(uri, out, cwd);
  }
  return [...out].sort();
}

async function collect(uri: vscode.Uri, out: Set<string>, cwd: string): Promise<void> {
  let stat: vscode.FileStat;
  try {
    stat = await vscode.workspace.fs.stat(uri);
  } catch {
    return;
  }
  if (stat.type & vscode.FileType.Directory) {
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(uri);
    } catch {
      return;
    }
    for (const [name, type] of entries) {
      if (type & vscode.FileType.Directory && SKIP_DIRS.has(name)) {
        continue;
      }
      await collect(vscode.Uri.joinPath(uri, name), out, cwd);
    }
    return;
  }
  if (stat.type & vscode.FileType.File) {
    const rel = path.relative(cwd, uri.fsPath).split(path.sep).join('/');
    if (rel && !rel.startsWith('..')) {
      out.add(rel);
    }
  }
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'bin', 'obj', '.vs']);
