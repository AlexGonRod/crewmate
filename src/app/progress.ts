import type { TaskDetail, TaskSummary } from '../core/types';
import { summarizeDetail } from './summary';

export interface ProgressEvent {
  type: string;
  createdAt: string;
}

export interface TaskProgress {
  taskId: string;
  title: string;
  state: string;
  stage: string;
  deliveryMode: string;
  attempt: number;
  updatedAt: string;
  elapsedMs: number;
  waitingFor: string | null;
  blockedBy: string[];
  next: string;
  recentEvents: ProgressEvent[];
  summary: TaskSummary;
}

function nextStep(detail: TaskDetail, summary: TaskSummary): string {
  const { task } = detail;
  switch (task.state) {
    case 'draft':
      return 'the task is not queued yet';
    case 'queued': {
      if (summary.nextAttemptAt && Date.parse(summary.nextAttemptAt) > Date.now()) {
        return `waiting for the backoff to expire at ${summary.nextAttemptAt}`;
      }
      if (summary.dependsOn.length > 0) {
        return `waiting for its dependencies (${summary.dependsOn.join(', ')})`;
      }
      return 'waiting in the queue for a worker';
    }
    case 'starting':
      return 'preparing the worktree and the agent';
    case 'running':
      return `the ${task.stage} stage is running`;
    case 'waiting_input':
      return 'the agent needs an answer: crew task answer <id> --text "<texto>"';
    case 'blocked':
      return `blocked: ${task.lastError ?? 'no reason recorded'}`;
    case 'review':
      return summary.pr
        ? 'ready for review: check the PR and accept or reject it'
        : 'ready for review: accept it or request changes';
    case 'delivering':
      return 'delivering the result';
    case 'done':
      return 'the task is done';
    case 'failed':
      return `failed: ${task.lastError ?? 'no reason recorded'}`;
    case 'cancelled':
      return 'the task was cancelled';
    default:
      return task.state;
  }
}

export function buildProgress(
  detail: TaskDetail,
  options: { now?: number; events?: number } = {},
): TaskProgress {
  const now = options.now ?? Date.now();
  const limit = Math.max(1, Math.min(options.events ?? 8, 50));
  const summary = summarizeDetail(detail);
  const startedAt = Date.parse(detail.task.createdAt);
  const finishedAt = detail.task.finishedAt ? Date.parse(detail.task.finishedAt) : now;

  return {
    taskId: detail.task.id,
    title: detail.task.title,
    state: detail.task.state,
    stage: detail.task.stage,
    deliveryMode: detail.task.deliveryMode,
    attempt: detail.task.attempts + 1,
    updatedAt: detail.task.updatedAt,
    elapsedMs: Math.max(0, finishedAt - startedAt),
    waitingFor: detail.task.state === 'waiting_input' ? detail.task.title : null,
    blockedBy: summary.dependsOn,
    next: nextStep(detail, summary),
    recentEvents: detail.events.slice(-limit).map((event) => ({
      type: event.type,
      createdAt: event.createdAt,
    })),
    summary,
  };
}

export function renderProgress(progress: TaskProgress): string {
  const minutes = Math.floor(progress.elapsedMs / 60_000);
  const seconds = Math.floor((progress.elapsedMs % 60_000) / 1000);
  const lines = [
    `Task ${progress.taskId} [${progress.state}] ${progress.title}`,
    `Stage: ${progress.stage} · attempt ${progress.attempt} · elapsed ${minutes}m ${seconds}s · updated ${progress.updatedAt}`,
    `Next: ${progress.next}`,
  ];
  const risk = progress.summary.risk;
  lines.push(
    `Risk: ${risk ? `${risk.level} (score ${risk.score})` : 'unknown'} · verify ${progress.summary.verification.state} · ci ${progress.summary.ci?.state ?? '-'}`,
  );
  if (progress.recentEvents.length > 0) {
    lines.push('Recent events:');
    for (const event of progress.recentEvents) {
      lines.push(`  ${event.createdAt} ${event.type}`);
    }
  }
  return lines.join('\n');
}
