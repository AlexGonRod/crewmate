import { CrewError } from '../core/errors';
import { getForge } from '../forges';
import type {
  CiResult,
  MergeMethod,
  MergeResult,
  RiskLevel,
  TaskDetail,
  TaskSummary,
} from '../core/types';
import type { ProjectConfig } from '../config/config';
import {
  pathNeedsPullRequest,
  pathRequiresFullPipeline,
  resolveDeliveryPolicy,
  type DeliveryPolicy,
} from './delivery';
import { localBranchHead, remoteBranchHead } from '../git/git';
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
  /** The path that owns the rigour of this merge. */
  path: DeliveryPolicy['path'];
  /** Whether the captain may sign this merge on its own. */
  yolo: boolean;
  /** Who is allowed to sign: the captain, or the captain with a standing grant. */
  authority: 'captain' | 'captain-with-yolo';
  gates: MergeGate[];
  missing: string[];
  risk: TaskSummary['risk'];
  /** The frozen receipt: the reviewed commit and where its head was read. */
  receipt: {
    headSha: string;
    source: 'remote' | 'local';
  } | null;
  pr: {
    url: string;
    state: string;
    merged: boolean;
    draft: boolean;
    mergeable: string;
    headSha?: string | null;
  } | null;
}

export interface MergeOutcome {
  decision: MergeDecision;
  merge: MergeResult | null;
  taskState: string;
  accepted: boolean;
  authorizedBy: string;
}

/** A resolved head of the reviewed branch, pending comparison in the gates. */
export interface ResolvedReceipt {
  headSha: string | null;
  source: 'remote' | 'local';
  error?: string;
}

function latestArtifact<T>(detail: TaskDetail, kind: string): T | null {
  const artifact = detail.artifacts.filter((item) => item.kind === kind).at(-1);
  return artifact?.metadata ? (artifact.metadata as T) : null;
}

/**
 * The head of the reviewed branch, resolved from the project. The comparison
 * stays lazy because evaluating it requires git access; with `force: true` no
 * receipt is applicable.
 */
function resolveReceipt(
  detail: TaskDetail,
  policy: DeliveryPolicy,
  options: {
    force?: boolean;
    projectRootPath: string;
    pr: MergeDecision['pr'];
  },
): ResolvedReceipt | null {
  const { task } = detail;
  if (options.force) {
    return null;
  }
  if (!task.commitSha || !task.branch) {
    return null;
  }
  if (pathNeedsPullRequest(policy.path) && task.prUrl) {
    if (options.pr?.headSha) {
      return { headSha: options.pr.headSha, source: 'remote' };
    }
    const probe = remoteBranchHead(options.projectRootPath, task.branch);
    return { headSha: probe.sha, source: 'remote', error: probe.error ?? undefined };
  }
  const probe = localBranchHead(options.projectRootPath, task.branch);
  return { headSha: probe.sha, source: 'local', error: probe.error ?? undefined };
}

/**
 * The human authorization left by a review in the editor: the captain wrote
 * `crew-decision: accept` and the crew recorded it.
 */
export function lastHumanAuthorization(
  detail: TaskDetail,
): { authorizedBy: string; reason: string | null; at: string } | null {
  const reviews = detail.artifacts.filter((item) => item.kind === 'review');
  for (const review of reviews.reverse()) {
    const metadata = review.metadata as
      | { decision?: string; reason?: string | null; authorizedBy?: string }
      | undefined;
    if (metadata?.decision === 'accept') {
      return {
        authorizedBy: metadata.authorizedBy ?? 'user',
        reason: metadata.reason ?? null,
        at: review.createdAt,
      };
    }
  }
  return null;
}

export function evaluateMerge(
  detail: TaskDetail,
  options: {
    pr?: {
      url: string;
      state: string;
      merged: boolean;
      draft: boolean;
      mergeable: string;
      headSha?: string | null;
    } | null;
    projectConfig?: ProjectConfig | null;
    /** The human authorization to take into account. */
    authorization?: { authorizedBy: string; reason: string | null } | null;
    /** The resolved head of the reviewed branch, when a receipt is applicable. */
    receipt?: ResolvedReceipt | null;
  } = {},
): MergeDecision {
  const summary = summarizeDetail(detail);
  const { task } = detail;
  const policy = resolveDeliveryPolicy({
    taskMode: task.deliveryMode,
    projectConfig: options.projectConfig ?? null,
  });
  const authorization =
    options.authorization === undefined
      ? lastHumanAuthorization(detail)
      : options.authorization;
  const gates: MergeGate[] = [];

  // 1. The path: the rigour is owned by the delivery mode.
  gates.push({
    name: 'task in review',
    ok: task.state === 'review',
    detail: `state is ${task.state}`,
  });

  const needsPr = pathNeedsPullRequest(policy.path);
  const fullPipeline = pathRequiresFullPipeline(policy.path);

  if (fullPipeline) {
    // ADR 0040: the proportionate policy may have skipped the tester. The
    // waiver holds only when the route was recorded as skipped *and* the
    // final risk (computed from the recorded change) is still low; unknown
    // or raised risk keeps the requirement.
    const testerWaivedByRoute =
      summary.reviewRoute?.route === 'skipped' &&
      (summary.risk?.level ?? 'high') === 'low';
    const testerApproved =
      summary.tester?.verdict === 'approve' || testerWaivedByRoute;
    gates.push({
      name: 'tester approved',
      ok: testerApproved,
      detail: testerApproved
        ? summary.tester?.verdict === 'approve'
          ? 'verdict approve'
          : 'tester skipped under the proportionate policy (low pre-commit risk)'
        : 'the tester has not approved the change',
    });

    const verificationOk = summary.verification.state === 'passed';
    gates.push({
      name: 'verification passed',
      ok: verificationOk,
      detail: `verification is ${summary.verification.state}`,
    });
  }

  // 2. The red veto: a failed check, or a required check that never reported.
  const ci = latestArtifact<CiResult>(detail, 'ci');
  const ciRequired = ci !== null || Boolean(options.projectConfig?.ci);
  if (ciRequired) {
    const ciOk = ci !== null && ci.state === 'passed';
    gates.push({
      name: 'CI passed',
      ok: ciOk,
      detail:
        ci === null
          ? 'CI is configured but no check has reported yet'
          : `CI is ${ci.state}: ${ci.summary}`,
    });
  }

  // 3. The receipt: the reviewed commit must still be the head of the branch.
  const receipt = options.receipt ?? null;
  let receiptResult: MergeDecision['receipt'] = null;
  if (receipt !== null && task.commitSha) {
    const receiptOk =
      receipt.headSha !== null && receipt.headSha !== '' && receipt.headSha === task.commitSha;
    gates.push({
      name: 'head matches the reviewed commit',
      ok: receiptOk,
      detail: receiptOk
        ? `head ${receipt.headSha} (${receipt.source}) is the reviewed commit`
        : receipt.error
          ? `the head of the branch could not be verified (${receipt.source}): ${receipt.error}`
          : `the head is ${receipt.headSha} (${receipt.source}), not the reviewed commit ${task.commitSha}: the branch moved after the review`,
    });
    if (receiptOk && receipt.headSha) {
      receiptResult = { headSha: receipt.headSha, source: receipt.source };
    }
  }

  // 4. The authority: who signs this merge.
  const risk = summary.risk;
  const riskLevel: RiskLevel | null = risk ? risk.level : null;
  const highRisk = riskLevel === 'high';
  const yoloUsable = policy.yolo && !highRisk;
  if (highRisk) {
    gates.push({
      name: 'risk authorization',
      ok: authorization !== null,
      detail: authorization
        ? `risk is high and the captain authorized (${authorization.authorizedBy})`
        : 'risk is high: a human authorization is required even with yolo',
    });
  }
  gates.push({
    name: 'merge authority',
    ok: yoloUsable || authorization !== null,
    detail: authorization
      ? `authorized by ${authorization.authorizedBy}`
      : yoloUsable
        ? 'the project grants standing authority (yolo)'
        : 'the captain must authorize: run "crew task review <id>"',
  });

  // 5. The pull request itself.
  const pr = options.pr ?? null;
  if (needsPr) {
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
    path: policy.path,
    yolo: policy.yolo,
    authority: yoloUsable ? 'captain-with-yolo' : 'captain',
    gates,
    missing,
    risk: summary.risk,
    receipt: receiptResult,
    pr: pr
      ? {
          url: pr.url,
          state: pr.state,
          merged: pr.merged,
          draft: pr.draft,
          mergeable: pr.mergeable,
          headSha: pr.headSha ?? null,
        }
      : null,
  };
}

export function mergeTask(
  store: Store,
  taskId: string,
  options: {
    projectRootPath: string;
    method?: MergeMethod;
    deleteBranch?: boolean;
    authorizedBy: string;
    skipMerge?: boolean;
    livePr?: boolean;
    forge?: string | null;
    projectConfig?: ProjectConfig | null;
    /** An explicit human authorization, when the caller holds one. */
    authorization?: { authorizedBy: string; reason: string | null } | null;
    /** Bypass the reviewed-commit receipt; every other gate still applies. */
    force?: boolean;
  },
): MergeOutcome {
  const detail = store.getTaskDetail(taskId);
  const { task } = detail;

  let pr: MergeDecision['pr'] = null;
  const forge = getForge(options.forge ?? detail.project?.forge ?? 'github');
  const policy = resolveDeliveryPolicy({
    taskMode: task.deliveryMode,
    projectConfig: options.projectConfig ?? null,
  });
  if (
    pathNeedsPullRequest(policy.path) &&
    task.prUrl &&
    options.livePr !== false
  ) {
    const info = forge.viewPullRequest(options.projectRootPath, task.prUrl);
    pr = {
      url: info.url,
      state: info.state,
      merged: info.merged,
      draft: Boolean(info.draft),
      mergeable: info.mergeable ?? 'UNKNOWN',
      headSha: info.headSha ?? null,
    };
  }

  const decision = evaluateMerge(detail, {
    pr,
    projectConfig: options.projectConfig ?? null,
    authorization: options.authorization,
    receipt: resolveReceipt(detail, policy, {
      force: options.force,
      projectRootPath: options.projectRootPath,
      pr,
    }),
  });
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
    const info = forge.mergePullRequest({
      cwd: options.projectRootPath,
      url: pr.url,
      method: options.method ?? policy.method,
      deleteBranch: options.deleteBranch ?? policy.deleteBranch,
    });
    merge = {
      state: 'merged',
      method: options.method ?? policy.method,
      actor: options.authorizedBy,
      reason: `authorized by ${options.authorizedBy}`,
      url: info.url,
      deleteBranch: Boolean(options.deleteBranch ?? policy.deleteBranch),
    };
  } catch (error) {
    merge = {
      state: 'failed',
      method: options.method ?? policy.method,
      actor: options.authorizedBy,
      reason: error instanceof Error ? error.message : 'merge failed',
      url: pr.url,
      deleteBranch: Boolean(options.deleteBranch ?? policy.deleteBranch),
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
