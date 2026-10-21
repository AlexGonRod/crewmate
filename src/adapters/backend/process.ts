import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import path from 'node:path';
import { redactText } from '../../core/redact';
import { sessionPid, startSession, waitForSession } from '../../app/session';
import { remoteProcessOptions, type RemoteRunner } from '../../app/runner';

export interface ProcessResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  outputTail: string;
}

export interface RunProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  logPath: string;
  timeoutMs: number;
  stdin?: string;
  quiet?: boolean;
  signal?: AbortSignal;
  onSpawn?: (pid: number) => void;
  session?: string;
  stdinPath?: string;
  remote?: RemoteRunner | null;
}

function cleanEnv(env: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) {
    return;
  }
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall through to the direct kill.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // The process may already be gone.
  }
}

async function runSessionProcess(
  options: RunProcessOptions,
  name: string,
): Promise<ProcessResult> {
  const { command, args, cwd, env, logPath, timeoutMs, quiet = false, signal, onSpawn } =
    options;
  mkdirSync(path.dirname(logPath), { recursive: true });
  const log = createWriteStream(logPath, { flags: 'a' });
  const processEnv = cleanEnv(env);
  const writeLog = (stream: string, line: string): void => {
    log.write(`${JSON.stringify({ ts: new Date().toISOString(), stream, line })}\n`);
  };

  writeLog('crew', `tmux session started: ${name} (${command} ${args.join(' ')})`);
  const started = startSession({
    name,
    command,
    args,
    cwd,
    env,
    stdinPath: options.stdinPath,
  });
  if (!started.ok) {
    log.end();
    throw new Error(started.error ?? `Could not start the tmux session ${name}`);
  }

  const pid = sessionPid(name);
  if (pid && onSpawn) {
    try {
      onSpawn(pid);
    } catch (error) {
      writeLog('crew', `onSpawn failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const result = await waitForSession(name, {
    timeoutMs,
    signal,
  });

  const output = redactText(result.output, processEnv);
  writeLog('stdout', output);
  if (!quiet && output.trim()) {
    process.stdout.write(`${output}\n`);
  }
  writeLog(
    'crew',
    `tmux session finished: code=${result.exitCode} timed_out=${result.timedOut}`,
  );
  log.end();
  return {
    exitCode: result.exitCode,
    signal: null,
    timedOut: result.timedOut,
    outputTail: output,
  };
}

export function runProcess(input: RunProcessOptions): Promise<ProcessResult> {
  if (input.remote) {
    return runProcess(remoteProcessOptions(input, input.remote));
  }
  const options = input;
  if (options.session) {
    return runSessionProcess(options, options.session);
  }
  const {
    command,
    args,
    cwd,
    env,
    logPath,
    timeoutMs,
    stdin,
    quiet = false,
    signal,
    onSpawn,
  } = options;

  mkdirSync(path.dirname(logPath), { recursive: true });
  const log = createWriteStream(logPath, { flags: 'a' });
  const processEnv = cleanEnv(env);
  const outputLimit = 1_000_000;
  let outputTail = '';
  let timedOut = false;
  let settled = false;
  let killTimer: NodeJS.Timeout | null = null;

  const writeLog = (stream: string, line: string): void => {
    log.write(`${JSON.stringify({ ts: new Date().toISOString(), stream, line })}\n`);
  };

  writeLog('crew', `process started: ${command} ${args.join(' ')}`);

  return new Promise<ProcessResult>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        cwd,
        env: processEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
    } catch (error) {
      log.end();
      reject(error);
      return;
    }

    if (child.pid && onSpawn) {
      try {
        onSpawn(child.pid);
      } catch (error) {
        writeLog('crew', `onSpawn failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const appendOutput = (text: string): void => {
      outputTail = (outputTail + text).slice(-outputLimit);
    };

    const attach = (stream: NodeJS.ReadableStream | null, name: string): void => {
      if (!stream) {
        return;
      }
      let buffer = '';
      stream.on('data', (chunk: Buffer | string) => {
        const text = redactText(chunk.toString(), processEnv);
        appendOutput(text);
        buffer += text;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (line.length === 0) {
            continue;
          }
          writeLog(name, line);
          if (!quiet) {
            const target = name === 'stderr' ? process.stderr : process.stdout;
            target.write(`${line}\n`);
          }
        }
      });
      stream.on('end', () => {
        if (buffer.length > 0) {
          writeLog(name, buffer);
          if (!quiet) {
            const target = name === 'stderr' ? process.stderr : process.stdout;
            target.write(`${buffer}\n`);
          }
          buffer = '';
        }
      });
    };

    attach(child.stdout, 'stdout');
    attach(child.stderr, 'stderr');

    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            writeLog('crew', `process timed out after ${timeoutMs}ms`);
            killTree(child, 'SIGTERM');
            if (killTimer) {
              clearTimeout(killTimer);
            }
            killTimer = setTimeout(() => killTree(child, 'SIGKILL'), 2000);
            killTimer.unref();
          }, timeoutMs)
        : null;

    const onAbort = (): void => {
      if (settled) {
        return;
      }
      writeLog('crew', 'process aborted');
      killTree(child, 'SIGTERM');
      if (killTimer) {
        clearTimeout(killTimer);
      }
      killTimer = setTimeout(() => killTree(child, 'SIGKILL'), 2000);
      killTimer.unref();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
    }

    const settle = (result: ProcessResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      if (timer) {
        clearTimeout(timer);
      }
      if (killTimer) {
        clearTimeout(killTimer);
      }
      writeLog('crew', `process exited: code=${result.exitCode} signal=${result.signal} timed_out=${result.timedOut}`);
      log.end();
      resolve(result);
    };

    child.on('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      if (timer) {
        clearTimeout(timer);
      }
      if (killTimer) {
        clearTimeout(killTimer);
      }
      writeLog('crew', `process error: ${error.message}`);
      log.end();
      reject(error);
    });

    child.on('close', (code, signal) => {
      settle({
        exitCode: code,
        signal,
        timedOut,
        outputTail,
      });
    });

    if (stdin !== undefined && child.stdin) {
      child.stdin.on('error', () => {
        // The agent may not read stdin; that is not fatal.
      });
      child.stdin.end(stdin);
    }
  });
}
