import { spawnSync } from 'node:child_process';
import { CrewError } from '../core/errors';
import type {
  CreatePullRequestOptions,
  Forge,
  ForgePullRequest,
  MergePullRequestOptions,
} from './types';

function glab(
  args: string[],
  cwd: string,
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync('glab', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GLAB_PAGER: 'cat', GIT_PAGER: 'cat' },
  });
  if (result.error) {
    throw new CrewError('GLAB_NOT_FOUND', `Could not run glab: ${result.error.message}`);
  }
  return {
    status: result.status ?? 1,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
  };
}

function parseMergeRequest(raw: string): ForgePullRequest | null {
  if (!raw) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }
  const item = parsed as Record<string, unknown>;
  const url =
    typeof item.web_url === 'string'
      ? item.web_url
      : typeof item.url === 'string'
        ? item.url
        : '';
  if (!url) {
    return null;
  }
  const rawState = typeof item.state === 'string' ? item.state.toUpperCase() : 'UNKNOWN';
  const merged =
    rawState === 'MERGED' ||
    (typeof item.merged_at === 'string' && item.merged_at.length > 0) ||
    (typeof item.mergedAt === 'string' && item.mergedAt.length > 0);
  const mergeStatus =
    typeof item.merge_status === 'string'
      ? item.merge_status
      : typeof item.detailed_merge_status === 'string'
        ? item.detailed_merge_status
        : undefined;
  const mergeable =
    mergeStatus === undefined
      ? undefined
      : mergeStatus === 'can_be_merged' || mergeStatus === 'mergeable'
        ? 'MERGEABLE'
        : mergeStatus === 'cannot_be_merged' || mergeStatus === 'conflicts'
          ? 'CONFLICTING'
          : mergeStatus;
  return {
    url,
    state: merged ? 'MERGED' : rawState === 'OPENED' ? 'OPEN' : rawState,
    merged,
    number: typeof item.iid === 'number' ? item.iid : undefined,
    mergeable,
    draft: item.draft === true || item.work_in_progress === true,
    headSha: typeof item.sha === 'string' && item.sha.length > 0 ? item.sha : null,
  };
}

export class GitlabForge implements Forge {
  readonly id = 'gitlab';

  assertReady(cwd: string): void {
    const result = glab(['auth', 'status'], cwd);
    if (result.status !== 0) {
      throw new CrewError(
        'GLAB_NOT_AUTHENTICATED',
        `GitLab CLI is not authenticated: ${result.stderr || result.stdout || 'glab auth status failed'}`,
      );
    }
  }

  createPullRequest(options: CreatePullRequestOptions): { url: string } {
    const result = glab(
      [
        'mr',
        'create',
        '--source-branch',
        options.head,
        '--target-branch',
        options.base,
        '--title',
        options.title,
        '--description',
        options.body,
        '--yes',
      ],
      options.cwd,
    );
    if (result.status !== 0) {
      throw new CrewError(
        'GLAB_MR_CREATE_FAILED',
        `glab mr create failed: ${result.stderr || result.stdout}`,
      );
    }
    const url =
      result.stdout
        .split(/\s+/)
        .find((token) => token.startsWith('http')) ?? '';
    if (!url) {
      throw new CrewError(
        'GLAB_MR_CREATE_FAILED',
        `glab mr create returned no URL: ${result.stdout}`,
      );
    }
    return { url };
  }

  viewPullRequest(cwd: string, url: string): ForgePullRequest {
    const result = glab(['mr', 'view', url, '--output', 'json'], cwd);
    if (result.status !== 0) {
      throw new CrewError(
        'GLAB_MR_VIEW_FAILED',
        `glab mr view failed: ${result.stderr || result.stdout}`,
      );
    }
    const parsed = parseMergeRequest(result.stdout);
    if (!parsed) {
      throw new CrewError(
        'GLAB_MR_VIEW_FAILED',
        `Could not parse glab mr view output: ${result.stdout}`,
      );
    }
    return parsed;
  }

  mergePullRequest(options: MergePullRequestOptions): ForgePullRequest {
    const before = this.viewPullRequest(options.cwd, options.url);
    if (before.merged) {
      return before;
    }
    if (before.state !== 'OPEN') {
      throw new CrewError(
        'PR_NOT_OPEN',
        `Merge request ${options.url} is ${before.state}`,
      );
    }
    if (before.draft) {
      throw new CrewError(
        'PR_IS_DRAFT',
        `Merge request ${options.url} is still a draft`,
      );
    }
    if (before.mergeable && before.mergeable !== 'MERGEABLE' && before.mergeable !== 'UNKNOWN') {
      throw new CrewError(
        'PR_NOT_MERGEABLE',
        `Merge request ${options.url} is not mergeable (${before.mergeable})`,
      );
    }

    const args = ['mr', 'merge', options.url, '--yes'];
    if (options.method === 'squash') {
      args.push('--squash');
    }
    if (options.deleteBranch) {
      args.push('--remove-source-branch');
    }
    const result = glab(args, options.cwd);
    if (result.status !== 0) {
      throw new CrewError(
        'PR_MERGE_FAILED',
        `glab mr merge failed: ${result.stderr || result.stdout || `glab exited with ${result.status}`}`,
      );
    }
    const after = this.viewPullRequest(options.cwd, options.url);
    if (!after.merged) {
      throw new CrewError(
        'PR_MERGE_FAILED',
        `glab mr merge did not merge the merge request: ${options.url}`,
      );
    }
    return after;
  }
}
