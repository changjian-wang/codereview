import type * as vscode from 'vscode';
import type { Finding, GlobalReport } from '../ai/types';

/** Per-file review progress. */
export interface PerFileState {
  /** Line numbers (1-based) that have been scrolled into view. */
  seenLines: number[];
  /** Total reviewable lines, set once the file is opened. */
  totalLines: number;
  /** Whether file-level AI analysis has run. */
  analyzed: boolean;
  /** Findings raised by file-level analysis. */
  findings: Finding[];
  /** Finding ids the reviewer has manually confirmed. */
  confirmedFindings: string[];
}

/** A complete, persistable snapshot of one review. */
export interface ReviewSnapshot {
  repo: string;
  /** Stable id of the review scope (selected files / PR / branch / working tree). */
  scopeId: string;
  /** HEAD SHA this progress is bound to, or "live" when not pinned to a commit. */
  headSha: string;
  activeFile?: string;
  perFile: Record<string, PerFileState>;
  /** Cross-file analysis report, once global analysis has run. */
  globalReport?: GlobalReport;
  globalDone: boolean;
  updatedAt: number;
}

/** Identity of a review snapshot. */
export interface ReviewKey {
  repo: string;
  scopeId: string;
  headSha: string;
}

export function storageKey(k: ReviewKey): string {
  return `codereview:review:${k.repo}#${k.scopeId}@${k.headSha}`;
}

/**
 * Abstraction over where review progress lives. The local implementation uses
 * workspaceState; a future remote implementation can make progress follow the
 * user across machines.
 */
export interface ReviewStore {
  load(key: ReviewKey): Promise<ReviewSnapshot | undefined>;
  save(snapshot: ReviewSnapshot): Promise<void>;
  clear(key: ReviewKey): Promise<void>;
}

/** Local, single-machine store backed by VS Code workspaceState. */
export class WorkspaceStateReviewStore implements ReviewStore {
  constructor(private readonly memento: vscode.Memento) {}

  async load(key: ReviewKey): Promise<ReviewSnapshot | undefined> {
    return this.memento.get<ReviewSnapshot>(storageKey(key));
  }

  async save(snapshot: ReviewSnapshot): Promise<void> {
    await this.memento.update(
      storageKey({ repo: snapshot.repo, scopeId: snapshot.scopeId, headSha: snapshot.headSha }),
      snapshot,
    );
  }

  async clear(key: ReviewKey): Promise<void> {
    await this.memento.update(storageKey(key), undefined);
  }
}
