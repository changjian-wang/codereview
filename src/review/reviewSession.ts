import * as vscode from 'vscode';
import * as path from 'node:path';
import { m } from '../i18n';
import type { ReviewSet } from '../scope/types';
import type { Finding, GlobalReport } from '../ai/types';
import type { TokenUsage } from '../ai/analyzer';
import type { PerFileState, ReviewKey, ReviewSnapshot, ReviewStore, Annotation, ReviewConclusion, FindingDisposition, TokenAccount } from './reviewStore';

/**
 * Holds the in-memory state of the active review and persists it through a
 * ReviewStore. Emits onDidChange whenever progress changes so UI can refresh.
 */
export class ReviewSession {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  reviewSet?: ReviewSet;
  snapshot?: ReviewSnapshot;
  /** Workspace folder picked for this review (set by start()). */
  private cwd?: string;
  /** Repo name override for the active review (typically basename of cwd). */
  private repoName?: string;

  constructor(
    private readonly store: ReviewStore,
    private readonly defaultRepo: string,
  ) {}

  /**
   * Returns the working directory for the active review (the picked workspace
   * folder). Falls back to the first workspace folder when no review is active.
   */
  getCwd(): string | undefined {
    return this.cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  /** Returns the repo name used as the storage key prefix for the active review. */
  getRepoName(): string {
    return this.repoName ?? this.defaultRepo;
  }

  /** Loads or initialises review progress for the given review set. */
  async start(reviewSet: ReviewSet, cwd?: string): Promise<void> {
    this.reviewSet = reviewSet;
    this.cwd = cwd;
    this.repoName = cwd ? path.basename(cwd) : this.defaultRepo;
    const key: ReviewKey = {
      repo: this.repoName,
      scopeId: reviewSet.scopeId,
      headSha: reviewSet.headSha,
    };
    let snapshot = await this.store.load(key);

    if (!snapshot) {
      const perFile: Record<string, PerFileState> = {};
      for (const f of reviewSet.files) {
        perFile[f.path] = {
          seenLines: [],
          totalLines: 0,
          analyzed: false,
          findings: [],
          confirmedFindings: [],
        };
      }
      snapshot = {
        repo: this.repoName,
        scopeId: reviewSet.scopeId,
        headSha: reviewSet.headSha,
        perFile,
        globalDone: false,
        updatedAt: Date.now(),
      };
      await this.store.save(snapshot);
    }

    this.snapshot = snapshot;
    // Normalise older snapshots that predate fields added in later slices.
    for (const f of reviewSet.files) {
      const s = this.snapshot.perFile[f.path];
      if (s && !Array.isArray(s.findings)) {
        s.findings = [];
      }
      if (s && !Array.isArray(s.annotations)) {
        s.annotations = [];
      }
      if (s && !s.dispositions) {
        s.dispositions = {};
      }
      // Migrate legacy "confirmed read" marks to the new commented disposition.
      if (s?.confirmedFindings?.length) {
        for (const id of s.confirmedFindings) {
          if (!s.dispositions![id]) {
            s.dispositions![id] = { kind: 'commented', at: Date.now() };
          }
        }
        s.confirmedFindings = [];
      }
    }
    this._onDidChange.fire();
  }

  fileState(path: string): PerFileState | undefined {
    return this.snapshot?.perFile[path];
  }

  private isDeletedFile(path: string): boolean {
    return this.reviewSet?.files.find((f) => f.path === path)?.status === 'deleted';
  }

  /**
   * Resolves a file-scheme document/URI to its review-set relative path, or
   * undefined if the file is not part of the active review set. This is the
   * single source of truth for "is this document under review, and as what path".
   */
  relPathInSet(uri: vscode.Uri): string | undefined {
    if (uri.scheme !== 'file' || !this.reviewSet) {
      return undefined;
    }
    // Prefer the session's chosen cwd, then the URI's workspace folder, then
    // the first workspace folder. Multi-root workspaces can have several roots
    // and the review may belong to any of them.
    const root =
      this.cwd
      ?? vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath
      ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      return undefined;
    }
    const rel = path.relative(root, uri.fsPath).split(path.sep).join('/');
    if (!rel || rel.startsWith('..')) {
      return undefined;
    }
    return this.reviewSet.files.some((f) => f.path === rel) ? rel : undefined;
  }

  /** Coverage for a file: how many of its lines have been seen, out of total. */
  coverage(path: string): { seen: number; total: number } {
    if (this.isDeletedFile(path)) {
      return { seen: 0, total: 0 };
    }
    const s = this.fileState(path);
    return { seen: s?.seenLines.length ?? 0, total: s?.totalLines ?? 0 };
  }

  /** Records the file's total line count, the first time it is opened. */
  setTotalLines(path: string, total: number): void {
    if (this.isDeletedFile(path)) {
      return;
    }
    const s = this.fileState(path);
    if (s && s.totalLines !== total) {
      s.totalLines = total;
      void this.persist();
    }
  }

  /**
   * Marks the given 1-based line numbers as seen. Returns true if anything
   * changed (so callers can avoid redundant persistence / redraws).
   */
  markSeen(path: string, lines: Iterable<number>): boolean {
    if (this.isDeletedFile(path)) {
      return false;
    }
    const s = this.fileState(path);
    if (!s) {
      return false;
    }
    const set = new Set(s.seenLines);
    const before = set.size;
    for (const line of lines) {
      if (line >= 1 && (s.totalLines === 0 || line <= s.totalLines)) {
        set.add(line);
      }
    }
    if (set.size === before) {
      return false;
    }
    s.seenLines = [...set].sort((a, b) => a - b);
    void this.persist();
    return true;
  }

  /** A file is "ready" when it has been analyzed and every finding has a disposition. */
  fileReady(path: string): boolean {
    if (this.isDeletedFile(path)) {
      return true;
    }
    const s = this.fileState(path);
    if (!s || !s.analyzed) {
      return false;
    }
    const dispositions = s.dispositions ?? {};
    return s.findings.every((f) => !!dispositions[f.id]);
  }

  /** Whether every line of the file has been seen (coverage complete). */
  fileFullySeen(path: string): boolean {
    if (this.isDeletedFile(path)) {
      return true;
    }
    const s = this.fileState(path);
    return !!s && s.totalLines > 0 && s.seenLines.length >= s.totalLines;
  }

  /** Stores file-level analysis results and marks the file analyzed. */
  setFindings(path: string, findings: Finding[]): void {
    const s = this.fileState(path);
    if (!s) {
      return;
    }
    // Finding ids are positional (`f0`, `f1`, …) and therefore NOT stable across
    // re-analysis. Re-keying dispositions by id would resurrect already-handled
    // findings as fresh, unconfirmed ones. Instead, carry each prior disposition
    // forward by matching the new finding to the old one by content signature.
    const prev = s.dispositions ?? {};
    const sigToDisp = new Map<string, FindingDisposition>();
    for (const old of s.findings) {
      const d = prev[old.id];
      if (d) {
        sigToDisp.set(findingSignature(old), d);
      }
    }
    const next: Record<string, FindingDisposition> = {};
    for (const f of findings) {
      const d = sigToDisp.get(findingSignature(f));
      if (d) {
        next[f.id] = d;
      }
    }
    s.findings = findings;
    s.analyzed = true;
    s.dispositions = next;
    s.confirmedFindings = [];
    void this.persist();
  }

  findings(path: string): Finding[] {
    return this.fileState(path)?.findings ?? [];
  }

  /** Disposition of a single finding, if the reviewer has acted on it. */
  findingDisposition(path: string, findingId: string): FindingDisposition | undefined {
    return this.fileState(path)?.dispositions?.[findingId];
  }

  /** Records the reviewer's disposition for a finding. Returns true if changed. */
  setFindingDisposition(path: string, findingId: string, disposition: FindingDisposition | null): boolean {
    const s = this.fileState(path);
    if (!s) {
      return false;
    }
    s.dispositions ??= {};
    if (disposition === null) {
      if (!(findingId in s.dispositions)) {
        return false;
      }
      delete s.dispositions[findingId];
    } else {
      s.dispositions[findingId] = { ...disposition, at: disposition.at || Date.now() };
    }
    void this.persist();
    return true;
  }

  /** Count of findings that still have no disposition. */
  unconfirmedCount(path: string): number {
    if (this.isDeletedFile(path)) {
      return 0;
    }
    const s = this.fileState(path);
    if (!s) {
      return 0;
    }
    const dispositions = s.dispositions ?? {};
    return s.findings.filter((f) => !dispositions[f.id]).length;
  }

  /** Reviewer translations / notes attached to a file. */
  annotations(path: string): Annotation[] {
    return this.fileState(path)?.annotations ?? [];
  }

  /** Adds a translation / note to a file and persists it. */
  addAnnotation(path: string, annotation: Annotation): void {
    const s = this.fileState(path);
    if (!s) {
      return;
    }
    (s.annotations ??= []).push(annotation);
    void this.persist();
  }

  /** Removes an annotation by id. */
  removeAnnotation(path: string, id: string): void {
    const s = this.fileState(path);
    if (!s?.annotations) {
      return;
    }
    const next = s.annotations.filter((a) => a.id !== id);
    if (next.length !== s.annotations.length) {
      s.annotations = next;
      void this.persist();
    }
  }

  /** Stores the cross-file global report (reviewer must still confirm it). */
  setGlobalReport(report: GlobalReport): void {
    if (this.snapshot) {
      this.snapshot.globalReport = report;
      void this.persist();
    }
  }

  get globalReport(): GlobalReport | undefined {
    return this.snapshot?.globalReport;
  }

  /** Reviewer confirms they have read the global conclusion. */
  confirmGlobal(): void {
    if (this.snapshot?.globalReport) {
      this.snapshot.globalDone = true;
      void this.persist();
    }
  }

  get globalConfirmed(): boolean {
    return !!this.snapshot?.globalDone;
  }

  /** Records the reviewer's final verdict so it survives reloads. */
  setConclusion(conclusion: ReviewConclusion): void {
    if (this.snapshot) {
      this.snapshot.conclusion = conclusion;
      void this.persist();
    }
  }

  get conclusion(): ReviewConclusion | undefined {
    return this.snapshot?.conclusion;
  }

  /**
   * Accumulates one LLM call's estimated token usage onto the review snapshot,
   * bucketed by operation. Totals are approximate (countTokens-based), not the
   * provider's billed counts. Persisted so usage survives reloads.
   */
  recordTokenUsage(usage: TokenUsage): void {
    if (!this.snapshot) {
      return;
    }
    const acct = this.snapshot.tokenUsage ?? {
      totalInput: 0,
      totalOutput: 0,
      calls: 0,
      byOp: {},
    };
    acct.totalInput += usage.input;
    acct.totalOutput += usage.output;
    acct.calls += 1;
    const bucket = acct.byOp[usage.op] ?? { input: 0, output: 0, calls: 0 };
    bucket.input += usage.input;
    bucket.output += usage.output;
    bucket.calls += 1;
    acct.byOp[usage.op] = bucket;
    this.snapshot.tokenUsage = acct;
    void this.persist();
  }

  /** Estimated token usage accumulated over this review, if any. */
  get tokenUsage(): TokenAccount | undefined {
    return this.snapshot?.tokenUsage;
  }

  allFilesReady(): boolean {
    return !!this.reviewSet && this.reviewSet.files.every((f) => this.fileReady(f.path));
  }

  /** Overall coverage across all files in the review set, as seen/total lines. */
  totalCoverage(): { seen: number; total: number; filesReady: number; filesTotal: number } {
    let seen = 0;
    let total = 0;
    let filesReady = 0;
    const files = this.reviewSet?.files ?? [];
    for (const f of files) {
      const c = this.coverage(f.path);
      seen += Math.min(c.seen, c.total || c.seen);
      total += c.total;
      if (this.fileReady(f.path)) {
        filesReady++;
      }
    }
    return { seen, total, filesReady, filesTotal: files.length };
  }

  /** Gate passes only when every file is ready and global analysis is confirmed. */
  gatePassed(): boolean {
    return this.allFilesReady() && !!this.snapshot?.globalDone;
  }

  async persist(): Promise<void> {
    if (this.snapshot) {
      this.snapshot.updatedAt = Date.now();
      try {
        await this.store.save(this.snapshot);
      } catch (err) {
        const message = String((err as Error)?.message ?? err);
        void vscode.window.showWarningMessage(m().review.saveFailed(message));
        return;
      }
      this._onDidChange.fire();
    }
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}

/**
 * Content-based identity for a finding, used to carry dispositions across
 * re-analysis (where positional ids change). Prefers the verbatim source
 * `anchor` (stable while the offending code is unchanged); falls back to the
 * detail text. Combined with severity + title to avoid collisions.
 */
function findingSignature(f: Finding): string {
  const body = (f.anchor ?? f.detail ?? '').trim();
  return `${f.severity}\u0000${f.title.trim()}\u0000${body}`;
}
