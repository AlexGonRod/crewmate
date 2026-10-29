import { hostname } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { runDaemon, type DaemonExecutor } from '../../src/app/daemon';
import { runPipeline, type PipelineResult } from '../../src/app/pipeline';
import { CrewError } from '../../src/core/errors';
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
      projectsDir: '/tmp/crew/projects',
      worktreesDir: '/tmp/crew/worktrees',
      tasksDir: '/tmp/crew/tasks',
      logsDir: '/tmp/crew/logs',
    },
    config: {
      harness: 'fake',
      timeoutSeconds: 60,
      agents: { developer: {}, tester: {}, captain: {} },
      review: { maxIterations: 3, mode: 'full' },
      delivery: 'local',
      scheduling: { concurrency: 1, mode: 'serial' },
    },
  };
}

function contextWith(scheduling: { concurrency: number; mode: 'serial' | 'parallel' }): ResolvedContext {
  const base = context();
  return {
    ...base,
    config: { ...base.config, scheduling },
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

function completeTask(store: Store, taskId: string): PipelineResult {
  const runId = startRun(store, taskId);
  store.markRunRunning(runId, process.pid);
  store.recordReport(reportFor(taskId, runId));
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
    merge: null,
    commitSha: task.commitSha,
    prUrl: task.prUrl,
  };
}

const successfulExecutor: DaemonExecutor = async (store, _context, options) =>
  completeTask(store, options.taskId);

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

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

  it('takes over a lease whose holder process is dead', () => {
    const store = createStore();
    const deadPid = 999_999;
    const owner = `${hostname()}:${deadPid}`;

    expect(store.acquireLease('daemon', owner, 30)).not.toBeNull();
    const taken = store.acquireLease('daemon', `${hostname()}:${process.pid}`, 30);
    expect(taken?.owner).toBe(`${hostname()}:${process.pid}`);
  });

  it('does not take over a lease held by a live process', () => {
    const store = createStore();
    const owner = `${hostname()}:${process.pid}`;
    expect(store.acquireLease('daemon', owner, 30)).not.toBeNull();
    expect(store.acquireLease('daemon', `${hostname()}:999999`, 30)).toBeNull();
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

  it('runs up to the configured concurrency and refills freed slots', async () => {
    const store = createStore();
    const tasks = [
      createTask(store).task,
      createTask(store).task,
      createTask(store).task,
    ];
    for (const task of tasks) {
      store.queueTask(task.id);
    }

    const launched: string[] = [];
    const finishers = new Map<string, () => void>();
    const execute: DaemonExecutor = (execStore, _context, options) =>
      new Promise<PipelineResult>((resolve) => {
        launched.push(options.taskId);
        finishers.set(options.taskId, () =>
          resolve(completeTask(execStore, options.taskId)),
        );
      });

    const daemon = runDaemon(store, context(), {
      intervalMs: 250,
      concurrency: 2,
      maxTasks: 3,
      execute,
    });

    await waitFor(() => launched.length === 2);
    expect(launched).toHaveLength(2);
    expect(new Set(launched).size).toBe(2);

    finishers.get(launched[0]!)!();
    await waitFor(() => launched.length === 3);
    expect(new Set(launched).size).toBe(3);

    finishers.get(launched[1]!)!();
    finishers.get(launched[2]!)!();
    const result = await daemon;

    expect(result.stopped).toBe('max_tasks');
    expect(result.processed).toHaveLength(3);
    for (const task of tasks) {
      expect(store.getTaskOrThrow(task.id).state).toBe('done');
    }
  });

  it('keeps concurrency at one by default', async () => {
    const store = createStore();
    const tasks = [createTask(store).task, createTask(store).task];
    for (const task of tasks) {
      store.queueTask(task.id);
    }

    const launched: string[] = [];
    const finishers = new Map<string, () => void>();
    const execute: DaemonExecutor = (execStore, _context, options) =>
      new Promise<PipelineResult>((resolve) => {
        launched.push(options.taskId);
        finishers.set(options.taskId, () =>
          resolve(completeTask(execStore, options.taskId)),
        );
      });

    const daemon = runDaemon(store, context(), {
      intervalMs: 250,
      maxTasks: 2,
      execute,
    });

    await waitFor(() => launched.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(launched).toHaveLength(1);

    finishers.get(launched[0]!)!();
    await waitFor(() => launched.length === 2);
    finishers.get(launched[1]!)!();
    const result = await daemon;

    expect(result.stopped).toBe('max_tasks');
    expect(result.processed).toHaveLength(2);
  });

  it('stops scheduling on abort and leaves unstarted tasks queued', async () => {
    const store = createStore();
    const tasks = [
      createTask(store).task,
      createTask(store).task,
      createTask(store).task,
    ];
    for (const task of tasks) {
      store.queueTask(task.id);
    }

    const controller = new AbortController();
    const launched: string[] = [];
    const execute: DaemonExecutor = (execStore, _context, options) =>
      new Promise<PipelineResult>((resolve) => {
        launched.push(options.taskId);
        const finish = (): void =>
          resolve(completeTask(execStore, options.taskId));
        if (options.signal?.aborted) {
          finish();
          return;
        }
        options.signal?.addEventListener('abort', finish, { once: true });
      });

    const daemon = runDaemon(store, context(), {
      intervalMs: 250,
      concurrency: 2,
      signal: controller.signal,
      execute,
    });

    await waitFor(() => launched.length === 2);
    controller.abort();
    const result = await daemon;

    expect(result.stopped).toBe('aborted');
    expect(result.processed).toHaveLength(2);
    expect(new Set(result.processed.map((entry) => entry.taskId))).toEqual(
      new Set(launched),
    );
    const remaining = tasks.filter((task) => !launched.includes(task.id));
    expect(remaining).toHaveLength(1);
    expect(store.getTaskOrThrow(remaining[0]!.id).state).toBe('queued');
    expect(store.getLease('daemon')).toBeNull();
  });

  it('retries a transient failure until the attempt limit', async () => {
    const store = createStore();
    const { task } = createTask(store);
    store.queueTask(task.id);

    let attempts = 0;
    const result = await runDaemon(store, context(), {
      intervalMs: 10,
      maxTasks: 3,
      maxAttempts: 3,
      backoffMs: 0,
      execute: async () => {
        attempts += 1;
        throw new Error('harness exploded');
      },
    });

    expect(attempts).toBe(3);
    expect(result.processed).toHaveLength(3);
    expect(result.processed[0]?.retryInMs).not.toBeNull();
    expect(store.getTaskOrThrow(task.id).state).toBe('failed');
    expect(store.getTaskOrThrow(task.id).attempts).toBe(2);
  });

  it('requeues a transient failure instead of failing it', async () => {
    const store = createStore();
    const { task } = createTask(store);
    store.queueTask(task.id);

    const result = await runDaemon(store, context(), {
      intervalMs: 10,
      maxTasks: 1,
      maxAttempts: 2,
      backoffMs: 60_000,
      execute: async () => {
        throw new Error('harness exploded');
      },
    });

    expect(result.processed[0]?.taskState).toBe('queued');
    expect(result.processed[0]?.retryInMs).toBeGreaterThan(0);
    const requeued = store.getTaskOrThrow(task.id);
    expect(requeued.state).toBe('queued');
    expect(requeued.attempts).toBe(1);
    expect(requeued.nextAttemptAt).toBeTruthy();
  });

  it('does not retry permanent failures', async () => {
    const store = createStore();
    const { task } = createTask(store);
    store.queueTask(task.id);

    const result = await runDaemon(store, context(), {
      intervalMs: 10,
      maxTasks: 1,
      maxAttempts: 3,
      backoffMs: 0,
      execute: async () => {
        throw new CrewError('MERGE_POLICY_REQUIRED', 'no merge policy');
      },
    });

    expect(result.processed).toHaveLength(1);
    expect(result.processed[0]?.taskState).toBe('failed');
    expect(store.getTaskOrThrow(task.id).state).toBe('failed');
    expect(store.getTaskOrThrow(task.id).attempts).toBe(0);
  });

  it('requeues tasks whose run was lost when retries are enabled', async () => {
    const store = createStore();
    const { task } = createTask(store);
    store.queueTask(task.id);
    const runId = startRun(store, task.id);
    store.markRunRunning(runId, 999_999);

    const result = await runDaemon(store, context(), {
      intervalMs: 10,
      maxTasks: 1,
      maxAttempts: 2,
      backoffMs: 0,
      execute: successfulExecutor,
    });

    expect(result.reclaimed).toHaveLength(1);
    expect(store.getTaskOrThrow(task.id).state).toBe('done');
    expect(store.getTaskOrThrow(task.id).attempts).toBe(1);
  });

  it('runs tasks of the same project one at a time in serial mode', async () => {
    const store = createStore();
    const { project, task } = createTask(store);
    const second = store.createTask({
      projectId: project.id,
      title: 'Same project second task',
      briefText: 'Do the thing',
      deliveryMode: 'local',
      methodology: 'free',
      spec: null,
    });
    store.queueTask(task.id);
    store.queueTask(second.id);

    const running: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const execute: DaemonExecutor = async (execStore, _context, options) => {
      running.push(options.taskId);
      await gate;
      return completeTask(execStore, options.taskId);
    };

    const daemon = runDaemon(store, contextWith({ concurrency: 2, mode: 'serial' }), {
      intervalMs: 10,
      maxTasks: 2,
      execute,
    });
    await waitFor(() => running.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(running).toHaveLength(1);
    release();
    const result = await daemon;
    expect(result.processed).toHaveLength(2);
  });

  it('runs tasks of the same project in parallel in parallel mode', async () => {
    const store = createStore();
    const { project, task } = createTask(store);
    const second = store.createTask({
      projectId: project.id,
      title: 'Same project second task',
      briefText: 'Do the thing',
      deliveryMode: 'local',
      methodology: 'free',
      spec: null,
    });
    store.queueTask(task.id);
    store.queueTask(second.id);

    const running: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const execute: DaemonExecutor = async (execStore, _context, options) => {
      running.push(options.taskId);
      await gate;
      return completeTask(execStore, options.taskId);
    };

    const daemon = runDaemon(store, contextWith({ concurrency: 2, mode: 'parallel' }), {
      intervalMs: 10,
      maxTasks: 2,
      execute,
    });
    await waitFor(() => running.length === 2);
    release();
    const result = await daemon;
    expect(result.processed).toHaveLength(2);
  });

  it('takes the concurrency from the scheduling policy', async () => {
    const store = createStore();
    const { task } = createTask(store);
    store.queueTask(task.id);

    const result = await runDaemon(
      store,
      contextWith({ concurrency: 3, mode: 'parallel' }),
      { once: true, execute: successfulExecutor },
    );

    expect(result.processed).toHaveLength(1);
    expect(store.getTaskOrThrow(task.id).state).toBe('done');
  });

  it('leaves tasks leased by another process queued and retries later', async () => {
    const store = createStore();
    const leased = createTask(store).task;
    const free = createTask(store).task;
    store.queueTask(leased.id);
    store.queueTask(free.id);

    const launched: string[] = [];
    const execute: DaemonExecutor = async (execStore, _context, options) => {
      launched.push(options.taskId);
      if (options.taskId === leased.id) {
        throw new CrewError('TASK_LEASED', 'Task is already running');
      }
      return completeTask(execStore, options.taskId);
    };

    const result = await runDaemon(store, context(), {
      intervalMs: 250,
      maxTasks: 1,
      execute,
    });

    expect(result.stopped).toBe('max_tasks');
    expect(result.processed).toHaveLength(1);
    expect(result.processed[0]?.taskId).toBe(free.id);
    expect(launched).toEqual([leased.id, free.id]);
    expect(store.getTaskOrThrow(leased.id).state).toBe('queued');
    expect(store.getTaskOrThrow(free.id).state).toBe('done');
  });
});

describe('task execution leases', () => {
  it('rejects a task that another process is already executing', async () => {
    const store = createStore();
    const taskId = newId('tsk');
    store.acquireLease(`task:${taskId}`, 'other-host:1', 30);

    await expect(
      runPipeline(store, context(), { taskId }),
    ).rejects.toMatchObject({ code: 'TASK_LEASED' });
    expect(store.getLease(`task:${taskId}`)?.owner).toBe('other-host:1');
  });

  it('releases the task lease when execution fails', async () => {
    const store = createStore();
    const taskId = newId('tsk');

    await expect(
      runPipeline(store, context(), { taskId }),
    ).rejects.toThrow('Task not found');
    expect(store.getLease(`task:${taskId}`)).toBeNull();
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
