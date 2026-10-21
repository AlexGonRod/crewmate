import { describe, expect, it } from 'vitest';
import { backoffDelayMs, DEFAULT_BACKOFF_MS, MAX_BACKOFF_MS } from '../../src/core/backoff';
import { CrewError } from '../../src/core/errors';
import { isRetryableError } from '../../src/app/retry';
import { Store } from '../../src/store/store';

function createStore(): Store {
  return new Store(':memory:');
}

function createTask(store: Store): string {
  const project = store.createProject({
    name: `demo-${Math.random().toString(36).slice(2)}`,
    rootPath: `/tmp/demo-${Math.random().toString(36).slice(2)}`,
    defaultBranch: 'main',
    remoteUrl: null,
    forge: null,
  });
  const task = store.createTask({
    projectId: project.id,
    title: 'Retry task',
    briefText: 'Do the thing',
    deliveryMode: 'local',
    methodology: 'free',
    spec: null,
  });
  return task.id;
}

describe('backoffDelayMs', () => {
  it('grows exponentially with the attempt number', () => {
    expect(backoffDelayMs(1000, 1)).toBe(1000);
    expect(backoffDelayMs(1000, 2)).toBe(2000);
    expect(backoffDelayMs(1000, 3)).toBe(4000);
  });

  it('caps the delay', () => {
    expect(backoffDelayMs(1000, 20)).toBe(MAX_BACKOFF_MS);
    expect(backoffDelayMs(1000, 20, 5000)).toBe(5000);
  });

  it('never returns a negative delay', () => {
    expect(backoffDelayMs(-10, 1)).toBe(0);
    expect(backoffDelayMs(1000, 0)).toBe(1000);
  });

  it('exposes sane defaults', () => {
    expect(DEFAULT_BACKOFF_MS).toBe(60_000);
    expect(MAX_BACKOFF_MS).toBeGreaterThan(DEFAULT_BACKOFF_MS);
  });
});

describe('isRetryableError', () => {
  it('treats protocol and configuration errors as permanent', () => {
    expect(isRetryableError(new CrewError('REPORT_INVALID', 'bad report'))).toBe(false);
    expect(isRetryableError(new CrewError('SPEC_REQUIRED', 'no spec'))).toBe(false);
    expect(isRetryableError(new CrewError('MERGE_POLICY_REQUIRED', 'no policy'))).toBe(false);
  });

  it('treats unexpected errors as transient', () => {
    expect(isRetryableError(new Error('socket hang up'))).toBe(true);
    expect(isRetryableError(new CrewError('GIT_ERROR', 'git failed'))).toBe(true);
  });
});

describe('store retry state', () => {
  it('records the failure reason and whether it can be retried', () => {
    const store = createStore();
    const taskId = createTask(store);
    store.queueTask(taskId);

    store.failTask(taskId, 'agent crashed', { retryable: true });
    const failed = store.getTaskOrThrow(taskId);
    expect(failed.state).toBe('failed');
    expect(failed.retryable).toBe(true);
    expect(failed.lastError).toBe('agent crashed');
  });

  it('requeues a failed task with an attempt counter and a backoff deadline', () => {
    const store = createStore();
    const taskId = createTask(store);
    store.queueTask(taskId);
    store.failTask(taskId, 'agent crashed', { retryable: true });

    const requeued = store.requeueTask(taskId, { reason: 'retry', delayMs: 60_000 });
    expect(requeued.state).toBe('queued');
    expect(requeued.attempts).toBe(1);
    expect(requeued.retryable).toBe(false);
    expect(requeued.nextAttemptAt).toBeTruthy();
    expect(Date.parse(requeued.nextAttemptAt as string)).toBeGreaterThan(Date.now());

    const events = store.listEvents({ taskId });
    expect(events.some((event) => event.type === 'task.requeued')).toBe(true);
  });

  it('does not pick a task that is waiting for its backoff', () => {
    const store = createStore();
    const taskId = createTask(store);
    store.queueTask(taskId);
    store.failTask(taskId, 'agent crashed', { retryable: true });
    store.requeueTask(taskId, { delayMs: 60_000 });

    expect(store.nextQueuedTask()).toBeNull();
    const later = Date.now() + 120_000;
    expect(store.nextQueuedTask([], { now: later })?.id).toBe(taskId);
  });

  it('resets the attempt budget on a manual retry', () => {
    const store = createStore();
    const taskId = createTask(store);
    store.queueTask(taskId);
    store.failTask(taskId, 'agent crashed', { retryable: true });
    store.requeueTask(taskId, { delayMs: 60_000 });
    store.failTask(taskId, 'agent crashed again', { retryable: true });

    const retried = store.retryTask(taskId);
    expect(retried.state).toBe('queued');
    expect(retried.attempts).toBe(0);
    expect(retried.nextAttemptAt).toBeNull();
    expect(retried.lastError).toBeNull();
  });

  it('keeps the queue usable when the backoff expires', () => {
    const store = createStore();
    const taskId = createTask(store);
    store.queueTask(taskId);
    store.failTask(taskId, 'agent crashed', { retryable: true });
    store.requeueTask(taskId, { delayMs: 0 });

    expect(store.nextQueuedTask()?.id).toBe(taskId);
  });
});
