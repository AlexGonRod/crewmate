import { CrewError } from '../core/errors';
import { mergePullRequest, viewPullRequest } from '../git/forge';
import type {
  CiResult,
  MergeMethod,
  MergeResult,
  TaskDetail,
  TaskSummary,
} from '../core/types';
import { summarizeDetail } from './summary';
import type { Store } from '../store/store';

export interface MergeGate {
  name: string;
  ok: boolean;
  detail: string;
}

export interface MergeDecision {
  allowed: boolean;
  taskId: string;
  state: string;
  deliveryMode: string;
  gates: MergeGate[];
  missing: string[];
  risk: TaskSummary['risk'];
  pr: {
    url: string;
    state: string;
    merged: boolean;
    draft: boolean;
    mergeable: string;
  } | null;
}

export interface MergeOutcome {
  decision: MergeDecision;
  merge: MergeResult | null;
  taskState: string;
  accepted: boolean;
  authorizedBy: string;
}

function latestArtifact<T>(detail: TaskDetail, kind: string): T | null {
  const artifact = detail.artifacts.filter((item) => item.kind === kind).at(-1);
  return artifact?.metadata ? (artifact.metadata as T) : null;
}

export function evaluateMerge(
  detail: TaskDetail,
  options: { pr?: { url: string; state: string; merged: boolean; draft: boolean; mergeable: string } | null } = {},
): MergeDecision {
  const summary = summarizeDetail(detail);
  const { task } = detail;
  const gates: MergeGate[] = [];

  gates.push({
    name: 'task in review',
    ok: task.state === 'review',
    detail: `state is ${task.state}`,
  });

  const testerApproved = summary.tester?.verdict === 'approve';
  gates.push({
    name: 'tester approved',
    ok: testerApproved,
    detail: testerApproved ? 'verdict approve' : 'the tester has not approved the change',
  });

  const verificationOk = summary.verification.state === 'passed';
  gates.push({
    name: 'verification passed',
    ok: verificationOk,
    detail: `verification is ${summary.verification.state}`,
  });

  const ci = latestArtifact<CiResult>(detail, 'ci');
  const ciRequired = ci !== null;
  const ciOk = !ciRequired || ci.state === 'passed';
  gates.push({
    name: 'CI passed',
    ok: ciOk,
    detail: ciRequired ? `CI is ${ci.state}: ${ci.summary}` : 'no CI result recorded',
  });

  const pr = options.pr ?? null;
  if (task.deliveryMode === 'pr' || task.deliveryMode === 'auto_merge') {
    gates.push({
      name: 'pull request open',
      ok: pr !== null && !pr.merged && pr.state === 'OPEN',
      detail: pr
        ? `PR is ${pr.state}${pr.merged ? ' (already merged)' : ''}`
        : 'no pull request found',
    });
    gates.push({
      name: 'pull request not a draft',
      ok: pr !== null ? !pr.draft : false,
      detail: pr ? (pr.draft ? 'the PR is a draft' : 'the PR is ready') : 'no pull request found',
    });
    gates.push({
      name: 'pull request mergeable',
      ok:
        pr !== null &&
        (!pr.mergeable || pr.mergeable === 'MERGEABLE' || pr.mergeable === 'UNKNOWN'),
      detail: pr ? `mergeable is ${pr.mergeable}` : 'no pull request found',
    });
  }

  const missing = gates.filter((gate) => !gate.ok).map((gate) => `${gate.name} (${gate.detail})`);

  return {
    allowed: missing.length === 0,
    taskId: task.id,
    state: task.state,
    deliveryMode: task.deliveryMode,
    gates,
    missing,
    risk: summary.risk,
    pr: pr
      ? {
          url: pr.url,
          state: pr.state,
          merged: pr.merged,
          draft: pr.draft,
          mergeable: pr.mergeable,
        }
      : null,
  };
}

export function mergeTask(
  store: Store,
  taskId: string,
  options: {
    projectRootPath: string;
    method: MergeMethod;
    deleteBranch?: boolean;
    authorizedBy: string;
    skipMerge?: boolean;
    livePr?: boolean;
  },
): MergeOutcome {
  const detail = store.getTaskDetail(taskId);
  const { task } = detail;

  let pr: MergeDecision['pr'] = null;
  if (
    (task.deliveryMode === 'pr' || task.deliveryMode === 'auto_merge') &&
    task.prUrl &&
    options.livePr !== false
  ) {
    const info = viewPullRequest(options.projectRootPath, task.prUrl);
    pr = {
      url: info.url,
      state: info.state,
      merged: info.merged,
      draft: Boolean(info.draft),
      mergeable: info.mergeable ?? 'UNKNOWN',
    };
  }

  const decision = evaluateMerge(detail, { pr });
  if (!decision.allowed) {
    throw new CrewError(
      'MERGE_BLOCKED',
      `Cannot merge ${taskId}: ${decision.missing.join('; ')}`,
    );
  }

  store.appendAuthorizationEvent(taskId, {
    actor: options.authorizedBy,
    action: 'merge',
    gates: decision.gates.map((gate) => ({ name: gate.name, ok: gate.ok })),
  });

  if (!pr || options.skipMerge) {
    const accepted = store.acceptTask(taskId);
    return {
      decision,
      merge: null,
      taskState: accepted.state,
      accepted: true,
      authorizedBy: options.authorizedBy,
    };
  }

  let merge: MergeResult;
  try {
    const info = mergePullRequest({
      cwd: options.projectRootPath,
      url: pr.url,
      method: options.method,
      deleteBranch: options.deleteBranch,
    });
    merge = {
      state: 'merged',
      method: options.method,
      actor: options.authorizedBy,
      reason: `authorized by ${options.authorizedBy}`,
      url: info.url,
      deleteBranch: Boolean(options.deleteBranch),
    };
  } catch (error) {
    merge = {
      state: 'failed',
      method: options.method,
      actor: options.authorizedBy,
      reason: error instanceof Error ? error.message : 'merge failed',
      url: pr.url,
      deleteBranch: Boolean(options.deleteBranch),
    };
  }

  store.recordMergeResult(taskId, merge);
  let accepted = false;
  let taskState = store.getTaskOrThrow(taskId).state;
  if (merge.state === 'merged') {
    const done = store.acceptTask(taskId);
    taskState = done.state;
    accepted = true;
  }

  return { decision, merge, taskState, accepted, authorizedBy: options.authorizedBy };
}
