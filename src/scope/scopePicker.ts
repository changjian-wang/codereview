import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as vscode from 'vscode';
import { FileSystemScope, PrScope } from './scopes';
import { pickScopeTree } from './scopePickerPanel';
import type { ReviewScope } from './types';
import { m } from '../i18n';
import { transientWarning } from '../ui/toast';

/** Result of {@link pickScope}: the chosen scope plus the workspace-folder cwd it should run against. */
export interface PickedScope {
  scope: ReviewScope;
  /**
   * Workspace folder that should act as the working directory for git / gh
   * operations during this review. In a multi-root workspace this is the root
   * that **contains** the picked path, not necessarily the first root.
   */
  cwd: string;
}

/** Lets the user choose how the set of source files under review is scoped. */
export async function pickScope(
  defaultCwd: string,
  viewColumn?: vscode.ViewColumn,
): Promise<PickedScope | undefined> {
  type Item = vscode.QuickPickItem & { build: () => Promise<PickedScope | undefined> };
  const items: Item[] = [
    {
      label: m().scope.pickFilesLabel,
      description: m().scope.pickFilesDescription,
      detail: m().scope.pickFilesDetail,
      build: buildFileSystemScope,
    },
    {
      label: m().scope.pickPrLabel,
      description: 'gh pr view',
      detail: m().scope.pickPrDetail,
      build: async () => ({ scope: new PrScope(), cwd: defaultCwd }),
    },
  ];

  const choice = await vscode.window.showQuickPick(items, {
    title: m().scope.pickTitle,
    placeHolder: m().scope.pickPlaceholder,
  });
  return choice?.build();

  async function buildFileSystemScope(): Promise<PickedScope | undefined> {
    // Scan the whole project root once, then let the reviewer narrow down via a
    // webview tree that is *locked* to this root. Because the tree is built only
    // from paths under `defaultCwd`, nothing outside the project can be picked —
    // unlike the native open dialog, which can wander out of the root and then
    // fail with an error that is invisible when the workbench is full-screen.
    const relPaths = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: m().scope.scanning },
      () => expandToRelPaths([vscode.Uri.file(defaultCwd)], defaultCwd),
    );
    if (relPaths.length === 0) {
      transientWarning(m().scope.noFiles);
      return undefined;
    }
    const picked = await pickScopeTree({
      rootLabel: path.basename(defaultCwd) || defaultCwd,
      relPaths,
      viewColumn,
    });
    if (!picked || picked.length === 0) {
      return undefined;
    }
    return { scope: new FileSystemScope(picked), cwd: defaultCwd };
  }
}

/** Expands selected files/folders into a de-duplicated, sorted list of relative file paths. */
async function expandToRelPaths(uris: vscode.Uri[], cwd: string): Promise<string[]> {
  const out = new Set<string>();
  // Walk each picked entry concurrently. For folders this fans out to
  // walkDir's internal Promise.all so big trees finish much faster than the
  // old sequential vscode.workspace.fs.stat-based walk.
  await Promise.all(uris.map((u) => collect(u.fsPath, out, cwd)));
  return [...out].sort();
}

/**
 * Fast recursive walk via `node:fs/promises`. Uses `withFileTypes` (single
 * syscall returns name + type), fans out subdirectory walks in parallel, and
 * aggressively skips well-known build / vendor dirs and obvious non-source
 * files. Errors on individual entries are swallowed so a single unreadable
 * file or symlink can't abort the whole scan.
 */
async function collect(absPath: string, out: Set<string>, cwd: string): Promise<void> {
  let stat: import('node:fs').Stats;
  try {
    stat = await fs.lstat(absPath);
  } catch {
    return;
  }
  if (stat.isSymbolicLink()) {
    // Don't follow symlinks — cheap protection against cycles and surprise
    // out-of-tree paths (e.g. pnpm's symlink farm).
    return;
  }
  if (stat.isDirectory()) {
    await walkDir(absPath, out, cwd);
    return;
  }
  if (stat.isFile() && isReviewableFile(absPath, stat.size)) {
    addRel(absPath, cwd, out);
  }
}

async function walkDir(dir: string, out: Set<string>, cwd: string): Promise<void> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const subdirs: string[] = [];
  const filePromises: Promise<void>[] = [];
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    const child = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) {
        // Hidden directories (.git, .vscode, .next, .nuxt, .idea, .gradle, …)
        // are virtually never review targets. Skipping by prefix catches new
        // tools without us having to maintain a list.
        continue;
      }
      subdirs.push(child);
    } else if (e.isFile()) {
      // Cheap-path: filter by extension first to avoid even calling stat.
      if (!isReviewableExt(e.name)) continue;
      filePromises.push(
        fs.stat(child).then(
          (s) => {
            if (s.size <= MAX_FILE_BYTES) {
              addRel(child, cwd, out);
            }
          },
          () => {/* ignore */},
        ),
      );
    }
  }
  await Promise.all([
    ...filePromises,
    ...subdirs.map((d) => walkDir(d, out, cwd)),
  ]);
}

function addRel(absPath: string, cwd: string, out: Set<string>): void {
  const rel = path.relative(cwd, absPath).split(path.sep).join('/');
  if (rel && !rel.startsWith('..')) {
    out.add(rel);
  }
}

function isReviewableFile(absPath: string, size: number): boolean {
  return size <= MAX_FILE_BYTES && isReviewableExt(path.basename(absPath));
}

function isReviewableExt(name: string): boolean {
  // Reject lock files & minified bundles early — they bloat the tree and
  // nobody reviews them.
  if (SKIP_FILES.has(name)) return false;
  if (name.endsWith('.min.js') || name.endsWith('.min.css') || name.endsWith('.map')) return false;
  const dotAt = name.lastIndexOf('.');
  if (dotAt < 0) {
    // No extension: typical README, Makefile, Dockerfile etc. — keep if name
    // is in the allow list, otherwise skip.
    return EXTENSIONLESS_ALLOW.has(name);
  }
  const ext = name.slice(dotAt + 1).toLowerCase();
  return !SKIP_EXTS.has(ext);
}

const MAX_FILE_BYTES = 1_000_000; // 1 MB: anything bigger is almost never reviewable source.

/** Directories that are virtually never review targets. */
const SKIP_DIRS = new Set([
  'node_modules', 'bower_components', 'vendor', 'Pods',
  'dist', 'out', 'build', 'target', 'bin', 'obj',
  '__pycache__', 'venv', 'env',
  'coverage', '.nyc_output',
]);

/** Specific files to drop on sight. */
const SKIP_FILES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'pnpm-lock.yml',
  'composer.lock', 'Gemfile.lock', 'poetry.lock', 'Cargo.lock',
  '.DS_Store', 'Thumbs.db',
]);

/** Binary / non-source extensions — skip these even if they slipped through. */
const SKIP_EXTS = new Set([
  // images
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg', 'tif', 'tiff',
  // archives
  'zip', 'tar', 'gz', 'tgz', 'bz2', '7z', 'rar', 'xz',
  // binaries
  'exe', 'dll', 'so', 'dylib', 'a', 'lib', 'class', 'jar', 'war', 'pdb',
  // media
  'mp3', 'mp4', 'mov', 'avi', 'mkv', 'flac', 'wav', 'ogg',
  // documents
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  // fonts
  'ttf', 'otf', 'woff', 'woff2', 'eot',
  // misc
  'wasm', 'snap',
]);

/** Files without an extension we still want to review. */
const EXTENSIONLESS_ALLOW = new Set([
  'Dockerfile', 'Makefile', 'Rakefile', 'Gemfile', 'Procfile', 'Jenkinsfile',
  'README', 'LICENSE', 'NOTICE', 'CHANGELOG', 'CONTRIBUTING', 'AUTHORS',
]);

/**
 * Builds a {@link FileSystemScope} covering every reviewable file under `cwd`
 * (skipping the same `SKIP_DIRS` as the interactive picker). Returns
 * `undefined` if the folder has no reviewable files.
 */
export async function buildFolderScope(cwd: string): Promise<PickedScope | undefined> {
  const rels = await expandToRelPaths([vscode.Uri.file(cwd)], cwd);
  if (rels.length === 0) {
    return undefined;
  }
  return { scope: new FileSystemScope(rels), cwd };
}
