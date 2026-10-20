import { spawnSync } from 'node:child_process';
import { CrewError } from '../core/errors';
import type { MergeMethod } from '../core/types';

export interface PullRequestInfo {
  url: string;
  state: string;
  merged: boolean;
  number?: number;
  mergeable?: string;
  draft?: boolean;
}

function gh(args: string[], cwd: string): { status: number; stdout: string; stderr: string } {
  const result = spawnSync('gh', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GH_PROMPT_DISABLED: '1' },
  });
  if (result.error) {
    throw new CrewError('GH_NOT_FOUND', `Could not run gh: ${result.error.message}`);
  }
  return {
    status: result.status ?? 1,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
  };
}

export function assertGhReady(cwd: string): void {
  const result = gh(['auth', 'status'], cwd);
  if (result.status !== 0) {
    throw new CrewError(
      'GH_NOT_AUTHENTICATED',
      `GitHub CLI is not authenticated: ${result.stderr || result.stdout || 'gh auth status failed'}`,
    );
  }
}

function parsePullRequest(raw: string): PullRequestInfo | null {
  if (!raw) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const record = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!record || typeof record !== 'object') {
    return null;
  }
  const item = record as Record<string, unknown>;
  if (typeof item.url !== 'string') {
    return null;
  }
  return {
    url: item.url,
    state: typeof item.state === 'string' ? item.state : 'UNKNOWN',
    merged:
      typeof item.mergedAt === 'string' && item.mergedAt.length > 0
        ? true
        : item.state === 'MERGED',
    number: typeof item.number === 'number' ? item.number : undefined,
    mergeable:
      typeof item.mergeable === 'string' ? item.mergeable : undefined,
    draft: item.isDraft === true,
  };
}

export function findPullRequest(cwd: string, branch: string): PullRequestInfo | null {
  const result = gh(
    [
      'pr',
      'list',
      '--head',
      branch,
      '--state',
      'all',
      '--limit',
      '1',
      '--json',
      'url,state,mergedAt,number',
    ],
    cwd,
  );
  if (result.status !== 0) {
    throw new CrewError(
      'GH_PR_LIST_FAILED',
      `gh pr list failed: ${result.stderr || result.stdout}`,
    );
  }
  return parsePullRequest(result.stdout);
}

export function createPullRequest(options: {
  cwd: string;
  base: string;
  head: string;
  title: string;
  body: string;
}): PullRequestInfo {
  const existing = findPullRequest(options.cwd, options.head);
  if (existing) {
    return existing;
  }
  const result = gh(
    [
      'pr',
      'create',
      '--base',
      options.base,
      '--head',
      options.head,
      '--title',
      options.title,
      '--body',
      options.body,
    ],
    options.cwd,
  );
  if (result.status !== 0) {
    throw new CrewError(
      'GH_PR_CREATE_FAILED',
      `gh pr create failed: ${result.stderr || result.stdout}`,
    );
  }
  const url = result.stdout.split(/\s+/).find((token) => token.startsWith('http')) ?? '';
  if (!url) {
    throw new CrewError('GH_PR_CREATE_FAILED', `gh pr create returned no URL: ${result.stdout}`);
  }
  return findPullRequest(options.cwd, options.head) ?? { url, state: 'OPEN', merged: false };
}

export function viewPullRequest(cwd: string, url: string): PullRequestInfo {
  const result = gh(
    [
      'pr',
      'view',
      url,
      '--json',
      'url,state,mergedAt,number,mergeable,isDraft',
    ],
    cwd,
  );
  if (result.status !== 0) {
    throw new CrewError(
      'GH_PR_VIEW_FAILED',
      `gh pr view failed: ${result.stderr || result.stdout}`,
    );
  }
  const parsed = parsePullRequest(result.stdout);
  if (!parsed) {
    throw new CrewError('GH_PR_VIEW_FAILED', `Could not parse gh pr view output: ${result.stdout}`);
  }
  return parsed;
}

export function mergePullRequest(options: {
  cwd: string;
  url: string;
  method: MergeMethod;
  deleteBranch?: boolean;
}): PullRequestInfo {
  const before = viewPullRequest(options.cwd, options.url);
  if (before.merged) {
    return before;
  }
  if (before.state !== 'OPEN') {
    throw new CrewError(
      'PR_NOT_OPEN',
      `Pull request ${options.url} is ${before.state}`,
    );
  }
  if (before.draft) {
    throw new CrewError(
      'PR_IS_DRAFT',
      `Pull request ${options.url} is still a draft`,
    );
  }
  if (
    before.mergeable &&
    before.mergeable !== 'MERGEABLE' &&
    before.mergeable !== 'UNKNOWN'
  ) {
    throw new CrewError(
      'PR_NOT_MERGEABLE',
      `Pull request ${options.url} is not mergeable (${before.mergeable})`,
    );
  }

  const args = ['pr', 'merge', options.url, `--${options.method}`];
  if (options.deleteBranch) {
    args.push('--delete-branch');
  }
  const result = gh(args, options.cwd);
  let after: PullRequestInfo;
  try {
    after = viewPullRequest(options.cwd, options.url);
  } catch (error) {
    if (result.status !== 0) {
      throw new CrewError(
        'PR_MERGE_FAILED',
        `gh pr merge failed: ${
          result.stderr || result.stdout || `gh exited with ${result.status}`
        }`,
      );
    }
    throw error;
  }
  if (!after.merged) {
    throw new CrewError(
      'PR_MERGE_FAILED',
      `gh pr merge did not merge the pull request: ${
        result.stderr || result.stdout || `gh exited with ${result.status}`
      }`,
    );
  }
  return after;
}
