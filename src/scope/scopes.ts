import * as git from './gitClient';
import { ensureAuth, ensureGhAvailable, getCurrentPr } from '../gh/ghClient';
import type { ReviewFile, ReviewScope, ReviewSet } from './types';

/** PR associated with the current branch (via GitHub CLI). Lists files only. */
export class PrScope implements ReviewScope {
  async load(cwd: string): Promise<ReviewSet> {
    await ensureGhAvailable(cwd);
    await ensureAuth(cwd);
    const pr = await getCurrentPr(cwd);
    return {
      scopeId: `pr-${pr.number}`,
      label: `PR #${pr.number} · ${pr.title}`,
      headSha: pr.headRefOid,
      files: pr.files,
    };
  }
}

/** Files differing between the current branch and its base (pure git). */
export class BranchVsBaseScope implements ReviewScope {
  constructor(private readonly base?: string) {}

  async load(cwd: string): Promise<ReviewSet> {
    await git.ensureGitRepo(cwd);
    const base = this.base ?? (await git.detectBaseBranch(cwd));
    const headSha = await git.headSha(cwd);
    const files = await git.diffFiles(cwd, `${base}...HEAD`);
    return {
      scopeId: `branch-vs-${base}`,
      label: `当前分支 vs ${base}`,
      headSha,
      files,
    };
  }
}

/** Uncommitted tracked changes in the working tree (pure git). */
export class WorkingTreeScope implements ReviewScope {
  async load(cwd: string): Promise<ReviewSet> {
    await git.ensureGitRepo(cwd);
    const headSha = await git.headSha(cwd);
    const files = await git.workingTreeFiles(cwd);
    return {
      scopeId: 'working-tree',
      label: '未提交的改动',
      headSha,
      files,
    };
  }
}

/**
 * Source files chosen directly by the user — pure source review, no diff.
 * `relPaths` are repository-relative paths already expanded from the selection.
 */
export class FileSystemScope implements ReviewScope {
  constructor(private readonly relPaths: string[]) {}

  async load(cwd: string): Promise<ReviewSet> {
    const headSha = await git.headShaOrLive(cwd);
    const files: ReviewFile[] = this.relPaths.map((path) => ({ path }));
    return {
      scopeId: `files-${files.length}`,
      label: `选定的源码（${files.length}）`,
      headSha,
      files,
    };
  }
}
