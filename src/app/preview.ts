import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { CrewError } from '../core/errors';
import { isPidAlive, terminateProcessTree } from '../core/process';
import {
  listLivePreviews,
  previewLogPath,
  previewStatePath,
  readPreview,
  readStateFile,
  removeStateFile,
  type PreviewState,
} from './preview-state';
import { DEFAULT_PREVIEW_PORT, pickFreePort, previewUrl } from './preview-ports';

export type { PreviewState, PreviewStatus } from './preview-state';
export { listLivePreviews, readPreview, toStatus } from './preview-state';

export interface StartPreviewOptions {
  taskId: string;
  worktreePath: string;
  command: string;
  previewsDir: string;
  basePort?: number;
  timeoutMs?: number;
}

export interface StopPreviewResult {
  stopped: boolean;
  state: PreviewState | null;
}

const READY_POLL_MS = 200;
const READY_TIMEOUT_MS = 60_000;
const STOP_GRACE_MS = 3_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function probe(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const done = (ok: boolean): void => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(500);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function waitForPort(
  port: number,
  timeoutMs: number,
  alive: () => boolean,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe(port)) {
      return;
    }
    if (!alive()) {
      throw new Error(`preview process exited before port ${port} answered`);
    }
    await sleep(READY_POLL_MS);
  }
  throw new Error(`port ${port} did not answer within ${timeoutMs}ms`);
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) {
      return true;
    }
    await sleep(100);
  }
  return !isPidAlive(pid);
}

/**
 * Starts the preview command in the worktree, detached from this CLI, and
 * waits until the assigned port answers. The registry is written before the
 * wait so `--stop` can always find and kill the process.
 */
export async function startPreview(
  options: StartPreviewOptions,
): Promise<{ state: PreviewState; reused: boolean }> {
  const { taskId, worktreePath, command, previewsDir } = options;
  const existing = readPreview(previewsDir, taskId);
  if (existing) {
    return { state: existing, reused: true };
  }
  mkdirSync(previewsDir, { recursive: true });
  const used = new Set(listLivePreviews(previewsDir).map((state) => state.port));
  const port = await pickFreePort(options.basePort ?? DEFAULT_PREVIEW_PORT, {
    isUsed: (candidate) => used.has(candidate),
  });
  const withPlaceholder = command.includes('{port}');
  const resolvedCommand = withPlaceholder
    ? command.replaceAll('{port}', String(port))
    : command;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOST: '127.0.0.1',
    ...(withPlaceholder ? {} : { PORT: String(port) }),
  };
  const logPath = previewLogPath(previewsDir, taskId);
  const logFd = openSync(logPath, 'a');
  let child;
  try {
    child = spawn(resolvedCommand, {
      cwd: worktreePath,
      env,
      shell: true,
      detached: true,
      stdio: ['ignore', logFd, logFd],
    });
  } finally {
    closeSync(logFd);
  }
  child.unref();
  const pid = child.pid;
  if (!pid) {
    throw new CrewError(
      'PREVIEW_START_FAILED',
      `Could not start the preview for ${taskId}; log: ${logPath}`,
    );
  }
  const state: PreviewState = {
    taskId,
    port,
    pid,
    url: previewUrl(port),
    command: resolvedCommand,
    startedAt: new Date().toISOString(),
  };
  writeFileSync(previewStatePath(previewsDir, taskId), JSON.stringify(state, null, 2));
  try {
    await waitForPort(port, options.timeoutMs ?? READY_TIMEOUT_MS, () =>
      child.exitCode === null && isPidAlive(pid),
    );
  } catch {
    terminateProcessTree(pid, 'SIGKILL');
    removeStateFile(previewsDir, taskId);
    throw new CrewError(
      'PREVIEW_START_FAILED',
      `The preview for ${taskId} did not answer on ${previewUrl(port)}; log: ${logPath}`,
    );
  }
  return { state, reused: false };
}

/**
 * Stops the preview process group (SIGTERM, then SIGKILL) and removes its
 * registry. Idempotent: a task without a preview is not an error.
 */
export async function stopPreview(
  previewsDir: string,
  taskId: string,
): Promise<StopPreviewResult> {
  const state = readStateFile(previewsDir, taskId);
  if (!state) {
    removeStateFile(previewsDir, taskId);
    return { stopped: false, state: null };
  }
  let stopped = false;
  if (isPidAlive(state.pid)) {
    terminateProcessTree(state.pid, 'SIGTERM');
    if (!(await waitForExit(state.pid, STOP_GRACE_MS))) {
      terminateProcessTree(state.pid, 'SIGKILL');
    }
    stopped = true;
  }
  removeStateFile(previewsDir, taskId);
  return { stopped, state };
}
