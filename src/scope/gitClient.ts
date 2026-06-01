import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ReviewFile } from './types';

const pexec = promisify(execFile);
const MAX_BUFFER = 32 * 1024 * 1024;

/** Raised for any git failure with a user-facing message. */
export class GitError extends Error {}

async function git(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await pexec('git', args, { cwd, maxBuffer: MAX_BUFFER });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new GitError((e.stderr || e.message || String(err)).trim());
  }
}

/** Throws GitError if cwd is not inside a git work tree. */
export async function ensureGitRepo(cwd: string): Promise<void> {
  try {
    await pexec('git', ['rev-parse', '--is-inside-work-tree'], { cwd });
  } catch {
    throw new GitError('当前工作区不是 Git 仓库。');
  }
}

/** Current HEAD commit SHA, or "live" when not in a git repo. */
export async function headShaOrLive(cwd: string): Promise<string> {
  try {
    return (await git(['rev-parse', 'HEAD'], cwd)).trim();
  } catch {
    return 'live';
  }
}

/** Current HEAD commit SHA. */
export async function headSha(cwd: string): Promise<string> {
  return (await git(['rev-parse', 'HEAD'], cwd)).trim();
}

/**
 * Best-effort default base branch: origin/HEAD's target, else main, else master.
 */
export async function detectBaseBranch(cwd: string): Promise<string> {
  try {
    const ref = (await git(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], cwd)).trim();
    const name = ref.replace(/^refs\/remotes\/origin\//, '');
    if (name) {
      return `origin/${name}`;
    }
  } catch {
    // fall through to heuristics
  }
  for (const candidate of ['main', 'master']) {
    try {
      await git(['rev-parse', '--verify', '--quiet', candidate], cwd);
      return candidate;
    } catch {
      // try next
    }
  }
  throw new GitError('无法确定默认分支（未找到 origin/HEAD、main 或 master）。');
}

/** Parses `git diff --numstat` output into ReviewFile[]. */
function parseNumstat(out: string): ReviewFile[] {
  const files: ReviewFile[] = [];
  for (const line of out.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const parts = trimmed.split('\t');
    if (parts.length < 3) {
      continue;
    }
    const [add, del, ...rest] = parts;
    let path = rest.join('\t');
    // Renames appear as "old => new" or "dir/{old => new}/file".
    const arrow = path.indexOf(' => ');
    const status: ReviewFile['status'] | undefined = arrow >= 0 ? 'renamed' : undefined;
    if (arrow >= 0) {
      path = path.replace(/\{[^}]*=> ([^}]*)\}/, '$1').replace(/^.* => /, '');
    }
    files.push({
      path,
      additions: add === '-' ? 0 : Number.parseInt(add, 10) || 0,
      deletions: del === '-' ? 0 : Number.parseInt(del, 10) || 0,
      status,
    });
  }
  return files;
}

/** Files changed for an arbitrary diff range, e.g. "main...HEAD". */
export async function diffFiles(cwd: string, range: string): Promise<ReviewFile[]> {
  return parseNumstat(await git(['diff', '--numstat', range], cwd));
}

/** Tracked changes in the working tree and index vs HEAD. */
export async function workingTreeFiles(cwd: string): Promise<ReviewFile[]> {
  return parseNumstat(await git(['diff', '--numstat', 'HEAD'], cwd));
}
