import { CrewError, errorMessage } from '../core/errors';
import type {
  CiResult,
  DeliveryMode,
  PipelineStage,
  Report,
  Run,
  Task,
  VerificationResult,
} from '../core/types';
import type { ResolvedContext } from '../config/config';
import { readProjectConfig } from '../config/config';
import type { Store } from '../store/store';
import { commitWorktree, pushBranch } from '../git/commit';
import { assertGhReady, createPullRequest } from '../git/forge';
import {
  DEFAULT_CI_INTERVAL_SECONDS,
  DEFAULT_CI_TIMEOUT_SECONDS,
  waitForCiGate,
} from '../ci/ci';
import { currentBranch } from '../git/git';
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
  timeoutSeconds?: number;
  env?: Record<string, string>;
  quiet?: boolean;
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

function isUnsupportedDelivery(mode: DeliveryMode): boolean {
  return mode === 'auto_merge' || mode === 'scout';
}

export async function runPipeline(
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
  const verifyCommands = verificationCommands(projectConfig, task);
  const maxIterations =
    options.maxIterations ??
    projectConfig?.review?.max_iterations ??
    context.config.review.maxIterations;
  const delivery: DeliveryMode =
    options.delivery ?? task.deliveryMode ?? context.config.delivery;
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
  if (isUnsupportedDelivery(delivery)) {
    throw new CrewError(
      'DELIVERY_UNSUPPORTED',
      `Delivery mode "${delivery}" is not supported yet`,
    );
  }
  if (delivery === 'pr') {
    if (project.forge !== 'github') {
      throw new CrewError(
        'FORGE_UNSUPPORTED',
        `Delivery mode "pr" requires a GitHub remote; found ${project.forge ?? 'none'}`,
      );
    }
    assertGhReady(project.rootPath);
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
  };

  let developerReport: Report | null = null;
  let testerReport: Report | null = null;
  let developerReportPath: string | undefined;
  let verifications: VerificationResult[] = [];
  let ci: CiResult | null = null;

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
        commitSha: task.commitSha,
        prUrl: task.prUrl,
      };
    }

    if (verifyCommands.length > 0) {
      const outcomes = await runVerificationCommands({
        taskId: task.id,
        runId: developer.run.id,
        worktreePath: task.worktreePath ?? project.rootPath,
        commands: verifyCommands,
        timeoutSeconds:
          projectConfig?.verify_timeout_seconds ?? DEFAULT_VERIFY_TIMEOUT_SECONDS,
        tasksDir: context.paths.tasksDir,
        env: options.env ?? {},
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
        commitSha: task.commitSha,
        prUrl: task.prUrl,
      };
    }

    const commit = commitWorktree(
      task.worktreePath ?? project.rootPath,
      `crew: ${task.title}`,
    );
    task = store.recordCommit(task.id, commit.sha);

    if (delivery === 'pr') {
      const branch = task.branch ?? currentBranch(project.rootPath);
      pushBranch(project.rootPath, branch);
      const pullRequest = createPullRequest({
        cwd: project.rootPath,
        base: task.baseBranch,
        head: branch,
        title: task.title,
        body: pullRequestBody(task, developerReport),
      });
      task = store.recordPullRequest(task.id, pullRequest.url);

      if (projectConfig?.ci) {
        ci = await waitForCiGate({
          cwd: project.rootPath,
          prUrl: pullRequest.url,
          commitSha: commit.sha,
          timeoutSeconds:
            projectConfig.ci.timeout_seconds ?? DEFAULT_CI_TIMEOUT_SECONDS,
          intervalSeconds:
            projectConfig.ci.interval_seconds ?? DEFAULT_CI_INTERVAL_SECONDS,
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
            commitSha: task.commitSha,
            prUrl: task.prUrl,
          };
        }
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
      commitSha: task.commitSha,
      prUrl: task.prUrl,
    };
  } catch (error) {
    const message = errorMessage(error);
    const current = store.getTask(task.id);
    if (!current || current.state !== 'running') {
      throw error;
    }
    store.failTask(task.id, message);
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
