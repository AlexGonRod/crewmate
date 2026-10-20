import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { generateBrief } from '../brief/brief';
import { errorMessage } from '../core/errors';
import { newId } from '../core/ids';
import { redactDeep } from '../core/redact';
import { slugify } from '../core/slug';
import type { Project, Report, Run, Task } from '../core/types';
import { readProjectConfig } from '../config/config';
import type { ResolvedContext } from '../config/config';
import { ensureWorktree, removeWorktree } from '../git/worktree';
import { assertHarnessAvailable } from '../adapters/harness/detect';
import { getHarness, resolveHarnessId } from '../adapters/harness/registry';
import { runProcess, type ProcessResult } from '../adapters/backend/process';
import {
  normalizeReport,
  parseReportFromOutput,
  readReportFile,
  validateReport,
} from '../protocol/report';
import type { Store } from '../store/store';

export interface RunTaskOptions {
  taskId: string;
  harnessId: string;
  timeoutSeconds?: number;
  env: Record<string, string>;
  quiet?: boolean;
}

export interface RunTaskResult {
  task: Task;
  run: Run;
  report: Report | null;
  process: ProcessResult;
}

export async function runTask(
  store: Store,
  context: ResolvedContext,
  options: RunTaskOptions,
): Promise<RunTaskResult> {
  const initialTask = store.getTaskOrThrow(options.taskId);
  const project = store.getProject(initialTask.projectId);
  if (!project) {
    throw new Error(`Project not found for task ${initialTask.id}`);
  }
  if (store.getActiveRun(initialTask.id)) {
    throw new Error(`Task ${initialTask.id} already has an active run`);
  }

  const harnessId = resolveHarnessId(options.harnessId);
  const harness = getHarness(harnessId);
  const availability = assertHarnessAvailable(harness);
  const attempt = store.nextAttempt(initialTask.id);
  const branch =
    initialTask.branch ?? `crew/${initialTask.id}-${slugify(initialTask.title)}`;
  const worktreePath =
    initialTask.worktreePath ??
    path.join(context.paths.worktreesDir, slugify(project.name), initialTask.id);

  const taskDir = path.join(context.paths.tasksDir, initialTask.id);
  const runId = newId('run');
  const runDir = path.join(taskDir, 'runs', runId);
  const logPath = path.join(runDir, 'run.jsonl');
  const briefDataPath = path.join(taskDir, `brief-${attempt}.md`);
  const briefPath = path.join(worktreePath, '.crew', 'brief.md');
  const specPath = path.join(worktreePath, '.crew', 'spec.json');
  const reportPath = path.join(worktreePath, '.crew', 'report.json');

  mkdirSync(runDir, { recursive: true });

  let worktreeCreated = false;
  try {
    const worktree = ensureWorktree({
      repoPath: project.rootPath,
      worktreePath,
      branch,
      baseBranch: initialTask.baseBranch,
    });
    worktreeCreated = worktree.created;

    store.startRun({
      taskId: initialTask.id,
      runId,
      attempt,
      harnessId,
      backend: 'process',
      logPath,
      worktreePath,
      branch,
    });
  } catch (error) {
    if (worktreeCreated) {
      try {
        removeWorktree({ repoPath: project.rootPath, worktreePath, force: false });
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

  mkdirSync(path.join(worktreePath, '.crew'), { recursive: true });

  const projectConfig = readProjectConfig(project.rootPath);
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
    verifyCommands: projectConfig?.verify ?? [],
    messages: store.listMessages(task.id),
  });
  writeFileSync(briefDataPath, brief, 'utf8');
  writeFileSync(briefPath, brief, 'utf8');
  if (task.spec) {
    writeFileSync(specPath, `${JSON.stringify(task.spec, null, 2)}\n`, 'utf8');
  }

  const baseEnv: Record<string, string> = {
    ...stringEnv(process.env),
    ...options.env,
    CREW_TASK_ID: task.id,
    CREW_RUN_ID: run.id,
    CREW_PROJECT_ID: project.id,
    CREW_METHODOLOGY: task.methodology,
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
      const raw =
        readReportFile(reportPath) ?? parseReportFromOutput(processResult.outputTail);
      if (raw) {
        const normalized = normalizeReport(raw, {
          taskId: task.id,
          runId: run.id,
          methodology: task.methodology,
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
  });
  const finalRun = store.getRun(run.id) ?? run;

  return {
    task: finalTask,
    run: finalRun,
    report: report ?? store.getReportByRun(run.id),
    process: processResult,
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
