import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { CrewError } from '../../core/errors';
import {
  buildCommand,
  shellQuote,
} from './tmux';
import {
  type SessionBackend,
  type SessionInfo,
  type SessionRunResult,
  type SessionStatus,
  type StartSessionOptions,
  type WaitSessionOptions,
} from './types';

interface HerdrResponse {
  ok: boolean;
  stdout: string;
  stderr: string;
  json: any;
}

interface HerdrSessionState {
  name: string;
  workspaceId: string;
  paneId: string;
  exitFile: string | null;
  taskId: string | null;
  createdAt: string;
}

function herdr(args: string[]): HerdrResponse {
  const result = spawnSync('herdr', args, { encoding: 'utf8' });
  if (result.error) {
    return {
      ok: false,
      stdout: '',
      stderr: result.error.message,
      json: null,
    };
  }
  const stdout = result.stdout ?? '';
  let json: any = null;
  try {
    json = JSON.parse(stdout);
  } catch {
    json = null;
  }
  return {
    ok: (result.status ?? 1) === 0,
    stdout,
    stderr: result.stderr ?? '',
    json,
  };
}

/**
 * Runs the crew agents inside Herdr instead of tmux.
 *
 * A crew session is a Herdr workspace labelled with the session name, whose
 * root pane runs the agent. The exit code of the agent is written to a file
 * by the pane itself, because Herdr does not keep the exit status of a
 * process that already finished.
 */
export class HerdrBackend implements SessionBackend {
  readonly id = 'herdr' as const;

  constructor(private readonly stateDir: string) {}

  available(): boolean {
    const version = spawnSync('herdr', ['--version'], { encoding: 'utf8' });
    if (version.error) {
      return false;
    }
    return herdr(['status', 'server']).ok;
  }

  version(): string {
    const result = spawnSync('herdr', ['--version'], { encoding: 'utf8' });
    if (result.error) {
      return '';
    }
    return (result.stdout ?? '').trim();
  }

  private statePath(name: string): string {
    return path.join(this.stateDir, `${name}.json`);
  }

  private readState(name: string): HerdrSessionState | null {
    const file = this.statePath(name);
    if (!existsSync(file)) {
      return null;
    }
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as HerdrSessionState;
    } catch {
      return null;
    }
  }

  private writeState(state: HerdrSessionState): void {
    mkdirSync(this.stateDir, { recursive: true });
    writeFileSync(this.statePath(state.name), JSON.stringify(state, null, 2), 'utf8');
  }

  private findWorkspaceByLabel(label: string): { id: string; paneId: string } | null {
    const listed = herdr(['workspace', 'list']);
    if (!listed.ok || !listed.json?.result?.workspaces) {
      return null;
    }
    const workspace = (listed.json.result.workspaces as Array<{ label?: string; workspace_id: string }>).find(
      (item) => item.label === label,
    );
    if (!workspace) {
      return null;
    }
    const panes = herdr(['pane', 'list', '--workspace', workspace.workspace_id]);
    const first = panes.json?.result?.panes?.[0];
    if (!first?.pane_id) {
      return null;
    }
    return { id: workspace.workspace_id, paneId: first.pane_id as string };
  }

  start(options: StartSessionOptions): { ok: boolean; error?: string } {
    if (!this.available()) {
      return {
        ok: false,
        error:
          'herdr is not available (the binary or its background server is not running)',
      };
    }
    const existing = this.findWorkspaceByLabel(options.name);
    if (existing) {
      herdr(['pane', 'close', existing.paneId]);
      herdr(['workspace', 'close', existing.id]);
    }

    const created = herdr([
      'workspace',
      'create',
      '--cwd',
      options.cwd,
      '--label',
      options.name,
      '--no-focus',
    ]);
    const paneId = created.json?.result?.root_pane?.pane_id;
    const workspaceId = created.json?.result?.workspace?.workspace_id;
    if (!created.ok || !paneId || !workspaceId) {
      return {
        ok: false,
        error: `Could not create the herdr workspace ${options.name}: ${
          created.stderr.trim() || 'unknown error'
        }`,
      };
    }

    const exitFile = options.exitFile ?? null;
    // The command is written to a script file instead of being typed into the
    // pane: a terminal line is limited to a few kilobytes, and the crew
    // command carries the whole environment.
    const scriptFile = path.join(
      exitFile ? path.dirname(exitFile) : this.stateDir,
      'session.sh',
    );
    mkdirSync(path.dirname(scriptFile), { recursive: true });
    const command = buildCommand(options.command, options.args, options.env);
    const stdin = options.stdinPath ? ` < ${shellQuote(options.stdinPath)}` : '';
    const record = exitFile ? `printf '%s' "$?" > ${shellQuote(exitFile)}` : 'true';
    writeFileSync(scriptFile, `#!/bin/sh\n${command}${stdin}\n${record}\n`, 'utf8');
    const run = herdr(['pane', 'run', paneId, `sh ${shellQuote(scriptFile)}`]);
    if (!run.ok) {
      herdr(['workspace', 'close', workspaceId]);
      return {
        ok: false,
        error: `Could not run the agent in herdr: ${
          run.stderr.trim() || 'unknown error'
        }`,
      };
    }

    this.writeState({
      name: options.name,
      workspaceId,
      paneId,
      exitFile,
      taskId: options.name.replace(/^crew-/, '').split('-')[0] ?? null,
      createdAt: new Date().toISOString(),
    });
    return { ok: true };
  }

  pid(name: string): number | null {
    const state = this.readState(name);
    if (!state) {
      return null;
    }
    const info = herdr(['pane', 'process-info', '--pane', state.paneId]);
    const processes = info.json?.result?.process_info?.foreground_processes;
    const pid = processes?.[0]?.pid ?? info.json?.result?.process_info?.shell_pid;
    return typeof pid === 'number' && pid > 0 ? pid : null;
  }

  capture(name: string): string {
    const state = this.readState(name);
    if (!state) {
      return '';
    }
    const result = herdr([
      'pane',
      'read',
      state.paneId,
      '--source',
      'recent-unwrapped',
      '--lines',
      '200',
    ]);
    return result.ok ? result.stdout : '';
  }

  status(name: string): SessionStatus {
    const state = this.readState(name);
    if (!state) {
      return { dead: true, exitCode: null, agentState: null };
    }
    if (state.exitFile && existsSync(state.exitFile)) {
      const raw = readFileSync(state.exitFile, 'utf8').trim();
      const exitCode = Number(raw);
      return {
        dead: true,
        exitCode: Number.isFinite(exitCode) ? exitCode : null,
        agentState: null,
      };
    }
    const pane = herdr(['pane', 'get', state.paneId]);
    const agentState = pane.json?.result?.pane?.agent_status ?? null;
    return {
      dead: !pane.ok && agentState === null,
      exitCode: null,
      agentState: typeof agentState === 'string' ? agentState : null,
    };
  }

  async wait(name: string, options: WaitSessionOptions): Promise<SessionRunResult> {
    const pollMs = Math.max(100, options.pollMs ?? 400);
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
    const state = this.readState(name);
    if (!state) {
      return false;
    }
    herdr(['pane', 'close', state.paneId]);
    herdr(['workspace', 'close', state.workspaceId]);
    rmSync(this.statePath(name), { force: true });
    return true;
  }

  list(): SessionInfo[] {
    const listed = herdr(['workspace', 'list']);
    if (!listed.ok || !listed.json?.result?.workspaces) {
      return [];
    }
    const sessions: SessionInfo[] = [];
    for (const workspace of listed.json.result.workspaces as Array<{
      label?: string;
      workspace_id: string;
    }>) {
      const label = workspace.label ?? '';
      if (!label.startsWith('crew-')) {
        continue;
      }
      const state = this.readState(label);
      const status = this.status(label);
      sessions.push({
        name: label,
        taskId: state?.taskId ?? label.replace(/^crew-/, '').split('-')[0] ?? null,
        command: state ? 'herdr pane' : 'herdr workspace',
        createdAt: state?.createdAt ?? null,
        dead: status.dead,
        exitCode: status.exitCode,
        backend: 'herdr',
        agentState: status.agentState,
        attach: `herdr (workspace ${workspace.workspace_id})`,
      });
    }
    return sessions;
  }
}

export function assertHerdrAvailable(backend: HerdrBackend): void {
  if (!backend.available()) {
    throw new CrewError(
      'HERDR_UNAVAILABLE',
      'herdr is not available. Start it with "herdr" or use --session tmux.',
    );
  }
}
