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
  /**
   * Dispositions for global fix spots that could NOT be mapped to a file-level
   * finding (pure cross-file discoveries). Keyed by the fix spot's stable id.
   * Mappable spots reuse the file-level finding's disposition instead.
   */
  globalFixDispositions?: Record<string, FindingDisposition>;
  /** The reviewer's final verdict, once submitted. */
  conclusion?: ReviewConclusion;
  /** Estimated LLM token usage accumulated over this review (approximate). */
  tokenUsage?: TokenAccount;
  updatedAt: number;
}

/**
 * Accumulated, estimated token usage for a review. Totals are approximations
 * (via `countTokens`), NOT the provider's billed counts. `byOp` buckets usage
 * by operation kind so the UI can show a breakdown.
 */
export interface TokenAccount {
  totalInput: number;
  totalOutput: number;
  /** Number of LLM calls counted. */
  calls: number;
  /** Per-operation breakdown, keyed by LlmOp ('analyze' | 'global' | ...). */
  byOp: Record<string, { input: number; output: number; calls: number }>;
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
 * Storage key for a single file's review progress. Deliberately scope- and
 * commit-independent: progress (reading / findings / dispositions / notes)
 * belongs to the FILE, so it follows the file across scope re-selections and
 * commits instead of being orphaned when the scope id changes.
 */
export function fileStorageKey(repo: string, filePath: string): string {
  return `codereview:file:${repo}#${filePath}`;
}

/**
 * Whether a per-file record carries NO progress at all (nothing seen, no
 * findings, no notes, no dispositions). Used both to detect blank records a
 * buggy build may have written (so migration can recover real progress) and as
 * a write guard so a blank can never overwrite a non-blank record.
 */
export function isBlankFileState(s: PerFileState | undefined): boolean {
  if (!s) {
    return true;
  }
  const noSeen = !s.seenLines || s.seenLines.length === 0;
  const noFindings = !s.findings || s.findings.length === 0;
  const noNotes = !s.annotations || s.annotations.length === 0;
  const noDisp = !s.dispositions || Object.keys(s.dispositions).length === 0;
  const noLegacy = !s.confirmedFindings || s.confirmedFindings.length === 0;
  return noSeen && noFindings && noNotes && noDisp && noLegacy;
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
  /**
   * Finds the most recently-updated snapshot for the same repo + scopeId
   * regardless of headSha. Used to migrate a pure-source review whose key
   * stopped being bound to a git SHA, so prior progress isn't orphaned.
   * Returns undefined when the store can't enumerate keys.
   */
  findLatestForScope?(repo: string, scopeId: string): Promise<ReviewSnapshot | undefined>;
  /** Loads a single file's progress (per-file storage), or undefined. */
  loadFile?(repo: string, filePath: string): Promise<PerFileState | undefined>;
  /** Saves a single file's progress (per-file storage). */
  saveFile?(repo: string, filePath: string, state: PerFileState): Promise<void>;
  /**
   * Migration helper: builds a path→PerFileState index from all legacy per-scope
   * snapshots for the repo in a SINGLE pass (most-recently-updated wins). Lets
   * per-file storage adopt pre-split progress without rescanning every snapshot
   * once per file.
   */
  buildLegacyFileIndex?(repo: string): Promise<Map<string, PerFileState>>;
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

  async findLatestForScope(repo: string, scopeId: string): Promise<ReviewSnapshot | undefined> {
    const prefix = `codereview:review:${repo}#${scopeId}@`;
    let best: ReviewSnapshot | undefined;
    for (const key of this.memento.keys()) {
      if (!key.startsWith(prefix)) {
        continue;
      }
      const snap = this.memento.get<ReviewSnapshot>(key);
      if (snap && (!best || (snap.updatedAt ?? 0) > (best.updatedAt ?? 0))) {
        best = snap;
      }
    }
    return best;
  }

  async loadFile(repo: string, filePath: string): Promise<PerFileState | undefined> {
    return this.memento.get<PerFileState>(fileStorageKey(repo, filePath));
  }

  async saveFile(repo: string, filePath: string, state: PerFileState): Promise<void> {
    // Defensive: never let a BLANK record overwrite an existing one that carries
    // real progress. A buggy migration/persist once wiped files this way; this
    // guard makes that class of data loss impossible going forward.
    if (isBlankFileState(state)) {
      const existing = this.memento.get<PerFileState>(fileStorageKey(repo, filePath));
      if (existing && !isBlankFileState(existing)) {
        return;
      }
    }
    await this.memento.update(fileStorageKey(repo, filePath), state);
  }

  async buildLegacyFileIndex(repo: string): Promise<Map<string, PerFileState>> {
    // ONE pass over the legacy per-scope snapshots, building a path→state map
    // (most-recently-updated snapshot wins per file). This replaces a per-file
    // scan that deserialized every large snapshot N times and made startup
    // O(files × keys × snapshotSize).
    const prefix = `codereview:review:${repo}#`;
    const index = new Map<string, PerFileState>();
    const at = new Map<string, number>();
    for (const key of this.memento.keys()) {
      if (!key.startsWith(prefix)) {
        continue;
      }
      const snap = this.memento.get<ReviewSnapshot>(key);
      if (!snap?.perFile) {
        continue;
      }
      const updated = snap.updatedAt ?? 0;
      for (const [filePath, state] of Object.entries(snap.perFile)) {
        if (!index.has(filePath) || updated > (at.get(filePath) ?? 0)) {
          index.set(filePath, state);
          at.set(filePath, updated);
        }
      }
    }
    return index;
  }
}
