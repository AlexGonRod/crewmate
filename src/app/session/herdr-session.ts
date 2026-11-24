import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { decideInteractiveRun, CREW_SESSION_WORKSPACE } from './interactive';
import { reportState } from './herdr-cli';
import { listStates, readState, removeLayout, removeState, writeState } from './herdr-state';
import type { HerdrContext } from './herdr-types';
import { agentState, findWorkspace } from './herdr-workspaces';
import { buildCommand, shellQuote } from './tmux';
import type { SessionInfo, SessionStatus, StartSessionOptions } from './types';

/** The batch path: one workspace per session, whose root pane runs the agent. */
export function startBatch(
  ctx: HerdrContext,
  options: StartSessionOptions,
): { ok: boolean; error?: string } {
  const existing = findWorkspace(ctx.run, options.name);
  if (existing) {
    if (existing.paneId) {
      ctx.run(['pane', 'close', existing.paneId]);
    }
    ctx.run(['workspace', 'close', existing.id]);
  }

  const created = ctx.run([
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
    exitFile ? path.dirname(exitFile) : ctx.stateDir,
    'session.sh',
  );
  mkdirSync(path.dirname(scriptFile), { recursive: true });
  const command = buildCommand(options.command, options.args, options.env);
  const stdin = options.stdinPath ? ` < ${shellQuote(options.stdinPath)}` : '';
  const record = exitFile ? `printf '%s' "$?" > ${shellQuote(exitFile)}` : 'true';
  writeFileSync(scriptFile, `#!/bin/sh\n${command}${stdin}\n${record}\n`, 'utf8');
  const run = ctx.run(['pane', 'run', paneId, `sh ${shellQuote(scriptFile)}`]);
  if (!run.ok) {
    ctx.run(['workspace', 'close', workspaceId]);
    return {
      ok: false,
      error: `Could not run the agent in herdr: ${run.stderr.trim() || 'unknown error'}`,
    };
  }

  writeState(ctx.stateDir, {
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

export function sessionStatus(ctx: HerdrContext, name: string): SessionStatus {
  const state = readState(ctx.stateDir, name);
  if (!state) {
    return { dead: true, exitCode: null, agentState: null };
  }
  if (state.mode === 'interactive') {
    const agent = agentState(ctx.run, state.agentName);
    const decision = decideInteractiveRun({
      report: reportState(state.reportPath),
      agentState: agent,
      timedOut: false,
    });
    return { dead: decision.done, exitCode: decision.exitCode, agentState: agent };
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
  const pane = ctx.run(['pane', 'get', state.paneId]);
  const agent = pane.json?.result?.pane?.agent_status ?? null;
  return {
    dead: !pane.ok && agent === null,
    exitCode: null,
    agentState: typeof agent === 'string' ? agent : null,
  };
}

/**
 * Stops a session. A graceful finish (the report was written and the agent
 * settled) leaves the agent idle in its pane and the task tab alive: the
 * reviewer surface still needs the layout, and the human can read the
 * conversation. Any other outcome closes the pane (stopping the agent) and,
 * when no other run of the task remains, the tab and the layout with it.
 * The shared crew-sessions workspace is never closed.
 */
export function killSession(
  ctx: HerdrContext,
  name: string,
  options?: { graceful?: boolean },
): boolean {
  const state = readState(ctx.stateDir, name);
  if (!state) {
    return false;
  }
  if (state.mode === 'interactive') {
    const graceful = options?.graceful === true;
    if (!graceful) {
      ctx.run(['pane', 'close', state.paneId]);
    }
    if (
      !graceful &&
      state.tabId &&
      !listStates(ctx.stateDir).some(
        (other) =>
          other.mode === 'interactive' && other.tabId === state.tabId && other.name !== name,
      )
    ) {
      ctx.run(['tab', 'close', state.tabId]);
      if (state.taskId) {
        removeLayout(ctx.stateDir, state.taskId);
      }
    }
    removeState(ctx.stateDir, name);
    return true;
  }
  ctx.run(['pane', 'close', state.paneId]);
  ctx.run(['workspace', 'close', state.workspaceId]);
  removeState(ctx.stateDir, name);
  return true;
}

export function listSessions(ctx: HerdrContext): SessionInfo[] {
  const sessions: SessionInfo[] = [];
  const seen = new Set<string>();
  for (const state of listStates(ctx.stateDir)) {
    if (state.mode !== 'interactive') {
      continue;
    }
    seen.add(state.name);
    const status = sessionStatus(ctx, state.name);
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

  const listed = ctx.run(['workspace', 'list']);
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
    const state = readState(ctx.stateDir, label);
    const status = sessionStatus(ctx, label);
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
