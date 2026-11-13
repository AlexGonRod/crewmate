import type { Store } from '../store/store';
import { runHerdr, type HerdrRunner } from './session/herdr';

/** The review plugin used by the `reviewr` alias and by the manual flag. */
export const DEFAULT_REVIEW_PLUGIN = 'persiyanov.reviewr';

/**
 * Turns `review.herdr_tab` into a plugin id. `off`, empty and absent mean
 * "do not open a surface"; `reviewr` is the friendly alias of the plugin.
 */
export function resolveReviewPluginId(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  if (trimmed === '' || trimmed === 'off') {
    return null;
  }
  return trimmed === 'reviewr' ? DEFAULT_REVIEW_PLUGIN : trimmed;
}

export interface ReviewSurfaceOutcome {
  taskId: string;
  pluginId: string;
  opened: boolean;
  reused: boolean;
  focused: boolean;
  paneId: string | null;
  reason: string | null;
}

interface OpenSurfaceResult {
  opened: boolean;
  reused: boolean;
  focused: boolean;
  paneId: string | null;
  reason: string | null;
}

function failure(reason: string): OpenSurfaceResult {
  return { opened: false, reused: false, focused: false, paneId: null, reason };
}

function herdrError(result: { stderr: string; stdout: string }): string {
  return (result.stderr.trim() || result.stdout.trim() || 'unknown error').split('\n')[0] ?? 'unknown error';
}

interface PluginPane {
  id: string;
  title: string;
}

function findPaneEntrypoint(plugin: any): PluginPane | null {
  const panes = Array.isArray(plugin?.panes) ? plugin.panes : [];
  const pane = panes.find((item: any) => item?.id === 'pane') ?? panes[0];
  if (!pane || typeof pane.id !== 'string') {
    return null;
  }
  return {
    id: pane.id,
    title: typeof pane.title === 'string' && pane.title !== '' ? pane.title : plugin.name ?? pane.id,
  };
}

/**
 * Opens (or focuses) the review pane of a Herdr plugin on the task worktree.
 *
 * The pane is opened explicitly, with `--placement tab` and `--no-focus`, and
 * the `cwd` is the task worktree: the captain pane usually lives in the main
 * checkout, so a manual toggle would review the wrong branch. No open is
 * attempted twice for the same worktree: an existing pane of the plugin in
 * that directory is focused instead (ADR 0046).
 */
export function openReviewSurface(
  pluginId: string,
  worktreePath: string,
  run: HerdrRunner = runHerdr,
): OpenSurfaceResult {
  const status = run(['status', 'server']);
  if (!status.ok) {
    return failure(`herdr is not available: ${herdrError(status)}`);
  }

  const listed = run(['plugin', 'list', '--json']);
  const plugins = listed.json?.result?.plugins;
  if (!listed.ok || !Array.isArray(plugins)) {
    return failure(`could not list herdr plugins: ${herdrError(listed)}`);
  }
  const plugin = plugins.find(
    (item: any) => item?.plugin_id === pluginId || item?.name === pluginId,
  );
  if (!plugin) {
    return failure(`the herdr plugin ${pluginId} is not installed`);
  }
  if (plugin.enabled === false) {
    return failure(`the herdr plugin ${pluginId} is disabled`);
  }
  const entrypoint = findPaneEntrypoint(plugin);
  if (!entrypoint) {
    return failure(`the herdr plugin ${pluginId} has no pane entrypoint`);
  }

  const panes = run(['pane', 'list']);
  const live = Array.isArray(panes.json?.result?.panes) ? panes.json.result.panes : [];
  const existing = live.find(
    (pane: any) => pane?.cwd === worktreePath && pane?.label === entrypoint.title,
  );
  if (existing && typeof existing.pane_id === 'string') {
    const focus = run(['plugin', 'pane', 'focus', existing.pane_id]);
    return {
      opened: true,
      reused: true,
      focused: focus.ok,
      paneId: existing.pane_id,
      reason: focus.ok
        ? null
        : `could not focus the existing review pane ${existing.pane_id}: ${herdrError(focus)}`,
    };
  }

  const opened = run([
    'plugin',
    'pane',
    'open',
    '--plugin',
    pluginId,
    '--entrypoint',
    entrypoint.id,
    '--placement',
    'tab',
    '--cwd',
    worktreePath,
    '--no-focus',
  ]);
  if (!opened.ok) {
    return failure(`could not open the herdr plugin pane: ${herdrError(opened)}`);
  }
  const paneId =
    opened.json?.result?.pane?.pane_id ??
    opened.json?.result?.pane_id ??
    opened.json?.result?.root_pane?.pane_id ??
    null;
  return { opened: true, reused: false, focused: false, paneId, reason: null };
}

export interface OpenTaskReviewSurfaceOptions {
  taskId: string;
  pluginId: string;
  worktreePath: string;
  run?: HerdrRunner;
}

/**
 * Fail-soft wrapper used by the pipeline and the CLI: it records
 * `review.surface_opened` or `review.surface_failed` and never throws, so a
 * missing Herdr or plugin can never move a task out of review.
 */
export function openTaskReviewSurface(
  store: Store,
  options: OpenTaskReviewSurfaceOptions,
): ReviewSurfaceOutcome {
  const base = {
    taskId: options.taskId,
    pluginId: options.pluginId,
    opened: false,
    reused: false,
    focused: false,
    paneId: null as string | null,
    reason: null as string | null,
  };
  let result: OpenSurfaceResult;
  try {
    result = openReviewSurface(options.pluginId, options.worktreePath, options.run);
  } catch (error) {
    result = failure(error instanceof Error ? error.message : String(error));
  }
  const outcome: ReviewSurfaceOutcome = { ...base, ...result };
  try {
    store.recordEvent({
      aggregateType: 'task',
      aggregateId: options.taskId,
      taskId: options.taskId,
      type:
        outcome.opened && !outcome.reason
          ? 'review.surface_opened'
          : 'review.surface_failed',
      payload: {
        plugin: options.pluginId,
        worktree: options.worktreePath,
        paneId: outcome.paneId,
        reused: outcome.reused,
        reason: outcome.reason,
      },
    });
  } catch {
    // Recording the event must not break the review transition either.
  }
  return outcome;
}
