import type { ReviewFile } from '../scope/types';

export type { ReviewFile as ChangedFile };

/** Minimal pull-request shape AI Coding Review needs from the GitHub CLI. */
export interface PullRequest {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  baseRefName: string;
  /** HEAD commit SHA — review progress is bound to this. */
  headRefOid: string;
  files: ReviewFile[];
}
