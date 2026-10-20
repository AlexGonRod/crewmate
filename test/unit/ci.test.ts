import { describe, expect, it } from 'vitest';
import { evaluateCiChecks } from '../../src/ci/ci';
import type { CiCheck } from '../../src/core/types';

function check(
  name: string,
  state: string,
  bucket: string,
): CiCheck {
  return { name, state, bucket };
}

describe('CI checks', () => {
  it('waits when no checks have been reported', () => {
    expect(evaluateCiChecks([])).toEqual({
      state: 'pending',
      summary: 'No CI checks reported yet',
    });
  });

  it('passes when every check passed or was skipped', () => {
    expect(
      evaluateCiChecks([
        check('test', 'SUCCESS', 'pass'),
        check('lint', 'SKIPPED', 'skipping'),
      ]),
    ).toEqual({
      state: 'passed',
      summary: '2 of 2 CI checks passed',
    });
  });

  it('fails when a check failed or has an unknown state', () => {
    expect(
      evaluateCiChecks([
        check('test', 'SUCCESS', 'pass'),
        check('lint', 'FAILURE', 'fail'),
        check('deploy', 'UNKNOWN', ''),
      ]),
    ).toEqual({
      state: 'failed',
      summary:
        '2 of 3 CI checks failed: lint (FAILURE), deploy (UNKNOWN)',
    });
  });

  it('stays pending while any check is running', () => {
    expect(
      evaluateCiChecks([
        check('test', 'SUCCESS', 'pass'),
        check('lint', 'IN_PROGRESS', 'pending'),
      ]),
    ).toEqual({
      state: 'pending',
      summary: '1 of 2 CI checks pending',
    });
  });

  it('infers the bucket when gh omits it', () => {
    expect(
      evaluateCiChecks([
        check('test', 'PENDING', ''),
        check('lint', 'CANCELLED', ''),
      ]).state,
    ).toBe('failed');
  });
});
