import type {
  ReviewRoute,
  ReviewRouteMode,
  RiskAssessment,
  VerificationResult,
} from '../core/types';

/**
 * Decides whether a task needs the independent tester stage.
 *
 * The default policy (`full`) always runs it. The opt-in `proportionate`
 * policy (ADR 0040) skips the tester only when every objective signal is
 * available and green: the verification ran and passed, and the pre-commit
 * risk (computed from the worktree diff, without tester or CI signals) is
 * `low`. Anything unknown, failed or unmeasurable keeps the tester: a missing
 * evaluation is never evidence of low risk.
 */
export interface ReviewRoutePlanInput {
  mode: ReviewRouteMode;
  verifyCommands: string[];
  verifications: Array<Pick<VerificationResult, 'state'>>;
  /** Risk assessed from the worktree diff before the commit, or null when it
   *  could not be computed. */
  preRisk: RiskAssessment | null;
  /** False when the worktree estimate could not cover every change (e.g.
   *  remote workspace, unreadable files). */
  estimateComplete: boolean;
}

export interface ReviewRoutePlan {
  route: ReviewRoute;
  reason: string;
}

export function planReviewRoute(input: ReviewRoutePlanInput): ReviewRoutePlan {
  if (input.mode !== 'proportionate') {
    return { route: 'tester', reason: 'review.mode is "full"' };
  }
  if (input.verifyCommands.length === 0) {
    return {
      route: 'tester',
      reason: 'no verify commands: nothing objective lets the engine skip the tester',
    };
  }
  const failed = input.verifications.filter(
    (verification) => verification.state !== 'passed',
  );
  if (failed.length > 0) {
    return {
      route: 'tester',
      reason: `verification is not green (${failed.length} failed)`,
    };
  }
  if (!input.preRisk) {
    return {
      route: 'tester',
      reason: 'pre-commit risk is unknown: skipping the tester is not allowed',
    };
  }
  if (!input.estimateComplete) {
    return {
      route: 'tester',
      reason: 'the worktree estimate is incomplete (unmeasured files)',
    };
  }
  if (input.preRisk.level !== 'low') {
    return {
      route: 'tester',
      reason: `pre-commit risk is ${input.preRisk.level} (score ${input.preRisk.score})`,
    };
  }
  return {
    route: 'skipped',
    reason: `tester skipped: pre-commit risk is low (${input.preRisk.reasons.join('; ')})`,
  };
}
