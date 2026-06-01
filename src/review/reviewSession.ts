import * as vscode from 'vscode';
import type { ReviewSet } from '../scope/types';
import type { Finding, GlobalReport } from '../ai/types';
import type { PerFileState, ReviewKey, ReviewSnapshot, ReviewStore } from './reviewStore';

/**
 * Holds the in-memory state of the active review and persists it through a
 * ReviewStore. Emits onDidChange whenever progress changes so UI can refresh.
 */
export class ReviewSession {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  reviewSet?: ReviewSet;
  snapshot?: ReviewSnapshot;

  constructor(
    private readonly store: ReviewStore,
    private readonly repo: string,
  ) {}

  /** Loads or initialises review progress for the given review set. */
  async start(reviewSet: ReviewSet): Promise<void> {
    this.reviewSet = reviewSet;
    const key: ReviewKey = {
      repo: this.repo,
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
        repo: this.repo,
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
    }
    this._onDidChange.fire();
  }

  fileState(path: string): PerFileState | undefined {
    return this.snapshot?.perFile[path];
  }

  /** Coverage for a file: how many of its lines have been seen, out of total. */
  coverage(path: string): { seen: number; total: number } {
    const s = this.fileState(path);
    return { seen: s?.seenLines.length ?? 0, total: s?.totalLines ?? 0 };
  }

  /** Records the file's total line count, the first time it is opened. */
  setTotalLines(path: string, total: number): void {
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

  /** A file is "ready" when fully seen, analyzed, with no unconfirmed findings. */
  fileReady(path: string): boolean {
    const s = this.fileState(path);
    if (!s) {
      return false;
    }
    const fullySeen = s.totalLines > 0 && s.seenLines.length >= s.totalLines;
    return fullySeen && s.analyzed;
  }

  /** Whether every line of the file has been seen (coverage complete). */
  fileFullySeen(path: string): boolean {
    const s = this.fileState(path);
    return !!s && s.totalLines > 0 && s.seenLines.length >= s.totalLines;
  }

  /** Stores file-level analysis results and marks the file analyzed. */
  setFindings(path: string, findings: Finding[]): void {
    const s = this.fileState(path);
    if (!s) {
      return;
    }
    s.findings = findings;
    s.analyzed = true;
    void this.persist();
  }

  findings(path: string): Finding[] {
    return this.fileState(path)?.findings ?? [];
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
    if (this.snapshot) {
      this.snapshot.globalDone = true;
      void this.persist();
    }
  }

  get globalConfirmed(): boolean {
    return !!this.snapshot?.globalDone;
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
      await this.store.save(this.snapshot);
      this._onDidChange.fire();
    }
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}
