import { describe, expect, it } from 'vitest';
import type { ChangeStats, VerificationResult } from '../../src/core/types';
import { assessRisk } from '../../src/risk/risk';
import { planReviewRoute } from '../../src/risk/review-route';

function change(overrides: Partial<ChangeStats> = {}): ChangeStats {
  return {
    files: 1,
    additions: 5,
    deletions: 1,
    paths: ['src/app/example.ts'],
    ...overrides,
  };
}

function verification(state: VerificationResult['state']): Pick<VerificationResult, 'state'> {
  return { state };
}

const LOW_RISK = assessRisk({ change: change() });
const MEDIUM_RISK = assessRisk({
  change: change({ paths: ['package.json'], files: 1 }),
});
const HIGH_RISK = assessRisk({
  change: change({ paths: ['src/auth/session.ts'], files: 1 }),
});

function proportionate(
  overrides: Partial<Parameters<typeof planReviewRoute>[0]> = {},
): Parameters<typeof planReviewRoute>[0] {
  return {
    mode: 'proportionate',
    verifyCommands: ['pnpm test'],
    verifications: [verification('passed')],
    preRisk: LOW_RISK,
    estimateComplete: true,
    ...overrides,
  };
}

describe('planReviewRoute', () => {
  it('always runs the tester under the full policy', () => {
    const plan = planReviewRoute({ ...proportionate(), mode: 'full' });
    expect(plan.route).toBe('tester');
    expect(plan.reason).toContain('full');
  });

  it('skips the tester for a green verification and a low pre-commit risk', () => {
    const plan = planReviewRoute(proportionate());
    expect(plan.route).toBe('skipped');
    expect(plan.reason).toContain('pre-commit risk is low');
    expect(plan.reason).toContain('small change');
  });

  it('runs the tester when there are no verification commands', () => {
    const plan = planReviewRoute(proportionate({ verifyCommands: [] }));
    expect(plan.route).toBe('tester');
    expect(plan.reason).toContain('no verify commands');
  });

  it('runs the tester when a verification did not pass', () => {
    const plan = planReviewRoute(
      proportionate({ verifications: [verification('failed')] }),
    );
    expect(plan.route).toBe('tester');
    expect(plan.reason).toContain('not green');
  });

  it('runs the tester when the pre-commit risk could not be computed', () => {
    const plan = planReviewRoute(proportionate({ preRisk: null }));
    expect(plan.route).toBe('tester');
    expect(plan.reason).toContain('unknown');
  });

  it('runs the tester when the worktree estimate is incomplete', () => {
    const plan = planReviewRoute(proportionate({ estimateComplete: false }));
    expect(plan.route).toBe('tester');
    expect(plan.reason).toContain('incomplete');
  });

  it('runs the tester for medium pre-commit risk', () => {
    const plan = planReviewRoute(proportionate({ preRisk: MEDIUM_RISK }));
    expect(plan.route).toBe('tester');
    expect(plan.reason).toContain('medium');
  });

  it('runs the tester for high pre-commit risk', () => {
    const plan = planReviewRoute(proportionate({ preRisk: HIGH_RISK }));
    expect(plan.route).toBe('tester');
    expect(plan.reason).toContain('high');
  });

  it('treats sensitive paths as high risk through assessRisk', () => {
    expect(HIGH_RISK.level).toBe('high');
    expect(MEDIUM_RISK.level).toBe('medium');
    expect(LOW_RISK.level).toBe('low');
  });
});
