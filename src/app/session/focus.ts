/**
 * Manual focus gesture for the Herdr session surface.
 *
 * crew opens one tab per task (ADR 0047) and the review pane with
 * `--no-focus` (ADR 0046), so a task in review or blocked does not bring the
 * focus anywhere. `crew sessions focus` is the explicit jump: it either takes
 * the most recently updated task that needs a human (`--attention`) or a named
 * session, and focuses its tab (interactive) or workspace (batch).
 *
 * The selection is pure so it can be tested without Herdr; the backend calls
 * live behind a small structural interface.
 */

import { CrewError } from '../../core/errors';
import type { Task, TaskState } from '../../core/types';
import { readTaskLayout } from './layout';
import type { FocusBackend, FocusOutcome } from './focus-types';

export type { FocusBackend, FocusOutcome, FocusReason, SessionFocusState } from './focus-types';

/** States where a task waits for a human, so a jump makes sense. */
export const ATTENTION_STATES: TaskState[] = ['review', 'blocked', 'waiting_input'];

export function isAttentionState(state: TaskState): boolean {
  return ATTENTION_STATES.includes(state);
}

/**
 * The task that needs attention most recently: the one in review, blocked or
 * waiting_input with the latest `updated_at`. Returns null when none does.
 * Ties keep the first candidate, so the caller's order is the tie-breaker.
 */
export function selectAttentionTask<T extends Pick<Task, 'id' | 'state' | 'updatedAt'>>(
  tasks: T[],
): T | null {
  let selected: T | null = null;
  let selectedAt = Number.NEGATIVE_INFINITY;
  for (const task of tasks) {
    if (!isAttentionState(task.state)) {
      continue;
    }
    const parsed = Date.parse(task.updatedAt);
    const at = Number.isNaN(parsed) ? 0 : parsed;
    if (selected === null || at > selectedAt) {
      selected = task;
      selectedAt = at;
    }
  }
  return selected;
}

/**
 * Focuses a named session: its tab when it is interactive, its workspace when
 * it is batch. An unknown name is SESSION_NOT_FOUND.
 */
export function focusSession(backend: FocusBackend, name: string): FocusOutcome {
  const state = backend.sessionState(name);
  if (!state) {
    throw new CrewError('SESSION_NOT_FOUND', `Session not found: ${name}`);
  }
  if (state.mode === 'interactive') {
    if (!state.tabId) {
      return {
        focused: false,
        taskId: state.taskId,
        session: name,
        tabId: null,
        reason: 'focus-failed',
      };
    }
    const focused = backend.focusTab(state.tabId);
    return {
      focused,
      taskId: state.taskId,
      session: name,
      tabId: state.tabId,
      reason: focused ? 'interactive' : 'focus-failed',
    };
  }
  const focused = backend.focusWorkspace(state.workspaceId);
  return {
    focused,
    taskId: state.taskId,
    session: name,
    tabId: null,
    reason: focused ? 'batch' : 'focus-failed',
  };
}

/**
 * Focuses the tab of the task that needs attention most recently. The task
 * layout is the primary source (`layout-<taskId>.json`); when it is gone the
 * session recorded for that task is used instead. No task needing attention is
 * not an error: it reports `no-attention` so a keybinding can stay silent.
 */
export function focusAttentionTask(
  tasks: Array<Pick<Task, 'id' | 'state' | 'updatedAt'>>,
  backend: FocusBackend,
  stateDir: string,
): FocusOutcome {
  const task = selectAttentionTask(tasks);
  if (!task) {
    return {
      focused: false,
      taskId: null,
      session: null,
      tabId: null,
      reason: 'no-attention',
    };
  }
  const session = backend.sessionForTask(task.id);
  const layout = readTaskLayout(stateDir, task.id);
  if (layout && backend.focusTab(layout.tabId)) {
    return {
      focused: true,
      taskId: task.id,
      session,
      tabId: layout.tabId,
      reason: 'attention',
    };
  }
  if (session) {
    const outcome = focusSession(backend, session);
    if (outcome.focused) {
      return { ...outcome, taskId: task.id, reason: 'attention' };
    }
  }
  return {
    focused: false,
    taskId: task.id,
    session,
    tabId: layout?.tabId ?? null,
    reason: layout || session ? 'focus-failed' : 'no-session',
  };
}
