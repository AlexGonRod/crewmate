import { sessionTabLabel } from './interactive';
import { startAgent } from './herdr-agent';
import { removeLayout, reusableLayout, saveLayout, writeState } from './herdr-state';
import type { HerdrContext } from './herdr-types';
import {
  agentNameFor,
  ensureWorkspace,
  openTab,
  paneExists,
  splitPane,
} from './herdr-workspaces';
import type { TaskLayout } from './layout';
import type { StartSessionOptions } from './types';

type InteractiveSpec = NonNullable<StartSessionOptions['interactive']>;

export function startInteractive(
  ctx: HerdrContext,
  options: StartSessionOptions,
  spec: InteractiveSpec,
): { ok: boolean; error?: string } {
  const layout = spec.taskId ? reusableLayout(ctx.stateDir, spec.taskId, ctx.run) : null;
  if (layout && (spec.role === 'developer' || spec.role === 'tester')) {
    return startInteractiveInLayout(ctx, options, spec, layout);
  }

  const workspace = ensureWorkspace(ctx.run, spec.workspaceLabel, options.cwd);
  if (!workspace) {
    return {
      ok: false,
      error: `Could not find or create the herdr workspace ${spec.workspaceLabel}`,
    };
  }

  // The developer of a task turns this tab into the shared task layout, so
  // it carries the task title alone; any other run is a single-role tab and
  // names its role. Without a title both keep the session name.
  const createsTaskLayout = Boolean(spec.taskId) && spec.role === 'developer';
  const tabLabel = sessionTabLabel(
    spec.taskTitle,
    createsTaskLayout ? null : spec.role,
    options.name,
  );
  const tab = openTab(ctx.run, workspace, options.cwd, tabLabel);
  if ('error' in tab) {
    return {
      ok: false,
      error: `Could not create the herdr tab for ${options.name}: ${tab.error}`,
    };
  }
  const { tabId, paneId } = tab;

  // The 3-pane task layout is created with the developer run: one split to
  // the right reserves the reviewer column, one split down divides the left
  // column into developer (top) and tester (bottom). Both with --no-focus,
  // so the calling pane keeps its focus.
  if (spec.taskId && spec.role === 'developer') {
    const reviewerPaneId = splitPane(ctx.run, paneId, 'right', options.cwd);
    const testerPaneId = reviewerPaneId
      ? splitPane(ctx.run, paneId, 'down', options.cwd)
      : null;
    if (reviewerPaneId && testerPaneId) {
      saveLayout(ctx.stateDir, {
        schema: 'crew.herdr-layout/v1',
        taskId: spec.taskId,
        workspaceId: workspace.id,
        tabId,
        developerPaneId: paneId,
        testerPaneId,
        reviewerPaneId,
        createdAt: new Date().toISOString(),
      });
      options.onEvent?.(
        `task layout created: dev=${paneId} test=${testerPaneId} review=${reviewerPaneId}`,
      );
    } else {
      options.onEvent?.('task layout unavailable: falling back to one tab per run');
    }
  }
  const agentName = agentNameFor(ctx.run, spec.baseName);
  const startupTimeoutMs = spec.startupTimeoutMs ?? 30000;

  const started = startAgent(ctx, agentName, spec.kind, paneId, startupTimeoutMs);
  if (!started.ok) {
    ctx.run(['tab', 'close', tabId]);
    return { ok: false, error: started.error };
  }

  writeState(ctx.stateDir, {
    name: options.name,
    workspaceId: workspace.id,
    paneId,
    exitFile: null,
    taskId: spec.taskId ?? options.name.replace(/^crew-/, '').split('-')[0] ?? null,
    createdAt: new Date().toISOString(),
    mode: 'interactive',
    tabId,
    agentName,
    agentKind: spec.kind,
    reportPath: spec.reportPath,
    prompt: spec.prompt,
    workspaceLabel: spec.workspaceLabel,
  });
  options.onEvent?.(`herdr tab created: ${tabId} (workspace ${workspace.id})`);
  options.onEvent?.(`${spec.kind} agent started: ${agentName} (pane ${paneId})`);
  return { ok: true };
}

/**
 * Starts a run inside the shared task layout: the developer takes the
 * top-left pane, the tester the bottom-left one, and no new tab is created.
 * A missing tab (or a closed developer pane after a retry) rebuilds the
 * layout instead of stacking a second tab for the same task.
 */
function startInteractiveInLayout(
  ctx: HerdrContext,
  options: StartSessionOptions,
  spec: InteractiveSpec,
  layout: TaskLayout,
): { ok: boolean; error?: string } {
  const isTester = spec.role === 'tester';
  let paneId = isTester ? layout.testerPaneId : layout.developerPaneId;
  if (!paneExists(ctx.run, paneId)) {
    if (isTester && paneExists(ctx.run, layout.developerPaneId)) {
      const rebuilt = splitPane(ctx.run, layout.developerPaneId, 'down', options.cwd);
      if (!rebuilt) {
        return { ok: false, error: `Could not rebuild the tester pane of the task layout` };
      }
      paneId = rebuilt;
      saveLayout(ctx.stateDir, { ...layout, testerPaneId: rebuilt });
    } else {
      // The layout cannot host this run: drop it so a fresh tab is built.
      removeLayout(ctx.stateDir, layout.taskId);
      return startInteractive(ctx, options, spec);
    }
  }

  const agentName = agentNameFor(ctx.run, spec.baseName);
  const started = startAgent(ctx, agentName, spec.kind, paneId, 30000, ' in the task layout');
  if (!started.ok) {
    return { ok: false, error: started.error };
  }

  writeState(ctx.stateDir, {
    name: options.name,
    workspaceId: layout.workspaceId,
    paneId,
    exitFile: null,
    taskId: layout.taskId,
    createdAt: new Date().toISOString(),
    mode: 'interactive',
    tabId: layout.tabId,
    agentName,
    agentKind: spec.kind,
    reportPath: spec.reportPath,
    prompt: spec.prompt,
    workspaceLabel: spec.workspaceLabel,
  });
  options.onEvent?.(
    `${spec.kind} agent started: ${agentName} (pane ${paneId}, tab ${layout.tabId})`,
  );
  return { ok: true };
}
