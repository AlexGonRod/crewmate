import { describe, expect, it } from 'vitest';
import { newId } from '../../src/core/ids';
import type {
  Methodology,
  ReportPayload,
  Task,
  TaskSpec,
} from '../../src/core/types';
import { assertReportMeetsMethodology } from '../../src/protocol/methodology';

function makeTask(methodology: Methodology, spec: TaskSpec | null = null): Task {
  return {
    id: newId('tsk'),
    projectId: newId('prj'),
    title: 'Task',
    slug: 'task',
    requestText: null,
    origin: 'cli',
    briefText: 'Do it',
    methodology,
    spec,
    stage: 'develop',
    reviewIterations: 0,
    commitSha: null,
    prUrl: null,
    state: 'running',
    deliveryMode: 'local',
    baseBranch: 'main',
    branch: 'crew/task',
    worktreePath: '/tmp/worktree',
    harnessId: 'fake',
    priority: 0,
    attempts: 0,
    nextAttemptAt: null,
    lastError: null,
    retryable: false,
    lastSeq: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: null,
  };
}

function makeSpec(): TaskSpec {
  return {
    schema: 'crew.spec/v1',
    goal: 'Do it',
    acceptance_criteria: [
      { id: 'AC1', text: 'One' },
      { id: 'AC2', text: 'Two' },
    ],
  };
}

function makeReport(
  task: Task,
  overrides: Partial<ReportPayload> = {},
): ReportPayload {
  return {
    schema: 'crew.report/v2',
    task_id: task.id,
    run_id: newId('run'),
    methodology: task.methodology,
    status: 'done',
    summary: 'Done',
    ...overrides,
  };
}

describe('methodology gates', () => {
  it('accepts a v1 report for a free task', () => {
    const task = makeTask('free');
    const report = makeReport(task, {
      schema: 'crew.report/v1',
      methodology: undefined,
    });
    expect(() => assertReportMeetsMethodology(report, task)).not.toThrow();
  });

  it('requires a v2 report for spec and tdd tasks', () => {
    const task = makeTask('spec', makeSpec());
    const report = makeReport(task, {
      schema: 'crew.report/v1',
      methodology: undefined,
    });
    expect(() => assertReportMeetsMethodology(report, task)).toThrow(
      'requires a crew.report/v2',
    );
  });

  it('rejects a methodology mismatch', () => {
    const task = makeTask('spec', makeSpec());
    const report = makeReport(task, { methodology: 'free' });
    expect(() => assertReportMeetsMethodology(report, task)).toThrow(
      'does not match task methodology',
    );
  });

  it('requires evidence for every acceptance criterion on done', () => {
    const task = makeTask('spec', makeSpec());
    const report = makeReport(task, {
      acceptance: [
        { criterion_id: 'AC1', status: 'passed', evidence: 'test/ac1.test.ts' },
        { criterion_id: 'AC2', status: 'not_verified', evidence: 'pending' },
      ],
    });
    expect(() => assertReportMeetsMethodology(report, task)).toThrow(
      'Missing acceptance evidence for: AC2',
    );
  });

  it('accepts complete spec evidence', () => {
    const task = makeTask('spec', makeSpec());
    const report = makeReport(task, {
      acceptance: [
        { criterion_id: 'AC1', status: 'passed', evidence: 'test/ac1.test.ts' },
        { criterion_id: 'AC2', status: 'passed', evidence: 'test/ac2.test.ts' },
      ],
    });
    expect(() => assertReportMeetsMethodology(report, task)).not.toThrow();
  });

  it('does not require evidence for non-terminal reports', () => {
    const task = makeTask('spec', makeSpec());
    const report = makeReport(task, { status: 'needs_input' });
    expect(() => assertReportMeetsMethodology(report, task)).not.toThrow();
  });

  it('enforces tester role and verdict rules on v3 reports', () => {
    const task = makeTask('free');
    const testerReport = makeReport(task, {
      schema: 'crew.report/v3',
      role: 'tester',
      verdict: 'approve',
      methodology: 'free',
    });
    expect(() =>
      assertReportMeetsMethodology(testerReport, task, 'tester'),
    ).not.toThrow();
    expect(() =>
      assertReportMeetsMethodology(testerReport, task, 'developer'),
    ).toThrow('does not match run role');

    const noVerdict = makeReport(task, {
      schema: 'crew.report/v3',
      role: 'tester',
      methodology: 'free',
    });
    expect(() =>
      assertReportMeetsMethodology(noVerdict, task, 'tester'),
    ).toThrow('must include verdict');

    const approveFailed = makeReport(task, {
      schema: 'crew.report/v3',
      role: 'tester',
      verdict: 'approve',
      methodology: 'free',
      status: 'failed',
    });
    expect(() =>
      assertReportMeetsMethodology(approveFailed, task, 'tester'),
    ).toThrow('approve verdict requires status');

    const rejectDone = makeReport(task, {
      schema: 'crew.report/v3',
      role: 'tester',
      verdict: 'reject',
      methodology: 'free',
      status: 'done',
    });
    expect(() =>
      assertReportMeetsMethodology(rejectDone, task, 'tester'),
    ).toThrow('reject verdict requires status');
  });

  it('requires v3 for tester reports', () => {
    const task = makeTask('free');
    const report = makeReport(task, {
      schema: 'crew.report/v2',
      methodology: 'free',
    });
    expect(() =>
      assertReportMeetsMethodology(report, task, 'tester'),
    ).toThrow('Tester reports require a crew.report/v3');
  });

  it('requires red and green test phases for tdd done', () => {
    const task = makeTask('tdd', makeSpec());
    const acceptance = [
      { criterion_id: 'AC1', status: 'passed' as const, evidence: 'test/ac1.test.ts' },
      { criterion_id: 'AC2', status: 'passed' as const, evidence: 'test/ac2.test.ts' },
    ];
    const missingRed = makeReport(task, {
      acceptance,
      tests: [{ command: 'pnpm test', status: 'passed', phase: 'green' }],
    });
    expect(() => assertReportMeetsMethodology(missingRed, task)).toThrow(
      'phases: red',
    );

    const complete = makeReport(task, {
      acceptance,
      tests: [
        { command: 'pnpm test', status: 'failed', phase: 'red' },
        { command: 'pnpm test', status: 'passed', phase: 'green' },
      ],
    });
    expect(() => assertReportMeetsMethodology(complete, task)).not.toThrow();
  });
});
