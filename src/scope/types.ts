/** A single file in a review set. */
export interface ReviewFile {
  /** Repository-relative path, e.g. "src/foo/bar.ts". */
  path: string;
  /** Added lines, when the scope was defined by a diff. Absent for pure source review. */
  additions?: number;
  /** Deleted lines, when the scope was defined by a diff. */
  deletions?: number;
  status?: 'added' | 'modified' | 'deleted' | 'renamed';
}

/**
 * A reviewable set of source files. The review subject is always the source
 * itself (the whole file's logic); the scope only decides WHICH files are in.
 */
export interface ReviewSet {
  /** Stable id for this scope; part of the persistence key. */
  scopeId: string;
  /** Human label shown in the UI, e.g. "PR #42" or "选定的源码 (3)". */
  label: string;
  /**
   * Commit SHA review progress is bound to, when meaningful. "live" means the
   * scope is not pinned to a commit (e.g. directly-selected source files).
   */
  headSha: string;
  files: ReviewFile[];
}

/**
 * Anything that can define a ReviewSet — a way to scope which source files are
 * under review. A PR / branch comparison / working tree merely *lists* files;
 * a file-system selection picks them directly with no diff at all.
 */
export interface ReviewScope {
  /** Loads the review set, or throws an Error with a user-facing message. */
  load(cwd: string): Promise<ReviewSet>;
}
