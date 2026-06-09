/** Severity of a review finding, aligned with the prototype's vocabulary. */
export type FindingSeverity = 'bug' | 'conditional' | 'suggestion';

/** A single issue raised by file-level or global analysis. */
export interface Finding {
  /** Stable id within its file, used for confirmation tracking. */
  id: string;
  /** 1-based line where the issue starts. */
  line: number;
  /** 1-based line where the issue ends (defaults to `line`). */
  endLine?: number;
  /**
   * Verbatim source snippet (no line-number prefix) the finding refers to, used
   * to locate the issue by **content** instead of line number — robust against
   * line drift from edits/earlier fixes. Optional; callers fall back to `line`.
   */
  anchor?: string;
  severity: FindingSeverity;
  /** Short headline. */
  title: string;
  /** Full explanation / evidence. */
  detail: string;
  /** Optional concrete fix recommendation. */
  suggestion?: string;
}

/** One fix spot in the global report — a finding tied to a specific file. */
export interface GlobalFixSpot extends Finding {
  /** Repository-relative file path this fix lands in. */
  file: string;
}

/**
 * How a cross-file fact relates to the file-level reading:
 * - `flip`: a file-level assumption was overturned (false positive).
 * - `found`: a real bug only visible across files (file-level missed it).
 * - `confirmed`: global facts confirm the file-level reading stands.
 */
export type VerdictKind = 'flip' | 'found' | 'confirmed';

/** One before→after judgement in the evidence chain. */
export interface GlobalVerdict {
  kind: VerdictKind;
  title: string;
  /** What the file-level reading claimed (the "before"). */
  before: string;
  /** What cross-file facts establish (the "after"). */
  after: string;
  /** Concrete code/file evidence backing the after. */
  evidence?: string;
  /** Repository-relative file the verdict points at, for "locate". */
  file?: string;
  /** 1-based line the verdict points at. */
  line?: number;
}

/** Recommended overall outcome from the global analysis. */
export type GlobalRecommendation = 'approve' | 'request_changes' | 'comment';

/** Cross-file analysis report shown in the (single) rich webview. */
export interface GlobalReport {
  /** One-paragraph cross-file conclusion. */
  conclusion: string;
  /** Recommended outcome that the decision panel headlines. */
  recommendation: GlobalRecommendation;
  /** Ordered evidence chain backing the conclusion. */
  evidence: string[];
  /** Before→after verdicts: confirmed / overturned / newly found. */
  verdicts: GlobalVerdict[];
  /** Concrete fix spots, grouped by severity in the UI. */
  fixSpots: GlobalFixSpot[];
}
