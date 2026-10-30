import { afterEach, describe, expect, it } from 'vitest';
import type { ReportPayload } from '../../src/core/types';
import {
  decideTask,
  parseDecisionPaste,
} from '../../src/app/decision';
import { lastHumanAuthorization } from '../../src/app/merge';
import { Store } from '../../src/store/store';
import type { ResolvedContext } from '../../src/config/config';

const stores: Store[] = [];

function createContext(): ResolvedContext {
  return {
    paths: {
      rootDir: '/tmp/crew',
      configDir: '/tmp/crew/config',
      dataDir: '/tmp/crew/data',
      stateDir: '/tmp/crew/state',
      tasksDir: '/tmp/crew/tasks',
      logsDir: '/tmp/crew/logs',
      worktreesDir: '/tmp/crew/worktrees',
    },
    config: {
      harness: 'fake',
      timeoutSeconds: 60,
      agents: { developer: {}, tester: {}, captain: {} },
      review: { maxIterations: 3, mode: 'full' },
      delivery: 'local',
      scheduling: { concurrency: 1, mode: 'serial' },
    },
  } as unknown as ResolvedContext;
}

function createStore(): Store {
  const store = new Store(':memory:');
  stores.push(store);
  return store;
}

function prepareTask(store: Store): string {
  const project = store.createProject({
    name: 'demo',
    rootPath: '/tmp/demo',
    defaultBranch: 'main',
    remoteUrl: null,
    forge: null,
  });
  const task = store.createTask({
    projectId: project.id,
    title: 'Decision task',
    briefText: 'Do the thing',
    deliveryMode: 'local',
    methodology: 'free',
    spec: null,
  });
  store.queueTask(task.id);
  const developerRun = `run_dev_${task.id}`;
  store.startRun({
    taskId: task.id,
    runId: developerRun,
    attempt: store.nextAttempt(task.id),
    harnessId: 'fake',
    backend: 'process',
    logPath: '/tmp/dev.log',
    worktreePath: '/tmp/worktree',
    branch: 'crew/test',
  });
  store.markRunRunning(developerRun, process.pid);
  const payload: ReportPayload = {
    schema: 'crew.report/v1',
    task_id: task.id,
    run_id: developerRun,
    status: 'done',
    summary: 'Done',
    verdict: 'approve',
  };
  store.recordReport(payload);
  store.recordVerification({
    taskId: task.id,
    runId: developerRun,
    command: 'npm test',
    state: 'passed',
    exitCode: 0,
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

  const testerRun = `run_test_${task.id}`;
  store.startRun({
    taskId: task.id,
    runId: testerRun,
    attempt: store.nextAttempt(task.id),
    harnessId: 'fake',
    backend: 'process',
    logPath: '/tmp/tester.log',
    worktreePath: '/tmp/worktree',
    branch: 'crew/test',
    role: 'tester',
    continuePipeline: true,
  });
  store.markRunRunning(testerRun, process.pid);
  store.recordReport({
    schema: 'crew.report/v3',
    task_id: task.id,
    run_id: testerRun,
    status: 'done',
    summary: 'Approved',
    verdict: 'approve',
    role: 'tester',
    findings: [],
    acceptance: [],
  });
  store.finishRun({
    runId: testerRun,
    exitCode: 0,
    signal: null,
    timedOut: false,
    keepTaskRunning: true,
  });
  store.requestReview(task.id);
  return task.id;
}

afterEach(() => {
  while (stores.length > 0) {
    stores.pop()?.close();
  }
});

describe('parseDecisionPaste', () => {
  it('reads the decision line and keeps the verbatim comment after it', () => {
    const paste = [
      'crew-decision: reject',
      'Fix each comment, then run the tests.',
      '- the endpoint ignores the 404 case',
      '- add a test for the boundary',
    ].join('\n');
    const parsed = parseDecisionPaste(paste);
    expect(parsed.decision).toBe('reject');
    expect(parsed.comments).toBe(
      ['Fix each comment, then run the tests.', '- the endpoint ignores the 404 case', '- add a test for the boundary'].join('\n'),
    );
  });

  it('reads an accept without comments', () => {
    const parsed = parseDecisionPaste('crew-decision: accept');
    expect(parsed.decision).toBe('accept');
    expect(parsed.comments).toBeNull();
  });

  it('treats a paste without the decision line as none', () => {
    const parsed = parseDecisionPaste('please look at this file');
    expect(parsed.decision).toBe('none');
    expect(parsed.comments).toBeNull();
  });

  it('ignores an unrecognised value instead of guessing', () => {
    const parsed = parseDecisionPaste('crew-decision: maybe\nlooks good');
    expect(parsed.decision).toBe('none');
    expect(parsed.comments).toBeNull();
  });
});

describe('decideTask', () => {
  it('records a reject with the verbatim comments as review feedback', () => {
    const store = createStore();
    const taskId = prepareTask(store);
    const comments = [
      'the endpoint ignores the 404 case',
      'add a test for the boundary',
    ].join('\n');

    const outcome = decideTask(store, createContext(), {
      taskId,
      decision: 'reject',
      comments,
      authorizedBy: 'alex',
      origin: 'herdr-reviewr',
    });

    expect(outcome.decision).toBe('reject');
    expect(outcome.taskState).toBe('queued');
    expect(outcome.merge).toBeNull();

    const updated = store.getTaskDetail(taskId);
    const feedback = updated.messages.filter(
      (message) => message.kind === 'review_feedback',
    );
    expect(feedback).toHaveLength(1);
    expect(feedback[0]?.body).toContain('the endpoint ignores the 404 case');
    expect(feedback[0]?.body).toContain('add a test for the boundary');

    const review = updated.artifacts.filter((artifact) => artifact.kind === 'review').at(-1);
    expect(review?.ref.startsWith('reject: the endpoint ignores the 404 case')).toBe(true);
    expect(review?.metadata).toMatchObject({
      decision: 'reject',
      origin: 'herdr-reviewr',
      authorizedBy: 'alex',
    });

    const decided = updated.events.filter((event) => event.type === 'task.reviewed').at(-1);
    expect(decided?.payload).toMatchObject({ decision: 'reject', origin: 'herdr-reviewr' });
    expect(updated.task.reviewIterations).toBe(1);
  });

  it('accepts a task through the same merge gates', () => {
    const store = createStore();
    const taskId = prepareTask(store);

    const outcome = decideTask(store, createContext(), {
      taskId,
      decision: 'accept',
      comments: null,
      authorizedBy: 'alex',
      origin: 'herdr-reviewr',
    });

    expect(outcome.decision).toBe('accept');
    expect(outcome.accepted).toBe(true);
    expect(outcome.taskState).toBe('done');
    expect(store.getTaskDetail(taskId).task.state).toBe('done');

    const review = store
      .getTaskDetail(taskId)
      .artifacts.filter((artifact) => artifact.kind === 'review')
      .at(-1);
    expect(review?.metadata).toMatchObject({
      decision: 'accept',
      origin: 'herdr-reviewr',
    });
  });

  it('records an authorization a later merge gate can read', () => {
    // The decision record is what `lastHumanAuthorization` reads, so an
    // accept decided outside the editor must authorise a later merge too.
    const store = createStore();
    const taskId = prepareTask(store);
    decideTask(store, createContext(), {
      taskId,
      decision: 'accept',
      comments: 'looks good',
      authorizedBy: 'alex',
      origin: 'cli',
    });
    const authorization = lastHumanAuthorization(store.getTaskDetail(taskId));
    expect(authorization).toMatchObject({ authorizedBy: 'alex', reason: 'looks good' });
  });

  it('refuses to decide a task that is not in review', () => {
    const store = createStore();
    expect(() =>
      decideTask(store, createContext(), {
        taskId: 'tsk_missing',
        decision: 'accept',
        comments: null,
        authorizedBy: 'user',
        origin: 'cli',
      }),
    ).toThrow();
  });
});
