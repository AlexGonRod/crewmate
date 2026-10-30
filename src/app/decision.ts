import { CrewError } from '../core/errors';
import type {
  MergeMethod,
  MergeResult,
} from '../core/types';
import type { ResolvedContext } from '../config/config';
import type { Store } from '../store/store';
import { mergeTask, type MergeOutcome } from './merge';

/**
 * How a decision written for the human reads it lands: a paste (for example
 * from the herdr-reviewr plugin) carries one `crew-decision:` line, and
 * everything after it is the verbatim comment the person wrote.
 */
export interface DecisionPaste {
  decision: 'accept' | 'reject' | 'none';
  comments: string | null;
}

const DECISION_LINE = /(^|\n)\s*crew-decision:[ \t]*(accept|reject)[ \t]*$/im;


export function parseDecisionPaste(text: string): DecisionPaste {
  const match = DECISION_LINE.exec(text) as RegExpExecArray | null;
  if (!match) {
    return { decision: 'none', comments: null };
  }
  const decision = match[2] ? (match[2].toLowerCase() as 'accept' | 'reject') : null;
  if (!decision) {
    return { decision: 'none', comments: null };
  }
  const index = match.index + match[0].length;
  const rest = text.slice(index).trim();
  return { decision, comments: rest.length > 0 ? rest : null };
}

export interface DecideOptions {
  taskId: string;
  decision: 'accept' | 'reject';
  /** The verbatim comment: feedback for a reject, the reason for an accept. */
  comments: string | null;
  /** Who authorized the decision. */
  authorizedBy: string;
  /** Where the decision came from (e.g. 'cli' or 'herdr-reviewr'). */
  origin: string;
  method?: MergeMethod;
  deleteBranch?: boolean;
}

export interface DecideOutcome {
  taskId: string;
  decision: 'accept' | 'reject';
  taskState: string;
  accepted: boolean;
  merge: MergeResult | null;
  reason: string | null;
}

/**
 * Records a review decision that came without the editor (the `task decision`
 * command): the same artifacts and events as the review buffer, so the merge
 * authority model (ADR 0032) holds whatever channel delivered the human word.
 */
export function decideTask(
  store: Store,
  context: ResolvedContext,
  options: DecideOptions,
): DecideOutcome {
  const detail = store.getTaskDetail(options.taskId);
  const { task } = detail;
  const project = detail.project;
  if (!project) {
    throw new CrewError('PROJECT_NOT_FOUND', `Task ${task.id} has no project`);
  }
  if (task.state !== 'review') {
    throw new CrewError(
      'TASK_NOT_IN_REVIEW',
      `Task ${task.id} is ${task.state}; only tasks in review can be decided`,
    );
  }

  const comments = options.comments?.trim() ? options.comments.trim() : null;

  if (options.decision === 'reject') {
    const reason = comments ?? `rejected via ${options.origin}`;
    store.rejectReview(task.id, reason, context.config.review.maxIterations);
    store.recordReview(task.id, {
      decision: 'reject',
      reason,
      bufferPath: null,
      authorizedBy: options.authorizedBy,
      origin: options.origin,
    });
    const updated = store.getTaskOrThrow(task.id);
    return {
      taskId: task.id,
      decision: 'reject',
      taskState: updated.state,
      accepted: false,
      merge: null,
      reason,
    };
  }

  const outcome: MergeOutcome = mergeTask(store, task.id, {
    projectRootPath: project.rootPath,
    forge: project.forge,
    method: options.method ?? 'squash',
    deleteBranch: options.deleteBranch,
    authorizedBy: options.authorizedBy,
    // The person's written word, verbatim, is the authorization.
    authorization: {
      authorizedBy: options.authorizedBy,
      reason: comments,
    },
  });
  store.recordReview(task.id, {
    decision: 'accept',
    reason: comments,
    bufferPath: null,
    authorizedBy: options.authorizedBy,
    origin: options.origin,
  });
  return {
    taskId: task.id,
    decision: 'accept',
    taskState: outcome.taskState,
    accepted: outcome.accepted,
    merge: outcome.merge,
    reason: comments,
  };
}
