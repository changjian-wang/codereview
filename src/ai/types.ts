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

/** Cross-file analysis report shown in the (single) rich webview. */
export interface GlobalReport {
  /** One-paragraph cross-file conclusion. */
  conclusion: string;
  /** Ordered evidence chain backing the conclusion. */
  evidence: string[];
  /** Concrete fix spots, grouped by severity in the UI. */
  fixSpots: GlobalFixSpot[];
}
