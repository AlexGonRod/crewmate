import { afterEach, describe, expect, it } from 'vitest';
import { runDaemon, type DaemonExecutor } from '../../src/app/daemon';
import type { ResolvedContext } from '../../src/config/config';
import { newId } from '../../src/core/ids';
import type { Project, ReportPayload, Task } from '../../src/core/types';
import { Store } from '../../src/store/store';

const stores: Store[] = [];

function createStore(): Store {
  const store = new Store(':memory:');
  stores.push(store);
  return store;
}

function context(): ResolvedContext {
  return {
    paths: {
      configDir: '/tmp/crew/config',
      dataDir: '/tmp/crew/data',
      stateDir: '/tmp/crew/state',
      dbPath: ':memory:',
      worktreesDir: '/tmp/crew/worktrees',
      tasksDir: '/tmp/crew/tasks',
      logsDir: '/tmp/crew/logs',
    },
    config: {
      harness: 'fake',
      timeoutSeconds: 60,
      agents: { developer: {}, tester: {} },
      review: { maxIterations: 3 },
      delivery: 'local',
    },
  };
}

function createTask(store: Store): { project: Project; task: Task } {
  const project = store.createProject({
    name: `demo-${newId('x')}`,
    rootPath: `/tmp/demo-${newId('x')}`,
    defaultBranch: 'main',
    remoteUrl: null,
    forge: null,
  });
  const task = store.createTask({
    projectId: project.id,
    title: 'Daemon task',
    briefText: 'Do the thing',
    deliveryMode: 'local',
    methodology: 'free',
    spec: null,
  });
  return { project, task };
}

function startRun(store: Store, taskId: string): string {
  const runId = newId('run');
  store.startRun({
    taskId,
    runId,
    attempt: store.nextAttempt(taskId),
    harnessId: 'fake',
    backend: 'process',
    logPath: '/tmp/demo.log',
    worktreePath: '/tmp/worktree',
    branch: 'crew/test',
  });
  return runId;
}

function reportFor(taskId: string, runId: string): ReportPayload {
  return {
    schema: 'crew.report/v1',
    task_id: taskId,
    run_id: runId,
    status: 'done',
    summary: 'Done',
  };
}

const successfulExecutor: DaemonExecutor = async (store, _context, options) => {
  const runId = startRun(store, options.taskId);
  store.markRunRunning(runId, process.pid);
  store.recordReport(reportFor(options.taskId, runId));
  const task = store.finishRun({
    runId,
    exitCode: 0,
    signal: null,
    timedOut: false,
  });
  const run = store.getRun(runId);
  if (!run) {
    throw new Error('run missing');
  }
  return {
    task,
    outcome: 'review',
    stage: task.stage,
    runs: store.listRuns(task.id),
    report: store.getReportByRun(runId),
    developerReport: store.getReportByRun(runId),
    testerReport: null,
    verifications: [],
    ci: null,
    commitSha: task.commitSha,
    prUrl: task.prUrl,
  };
};

afterEach(() => {
  while (stores.length > 0) {
    stores.pop()?.close();
  }
});

describe('leases', () => {
  it('acquires, renews, releases, and takes over expired leases', () => {
    const store = createStore();
    const now = Date.parse('2026-01-01T00:00:00.000Z');

    const first = store.acquireLease('daemon', 'host:1', 30, now);
    expect(first?.owner).toBe('host:1');
    expect(store.acquireLease('daemon', 'host:2', 30, now + 1000)).toBeNull();

    expect(store.renewLease('daemon', 'host:1', 30, now + 25_000)).toBe(true);
    expect(store.renewLease('daemon', 'host:2', 30, now + 25_000)).toBe(false);

    expect(store.acquireLease('daemon', 'host:2', 30, now + 60_000)?.owner).toBe(
      'host:2',
    );
    expect(store.releaseLease('daemon', 'host:1')).toBe(false);
    expect(store.releaseLease('daemon', 'host:2')).toBe(true);
    expect(store.getLease('daemon')).toBeNull();
  });
});

describe('run reconciliation', () => {
  it('marks dead runs as lost and fails their tasks', () => {
    const store = createStore();
    const { task } = createTask(store);
    const runId = startRun(store, task.id);
    store.markRunRunning(runId, 4242);

    const lost = store.reconcileStaleRuns({ isAlive: () => false });
    expect(lost).toHaveLength(1);
    expect(lost[0]?.runId).toBe(runId);
    expect(lost[0]?.reason).toContain('4242');
    expect(store.getRun(runId)?.state).toBe('lost');
    expect(store.getTaskOrThrow(task.id).state).toBe('failed');

    const types = store.listEvents({ taskId: task.id }).map((event) => event.type);
    expect(types).toContain('run.lost');
    expect(types).toContain('task.failed');
  });

  it('leaves live runs alone', () => {
    const store = createStore();
    const { task } = createTask(store);
    const runId = startRun(store, task.id);
    store.markRunRunning(runId, process.pid);

    expect(store.reconcileStaleRuns({ isAlive: () => true })).toHaveLength(0);
    expect(store.getRun(runId)?.state).toBe('running');
    expect(store.getTaskOrThrow(task.id).state).toBe('running');
  });

  it('uses a grace period for runs that never recorded a pid', () => {
    const store = createStore();
    const { task } = createTask(store);
    const runId = startRun(store, task.id);

    expect(store.reconcileStaleRuns({ staleAfterMs: 30_000 })).toHaveLength(0);
    const later = Date.now() + 31_000;
    expect(store.reconcileStaleRuns({ staleAfterMs: 30_000, now: later })).toHaveLength(1);
    expect(store.getRun(runId)?.state).toBe('lost');
  });
});

describe('daemon', () => {
  it('processes a queued task once and releases the lease', async () => {
    const store = createStore();
    const { task } = createTask(store);
    store.queueTask(task.id);

    const result = await runDaemon(store, context(), {
      once: true,
      execute: successfulExecutor,
    });

    expect(result.stopped).toBe('once');
    expect(result.processed).toHaveLength(1);
    expect(result.processed[0]?.taskState).toBe('done');
    expect(store.getTaskOrThrow(task.id).state).toBe('done');
    expect(store.getLease('daemon')).toBeNull();
  });

  it('returns idle when there is nothing queued', async () => {
    const store = createStore();
    const result = await runDaemon(store, context(), {
      once: true,
      execute: successfulExecutor,
    });
    expect(result.stopped).toBe('idle');
    expect(result.processed).toHaveLength(0);
    expect(store.getLease('daemon')).toBeNull();
  });

  it('fails the task and keeps the daemon alive when execution throws', async () => {
    const store = createStore();
    const { task } = createTask(store);
    store.queueTask(task.id);

    const result = await runDaemon(store, context(), {
      once: true,
      execute: async () => {
        throw new Error('harness exploded');
      },
    });

    expect(result.processed[0]?.error).toContain('harness exploded');
    expect(result.processed[0]?.taskState).toBe('failed');
    expect(store.getTaskOrThrow(task.id).state).toBe('failed');
    expect(store.getTaskOrThrow(task.id).state).not.toBe('queued');
    expect(store.getLease('daemon')).toBeNull();
  });

  it('refuses to start when another daemon holds the lease', async () => {
    const store = createStore();
    store.acquireLease('daemon', 'other-host:1', 60);

    await expect(
      runDaemon(store, context(), { once: true, execute: successfulExecutor }),
    ).rejects.toThrow('Another daemon holds the lease');
    expect(store.getLease('daemon')?.owner).toBe('other-host:1');
  });
});

describe('task queueing', () => {
  it('queues drafts, retries failures, and rejects the wrong states', () => {
    const store = createStore();
    const { task } = createTask(store);

    expect(store.queueTask(task.id).state).toBe('queued');
    expect(store.queueTask(task.id).state).toBe('queued');

    const runId = startRun(store, task.id);
    store.finishRun({ runId, exitCode: 1, signal: null, timedOut: false });
    expect(store.getTaskOrThrow(task.id).state).toBe('failed');

    expect(store.retryTask(task.id).state).toBe('queued');
    expect(() => store.retryTask(task.id)).toThrow('only failed tasks can be retried');
  });
});
