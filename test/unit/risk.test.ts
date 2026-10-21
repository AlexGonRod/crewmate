import { describe, expect, it } from 'vitest';
import type { ChangeStats, Report } from '../../src/core/types';
import { assessRisk } from '../../src/risk/risk';

function change(overrides: Partial<ChangeStats> = {}): ChangeStats {
  return {
    files: 1,
    additions: 5,
    deletions: 1,
    paths: ['src/app/example.ts'],
    ...overrides,
  };
}

function testerReport(findings: Report['payload']['findings']): Report {
  return {
    id: 'rep_1',
    taskId: 'tsk_1',
    runId: 'run_1',
    schema: 'crew.report/v3',
    role: 'tester',
    status: 'done',
    summary: 'review',
    payload: {
      task_id: 'tsk_1',
      run_id: 'run_1',
      schema: 'crew.report/v3',
      status: 'done',
      summary: 'review',
      findings,
    },
    createdAt: new Date().toISOString(),
  };
}

describe('assessRisk', () => {
  it('classifies a small change as low risk', () => {
    const assessment = assessRisk({ change: change() });
    expect(assessment.level).toBe('low');
    expect(assessment.score).toBe(0);
    expect(assessment.reasons[0]).toContain('small change');
  });

  it('classifies authentication changes as high risk', () => {
    const assessment = assessRisk({
      change: change({ paths: ['src/auth/session.ts'], files: 1 }),
    });
    expect(assessment.level).toBe('high');
    expect(assessment.reasons.join(' ')).toContain('authentication/security');
  });

  it('classifies migrations as high risk', () => {
    const assessment = assessRisk({
      change: change({ paths: ['db/migrations/001_init.sql'], files: 1 }),
    });
    expect(assessment.level).toBe('high');
  });

  it('raises the level with medium sized changes', () => {
    const assessment = assessRisk({
      change: change({ files: 6, paths: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts', 'src/f.ts'] }),
    });
    expect(assessment.level).toBe('medium');
  });

  it('raises the level with large changes', () => {
    const paths = Array.from({ length: 25 }, (_, index) => `src/file-${index}.ts`);
    const assessment = assessRisk({
      change: change({ files: 25, additions: 400, deletions: 200, paths }),
    });
    expect(assessment.level).toBe('high');
  });

  it('treats dependency manifest changes as medium risk', () => {
    const assessment = assessRisk({
      change: change({ paths: ['package.json'], files: 1 }),
    });
    expect(assessment.level).toBe('medium');
  });

  it('raises the level with blocking tester findings', () => {
    const assessment = assessRisk({
      change: change(),
      testerReport: testerReport([{ severity: 'blocking', message: 'broken flow' }]),
    });
    expect(assessment.level).toBe('high');
    expect(assessment.reasons.join(' ')).toContain('blocking tester finding');
  });

  it('raises the level with a single tester warning', () => {
    const assessment = assessRisk({
      change: change(),
      testerReport: testerReport([{ severity: 'warning', message: 'missing docs' }]),
    });
    expect(assessment.level).toBe('medium');
  });

  it('raises the level with failing verification', () => {
    const assessment = assessRisk({
      change: change(),
      verifications: [
        {
          id: 'ver_1',
          taskId: 'tsk_1',
          runId: 'run_1',
          command: 'npm test',
          state: 'failed',
          exitCode: 1,
          timedOut: false,
          durationMs: 10,
          signal: null,
          output: 'boom',
          logPath: '/tmp/verify.log',
          createdAt: new Date().toISOString(),
        },
      ],
    });
    expect(assessment.level).toBe('medium');
    expect(assessment.reasons.join(' ')).toContain('failing verification');
  });

  it('raises the level when CI fails', () => {
    const assessment = assessRisk({
      change: change(),
      ci: { state: 'failed' },
    });
    expect(assessment.level).toBe('medium');
    expect(assessment.reasons.join(' ')).toContain('CI failed');
  });

  it('keeps the level low when CI passes', () => {
    const assessment = assessRisk({
      change: change(),
      ci: { state: 'passed' },
    });
    expect(assessment.level).toBe('low');
  });
});
