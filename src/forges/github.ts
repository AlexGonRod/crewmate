import {
  assertGhReady,
  createPullRequest,
  mergePullRequest,
  viewPullRequest,
} from '../git/forge';
import type {
  CreatePullRequestOptions,
  Forge,
  ForgePullRequest,
  MergePullRequestOptions,
} from './types';

export class GithubForge implements Forge {
  readonly id = 'github';

  assertReady(cwd: string): void {
    assertGhReady(cwd);
  }

  createPullRequest(options: CreatePullRequestOptions): { url: string } {
    return createPullRequest(options);
  }

  viewPullRequest(cwd: string, url: string): ForgePullRequest {
    return viewPullRequest(cwd, url);
  }

  mergePullRequest(options: MergePullRequestOptions): ForgePullRequest {
    return mergePullRequest(options);
  }
}
