import type { DeliveryMode, MergeMethod } from '../core/types';
import type { ProjectConfig, ProjectDeliveryConfig } from '../config/config';

/**
 * The path a task takes to be delivered, and who is allowed to sign it.
 *
 * The mode owns the technical rigour; `yolo` is the standing authority
 * posture; the risk and the recorded human authorization are the vetoes.
 */
export interface DeliveryPolicy {
  /** The technical rigour of the path. */
  path: 'no-mistakes' | 'direct-PR' | 'local-only';
  /** Whether the captain may merge green, in-scope work on its own. */
  yolo: boolean;
  method: MergeMethod;
  deleteBranch: boolean;
  /** The task's own delivery mode. */
  taskMode: DeliveryMode;
  /** Where the policy came from, for the audit trail. */
  source: 'project' | 'task' | 'default';
}

export const DEFAULT_DELIVERY_METHOD: MergeMethod = 'squash';

function normalizeProjectDelivery(
  delivery: ProjectConfig['delivery'],
): ProjectDeliveryConfig {
  if (!delivery) {
    return {};
  }
  if (typeof delivery === 'string') {
    // Legacy form: a single mode. `auto_merge` becomes a standing yolo.
    if (delivery === 'auto_merge') {
      return { mode: 'no-mistakes', yolo: true };
    }
    if (delivery === 'pr') {
      return { mode: 'no-mistakes' };
    }
    if (delivery === 'scout') {
      return { mode: 'local-only' };
    }
    return { mode: 'local-only' };
  }
  return delivery;
}

export function resolveDeliveryPolicy(options: {
  taskMode: DeliveryMode;
  projectConfig: ProjectConfig | null;
}): DeliveryPolicy {
  const { taskMode } = options;
  const project = normalizeProjectDelivery(options.projectConfig?.delivery);
  const autoMerge = options.projectConfig?.auto_merge;

  const method =
    project.method ?? autoMerge?.method ?? DEFAULT_DELIVERY_METHOD;
  const deleteBranch = project.delete_branch ?? autoMerge?.delete_branch ?? false;

  if (taskMode === 'scout') {
    return {
      path: 'local-only',
      yolo: project.yolo ?? false,
      method,
      deleteBranch,
      taskMode,
      source: 'task',
    };
  }

  const projectYolo = project.yolo ?? false;
  const taskYolo = taskMode === 'auto_merge';

  if (taskMode === 'local') {
    return {
      path: 'local-only',
      yolo: projectYolo || taskYolo,
      method,
      deleteBranch,
      taskMode,
      source: options.projectConfig?.delivery ? 'project' : 'default',
    };
  }

  // The task wants a pull request: the project decides how much rigour.
  const path =
    project.mode === 'direct-PR' ? 'direct-PR' : 'no-mistakes';
  return {
    path,
    yolo: projectYolo || taskYolo,
    method,
    deleteBranch,
    taskMode,
    source: options.projectConfig?.delivery ? 'project' : 'default',
  };
}

/**
 * The delivery mode a new task inherits from the project policy.
 */
export function taskDeliveryModeFor(projectConfig: ProjectConfig | null): DeliveryMode {
  const project = normalizeProjectDelivery(projectConfig?.delivery);
  if (project.mode === 'no-mistakes' || project.mode === 'direct-PR') {
    return 'pr';
  }
  return 'local';
}

/**
 * Whether the path requires a pull request at all.
 */
export function pathNeedsPullRequest(path: DeliveryPolicy['path']): boolean {
  return path === 'no-mistakes' || path === 'direct-PR';
}

/**
 * Whether the work itself goes through the full pipeline (the independent
 * verification and the tester).
 *
 * `direct-PR` is the fast path: it ships without an independent reviewer.
 * `local-only` keeps the full rigour of the work and only changes where it
 * lands.
 */
export function pathRequiresFullPipeline(path: DeliveryPolicy['path']): boolean {
  return path !== 'direct-PR';
}
