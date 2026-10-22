import { describe, expect, it } from 'vitest';
import { generateBrief } from '../../src/brief/brief';
import { newId } from '../../src/core/ids';
import type {
  Methodology,
  Project,
  Run,
  Task,
  TaskSpec,
  VerificationResult,
} from '../../src/core/types';

const project: Project = {
  id: newId('prj'),
  name: 'demo',
  rootPath: '/tmp/demo',
  defaultBranch: 'main',
  remoteUrl: null,
  forge: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const run: Run = {
  id: newId('run'),
  taskId: newId('tsk'),
  attempt: 1,
  harnessId: 'fake',
  role: 'developer',
  stage: 'develop',
  backend: 'process',
  state: 'running',
  pid: null,
  exitCode: null,
  logPath: '/tmp/run.jsonl',
  startedAt: '2026-01-01T00:00:00.000Z',
  endedAt: null,
};

function makeTask(
  methodology: Methodology,
  spec: TaskSpec | null,
): Task {
  return {
    id: run.taskId,
    projectId: project.id,
    title: 'Task',
    slug: 'task',
    requestText: null,
    origin: 'cli',
    briefText: 'Do the thing',
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

function makeBrief(
  task: Task,
  options: {
    role?: 'developer' | 'tester';
    reviewIteration?: number;
    verifications?: VerificationResult[];
  } = {},
): string {
  const role = options.role ?? 'developer';
  return generateBrief({
    task,
    project,
    run: { ...run, role },
    attempt: 1,
    reportPath: '/tmp/worktree/.crew/report.json',
    briefPath: '/tmp/worktree/.crew/brief.md',
    specPath: '/tmp/worktree/.crew/spec.json',
    cliCommand: 'crew',
    methodology: task.methodology,
    spec: task.spec,
    role,
    stage: role === 'tester' ? 'test' : 'develop',
    reviewIteration: options.reviewIteration ?? task.reviewIterations,
    developerReportPath:
      role === 'tester' ? '/tmp/worktree/.crew/reports/dev-run.json' : undefined,
    verifyCommands: ['pnpm test'],
    verifications: options.verifications,
    messages: [],
  });
}

const spec: TaskSpec = {
  schema: 'crew.spec/v1',
  goal: 'Add the endpoint',
  acceptance_criteria: [
    { id: 'AC1', text: 'It returns 200' },
    { id: 'AC2', text: 'It has a test' },
  ],
  non_goals: ['Authentication'],
};

describe('brief generation', () => {
  it('keeps the free methodology on report v1', () => {
    const brief = makeBrief(makeTask('free', null));
    expect(brief).toContain('methodology: "free"');
    expect(brief).toContain('crew.report/v1');
    expect(brief).not.toContain('## Methodology:');
  });

  it('renders acceptance criteria and v2 reporting for spec', () => {
    const brief = makeBrief(makeTask('spec', spec));
    expect(brief).toContain('## Acceptance criteria');
    expect(brief).toContain('**AC1**: It returns 200');
    expect(brief).toContain('### Non-goals');
    expect(brief).toContain('## Methodology: spec');
    expect(brief).toContain('crew.report/v2');
    expect(brief).toContain('CREW_SPEC_PATH');
  });

  it('renders a read-only v3 brief for the tester', () => {
    const brief = makeBrief(makeTask('tdd', spec), {
      role: 'tester',
      reviewIteration: 1,
    });
    expect(brief).toContain('role: "tester"');
    expect(brief).toContain('stage: "test"');
    expect(brief).toContain('review_iteration: 1');
    expect(brief).toContain('## Role contract (tester)');
    expect(brief).toContain('# Tester (crew)');
    expect(brief).toContain('Nunca modifiques el código');
    expect(brief).toContain('crew.report/v3');
    expect(brief).toContain('"verdict": "approve"');
    expect(brief).toContain('CREW_DEVELOPER_REPORT_PATH` = /tmp/worktree/.crew/reports/dev-run.json');
    expect(brief).not.toContain('## Methodology: TDD');
  });

  it('includes independent verification evidence for the tester', () => {
    const verification: VerificationResult = {
      id: 'ver_test',
      taskId: run.taskId,
      runId: 'run_dev',
      command: 'pnpm test',
      state: 'failed',
      exitCode: 1,
      signal: null,
      timedOut: false,
      durationMs: 123,
      output: 'AssertionError: expected 200',
      logPath: '/tmp/verifications/run_dev-1.log',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const brief = makeBrief(makeTask('spec', spec), {
      role: 'tester',
      verifications: [verification],
    });
    expect(brief).toContain('## Independent verification');
    expect(brief).toContain('`pnpm test`');
    expect(brief).toContain('State: `failed`');
    expect(brief).toContain('Exit code: 1');
    expect(brief).toContain('AssertionError: expected 200');
    expect(brief).toContain('/tmp/verifications/run_dev-1.log');
  });

  it('adds red-green-refactor instructions for tdd', () => {
    const brief = makeBrief(makeTask('tdd', spec));
    expect(brief).toContain('## Methodology: TDD');
    expect(brief).toContain('**Red**');
    expect(brief).toContain('**Green**');
    expect(brief).toContain('phase');
    expect(brief).toContain('crew.report/v2');
  });
});

describe('the request as the person asked it', () => {
  it('goes into the brief verbatim, before the goal', () => {
    const task = {
      ...makeTask('free', null),
      requestText: 'arregla el login\ncon estos pasos',
      origin: 'person' as const,
    };
    const brief = makeBrief(task);
    expect(brief).toContain('## Request (as the person asked it)');
    expect(brief).toContain('arregla el login\ncon estos pasos');
    expect(brief.indexOf('## Request')).toBeLessThan(brief.indexOf('## Goal'));
  });

  it('is absent when nobody recorded a request', () => {
    const brief = makeBrief(makeTask('free', null));
    expect(brief).not.toContain('## Request (as the person asked it)');
  });
});
