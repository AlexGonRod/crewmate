import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { CrewError } from '../../core/errors';
import { readReportFile, validateReport } from '../../protocol/report';
import {
  CREW_SESSION_WORKSPACE,
  decideInteractiveRun,
  uniqueAgentName,
  type InteractiveReportState,
} from './interactive';
import {
  buildCommand,
  shellQuote,
} from './tmux';
import {
  type HerdrAgentKind,
  type SessionBackend,
  type SessionInfo,
  type SessionRunResult,
  type SessionStatus,
  type StartSessionOptions,
  type WaitSessionOptions,
} from './types';

export interface HerdrResponse {
  ok: boolean;
  stdout: string;
  stderr: string;
  json: any;
}

export type HerdrRunner = (args: string[]) => HerdrResponse;

interface HerdrSessionState {
  name: string;
  workspaceId: string;
  paneId: string;
  exitFile: string | null;
  taskId: string | null;
  createdAt: string;
  mode?: 'batch' | 'interactive';
  tabId?: string | null;
  agentName?: string | null;
  agentKind?: HerdrAgentKind | null;
  reportPath?: string | null;
  prompt?: string | null;
  workspaceLabel?: string | null;
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

function reportState(reportPath: string | null | undefined): InteractiveReportState {
  if (!reportPath) {
    return 'missing';
  }
  try {
    const raw = readReportFile(reportPath);
    if (raw === null) {
      return 'missing';
    }
    validateReport(raw);
    return 'valid';
  } catch {
    return 'invalid';
  }
}

/**
 * Runs the crew agents inside Herdr instead of tmux.
 *
 * A crew session is either a Herdr workspace labelled with the session name,
 * whose root pane runs the agent (batch), or an interactive agent of the run
 * harness in its own tab of the shared `crew-sessions` workspace (ADR 0031).
 */
export class HerdrBackend implements SessionBackend {
  readonly id = 'herdr' as const;

  constructor(
    private readonly stateDir: string,
    private readonly run: HerdrRunner = herdr,
  ) {}

  available(): boolean {
    return this.run(['status', 'server']).ok;
  }

  version(): string {
    const result = this.run(['--version']);
    return result.ok ? result.stdout.trim() : '';
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

  private listStates(): HerdrSessionState[] {
    try {
      return readdirSync(this.stateDir)
        .filter((entry) => entry.endsWith('.json'))
        .map((entry) => this.readState(entry.replace(/\.json$/, '')))
        .filter((state): state is HerdrSessionState => state !== null);
    } catch {
      return [];
    }
  }

  private findWorkspace(label: string): { id: string; paneId: string } | null {
    const listed = this.run(['workspace', 'list']);
    if (!listed.ok || !listed.json?.result?.workspaces) {
      return null;
    }
    const workspace = (listed.json.result.workspaces as Array<{ label?: string; workspace_id: string }>).find(
      (item) => item.label === label,
    );
    if (!workspace) {
      return null;
    }
    const panes = this.run(['pane', 'list', '--workspace', workspace.workspace_id]);
    const first = panes.json?.result?.panes?.[0];
    if (!first?.pane_id) {
      return null;
    }
    return { id: workspace.workspace_id, paneId: first.pane_id as string };
  }

  private ensureWorkspace(label: string, cwd: string): string | null {
    const existing = this.findWorkspace(label);
    if (existing) {
      return existing.id;
    }
    const created = this.run([
      'workspace',
      'create',
      '--cwd',
      cwd,
      '--label',
      label,
      '--no-focus',
    ]);
    const id = created.json?.result?.workspace?.workspace_id;
    if (created.ok && id) {
      return id as string;
    }
    // Another crew run may have created it between the list and the create.
    return this.findWorkspace(label)?.id ?? null;
  }

  private agentState(agentName: string | null | undefined): string | null {
    if (!agentName) {
      return null;
    }
    const agent = this.run(['agent', 'get', agentName]);
    const state = agent.json?.result?.agent?.agent_status;
    return agent.ok && typeof state === 'string' ? state : null;
  }

  private startInteractive(options: StartSessionOptions): { ok: boolean; error?: string } {
    const spec = options.interactive;
    if (!spec) {
      return { ok: false, error: 'interactive options are missing' };
    }
    const workspaceId = this.ensureWorkspace(spec.workspaceLabel, options.cwd);
    if (!workspaceId) {
      return {
        ok: false,
        error: `Could not find or create the herdr workspace ${spec.workspaceLabel}`,
      };
    }

    const created = this.run([
      'tab',
      'create',
      '--workspace',
      workspaceId,
      '--cwd',
      options.cwd,
      '--label',
      options.name,
      '--no-focus',
    ]);
    const tabId = created.json?.result?.tab?.tab_id;
    const paneId = created.json?.result?.root_pane?.pane_id;
    if (!created.ok || !tabId || !paneId) {
      return {
        ok: false,
        error: `Could not create the herdr tab for ${options.name}: ${
          created.stderr.trim() || 'unknown error'
        }`,
      };
    }

    const listed = this.run(['agent', 'list']);
    const taken = new Set<string>();
    for (const agent of listed.json?.result?.agents ?? []) {
      if (typeof agent.name === 'string') {
        taken.add(agent.name);
      }
    }
    const agentName = uniqueAgentName(spec.baseName, taken);

    const started = this.run([
      'agent',
      'start',
      agentName,
      '--kind',
      spec.kind,
      '--pane',
      paneId,
      '--timeout',
      '30000',
    ]);
    if (!started.ok) {
      this.run(['tab', 'close', tabId]);
      return {
        ok: false,
        error: `Could not start the ${spec.kind} agent ${agentName}: ${
          started.stderr.trim() || 'unknown error'
        }`,
      };
    }
    const ready = this.run([
      'agent',
      'wait',
      agentName,
      '--until',
      'idle',
      '--timeout',
      '30000',
    ]);
    if (!ready.ok) {
      this.run(['tab', 'close', tabId]);
      return {
        ok: false,
        error: `The ${spec.kind} agent ${agentName} did not become idle: ${
          ready.stderr.trim() || 'unknown error'
        }`,
      };
    }

    this.writeState({
      name: options.name,
      workspaceId,
      paneId,
      exitFile: null,
      taskId: options.name.replace(/^crew-/, '').split('-')[0] ?? null,
      createdAt: new Date().toISOString(),
      mode: 'interactive',
      tabId,
      agentName,
      agentKind: spec.kind,
      reportPath: spec.reportPath,
      prompt: spec.prompt,
      workspaceLabel: spec.workspaceLabel,
    });
    options.onEvent?.(`herdr tab created: ${tabId} (workspace ${workspaceId})`);
    options.onEvent?.(`${spec.kind} agent started: ${agentName} (pane ${paneId})`);
    return { ok: true };
  }

  start(options: StartSessionOptions): { ok: boolean; error?: string } {
    if (!this.available()) {
      return {
        ok: false,
        error:
          'herdr is not available (the binary or its background server is not running)',
      };
    }
    if (options.interactive) {
      return this.startInteractive(options);
    }
    const existing = this.findWorkspace(options.name);
    if (existing) {
      this.run(['pane', 'close', existing.paneId]);
      this.run(['workspace', 'close', existing.id]);
    }

    const created = this.run([
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
    const run = this.run(['pane', 'run', paneId, `sh ${shellQuote(scriptFile)}`]);
    if (!run.ok) {
      this.run(['workspace', 'close', workspaceId]);
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
      mode: 'batch',
    });
    return { ok: true };
  }

  pid(name: string): number | null {
    const state = this.readState(name);
    if (!state) {
      return null;
    }
    const info = this.run(['pane', 'process-info', '--pane', state.paneId]);
    const processes = info.json?.result?.process_info?.foreground_processes;
    const pid = processes?.[0]?.pid ?? info.json?.result?.process_info?.shell_pid;
    return typeof pid === 'number' && pid > 0 ? pid : null;
  }

  capture(name: string): string {
    const state = this.readState(name);
    if (!state) {
      return '';
    }
    if (state.mode === 'interactive' && state.agentName) {
      const result = this.run([
        'agent',
        'read',
        state.agentName,
        '--source',
        'recent-unwrapped',
        '--lines',
        '200',
      ]);
      if (result.ok) {
        return result.stdout;
      }
    }
    const result = this.run([
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
    if (state.mode === 'interactive') {
      const agentState = this.agentState(state.agentName);
      const decision = decideInteractiveRun({
        report: reportState(state.reportPath),
        agentState,
        timedOut: false,
      });
      return { dead: decision.done, exitCode: decision.exitCode, agentState };
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
    const pane = this.run(['pane', 'get', state.paneId]);
    const agentState = pane.json?.result?.pane?.agent_status ?? null;
    return {
      dead: !pane.ok && agentState === null,
      exitCode: null,
      agentState: typeof agentState === 'string' ? agentState : null,
    };
  }

  private waitInteractive(
    name: string,
    state: HerdrSessionState,
    options: WaitSessionOptions,
  ): Promise<SessionRunResult> {
    const pollMs = Math.max(100, options.pollMs ?? 500);
    const deadline = Date.now() + Math.max(0, options.timeoutMs);
    const agentName = state.agentName ?? '';
    let prompted = false;
    let timedOut = false;
    let lastSignature = '';

    return new Promise((resolve) => {
      const finish = (exitCode: number | null): void => {
        clearInterval(timer);
        options.signal?.removeEventListener('abort', onAbort);
        const output = this.capture(name);
        this.kill(name);
        resolve({ exitCode, output, timedOut });
      };
      const onAbort = (): void => {
        timedOut = true;
        options.onEvent?.('interactive run aborted');
        finish(null);
      };
      const timer = setInterval(() => {
        if (!prompted) {
          prompted = true;
          // `--wait` makes Herdr confirm the agent picked the prompt up (it
          // must show `working` or `blocked`), so a settled state that is
          // still the one before the prompt cannot be mistaken for the end.
          // The timeout is short: the run loop keeps polling afterwards.
          const sent = this.run([
            'agent',
            'prompt',
            agentName,
            state.prompt ?? '',
            '--wait',
            '--until',
            'working',
            '--until',
            'blocked',
            '--timeout',
            '5000',
          ]);
          if (!sent.ok) {
            // A stalled prompt may still have been delivered (Herdr does not
            // guarantee it was not); the report and the agent state decide.
            options.onEvent?.(
              `prompt to ${agentName} not confirmed: ${sent.stderr.trim() || 'unknown error'}`,
            );
          } else {
            options.onEvent?.(`prompt sent to ${agentName}`);
          }
        }
        const agentState = this.agentState(agentName);
        const report = reportState(state.reportPath);
        const signature = `${agentState ?? 'unknown'}:${report}`;
        if (signature !== lastSignature) {
          lastSignature = signature;
          options.onEvent?.(
            `agent ${agentName}: state=${agentState ?? 'unknown'} report=${report}`,
          );
        }
        const decision = decideInteractiveRun({
          report,
          agentState,
          timedOut: false,
        });
        if (decision.done) {
          if (decision.reason === 'blocked') {
            options.onEvent?.(`agent ${agentName} is blocked`);
          }
          if (decision.exitCode === 0) {
            options.onEvent?.(`report detected: ${state.reportPath ?? ''}`);
          }
          finish(decision.exitCode);
          return;
        }
        if (Date.now() >= deadline) {
          timedOut = true;
          options.onEvent?.(`interactive run timed out after ${options.timeoutMs}ms`);
          finish(null);
        }
      }, pollMs);
      options.signal?.addEventListener('abort', onAbort, { once: true });
      if (options.signal?.aborted) {
        onAbort();
      }
    });
  }

  async wait(name: string, options: WaitSessionOptions): Promise<SessionRunResult> {
    const state = this.readState(name);
    if (state?.mode === 'interactive') {
      return this.waitInteractive(name, state, options);
    }
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
    if (state.mode === 'interactive') {
      if (state.tabId) {
        this.run(['tab', 'close', state.tabId]);
      }
      // The shared crew-sessions workspace may host other runs: never close it.
      rmSync(this.statePath(name), { force: true });
      return true;
    }
    this.run(['pane', 'close', state.paneId]);
    this.run(['workspace', 'close', state.workspaceId]);
    rmSync(this.statePath(name), { force: true });
    return true;
  }

  list(): SessionInfo[] {
    const sessions: SessionInfo[] = [];
    const seen = new Set<string>();
    for (const state of this.listStates()) {
      if (state.mode !== 'interactive') {
        continue;
      }
      seen.add(state.name);
      const status = this.status(state.name);
      sessions.push({
        name: state.name,
        taskId: state.taskId,
        command: `herdr agent ${state.agentName ?? 'unknown'}${
          state.agentKind ? ` --kind ${state.agentKind}` : ''
        }`,
        createdAt: state.createdAt,
        dead: status.dead,
        exitCode: status.exitCode,
        backend: 'herdr',
        agentState: status.agentState,
        agentKind: state.agentKind ?? null,
        attach: `herdr (tab ${state.tabId ?? '-'})`,
      });
    }

    const listed = this.run(['workspace', 'list']);
    if (!listed.ok || !listed.json?.result?.workspaces) {
      return sessions;
    }
    for (const workspace of listed.json.result.workspaces as Array<{
      label?: string;
      workspace_id: string;
    }>) {
      const label = workspace.label ?? '';
      if (!label.startsWith('crew-') || seen.has(label)) {
        continue;
      }
      if (label === CREW_SESSION_WORKSPACE) {
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
        agentKind: null,
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
