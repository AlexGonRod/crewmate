import { hostname } from 'node:os';
import { CrewError, errorMessage } from '../core/errors';
import { isPidAlive, terminateProcessTree } from '../core/process';
import type { CiState, RiskLevel, Task, TaskState } from '../core/types';
import type { ResolvedContext } from '../config/config';
import type { LostRun, Store } from '../store/store';
import { runPipeline, type PipelineOptions, type PipelineResult } from './pipeline';
import { summarizeDetail } from './summary';

const DAEMON_RESOURCE = 'daemon';

export interface DaemonTaskResult {
  taskId: string;
  taskState: TaskState;
  runId: string | null;
  reportStatus: string | null;
  risk: RiskLevel | null;
  ciState: CiState | null;
  error?: string;
}

export interface DaemonResult {
  owner: string;
  reclaimed: LostRun[];
  processed: DaemonTaskResult[];
  stopped: 'once' | 'idle' | 'max_tasks' | 'aborted';
}

export type DaemonExecutor = (
  store: Store,
  context: ResolvedContext,
  options: PipelineOptions,
) => Promise<PipelineResult>;

export interface DaemonOptions {
  once?: boolean;
  intervalMs?: number;
  maxTasks?: number;
  harnessId?: string;
  testerHarnessId?: string;
  maxIterations?: number;
  timeoutSeconds?: number;
  env?: Record<string, string>;
  quiet?: boolean;
  concurrency?: number;
  staleAfterMs?: number;
  leaseTtlSeconds?: number;
  signal?: AbortSignal;
  onTask?: (result: DaemonTaskResult) => void;
  onReclaim?: (run: LostRun) => void;
  execute?: DaemonExecutor;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
    if (signal?.aborted) {
      done();
    }
  });
}

function waitForAny(
  promises: Array<Promise<unknown>>,
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
    for (const promise of promises) {
      promise.then(done, done);
    }
    if (signal?.aborted) {
      done();
    }
  });
}

function isLeaseConflict(error: unknown): boolean {
  return error instanceof CrewError && error.code === 'TASK_LEASED';
}

export async function runDaemon(
  store: Store,
  context: ResolvedContext,
  options: DaemonOptions = {},
): Promise<DaemonResult> {
  const execute = options.execute ?? runPipeline;
  const intervalMs = Math.max(250, options.intervalMs ?? 5000);
  const concurrency = options.once
    ? 1
    : Math.max(
        1,
        Math.floor(
          Number.isFinite(options.concurrency) ? (options.concurrency as number) : 1,
        ),
      );
  const staleAfterMs = options.staleAfterMs ?? 30_000;
  const leaseTtlSeconds = Math.max(
    options.leaseTtlSeconds ?? 30,
    Math.ceil((intervalMs * 2) / 1000),
  );
  const owner = `${hostname()}:${process.pid}`;

  const lease = store.acquireLease(DAEMON_RESOURCE, owner, leaseTtlSeconds);
  if (!lease) {
    const held = store.getLease(DAEMON_RESOURCE);
    throw new CrewError(
      'DAEMON_RUNNING',
      `Another daemon holds the lease: ${held?.owner ?? 'unknown'} (expires ${held?.expiresAt ?? 'unknown'})`,
    );
  }

  const reclaimed: LostRun[] = [];
  const processed: DaemonTaskResult[] = [];
  const active = new Map<string, Promise<void>>();
  const activeTaskIds = new Set<string>();
  const cooldowns = new Map<string, number>();
  let stopped: DaemonResult['stopped'] = 'idle';
  let stopping = false;
  let leaseLost = false;
  let started = 0;

  const terminateActive = (): void => {
    for (const taskId of activeTaskIds) {
      const run = store.getActiveRun(taskId);
      if (run?.pid) {
        terminateProcessTree(run.pid, 'SIGTERM');
      }
    }
  };

  const startTask = (task: Task): void => {
    started += 1;
    activeTaskIds.add(task.id);
    const execution = (async (): Promise<void> => {
      let entry: DaemonTaskResult | null = null;
      try {
        const harnessId =
          options.harnessId ?? task.harnessId ?? context.config.harness;
        const result = await execute(store, context, {
          taskId: task.id,
          developerHarnessId: harnessId,
          testerHarnessId: options.testerHarnessId,
          maxIterations: options.maxIterations,
          timeoutSeconds: options.timeoutSeconds,
          env: options.env ?? {},
          quiet: options.quiet,
          signal: options.signal,
        });
        const summary = summarizeDetail(store.getTaskDetail(task.id));
        entry = {
          taskId: task.id,
          taskState: result.task.state,
          runId: result.runs.at(-1)?.id ?? null,
          reportStatus: result.report?.status ?? null,
          risk: summary.risk?.level ?? null,
          ciState: summary.ci?.state ?? null,
        };
      } catch (error) {
        if (isLeaseConflict(error)) {
          started -= 1;
          cooldowns.set(task.id, Date.now() + intervalMs);
          return;
        }
        const message = errorMessage(error);
        const failed = store.failTask(
          task.id,
          `Daemon could not run task: ${message}`,
        );
        entry = {
          taskId: task.id,
          taskState: failed.state,
          runId: null,
          reportStatus: null,
          risk: null,
          ciState: null,
          error: message,
        };
      } finally {
        activeTaskIds.delete(task.id);
        active.delete(task.id);
      }
      if (entry) {
        processed.push(entry);
        options.onTask?.(entry);
      }
    })();
    active.set(task.id, execution);
  };

  const onAbort = (): void => {
    stopping = true;
    terminateActive();
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });

  const heartbeat = setInterval(
    () => {
      if (!store.renewLease(DAEMON_RESOURCE, owner, leaseTtlSeconds)) {
        leaseLost = true;
      }
    },
    Math.max(5000, Math.floor((leaseTtlSeconds * 1000) / 3)),
  );

  let failure: unknown;
  try {
    while (true) {
      if (leaseLost) {
        throw new CrewError('DAEMON_LEASE_LOST', 'Daemon lease was lost');
      }
      store.renewLease(DAEMON_RESOURCE, owner, leaseTtlSeconds);

      for (const run of store.reconcileStaleRuns({
        isAlive: isPidAlive,
        staleAfterMs,
      })) {
        reclaimed.push(run);
        options.onReclaim?.(run);
      }

      if (options.signal?.aborted || stopping) {
        stopped = 'aborted';
        break;
      }

      while (
        !stopping &&
        active.size < concurrency &&
        !(options.maxTasks !== undefined && started >= options.maxTasks)
      ) {
        const now = Date.now();
        for (const [taskId, until] of cooldowns) {
          if (until <= now) {
            cooldowns.delete(taskId);
          }
        }
        const task = store.nextQueuedTask([
          ...activeTaskIds,
          ...cooldowns.keys(),
        ]);
        if (!task) {
          break;
        }
        startTask(task);
      }

      if (options.signal?.aborted || stopping) {
        stopped = 'aborted';
        break;
      }

      if (options.once) {
        await Promise.all(active.values());
        stopped = processed.length > 0 ? 'once' : 'idle';
        break;
      }

      if (
        options.maxTasks !== undefined &&
        started >= options.maxTasks &&
        active.size === 0
      ) {
        stopped = 'max_tasks';
        break;
      }

      if (active.size === 0) {
        await sleep(intervalMs, options.signal);
        continue;
      }

      await waitForAny([...active.values()], intervalMs, options.signal);
    }
  } catch (error) {
    failure = error;
    stopping = true;
    terminateActive();
  } finally {
    await Promise.allSettled(active.values());
    clearInterval(heartbeat);
    options.signal?.removeEventListener('abort', onAbort);
    store.releaseLease(DAEMON_RESOURCE, owner);
  }

  if (failure) {
    throw failure;
  }
  return { owner, reclaimed, processed, stopped };
}
