import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { generateBrief } from '../brief/brief';
import { CrewError, errorMessage } from '../core/errors';
import { newId } from '../core/ids';
import { redactDeep } from '../core/redact';
import { slugify } from '../core/slug';
import type {
  AgentRole,
  PipelineStage,
  Project,
  Report,
  Run,
  Task,
  VerificationResult,
} from '../core/types';
import { readProjectConfig } from '../config/config';
import type { ResolvedContext } from '../config/config';
import { ensureWorkspace, removeWorkspace, type Workspace } from './workspace';
import { resolveRoleAgents, roleContractFor } from './role-agents';
import { discoverSkills } from './skills';
import { assertHarnessAvailable } from '../adapters/harness/detect';
import { getHarness, resolveHarnessId } from '../adapters/harness/registry';
import { runProcess, type ProcessResult } from '../adapters/backend/process';
import { sessionNameForTask, type SessionMode } from './session';
import type { RemoteRunner } from './runner';
import {
  normalizeReport,
  parseReportFromOutput,
  parseReportText,
  readReportFile,
  validateReport,
} from '../protocol/report';
import type { Store } from '../store/store';

export interface RunStageOptions {
  taskId: string;
  harnessId: string;
  role?: AgentRole;
  stage?: PipelineStage;
  continuePipeline?: boolean;
  keepTaskRunning?: boolean;
  developerReportPath?: string;
  verifications?: VerificationResult[];
  verifyCommands?: string[];
  agent?: string;
  model?: string;
  timeoutSeconds?: number;
  env: Record<string, string>;
  quiet?: boolean;
  signal?: AbortSignal;
  session?: SessionMode;
  remote?: RemoteRunner | null;
  workspace: Workspace;
}

export interface RunStageResult {
  task: Task;
  run: Run;
  report: Report | null;
  process: ProcessResult;
  reportPath: string;
}

export async function runStage(
  store: Store,
  context: ResolvedContext,
  options: RunStageOptions,
): Promise<RunStageResult> {
  const initialTask = store.getTaskOrThrow(options.taskId);
  const project = store.getProject(initialTask.projectId);
  if (!project) {
    throw new Error(`Project not found for task ${initialTask.id}`);
  }
  if (store.getActiveRun(initialTask.id)) {
    throw new Error(`Task ${initialTask.id} already has an active run`);
  }
  if (options.signal?.aborted) {
    throw new CrewError(
      'RUN_ABORTED',
      `Task ${initialTask.id} was aborted before starting ${options.role ?? 'developer'}`,
    );
  }

  const role: AgentRole = options.role ?? 'developer';
  const stage: PipelineStage = options.stage ?? 'develop';
  const harnessId = resolveHarnessId(options.harnessId);
  const harness = getHarness(harnessId);
  const availability = assertHarnessAvailable(harness);
  const attempt = store.nextAttempt(initialTask.id);
  const branch =
    initialTask.branch ?? `crew/${initialTask.id}-${slugify(initialTask.title)}`;
  const worktreePath = options.workspace.worktreePath;

  const taskDir = path.join(context.paths.tasksDir, initialTask.id);
  const runId = newId('run');
  const runDir = path.join(taskDir, 'runs', runId);
  const logPath = path.join(runDir, 'run.jsonl');
  const briefDataPath = path.join(taskDir, `brief-${runId}.md`);
  const briefPath = path.join(worktreePath, '.crew', 'brief.md');
  const specPath = path.join(worktreePath, '.crew', 'spec.json');
  const reportPath = path.join(worktreePath, '.crew', 'reports', `${runId}.json`);

  mkdirSync(runDir, { recursive: true });

  let worktreeCreated = false;
  try {
    const worktree = ensureWorkspace(options.workspace, {
      branch,
      baseBranch: initialTask.baseBranch,
    });
    worktreeCreated = worktree.created;

    store.startRun({
      taskId: initialTask.id,
      runId,
      attempt,
      harnessId,
      role,
      stage,
      continuePipeline: options.continuePipeline,
      backend: 'process',
      logPath,
      worktreePath,
      branch,
    });
  } catch (error) {
    if (worktreeCreated) {
      try {
        removeWorkspace(options.workspace, { force: false });
      } catch {
        // Keep the original error; doctor can report a leftover worktree.
      }
    }
    throw error;
  }

  const task = store.getTaskOrThrow(initialTask.id);
  const run = store.getRun(runId);
  if (!run) {
    throw new Error(`Run not found after start: ${runId}`);
  }

  options.workspace.ensureDir(path.dirname(reportPath));

  const projectConfig = readProjectConfig(project.rootPath);
  const roleAgents = resolveRoleAgents(
    roleContractFor(role, task.deliveryMode),
    {
      projectRoot: project.rootPath,
      context: {
        reviewIteration: task.reviewIterations,
        methodology: task.methodology,
        developerReportPath: options.developerReportPath,
      },
    },
  );
  const brief = generateBrief({
    task,
    project,
    run,
    attempt,
    reportPath,
    briefPath,
    specPath,
    cliCommand: process.env.CREW_BIN ?? 'crew',
    methodology: task.methodology,
    spec: task.spec,
    role,
    stage,
    reviewIteration: task.reviewIterations,
    developerReportPath: options.developerReportPath,
    verifyCommands:
      options.verifyCommands ?? projectConfig?.verify ?? [],
    verifications: options.verifications,
    messages: store.listMessages(task.id),
    memories: store.listMemories(project.id),
    skills: discoverSkills({ projectRoot: project.rootPath }),
    roleAgents: roleAgents.content,
  });
  writeFileSync(briefDataPath, brief, 'utf8');
  options.workspace.writeFile(briefPath, brief);
  if (task.spec) {
    options.workspace.writeFile(specPath, `${JSON.stringify(task.spec, null, 2)}\n`);
  }

  const baseEnv: Record<string, string> = {
    ...stringEnv(process.env),
    ...options.env,
    CREW_TASK_ID: task.id,
    CREW_RUN_ID: run.id,
    CREW_PROJECT_ID: project.id,
    CREW_METHODOLOGY: task.methodology,
    CREW_ROLE: role,
    CREW_STAGE: stage,
    CREW_REVIEW_ITERATION: String(task.reviewIterations),
    CREW_DEVELOPER_REPORT_PATH: options.developerReportPath ?? '',
    CREW_WORKTREE: worktreePath,
    CREW_BRIEF_PATH: briefPath,
    CREW_SPEC_PATH: specPath,
    CREW_REPORT_PATH: reportPath,
    CREW_DB_PATH: store.dbPath,
  };

  const launch = harness.buildLaunch({
    task,
    project,
    run,
    worktreePath,
    briefPath,
    brief,
    reportPath,
    dbPath: store.dbPath,
    role,
    agent: options.agent,
    model: options.model,
    env: options.env,
  });

  const timeoutSeconds =
    options.timeoutSeconds && options.timeoutSeconds > 0
      ? options.timeoutSeconds
      : context.config.timeoutSeconds;

  let processResult: ProcessResult;
  let processError: string | undefined;
  try {
    processResult = await runProcess({
      command: availability.binary ?? launch.command,
      args: launch.args,
      cwd: worktreePath,
      env: { ...baseEnv, ...launch.env },
      logPath,
      timeoutMs: timeoutSeconds * 1000,
      stdin: brief,
      quiet: options.quiet,
      signal: options.signal,
      session: options.session ? sessionNameForTask(task.id, role) : undefined,
      sessionMode: options.session,
      sessionStateDir: path.join(context.paths.dataDir, 'sessions'),
      remote: options.remote ?? null,
      stdinPath: briefPath,
      onSpawn: (pid) => {
        store.markRunRunning(run.id, pid);
      },
    });
  } catch (error) {
    processError = errorMessage(error);
    processResult = {
      exitCode: null,
      signal: null,
      timedOut: false,
      outputTail: '',
    };
  }

  let report = store.getReportByRun(run.id);
  let reportError = processError;
  if (!report && !processResult.timedOut) {
    try {
      const workspaceReport = options.workspace.readFile(reportPath);
      const raw = workspaceReport
        ? parseReportText(workspaceReport)
        : (readReportFile(reportPath) ??
          parseReportFromOutput(processResult.outputTail));
      if (raw) {
        const normalized = normalizeReport(raw, {
          taskId: task.id,
          runId: run.id,
          methodology: task.methodology,
          role,
          reviewIteration: task.reviewIterations,
        });
        const payload = validateReport(redactDeep(normalized));
        report = store.recordReport(payload);
      }
    } catch (error) {
      reportError = errorMessage(error);
    }
  }

  const finalTask = store.finishRun({
    runId: run.id,
    exitCode: processResult.exitCode,
    signal: processResult.signal,
    timedOut: processResult.timedOut,
    reportError,
    keepTaskRunning: options.keepTaskRunning,
  });
  const finalRun = store.getRun(run.id) ?? run;

  return {
    task: finalTask,
    run: finalRun,
    report: report ?? store.getReportByRun(run.id),
    process: processResult,
    reportPath,
  };
}

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

export function projectForTask(store: Store, task: Task): Project {
  const project = store.getProject(task.projectId);
  if (!project) {
    throw new Error(`Project not found: ${task.projectId}`);
  }
  return project;
}
