import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { PullRequest } from './types';

const pexec = promisify(execFile);

/** Raised for any gh-related failure with a user-facing message. */
export class GhError extends Error {}

const MAX_BUFFER = 32 * 1024 * 1024;

async function runGh(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await pexec('gh', args, { cwd, maxBuffer: MAX_BUFFER });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    const msg = (e.stderr || e.message || String(err)).trim();
    throw new GhError(msg);
  }
}

/** Throws GhError if the GitHub CLI is not installed / not on PATH. */
export async function ensureGhAvailable(cwd: string): Promise<void> {
  try {
    await pexec('gh', ['--version'], { cwd });
  } catch {
    throw new GhError('未找到 GitHub CLI（gh）。请先安装 gh 并执行 `gh auth login`。');
  }
}

/** Throws GhError if the user is not authenticated with gh. */
export async function ensureAuth(cwd: string): Promise<void> {
  try {
    await pexec('gh', ['auth', 'status'], { cwd });
  } catch {
    throw new GhError('GitHub CLI 未登录。请先执行 `gh auth login`。');
  }
}

/** Loads the PR associated with the current branch in `cwd`. */
export async function getCurrentPr(cwd: string): Promise<PullRequest> {
  const json = await runGh(
    ['pr', 'view', '--json', 'number,title,url,headRefName,baseRefName,headRefOid,files'],
    cwd,
  );
  let raw: {
    number: number;
    title: string;
    url: string;
    headRefName: string;
    baseRefName: string;
    headRefOid: string;
    files?: { path: string; additions?: number; deletions?: number }[];
  };
  try {
    raw = JSON.parse(json);
  } catch {
    throw new GhError('无法解析 gh 返回的 PR 数据。');
  }
  return {
    number: raw.number,
    title: raw.title,
    url: raw.url,
    headRefName: raw.headRefName,
    baseRefName: raw.baseRefName,
    headRefOid: raw.headRefOid,
    files: (raw.files ?? []).map((f) => ({
      path: f.path,
      additions: f.additions ?? 0,
      deletions: f.deletions ?? 0,
    })),
  };
}

/** Raw unified diff for the current branch's PR. */
export async function getPrDiff(cwd: string): Promise<string> {
  return runGh(['pr', 'diff'], cwd);
}

/** Posts a review verdict to a PR via `gh pr review`. */
export async function submitPrReview(
  cwd: string,
  prNumber: number,
  verdict: 'approve' | 'request-changes' | 'comment',
  body: string,
): Promise<void> {
  const flag =
    verdict === 'approve' ? '--approve' : verdict === 'request-changes' ? '--request-changes' : '--comment';
  const args = ['pr', 'review', String(prNumber), flag];
  if (body.trim()) {
    args.push('--body', body);
  }
  await runGh(args, cwd);
}

/** Posts a single line-anchored review comment to a PR via the GitHub REST API. */
export async function postPrLineComment(
  cwd: string,
  prNumber: number,
  commitSha: string,
  filePath: string,
  line: number,
  body: string,
): Promise<{ id: number; url: string }> {
  // gh api needs the owner/repo, derivable from the remote.
  const repoJson = await runGh(['repo', 'view', '--json', 'owner,name'], cwd);
  let repo: { owner: { login: string }; name: string };
  try {
    repo = JSON.parse(repoJson);
  } catch {
    throw new GhError('无法解析 gh repo view 返回。');
  }
  const slug = `${repo.owner.login}/${repo.name}`;
  const out = await runGh(
    [
      'api',
      `repos/${slug}/pulls/${prNumber}/comments`,
      '-X', 'POST',
      '-f', `body=${body}`,
      '-f', `commit_id=${commitSha}`,
      '-f', `path=${filePath}`,
      '-F', `line=${line}`,
      '-f', 'side=RIGHT',
    ],
    cwd,
  );
  try {
    const parsed = JSON.parse(out);
    return { id: parsed.id, url: parsed.html_url };
  } catch {
    throw new GhError('PR 评论已发送但响应解析失败。');
  }
}
