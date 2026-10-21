import path from 'node:path';
import { runProcess } from '../adapters/backend/process';
import { errorMessage } from '../core/errors';
import type { VerificationState } from '../core/types';

export const DEFAULT_VERIFY_TIMEOUT_SECONDS = 600;
const OUTPUT_LIMIT = 20_000;

export interface RunVerificationOptions {
  taskId: string;
  runId: string;
  worktreePath: string;
  commands: string[];
  timeoutSeconds?: number;
  tasksDir: string;
  env?: Record<string, string>;
  quiet?: boolean;
  signal?: AbortSignal;
}

export interface VerificationOutcome {
  command: string;
  state: VerificationState;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  output: string;
  logPath: string;
  error?: string;
}

export async function runVerificationCommands(
  options: RunVerificationOptions,
): Promise<VerificationOutcome[]> {
  const commands = options.commands
    .map((command) => command.trim())
    .filter((command) => command.length > 0);
  const outcomes: VerificationOutcome[] = [];
  for (const [index, command] of commands.entries()) {
    outcomes.push(await runVerificationCommand(command, index, options));
  }
  return outcomes;
}

async function runVerificationCommand(
  command: string,
  index: number,
  options: RunVerificationOptions,
): Promise<VerificationOutcome> {
  const logPath = path.join(
    options.tasksDir,
    options.taskId,
    'verifications',
    `${options.runId}-${index + 1}.log`,
  );
  const startedAt = Date.now();
  const shell =
    process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : '/bin/sh';
  const args =
    process.platform === 'win32'
      ? ['/d', '/s', '/c', command]
      : ['-c', command];

  try {
    const result = await runProcess({
      command: shell,
      args,
      cwd: options.worktreePath,
      env: {
        ...process.env,
        ...options.env,
        CREW_TASK_ID: options.taskId,
        CREW_RUN_ID: options.runId,
        CREW_WORKTREE: options.worktreePath,
        CREW_VERIFY: '1',
      },
      logPath,
      timeoutMs: (options.timeoutSeconds ?? DEFAULT_VERIFY_TIMEOUT_SECONDS) * 1000,
      quiet: options.quiet ?? true,
      signal: options.signal,
    });
    const durationMs = Date.now() - startedAt;
    const timedOut = result.timedOut;
    const passed = !timedOut && result.exitCode === 0;
    return {
      command,
      state: passed ? 'passed' : 'failed',
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut,
      durationMs,
      output: tail(result.outputTail, OUTPUT_LIMIT),
      logPath,
    };
  } catch (error) {
    return {
      command,
      state: 'error',
      exitCode: null,
      signal: null,
      timedOut: false,
      durationMs: Date.now() - startedAt,
      output: '',
      logPath,
      error: errorMessage(error),
    };
  }
}

function tail(value: string, limit: number): string {
  return value.length > limit ? value.slice(-limit) : value;
}
