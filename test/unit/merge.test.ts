import { afterEach, describe, expect, it } from 'vitest';
import { evaluateMerge, mergeTask } from '../../src/app/merge';
import { CrewError } from '../../src/core/errors';
import type { ReportPayload } from '../../src/core/types';
import { Store } from '../../src/store/store';

const stores: Store[] = [];

function createStore(): Store {
  const store = new Store(':memory:');
  stores.push(store);
  return store;
}

function createTask(store: Store, deliveryMode: 'local' | 'pr' = 'local'): string {
  const project = store.createProject({
    name: 'demo',
    rootPath: '/tmp/demo',
    defaultBranch: 'main',
    remoteUrl: null,
    forge: null,
  });
  const task = store.createTask({
    projectId: project.id,
    title: 'Merge task',
    briefText: 'Do the thing',
    deliveryMode,
    methodology: 'free',
    spec: null,
  });
  return task.id;
}

function reportPayload(
  taskId: string,
  runId: string,
  overrides: Partial<ReportPayload> = {},
): ReportPayload {
  return {
    schema: 'crew.report/v3',
    task_id: taskId,
    run_id: runId,
    status: 'done',
    summary: 'Done',
    verdict: 'approve',
    ...overrides,
  };
}

function prepareTask(
  store: Store,
  taskId: string,
  options: { verification?: 'passed' | 'failed'; ci?: 'passed' | 'failed' } = {},
): void {
  store.queueTask(taskId);
  const developerRun = `run_dev_${taskId}`;
  store.startRun({
    taskId,
    runId: developerRun,
    attempt: store.nextAttempt(taskId),
    harnessId: 'fake',
    backend: 'process',
    logPath: '/tmp/dev.log',
    worktreePath: '/tmp/worktree',
    branch: 'crew/test',
  });
  store.markRunRunning(developerRun, process.pid);
  store.recordReport(reportPayload(taskId, developerRun, { schema: 'crew.report/v1' }));
  store.recordVerification({
    taskId,
    runId: developerRun,
    command: 'npm test',
    state: options.verification === 'failed' ? 'failed' : 'passed',
    exitCode: options.verification === 'failed' ? 1 : 0,
    signal: null,
    timedOut: false,
    durationMs: 12,
    output: '',
    logPath: '/tmp/verify.log',
  });
  store.finishRun({
    runId: developerRun,
    exitCode: 0,
    signal: null,
    timedOut: false,
    keepTaskRunning: true,
  });

  const testerRun = `run_test_${taskId}`;
  store.startRun({
    taskId,
    runId: testerRun,
    attempt: store.nextAttempt(taskId),
    harnessId: 'fake',
    backend: 'process',
    logPath: '/tmp/tester.log',
    worktreePath: '/tmp/worktree',
    branch: 'crew/test',
    role: 'tester',
    continuePipeline: true,
  });
  store.markRunRunning(testerRun, process.pid);
  store.recordReport(reportPayload(taskId, testerRun, { role: 'tester' }));
  store.finishRun({
    runId: testerRun,
    exitCode: 0,
    signal: null,
    timedOut: false,
    keepTaskRunning: true,
  });
  store.requestReview(taskId);

  if (options.ci) {
    store.recordCiCheck(taskId, {
      provider: 'github_actions',
      state: options.ci,
      summary: `CI ${options.ci}`,
      url: 'https://example.test/ci',
      checks: [],
      durationMs: 10,
    });
  }
}

afterEach(() => {
  while (stores.length > 0) {
    stores.pop()?.close();
  }
});

describe('evaluateMerge', () => {
  it('allows the merge when every gate passes', () => {
    const store = createStore();
    const taskId = createTask(store);
    prepareTask(store, taskId, { ci: 'passed' });

    const decision = evaluateMerge(store.getTaskDetail(taskId));
    expect(decision.allowed).toBe(true);
    expect(decision.missing).toEqual([]);
    expect(decision.gates.map((gate) => gate.name)).toContain('CI passed');
  });

  it('blocks the merge when the verification failed', () => {
    const store = createStore();
    const taskId = createTask(store);
    prepareTask(store, taskId, { verification: 'failed' });

    const decision = evaluateMerge(store.getTaskDetail(taskId));
    expect(decision.allowed).toBe(false);
    expect(decision.missing.join(' ')).toContain('verification passed');
  });

  it('blocks the merge when CI failed', () => {
    const store = createStore();
    const taskId = createTask(store);
    prepareTask(store, taskId, { ci: 'failed' });

    const decision = evaluateMerge(store.getTaskDetail(taskId));
    expect(decision.allowed).toBe(false);
    expect(decision.missing.join(' ')).toContain('CI passed');
  });

  it('blocks the merge when the pull request is missing', () => {
    const store = createStore();
    const taskId = createTask(store, 'pr');
    prepareTask(store, taskId);

    const decision = evaluateMerge(store.getTaskDetail(taskId));
    expect(decision.allowed).toBe(false);
    expect(decision.missing.join(' ')).toContain('pull request open');
  });
});

describe('mergeTask', () => {
  it('accepts the task and records the authorization', () => {
    const store = createStore();
    const taskId = createTask(store);
    prepareTask(store, taskId);

    const outcome = mergeTask(store, taskId, {
      projectRootPath: '/tmp/demo',
      method: 'squash',
      authorizedBy: 'captain',
      skipMerge: true,
      livePr: false,
    });

    expect(outcome.decision.allowed).toBe(true);
    expect(outcome.accepted).toBe(true);
    expect(outcome.taskState).toBe('done');
    const events = store.listEvents({ taskId });
    const authorization = events.find((event) => event.type === 'task.authorized');
    expect(authorization?.actor).toBe('captain');
    expect(authorization?.payload.action).toBe('merge');
  });

  it('refuses to merge and explains what is missing', () => {
    const store = createStore();
    const taskId = createTask(store);
    prepareTask(store, taskId, { verification: 'failed' });

    let code = '';
    let message = '';
    try {
      mergeTask(store, taskId, {
        projectRootPath: '/tmp/demo',
        method: 'squash',
        authorizedBy: 'captain',
        skipMerge: true,
        livePr: false,
      });
    } catch (error) {
      code = error instanceof CrewError ? error.code : 'unknown';
      message = error instanceof Error ? error.message : '';
    }
    expect(code).toBe('MERGE_BLOCKED');
    expect(message).toContain('verification passed');
    expect(store.getTaskOrThrow(taskId).state).toBe('review');
  });
});
