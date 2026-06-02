import type * as vscode from 'vscode';
import type { Finding, GlobalReport } from '../ai/types';

/** A persisted reviewer annotation: a translation, an explanation, or a free-form note. */
export interface Annotation {
  id: string;
  kind: 'translate' | 'explain' | 'note';
  /** 1-based source line range the selection covered; 0 when not anchored. */
  startLine: number;
  endLine: number;
  /** The original text the reviewer selected. */
  sourceText: string;
  /** The translation or note content. */
  content: string;
  createdAt: number;
}

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
  /** Legacy: finding ids the reviewer marked as "read". Migrated to dispositions on load. */
  confirmedFindings: string[];
  /** How each finding has been disposed of: fixed, commented out to a PR, or ignored with a reason. */
  dispositions?: Record<string, FindingDisposition>;
  /** Reviewer translations / notes, persisted with the review. */
  annotations?: Annotation[];
}

/** A reviewer's terminal decision about a single finding. */
export interface FindingDisposition {
  kind: 'fixed' | 'commented' | 'ignored';
  /** Required for `ignored`; optional context for the other kinds. */
  reason?: string;
  /** For `commented`, the PR review-comment id or local target. */
  ref?: string;
  at: number;
}

/** The reviewer's final verdict for a review, persisted once submitted. */
export interface ReviewConclusion {
  /** Machine-readable verdict. */
  verdict: 'approve' | 'request-changes' | 'comment';
  /** Human-readable label shown in the UI. */
  label: string;
  /** Whether the verdict was written back to a PR or only recorded locally. */
  target: 'pr' | 'local';
  /** The PR number, when target is 'pr'. */
  prNumber?: number;
  /** When the conclusion was submitted (epoch ms). */
  submittedAt: number;
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
  /** The reviewer's final verdict, once submitted. */
  conclusion?: ReviewConclusion;
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
