import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import path from 'node:path';
import { redactText } from '../../core/redact';

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
  onSpawn?: (pid: number) => void;
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

export function runProcess(options: RunProcessOptions): Promise<ProcessResult> {
  const {
    command,
    args,
    cwd,
    env,
    logPath,
    timeoutMs,
    stdin,
    quiet = false,
    onSpawn,
  } = options;

  mkdirSync(path.dirname(logPath), { recursive: true });
  const log = createWriteStream(logPath, { flags: 'a' });
  const processEnv = cleanEnv(env);
  const outputLimit = 1_000_000;
  let outputTail = '';
  let timedOut = false;
  let settled = false;

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
            const killTimer = setTimeout(() => killTree(child, 'SIGKILL'), 2000);
            killTimer.unref();
          }, timeoutMs)
        : null;

    const settle = (result: ProcessResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
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
      if (timer) {
        clearTimeout(timer);
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
