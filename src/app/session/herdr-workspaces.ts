import { uniqueAgentName } from './interactive';
import { paneSplitArgs } from './layout';
import type { HerdrRunner, WorkspaceHandle } from './herdr-types';

/** `herdr tab focus`; false when the tab is gone or Herdr refuses. */
export function focusTab(run: HerdrRunner, tabId: string): boolean {
  return run(['tab', 'focus', tabId]).ok;
}

/** `herdr workspace focus`; false when the workspace is gone or Herdr refuses. */
export function focusWorkspace(run: HerdrRunner, workspaceId: string): boolean {
  return run(['workspace', 'focus', workspaceId]).ok;
}

export function findWorkspace(
  run: HerdrRunner,
  label: string,
): { id: string; paneId?: string } | null {
  const listed = run(['workspace', 'list']);
  if (!listed.ok || !listed.json?.result?.workspaces) {
    return null;
  }
  const workspace = (
    listed.json.result.workspaces as Array<{ label?: string; workspace_id: string }>
  ).find((item) => item.label === label);
  if (!workspace) {
    return null;
  }
  const panes = run(['pane', 'list', '--workspace', workspace.workspace_id]);
  const first = panes.json?.result?.panes?.[0];
  // A workspace whose tabs were all closed still exists: report it without
  // a pane so the caller creates a new tab instead of a duplicate workspace.
  return {
    id: workspace.workspace_id,
    paneId: first?.pane_id as string | undefined,
  };
}

/**
 * The workspace for a session plus the tab and root pane that Herdr creates
 * with it. Reusing that tab avoids leaving an empty first tab: `workspace
 * create` already opens one, so a following `tab create` would stack a
 * second tab next to it.
 */
export function ensureWorkspace(
  run: HerdrRunner,
  label: string,
  cwd: string,
): WorkspaceHandle | null {
  const existing = findWorkspace(run, label);
  if (existing) {
    return { id: existing.id };
  }
  const created = run([
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
    return {
      id: id as string,
      tabId: created.json?.result?.tab?.tab_id as string | undefined,
      paneId: created.json?.result?.root_pane?.pane_id as string | undefined,
    };
  }
  // Another crew run may have created it between the list and the create.
  const fallback = findWorkspace(run, label);
  return fallback ? { id: fallback.id } : null;
}

/**
 * The tab and root pane for a session: the workspace's own tab when crew just
 * created it (renamed to `label`), or a fresh `tab create` for an existing
 * workspace.
 */
export function openTab(
  run: HerdrRunner,
  workspace: WorkspaceHandle,
  cwd: string,
  label: string,
): { tabId: string; paneId: string } | { error: string } {
  if (workspace.tabId && workspace.paneId) {
    run(['tab', 'rename', workspace.tabId, label]);
    return { tabId: workspace.tabId, paneId: workspace.paneId };
  }
  const created = run([
    'tab',
    'create',
    '--workspace',
    workspace.id,
    '--cwd',
    cwd,
    '--label',
    label,
    '--no-focus',
  ]);
  const tabId = created.json?.result?.tab?.tab_id as string | undefined;
  const paneId = created.json?.result?.root_pane?.pane_id as string | undefined;
  if (!created.ok || !tabId || !paneId) {
    return { error: created.stderr.trim() || 'unknown error' };
  }
  return { tabId, paneId };
}

export function splitPane(
  run: HerdrRunner,
  paneId: string,
  direction: 'right' | 'down',
  cwd: string,
): string | null {
  const result = run(paneSplitArgs(paneId, direction, cwd));
  return result.json?.result?.pane?.pane_id ?? null;
}

export function paneExists(run: HerdrRunner, paneId: string): boolean {
  return run(['pane', 'get', paneId]).ok;
}

export function agentState(run: HerdrRunner, agentName: string | null | undefined): string | null {
  if (!agentName) {
    return null;
  }
  const agent = run(['agent', 'get', agentName]);
  const state = agent.json?.result?.agent?.agent_status;
  return agent.ok && typeof state === 'string' ? state : null;
}

export function agentNameFor(run: HerdrRunner, baseName: string): string {
  const listed = run(['agent', 'list']);
  const taken = new Set<string>();
  for (const agent of listed.json?.result?.agents ?? []) {
    if (typeof agent.name === 'string') {
      taken.add(agent.name);
    }
  }
  return uniqueAgentName(baseName, taken);
}
