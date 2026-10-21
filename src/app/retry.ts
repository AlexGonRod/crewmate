import { CrewError } from '../core/errors';

const NON_RETRYABLE_CODES = new Set([
  'CI_REQUIRED_FOR_AUTO_MERGE',
  'DAEMON_LEASE_LOST',
  'EMPTY_ANSWER',
  'GH_NOT_FOUND',
  'GH_PR_CREATE_FAILED',
  'GH_PR_VIEW_FAILED',
  'HARNESS_NOT_FOUND',
  'INVALID_BRIEF',
  'INVALID_DELIVERY_MODE',
  'INVALID_ENV',
  'INVALID_METHODOLOGY',
  'INVALID_TASK',
  'MERGE_POLICY_REQUIRED',
  'NO_WORKTREE',
  'NOT_A_GIT_REPO',
  'PR_REQUIRED',
  'PROJECT_NOT_FOUND',
  'REPORT_INVALID',
  'RUN_ACTIVE',
  'RUN_NOT_FOUND',
  'SCHEMA_NOT_FOUND',
  'SPEC_INVALID',
  'SPEC_NOT_FOUND',
  'SPEC_REQUIRED',
  'TASK_ABORTED',
  'TASK_NOT_FOUND',
  'TASK_TERMINAL',
]);

export function isRetryableError(error: unknown): boolean {
  if (error instanceof CrewError) {
    return !NON_RETRYABLE_CODES.has(error.code);
  }
  return true;
}
