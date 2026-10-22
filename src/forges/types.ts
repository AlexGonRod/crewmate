export type MergeMethod = 'merge' | 'squash' | 'rebase';

export interface ForgePullRequest {
  url: string;
  state: string;
  merged: boolean;
  number?: number;
  mergeable?: string;
  draft?: boolean;
  /** Head commit of the source branch, when the forge reports it. */
  headSha?: string | null;
}

export interface CreatePullRequestOptions {
  cwd: string;
  base: string;
  head: string;
  title: string;
  body: string;
}

export interface MergePullRequestOptions {
  cwd: string;
  url: string;
  method: MergeMethod;
  deleteBranch?: boolean;
}

export interface Forge {
  readonly id: string;
  assertReady(cwd: string): void;
  createPullRequest(options: CreatePullRequestOptions): { url: string };
  viewPullRequest(cwd: string, url: string): ForgePullRequest;
  mergePullRequest(options: MergePullRequestOptions): ForgePullRequest;
}
