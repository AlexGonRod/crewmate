import { hostname } from 'node:os';
import { CrewError, errorMessage } from '../core/errors';
import { isPidAlive, terminateProcessTree } from '../core/process';
import type { TaskState } from '../core/types';
import type { ResolvedContext } from '../config/config';
import type { LostRun, Store } from '../store/store';
import { runPipeline, type PipelineOptions, type PipelineResult } from './pipeline';

const DAEMON_RESOURCE = 'daemon';

export interface DaemonTaskResult {
  taskId: string;
  taskState: TaskState;
  runId: string | null;
  reportStatus: string | null;
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

export async function runDaemon(
  store: Store,
  context: ResolvedContext,
  options: DaemonOptions = {},
): Promise<DaemonResult> {
  const execute = options.execute ?? runPipeline;
  const intervalMs = Math.max(250, options.intervalMs ?? 5000);
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
  let stopped: DaemonResult['stopped'] = 'idle';
  let stopping = false;
  let leaseLost = false;
  let currentTaskId: string | null = null;

  const onAbort = (): void => {
    stopping = true;
    if (currentTaskId) {
      const active = store.getActiveRun(currentTaskId);
      if (active?.pid) {
        terminateProcessTree(active.pid, 'SIGTERM');
      }
    }
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

  try {
    do {
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

      if (options.maxTasks !== undefined && processed.length >= options.maxTasks) {
        stopped = 'max_tasks';
        break;
      }

      const task = store.nextQueuedTask();
      if (!task) {
        if (options.once) {
          stopped = 'idle';
          break;
        }
        await sleep(intervalMs, options.signal);
        continue;
      }

      const harnessId =
        options.harnessId ?? task.harnessId ?? context.config.harness;
      currentTaskId = task.id;
      let entry: DaemonTaskResult;
      try {
        const result = await execute(store, context, {
          taskId: task.id,
          developerHarnessId: harnessId,
          testerHarnessId: options.testerHarnessId,
          maxIterations: options.maxIterations,
          timeoutSeconds: options.timeoutSeconds,
          env: options.env ?? {},
          quiet: options.quiet,
        });
        entry = {
          taskId: task.id,
          taskState: result.task.state,
          runId: result.runs.at(-1)?.id ?? null,
          reportStatus: result.report?.status ?? null,
        };
      } catch (error) {
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
          error: message,
        };
      } finally {
        currentTaskId = null;
      }

      processed.push(entry);
      options.onTask?.(entry);

      if (options.once) {
        stopped = 'once';
        break;
      }
    } while (!stopping);
  } finally {
    clearInterval(heartbeat);
    options.signal?.removeEventListener('abort', onAbort);
    store.releaseLease(DAEMON_RESOURCE, owner);
  }

  return { owner, reclaimed, processed, stopped };
}
