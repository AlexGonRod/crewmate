import { spawnSync } from 'node:child_process';
import { CrewError } from '../core/errors';
import type { CiCheck, CiResult } from '../core/types';

export const DEFAULT_CI_TIMEOUT_SECONDS = 900;
export const DEFAULT_CI_INTERVAL_SECONDS = 10;

const FAILED_BUCKETS = new Set(['fail', 'cancel']);
const PENDING_BUCKETS = new Set(['pending']);
const PASSED_BUCKETS = new Set(['pass', 'skipping']);

const FAILED_STATES = new Set([
  'FAILURE',
  'CANCELLED',
  'CANCELED',
  'TIMED_OUT',
  'ACTION_REQUIRED',
  'STARTUP_FAILURE',
  'ERROR',
]);
const PENDING_STATES = new Set([
  'PENDING',
  'QUEUED',
  'IN_PROGRESS',
  'WAITING',
  'REQUESTED',
  'EXPECTED',
]);
const PASSED_STATES = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);

export interface CiGateOptions {
  cwd: string;
  prUrl: string;
  commitSha: string;
  timeoutSeconds?: number;
  intervalSeconds?: number;
}

export interface CiEvaluation {
  state: 'passed' | 'failed' | 'pending';
  summary: string;
}

function gh(args: string[], cwd: string): {
  status: number;
  stdout: string;
  stderr: string;
  error?: Error;
} {
  const result = spawnSync('gh', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GH_PROMPT_DISABLED: '1' },
  });
  return {
    status: result.status ?? 1,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
    error: result.error,
  };
}

function githubRepository(prUrl: string): string {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\//.exec(prUrl);
  if (!match) {
    throw new CrewError(
      'GH_PR_URL_INVALID',
      `Could not determine GitHub repository from ${prUrl}`,
    );
  }
  return `${match[1]}/${match[2]}`;
}

function checkBucket(status: string, conclusion: string): string {
  if (status.toLowerCase() !== 'completed') {
    return 'pending';
  }
  if (['success', 'neutral', 'skipped'].includes(conclusion.toLowerCase())) {
    return 'pass';
  }
  if (
    [
      'failure',
      'cancelled',
      'canceled',
      'timed_out',
      'action_required',
      'startup_failure',
    ].includes(conclusion.toLowerCase())
  ) {
    return 'fail';
  }
  return '';
}

function bucketFor(check: CiCheck): 'failed' | 'pending' | 'passed' | 'unknown' {
  const bucket = check.bucket.trim().toLowerCase();
  if (FAILED_BUCKETS.has(bucket)) return 'failed';
  if (PENDING_BUCKETS.has(bucket)) return 'pending';
  if (PASSED_BUCKETS.has(bucket)) return 'passed';

  const state = check.state.trim().toUpperCase();
  if (FAILED_STATES.has(state)) return 'failed';
  if (PENDING_STATES.has(state)) return 'pending';
  if (PASSED_STATES.has(state)) return 'passed';
  return 'unknown';
}

export function evaluateCiChecks(checks: CiCheck[]): CiEvaluation {
  if (checks.length === 0) {
    return { state: 'pending', summary: 'No CI checks reported yet' };
  }

  const failed = checks.filter((check) => bucketFor(check) === 'failed');
  const pending = checks.filter((check) => bucketFor(check) === 'pending');
  const passed = checks.filter((check) => bucketFor(check) === 'passed');
  const unknown = checks.filter((check) => bucketFor(check) === 'unknown');

  if (failed.length > 0 || unknown.length > 0) {
    const names = [...failed, ...unknown]
      .map((check) => `${check.name} (${check.state || check.bucket || 'unknown'})`)
      .join(', ');
    return {
      state: 'failed',
      summary: `${failed.length + unknown.length} of ${checks.length} CI checks failed: ${names}`,
    };
  }
  if (pending.length > 0) {
    return {
      state: 'pending',
      summary: `${pending.length} of ${checks.length} CI checks pending`,
    };
  }
  return {
    state: 'passed',
    summary: `${passed.length} of ${checks.length} CI checks passed`,
  };
}

export function listCiChecks(
  cwd: string,
  prUrl: string,
  commitSha: string,
): CiCheck[] {
  const repository = githubRepository(prUrl);
  const result = gh(
    [
      'api',
      `repos/${repository}/commits/${commitSha}/check-runs?per_page=100`,
    ],
    cwd,
  );
  if (result.error) {
    throw new CrewError(
      'GH_NOT_FOUND',
      `Could not run gh: ${result.error.message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new CrewError(
      'GH_CI_QUERY_FAILED',
      `Could not read CI checks for ${commitSha}: ${
        result.stderr || result.stdout || `gh exited with ${result.status}`
      }`,
    );
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new CrewError(
      'GH_CI_QUERY_FAILED',
      `Could not parse CI checks for ${commitSha}`,
    );
  }

  const runs = (parsed as Record<string, unknown>).check_runs;
  if (!Array.isArray(runs)) {
    throw new CrewError(
      'GH_CI_QUERY_FAILED',
      `Could not parse CI checks for ${commitSha}`,
    );
  }

  return runs.map((entry) => {
    const item =
      entry && typeof entry === 'object'
        ? (entry as Record<string, unknown>)
        : {};
    const status = typeof item.status === 'string' ? item.status : 'unknown';
    const conclusion =
      typeof item.conclusion === 'string' ? item.conclusion : '';
    return {
      name: typeof item.name === 'string' ? item.name : 'unknown',
      state: conclusion || status,
      bucket: checkBucket(status, conclusion),
      link: typeof item.html_url === 'string' ? item.html_url : undefined,
    };
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function waitForCiGate(
  options: CiGateOptions,
): Promise<CiResult> {
  const timeoutSeconds =
    options.timeoutSeconds ?? DEFAULT_CI_TIMEOUT_SECONDS;
  const intervalSeconds =
    options.intervalSeconds ?? DEFAULT_CI_INTERVAL_SECONDS;
  const timeoutMs = timeoutSeconds * 1000;
  const intervalMs = intervalSeconds * 1000;
  const startedAt = Date.now();
  let checks: CiCheck[] = [];

  while (true) {
    checks = listCiChecks(options.cwd, options.prUrl, options.commitSha);
    const evaluation = evaluateCiChecks(checks);

    if (evaluation.state !== 'pending') {
      return {
        provider: 'github_actions',
        state: evaluation.state,
        summary: evaluation.summary,
        url: options.prUrl,
        checks,
        durationMs: Date.now() - startedAt,
      };
    }

    const elapsed = Date.now() - startedAt;
    if (elapsed >= timeoutMs) {
      return {
        provider: 'github_actions',
        state: 'error',
        summary: `CI checks did not finish within ${timeoutSeconds}s: ${evaluation.summary}`,
        url: options.prUrl,
        checks,
        durationMs: elapsed,
        error: 'CI_TIMEOUT',
      };
    }

    await sleep(Math.min(intervalMs, timeoutMs - elapsed));
  }
}
