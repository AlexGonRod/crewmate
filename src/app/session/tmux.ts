import { execFileSync, spawnSync } from 'node:child_process';
import {
  type SessionBackend,
  type SessionInfo,
  type SessionRunResult,
  type SessionStatus,
  type StartSessionOptions,
  type WaitSessionOptions,
} from './types';

function tmux(
  args: string[],
  options: { cwd?: string } = {},
): { status: number; stdout: string } {
  const result = spawnSync('tmux', args, {
    cwd: options.cwd,
    encoding: 'utf8',
  });
  if (result.error) {
    return { status: 1, stdout: '' };
  }
  return { status: result.status ?? 1, stdout: result.stdout ?? '' };
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function buildCommand(
  command: string,
  args: string[],
  env: Record<string, string | undefined>,
): string {
  const parts: string[] = [];
  const entries = Object.entries(env).filter(([, value]) => value !== undefined);
  if (entries.length > 0) {
    parts.push('env');
    for (const [key, value] of entries) {
      parts.push(`${key}=${shellQuote(value as string)}`);
    }
  }
  parts.push(shellQuote(command));
  for (const arg of args) {
    parts.push(shellQuote(arg));
  }
  return parts.join(' ');
}

export class TmuxBackend implements SessionBackend {
  readonly id = 'tmux' as const;

  available(): boolean {
    return tmux(['-V']).status === 0;
  }

  version(): string {
    try {
      return execFileSync('tmux', ['-V'], { encoding: 'utf8' }).trim();
    } catch {
      return '';
    }
  }

  start(options: StartSessionOptions): { ok: boolean; error?: string } {
    if (!this.available()) {
      return { ok: false, error: 'tmux is not available' };
    }
    const existing = tmux(['has-session', '-t', options.name]);
    if (existing.status === 0) {
      tmux(['kill-session', '-t', options.name]);
    }
    const command = buildCommand(options.command, options.args, options.env);
    const stdin = options.stdinPath ? ` < ${shellQuote(options.stdinPath)}` : '';
    const script = `tmux set-option -t ${shellQuote(options.name)} remain-on-exit on; ${command}${stdin}`;
    const created = tmux([
      'new-session',
      '-d',
      '-s',
      options.name,
      '-c',
      options.cwd,
      'sh',
      '-c',
      script,
    ]);
    if (created.status !== 0) {
      return { ok: false, error: `Could not create the tmux session ${options.name}` };
    }
    return { ok: true };
  }

  pid(name: string): number | null {
    const result = tmux(['list-panes', '-t', name, '-F', '#{pane_pid}']);
    if (result.status !== 0) {
      return null;
    }
    const pid = Number(result.stdout.trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  }

  capture(name: string): string {
    const result = tmux(['capture-pane', '-p', '-t', name, '-S', '-']);
    return result.status === 0 ? result.stdout : '';
  }

  status(name: string): SessionStatus {
    const result = tmux([
      'list-panes',
      '-t',
      name,
      '-F',
      '#{pane_dead} #{pane_dead_status}',
    ]);
    if (result.status !== 0) {
      return { dead: true, exitCode: null, agentState: null };
    }
    const [dead, status] = result.stdout.trim().split(/\s+/);
    return {
      dead: dead === '1',
      exitCode: status === undefined ? null : Number(status),
      agentState: null,
    };
  }

  async wait(name: string, options: WaitSessionOptions): Promise<SessionRunResult> {
    const pollMs = Math.max(50, options.pollMs ?? 250);
    const deadline = Date.now() + Math.max(0, options.timeoutMs);
    return new Promise((resolve) => {
      let timedOut = false;
      const finish = (exitCode: number | null): void => {
        clearInterval(timer);
        options.signal?.removeEventListener('abort', onAbort);
        resolve({
          exitCode,
          output: this.capture(name),
          timedOut,
        });
      };
      const onAbort = (): void => {
        timedOut = true;
        this.kill(name);
        finish(null);
      };
      const timer = setInterval(() => {
        const status = this.status(name);
        if (status.dead) {
          finish(status.exitCode);
          return;
        }
        if (Date.now() >= deadline) {
          timedOut = true;
          this.kill(name);
          finish(null);
        }
      }, pollMs);
      options.signal?.addEventListener('abort', onAbort, { once: true });
      if (options.signal?.aborted) {
        onAbort();
      }
    });
  }

  kill(name: string): boolean {
    return tmux(['kill-session', '-t', name]).status === 0;
  }

  list(): SessionInfo[] {
    const result = tmux([
      'list-sessions',
      '-F',
      '#{session_name}\t#{session_created}\t#{session_windows}',
    ]);
    if (result.status !== 0) {
      return [];
    }
    const sessions: SessionInfo[] = [];
    for (const line of result.stdout.split('\n')) {
      const [name, created, windows] = line.split('\t');
      if (!name || !name.startsWith('crew-')) {
        continue;
      }
      const withoutPrefix = name.replace(/^crew-/, '');
      const taskId = withoutPrefix.split('-')[0] ?? withoutPrefix;
      const status = this.status(name);
      sessions.push({
        name,
        taskId,
        command: `${windows ?? '1'} window(s)`,
        createdAt: created ? new Date(Number(created) * 1000).toISOString() : null,
        dead: status.dead,
        exitCode: status.exitCode,
        backend: 'tmux',
        agentState: null,
        attach: `tmux attach -t ${name}`,
      });
    }
    return sessions;
  }
}
