import { hostname } from 'node:os';
import { CrewError, errorMessage } from '../core/errors';
import type {
  CiResult,
  DeliveryMode,
  MergeResult,
  PipelineStage,
  Report,
  Run,
  Task,
  VerificationResult,
} from '../core/types';
import { newId } from '../core/ids';
import type { ResolvedContext } from '../config/config';
import { readProjectConfig } from '../config/config';
import type { Store } from '../store/store';
import {
  commitWorkspace,
  diffStatsWorkspace,
  pushWorkspace,
} from './workspace';
import { isRetryableError } from './retry';
import { assessRisk } from '../risk/risk';
import { resolveDeliveryPolicy } from './delivery';
import { getForge } from '../forges';
import {
  DEFAULT_CI_INTERVAL_SECONDS,
  DEFAULT_CI_TIMEOUT_SECONDS,
  waitForCiGate,
} from '../ci/ci';
import { currentBranch } from '../git/git';
import { resolveWorkspace } from './workspace';
import type { SessionMode } from './session';
import {
  DEFAULT_VERIFY_TIMEOUT_SECONDS,
  runVerificationCommands,
} from '../verify/verify';
import { runStage } from './run-stage';

export type PipelineOutcome =
  | 'review'
  | 'failed'
  | 'blocked'
  | 'needs_input'
  | 'retry'
  | 'done';

export interface PipelineOptions {
  taskId: string;
  developerHarnessId?: string;
  testerHarnessId?: string;
  developerAgent?: string;
  developerModel?: string;
  testerAgent?: string;
  testerModel?: string;
  maxIterations?: number;
  delivery?: DeliveryMode;
  session?: SessionMode;
  remoteHost?: string;
  timeoutSeconds?: number;
  env?: Record<string, string>;
  quiet?: boolean;
  signal?: AbortSignal;
}

export interface PipelineResult {
  task: Task;
  outcome: PipelineOutcome;
  stage: PipelineStage;
  runs: Run[];
  report: Report | null;
  developerReport: Report | null;
  testerReport: Report | null;
  verifications: VerificationResult[];
  ci: CiResult | null;
  merge: MergeResult | null;
  commitSha: string | null;
  prUrl: string | null;
  error?: string;
}

function outcomeFor(task: Task): PipelineOutcome {
  if (task.state === 'review') return 'review';
  if (task.state === 'waiting_input') return 'needs_input';
  if (task.state === 'blocked') return 'blocked';
  if (task.state === 'queued') return 'retry';
  if (task.state === 'done') return 'done';
  return 'failed';
}

function requiresForgeDelivery(mode: DeliveryMode): boolean {
  return mode === 'pr' || mode === 'auto_merge';
}

const TASK_LEASE_TTL_SECONDS = 30;
const TASK_LEASE_HEARTBEAT_MS = 10_000;

export async function runPipeline(
  store: Store,
  context: ResolvedContext,
  options: PipelineOptions,
): Promise<PipelineResult> {
  const resource = `task:${options.taskId}`;
  const owner = `${hostname()}:${process.pid}:${newId('worker')}`;
  if (!store.acquireLease(resource, owner, TASK_LEASE_TTL_SECONDS)) {
    const held = store.getLease(resource);
    throw new CrewError(
      'TASK_LEASED',
      `Task ${options.taskId} is already being executed by ${held?.owner ?? 'another process'}`,
    );
  }
  const heartbeat = setInterval(
    () => store.renewLease(resource, owner, TASK_LEASE_TTL_SECONDS),
    TASK_LEASE_HEARTBEAT_MS,
  );
  heartbeat.unref();
  try {
    return await runPipelineLocked(store, context, options);
  } finally {
    clearInterval(heartbeat);
    store.releaseLease(resource, owner);
  }
}

async function runPipelineLocked(
  store: Store,
  context: ResolvedContext,
  options: PipelineOptions,
): Promise<PipelineResult> {
  let task = store.getTaskOrThrow(options.taskId);
  const project = store.getProject(task.projectId);
  if (!project) {
    throw new CrewError('PROJECT_NOT_FOUND', `Project not found for task ${task.id}`);
  }

  const projectConfig = readProjectConfig(project.rootPath);
  const maxIterations =
    options.maxIterations ??
    projectConfig?.review?.max_iterations ??
    context.config.review.maxIterations;
  const delivery: DeliveryMode =
    options.delivery ?? task.deliveryMode ?? context.config.delivery;
  const isScout = delivery === 'scout';
  const resolution = resolveWorkspace({
    project,
    projectConfig,
    task,
    worktreesDir: context.paths.worktreesDir,
    remoteHost: options.remoteHost,
  });
  const workspace = resolution.workspace;
  const remote = resolution.runner;
  const verifyCommands = isScout ? [] : verificationCommands(projectConfig, task);
  const developerHarnessId =
    options.developerHarnessId ??
    context.config.agents.developer.harness ??
    task.harnessId ??
    context.config.harness;
  const testerHarnessId =
    options.testerHarnessId ??
    context.config.agents.tester.harness ??
    task.harnessId ??
    context.config.harness;
  let forge: ReturnType<typeof getForge> | null = null;
  if (requiresForgeDelivery(delivery)) {
    if (!project.forge) {
      throw new CrewError(
        'FORGE_UNSUPPORTED',
        `Delivery mode "${delivery}" requires a remote; found none`,
      );
    }
    forge = getForge(project.forge);
    forge.assertReady(project.rootPath);
  }
  if (delivery === 'auto_merge') {
    if (!projectConfig?.auto_merge) {
      throw new CrewError(
        'MERGE_POLICY_REQUIRED',
        'Delivery mode "auto_merge" requires auto_merge.method in the project config',
      );
    }
    if (!projectConfig.ci) {
      throw new CrewError(
        'CI_REQUIRED_FOR_AUTO_MERGE',
        'Delivery mode "auto_merge" requires a ci configuration',
      );
    }
  }

  if (options.delivery && options.delivery !== task.deliveryMode) {
    task = store.setDeliveryMode(task.id, options.delivery);
  }

  const developerAgent =
    options.developerAgent ?? context.config.agents.developer.agent;
  const developerModel =
    options.developerModel ?? context.config.agents.developer.model;
  const testerAgent = options.testerAgent ?? context.config.agents.tester.agent;
  const testerModel = options.testerModel ?? context.config.agents.tester.model;

  const base = {
    timeoutSeconds: options.timeoutSeconds,
    env: options.env ?? {},
    quiet: options.quiet,
    session: options.session,
    remote,
    workspace,
  };

  let developerReport: Report | null = null;
  let testerReport: Report | null = null;
  let developerReportPath: string | undefined;
  let verifications: VerificationResult[] = [];
  let ci: CiResult | null = null;
  let merge: MergeResult | null = null;

  try {
    if (task.state === 'review') {
      return {
        task,
        outcome: 'review',
        stage: task.stage,
        runs: store.listRuns(task.id),
        report: store.getLatestReport(task.id),
        developerReport: store.getLatestReportByRole(task.id, 'developer'),
        testerReport: store.getLatestReportByRole(task.id, 'tester'),
        verifications: store.listVerifications(task.id),
        ci: null,
        merge: null,
        commitSha: task.commitSha,
        prUrl: task.prUrl,
      };
    }
    if (task.state === 'done' || task.state === 'cancelled') {
      return {
        task,
        outcome: 'done',
        stage: task.stage,
        runs: store.listRuns(task.id),
        report: store.getLatestReport(task.id),
        developerReport: store.getLatestReportByRole(task.id, 'developer'),
        testerReport: store.getLatestReportByRole(task.id, 'tester'),
        verifications: store.listVerifications(task.id),
        ci: null,
        merge: null,
        commitSha: task.commitSha,
        prUrl: task.prUrl,
      };
    }

    const developer = await runStage(store, context, {
      ...base,
      taskId: task.id,
      harnessId: developerHarnessId,
      role: 'developer',
      stage: 'develop',
      keepTaskRunning: true,
      verifyCommands,
      agent: developerAgent,
      model: developerModel,
      signal: options.signal,
    });
    task = developer.task;
    developerReport = developer.report;
    developerReportPath = developer.reportPath;

    if (task.state !== 'running') {
      return {
        task,
        outcome: outcomeFor(task),
        stage: task.stage,
        runs: store.listRuns(task.id),
        report: developer.report,
        developerReport,
        testerReport: null,
        verifications,
        ci: null,
        merge: null,
        commitSha: task.commitSha,
        prUrl: task.prUrl,
      };
    }

    if (isScout && developer.report) {
      store.recordScoutReport(task.id, developer.report);
      task = store.requestReview(task.id);
      return {
        task,
        outcome: outcomeFor(task),
        stage: task.stage,
        runs: store.listRuns(task.id),
        report: developer.report,
        developerReport,
        testerReport: null,
        verifications,
        ci: null,
        merge: null,
        commitSha: task.commitSha,
        prUrl: task.prUrl,
      };
    }

    if (!developer.report || developer.report.status !== 'done') {
      task = store.applyReportOutcome(
        task.id,
        developer.report?.status ?? 'failed',
        developer.report?.summary,
      );
      return {
        task,
        outcome: outcomeFor(task),
        stage: task.stage,
        runs: store.listRuns(task.id),
        report: developer.report,
        developerReport,
        testerReport: null,
        verifications,
        ci: null,
        merge: null,
        commitSha: task.commitSha,
        prUrl: task.prUrl,
      };
    }

    if (verifyCommands.length > 0) {
      const outcomes = await runVerificationCommands({
        taskId: task.id,
        runId: developer.run.id,
        worktreePath: workspace.worktreePath,
        commands: verifyCommands,
        timeoutSeconds:
          projectConfig?.verify_timeout_seconds ?? DEFAULT_VERIFY_TIMEOUT_SECONDS,
        tasksDir: context.paths.tasksDir,
        env: options.env ?? {},
        signal: options.signal,
        remote,
      });
      verifications = outcomes.map((outcome) =>
        store.recordVerification({
          taskId: task.id,
          runId: developer.run.id,
          ...outcome,
        }),
      );
      const failed = verifications.filter(
        (verification) => verification.state !== 'passed',
      );
      if (failed.length > 0) {
        if (options.signal?.aborted) {
          throw new CrewError('TASK_ABORTED', 'Task aborted during verification');
        }
        task = store.rejectReview(
          task.id,
          verificationFeedback(failed),
          maxIterations,
        );
        return {
          task,
          outcome: outcomeFor(task),
          stage: task.stage,
          runs: store.listRuns(task.id),
          report: developer.report,
          developerReport,
          testerReport: null,
          verifications,
          ci: null,
          merge: null,
          commitSha: task.commitSha,
          prUrl: task.prUrl,
        };
      }
    }

    const tester = await runStage(store, context, {
      ...base,
      taskId: task.id,
      harnessId: testerHarnessId,
      role: 'tester',
      stage: 'test',
      continuePipeline: true,
      keepTaskRunning: true,
      developerReportPath,
      verifications,
      verifyCommands,
      agent: testerAgent,
      model: testerModel,
      signal: options.signal,
    });
    task = tester.task;
    testerReport = tester.report;

    if (task.state !== 'running') {
      return {
        task,
        outcome: outcomeFor(task),
        stage: task.stage,
        runs: store.listRuns(task.id),
        report: tester.report,
        developerReport,
        testerReport,
        verifications,
        ci: null,
        merge: null,
        commitSha: task.commitSha,
        prUrl: task.prUrl,
      };
    }

    if (!tester.report || tester.report.payload.verdict !== 'approve') {
      if (tester.report?.payload.verdict === 'reject') {
        const feedback = rejectFeedback(tester.report);
        task = store.rejectReview(task.id, feedback, maxIterations);
      } else {
        task = store.applyReportOutcome(
          task.id,
          tester.report?.status ?? 'failed',
          tester.report?.summary,
        );
      }
      return {
        task,
        outcome: outcomeFor(task),
        stage: task.stage,
        runs: store.listRuns(task.id),
        report: tester.report,
        developerReport,
        testerReport,
        verifications,
        ci: null,
        merge: null,
        commitSha: task.commitSha,
        prUrl: task.prUrl,
      };
    }

    if (options.signal?.aborted) {
      throw new CrewError('TASK_ABORTED', 'Task aborted before delivery');
    }

    const commit = commitWorkspace(workspace, `crew: ${task.title}`);
    task = store.recordCommit(task.id, commit.sha);

    const change = diffStatsWorkspace(workspace, task.baseBranch);
    if (change) {
      task = store.recordChangeStats(task.id, change);
    }

    if (requiresForgeDelivery(delivery)) {
      const branch = task.branch ?? currentBranch(workspace.repoPath);
      pushWorkspace(workspace, branch);
      const pullRequest = (forge as NonNullable<typeof forge>).createPullRequest({
        cwd: project.rootPath,
        base: task.baseBranch,
        head: branch,
        title: task.title,
        body: pullRequestBody(task, developerReport),
      });
      task = store.recordPullRequest(task.id, pullRequest.url);

      if (projectConfig?.ci) {
        if (project.forge !== 'github') {
          throw new CrewError(
            'CI_PROVIDER_UNSUPPORTED',
            `The CI gate uses GitHub Actions; the project forge is ${project.forge}`,
          );
        }
        ci = await waitForCiGate({
          cwd: project.rootPath,
          prUrl: pullRequest.url,
          commitSha: commit.sha,
          timeoutSeconds:
            projectConfig.ci.timeout_seconds ?? DEFAULT_CI_TIMEOUT_SECONDS,
          intervalSeconds:
            projectConfig.ci.interval_seconds ?? DEFAULT_CI_INTERVAL_SECONDS,
          signal: options.signal,
        });
        task = store.recordCiCheck(task.id, ci);
        if (ci.state !== 'passed') {
          task = store.failTask(task.id, `CI gate failed: ${ci.summary}`);
          return {
            task,
            outcome: 'failed',
            stage: task.stage,
            runs: store.listRuns(task.id),
            report: tester.report,
            developerReport,
            testerReport,
            verifications,
            ci,
            merge: null,
            commitSha: task.commitSha,
            prUrl: task.prUrl,
          };
        }
      }

      if (delivery === 'auto_merge') {
        if (options.signal?.aborted) {
          throw new CrewError('TASK_ABORTED', 'Task aborted before merge');
        }
        task = store.requestReview(task.id);
        const deliveryPolicy = resolveDeliveryPolicy({
          taskMode: delivery,
          projectConfig,
        });
        if (!deliveryPolicy.yolo) {
          throw new CrewError(
            'MERGE_POLICY_REQUIRED',
            'Delivery mode "auto_merge" requires delivery.yolo in the project config',
          );
        }
        // The standing authority never covers a high-risk change: that one
        // waits for a human, whatever the posture says.
        const changeRisk = assessRisk({
          change: change ?? { files: 0, additions: 0, deletions: 0, paths: [] },
          testerReport,
          verifications,
          ci: ci ? { state: ci.state } : null,
        });
        if (changeRisk.level === 'high') {
          throw new CrewError(
            'MERGE_REQUIRES_HUMAN',
            'The change is high risk: it waits for a human authorization',
          );
        }
        if (projectConfig?.ci && !ci) {
          throw new CrewError(
            'CI_NOT_REPORTED',
            'CI is configured but no check has reported yet',
          );
        }
        const method = deliveryPolicy.method;
        const deleteBranch = deliveryPolicy.deleteBranch;
        try {
          (forge as NonNullable<typeof forge>).mergePullRequest({
            cwd: project.rootPath,
            url: pullRequest.url,
            method,
            deleteBranch,
          });
          merge = {
            state: 'merged',
            method,
            actor: 'crew',
            reason: 'policy satisfied: verification, tester and CI passed',
            url: pullRequest.url,
            deleteBranch,
          };
        } catch (error) {
          let prState = 'UNKNOWN';
          try {
            prState = (forge as NonNullable<typeof forge>).viewPullRequest(
              project.rootPath,
              pullRequest.url,
            ).state;
          } catch {
            // Keep UNKNOWN when the PR state cannot be read after a merge failure.
          }
          merge = {
            state: 'failed',
            method,
            actor: 'crew',
            reason: `${errorMessage(error)} (PR ${prState})`,
            url: pullRequest.url,
            deleteBranch,
          };
        }
        task = store.recordMergeResult(task.id, merge);
        if (merge.state === 'merged') {
          task = store.acceptTask(task.id);
        }
        return {
          task,
          outcome: outcomeFor(task),
          stage: task.stage,
          runs: store.listRuns(task.id),
          report: tester.report,
          developerReport,
          testerReport,
          verifications,
          ci,
          merge,
          commitSha: task.commitSha,
          prUrl: task.prUrl,
        };
      }
    }

    task = store.requestReview(task.id);
    return {
      task,
      outcome: 'review',
      stage: task.stage,
      runs: store.listRuns(task.id),
      report: tester.report,
      developerReport,
      testerReport,
      verifications,
      ci,
      merge,
      commitSha: task.commitSha,
      prUrl: task.prUrl,
    };
  } catch (error) {
    const message = errorMessage(error);
    const current = store.getTask(task.id);
    if (!current || current.state !== 'running') {
      throw error;
    }
    store.failTask(task.id, message, { retryable: isRetryableError(error) });
    return {
      task: store.getTaskOrThrow(task.id),
      outcome: 'failed',
      stage: store.getTaskOrThrow(task.id).stage,
      runs: store.listRuns(task.id),
      report: testerReport ?? developerReport,
      developerReport,
      testerReport,
      verifications: store.listVerifications(task.id),
      ci,
      merge,
      commitSha: store.getTaskOrThrow(task.id).commitSha,
      prUrl: store.getTaskOrThrow(task.id).prUrl,
      error: message,
    };
  }
}

function verificationCommands(
  projectConfig: ReturnType<typeof readProjectConfig>,
  task: Task,
): string[] {
  const commands = [
    ...(projectConfig?.verify ?? []),
    ...(task.spec?.acceptance_criteria
      .map((criterion) => criterion.verify)
      .filter((command): command is string => Boolean(command)) ?? []),
  ];
  return [...new Set(commands.map((command) => command.trim()).filter(Boolean))];
}

function verificationFeedback(results: VerificationResult[]): string {
  const lines = ['Independent verification failed:'];
  for (const result of results) {
    const exit =
      result.exitCode === null ? result.state : `exit ${result.exitCode}`;
    lines.push(`- \`${result.command}\` (${exit})`);
    if (result.timedOut) {
      lines.push('  Timed out');
    }
    if (result.error) {
      lines.push(`  Error: ${result.error}`);
    }
    const output = result.output.trim();
    if (output) {
      lines.push('  Output (tail):');
      for (const line of output.slice(-2000).split('\n')) {
        lines.push(`  ${line}`);
      }
    }
    lines.push(`  Log: ${result.logPath}`);
  }
  return lines.join('\n');
}

function rejectFeedback(report: Report): string {
  const findings = report.payload.findings ?? [];
  const blocking = findings
    .filter((finding) => finding.severity === 'blocking')
    .map((finding) => `- ${finding.message}`);
  if (blocking.length === 0) {
    return report.summary;
  }
  return `${report.summary}\n${blocking.join('\n')}`;
}

function pullRequestBody(task: Task, report: Report | null): string {
  const lines = [task.briefText || task.title];
  const criteria = task.spec?.acceptance_criteria ?? [];
  if (criteria.length > 0) {
    lines.push('', '## Acceptance criteria');
    for (const criterion of criteria) {
      lines.push(`- ${criterion.id}: ${criterion.text}`);
    }
  }
  if (report) {
    lines.push('', '## Developer report', report.summary);
  }
  lines.push('', 'Generated by crew.');
  return lines.join('\n');
}
