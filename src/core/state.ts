import { CrewError } from './errors';
import type { ReportStatus, TaskState } from './types';

const TASK_TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  draft: ['queued', 'cancelled'],
  queued: ['starting', 'blocked', 'failed', 'cancelled'],
  starting: ['running', 'failed', 'cancelled'],
  running: ['waiting_input', 'blocked', 'review', 'delivering', 'done', 'failed', 'cancelled', 'queued'],
  waiting_input: ['queued', 'cancelled'],
  blocked: ['queued', 'failed', 'cancelled'],
  review: ['delivering', 'running', 'queued', 'failed', 'cancelled'],
  delivering: ['done', 'failed', 'cancelled'],
  done: [],
  failed: ['queued'],
  cancelled: [],
};

export function canTransitionTask(from: TaskState, to: TaskState): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

export function assertTaskTransition(from: TaskState, to: TaskState): void {
  if (!canTransitionTask(from, to)) {
    throw new CrewError(
      'INVALID_TRANSITION',
      `Invalid task transition: ${from} -> ${to}`,
    );
  }
}

export function isTerminalTaskState(state: TaskState): boolean {
  return state === 'done' || state === 'failed' || state === 'cancelled';
}

export function isActiveRunState(state: string): boolean {
  return state === 'starting' || state === 'running';
}

export function taskStateForReport(status: ReportStatus): TaskState | null {
  switch (status) {
    case 'done':
      return 'done';
    case 'failed':
      return 'failed';
    case 'blocked':
      return 'blocked';
    case 'needs_input':
      return 'waiting_input';
    case 'progress':
      return null;
  }
}
