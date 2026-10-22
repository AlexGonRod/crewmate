import { CrewError } from '../core/errors';
import type { MergeMethod, MergeResult, TaskDetail } from '../core/types';
import type { ResolvedContext } from '../config/config';
import type { Store } from '../store/store';
import { getForge } from '../forges';
import { openInEditor } from './editor';
import { mergeTask } from './merge';
import {
  buildAnswerBuffer,
  buildReviewBuffer,
  parseAnswer,
  parseReviewDecision,
  readReviewFile,
  writeReviewFile,
  type ReviewDecision,
} from './review';
import { diffText, logText, resolveWorkspace } from './workspace';

export interface ReviewOptions {
  taskId: string;
  method?: MergeMethod;
  deleteBranch?: boolean;
  authorizedBy: string;
  maxDiffLines?: number;
  open?: boolean;
  editorEnv?: NodeJS.ProcessEnv;
}

export interface ReviewOutcome {
  taskId: string;
  decision: ReviewDecision;
  bufferPath: string;
  taskState: string;
  merge: MergeResult | null;
  merged: boolean;
  reason: string | null;
}

function reviewFileName(taskId: string, kind: 'review' | 'answer'): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${kind}-${stamp}.md`;
}

function livePullRequest(
  detail: TaskDetail,
): { url: string; state: string; merged: boolean; draft: boolean; mergeable: string } | null {
  const { task, project } = detail;
  if (!project || !task.prUrl) {
    return null;
  }
  try {
    const forge = getForge(project.forge ?? 'github');
    const info = forge.viewPullRequest(project.rootPath, task.prUrl);
    return {
      url: info.url,
      state: info.state,
      merged: info.merged,
      draft: Boolean(info.draft),
      mergeable: info.mergeable ?? 'UNKNOWN',
    };
  } catch {
    return null;
  }
}

/**
 * Reviews a task in the editor: the human reads the brief, the gates and the
 * diff, writes a decision, and the crew applies it with its own gates.
 */
export async function reviewTask(
  store: Store,
  context: ResolvedContext,
  options: ReviewOptions,
): Promise<ReviewOutcome> {
  const detail = store.getTaskDetail(options.taskId);
  const { task } = detail;
  const project = detail.project;
  if (!project) {
    throw new CrewError('PROJECT_NOT_FOUND', `Task ${task.id} has no project`);
  }
  if (task.state !== 'review') {
    throw new CrewError(
      'TASK_NOT_IN_REVIEW',
      `Task ${task.id} is ${task.state}; only tasks in review can be reviewed`,
    );
  }

  const resolution = resolveWorkspace({
    project,
    projectConfig: null,
    task,
    worktreesDir: context.paths.worktreesDir,
  });
  const diff = diffText(resolution.workspace, task.baseBranch);
  const log = logText(resolution.workspace, task.baseBranch);

  const buffer = buildReviewBuffer(detail, {
    diff,
    log,
    pr: livePullRequest(detail),
    maxDiffLines: options.maxDiffLines,
  });
  const file = writeReviewFile(
    `${context.paths.tasksDir}/${task.id}`,
    reviewFileName(task.id, 'review'),
    buffer,
  );

  if (options.open !== false) {
    openInEditor(file.path, { env: options.editorEnv });
  }

  const decision = parseReviewDecision(readReviewFile(file.path));
  const diffLines = diff.split('\n').filter((line) => line.trim() !== '').length;

  if (decision.decision === 'none') {
    store.recordReview(task.id, {
      decision: 'none',
      reason: null,
      bufferPath: file.path,
      authorizedBy: options.authorizedBy,
      diffLines,
    });
    return {
      taskId: task.id,
      decision,
      bufferPath: file.path,
      taskState: task.state,
      merge: null,
      merged: false,
      reason: null,
    };
  }

  if (decision.decision === 'reject') {
    const reason = decision.reason ?? 'rejected in the review buffer';
    store.rejectReview(task.id, reason, context.config.review.maxIterations);
    store.recordReview(task.id, {
      decision: 'reject',
      reason,
      bufferPath: file.path,
      authorizedBy: options.authorizedBy,
      diffLines,
    });
    const updated = store.getTaskOrThrow(task.id);
    return {
      taskId: task.id,
      decision,
      bufferPath: file.path,
      taskState: updated.state,
      merge: null,
      merged: false,
      reason,
    };
  }

  const outcome = mergeTask(store, task.id, {
    projectRootPath: project.rootPath,
    forge: project.forge,
    method: options.method ?? 'squash',
    deleteBranch: options.deleteBranch,
    authorizedBy: options.authorizedBy,
    // The decision in the review buffer IS the captain's word.
    authorization: {
      authorizedBy: options.authorizedBy,
      reason: decision.reason,
    },
  });
  store.recordReview(task.id, {
    decision: 'accept',
    reason: decision.reason,
    bufferPath: file.path,
    authorizedBy: options.authorizedBy,
    diffLines,
  });
  return {
    taskId: task.id,
    decision,
    bufferPath: file.path,
    taskState: outcome.taskState,
    merge: outcome.merge,
    merged: outcome.accepted,
    reason: decision.reason,
  };
}

export interface AnswerOptions {
  taskId: string;
  open?: boolean;
  editorEnv?: NodeJS.ProcessEnv;
}

export interface AnswerOutcome {
  taskId: string;
  answered: boolean;
  answer: string | null;
  bufferPath: string;
  taskState: string;
}

/**
 * Answers a task that is waiting for the human, from the editor.
 */
export async function answerTaskInEditor(
  store: Store,
  context: ResolvedContext,
  options: AnswerOptions,
): Promise<AnswerOutcome> {
  const detail = store.getTaskDetail(options.taskId);
  const { task } = detail;
  if (task.state !== 'waiting_input' && task.state !== 'blocked') {
    throw new CrewError(
      'TASK_NOT_WAITING',
      `Task ${task.id} is ${task.state}; expected waiting_input or blocked`,
    );
  }
  const questions = detail.messages
    .filter(
      (message) =>
        message.direction === 'out' &&
        message.kind === 'question' &&
        message.consumedAt === null,
    )
    .map((message) => message.body);

  const buffer = buildAnswerBuffer(detail, { questions });
  const file = writeReviewFile(
    `${context.paths.tasksDir}/${task.id}`,
    reviewFileName(task.id, 'answer'),
    buffer,
  );

  if (options.open !== false) {
    openInEditor(file.path, { env: options.editorEnv });
  }

  const answer = parseAnswer(readReviewFile(file.path));
  if (!answer) {
    return {
      taskId: task.id,
      answered: false,
      answer: null,
      bufferPath: file.path,
      taskState: task.state,
    };
  }
  const updated = store.answerTask(task.id, answer);
  return {
    taskId: task.id,
    answered: true,
    answer,
    bufferPath: file.path,
    taskState: updated.state,
  };
}
