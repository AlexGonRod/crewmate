import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command, CommanderError } from 'commander';
import pc from 'picocolors';
import { runDaemon, type DaemonTaskResult } from '../app/daemon';
import { addProject, initProject } from '../app/projects';
import { detectHarness } from '../adapters/harness/detect';
import { listHarnessAdapters } from '../adapters/harness/registry';
import { runPipeline } from '../app/pipeline';
import { loadContext, readProjectConfig, type ResolvedContext } from '../config/config';
import { CrewError, errorMessage } from '../core/errors';
import { isPidAlive, terminateProcessTree } from '../core/process';
import { redactDeep } from '../core/redact';
import type { DeliveryMode, TaskSpec, TaskState } from '../core/types';
import { runDoctor } from '../doctor/doctor';
import { removeWorktree } from '../git/worktree';
import { viewPullRequest } from '../git/forge';
import {
  normalizeReport,
  parseReportText,
  validateReport,
} from '../protocol/report';
import {
  loadSpecFile,
  methodologyRequiresSpec,
  parseMethodology,
  resolveMethodology,
  specFromOptions,
  validateSpec,
} from '../spec/spec';
import { Store } from '../store/store';
import { VERSION } from '../version';

type GlobalOptions = {
  json?: boolean;
  db?: string;
  verbose?: boolean;
};

let activeProgram: Command | null = null;

function globalOptions(): GlobalOptions {
  return (activeProgram?.opts() ?? {}) as GlobalOptions;
}

function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? Number(value) : value;
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, jsonReplacer, 2)}\n`);
}

function printTable(
  rows: Array<Record<string, unknown>>,
  columns: Array<{ key: string; label: string }>,
): void {
  if (rows.length === 0) {
    console.log('(empty)');
    return;
  }
  const widths = columns.map((column) =>
    Math.max(
      column.label.length,
      ...rows.map((row) => String(row[column.key] ?? '').length),
    ),
  );
  const render = (values: string[]): string =>
    values.map((value, index) => value.padEnd(widths[index] ?? 0)).join('  ');
  console.log(render(columns.map((column) => column.label)));
  console.log(render(widths.map((width) => '-'.repeat(width))));
  for (const row of rows) {
    console.log(render(columns.map((column) => String(row[column.key] ?? ''))));
  }
}

function stateLabel(state: string): string {
  if (state === 'done') {
    return pc.green(state);
  }
  if (state === 'failed' || state === 'cancelled') {
    return pc.red(state);
  }
  if (state === 'waiting_input' || state === 'blocked') {
    return pc.yellow(state);
  }
  return pc.cyan(state);
}

async function withStore<T>(
  fn: (store: Store, context: ResolvedContext) => Promise<T> | T,
): Promise<T> {
  const context = loadContext({ dbPath: globalOptions().db });
  const store = new Store(context.paths.dbPath);
  try {
    return await fn(store, context);
  } finally {
    store.close();
  }
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseEnv(values: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of values) {
    const index = entry.indexOf('=');
    if (index <= 0) {
      throw new CrewError('INVALID_ENV', `Expected KEY=VALUE, got: ${entry}`);
    }
    result[entry.slice(0, index)] = entry.slice(index + 1);
  }
  return result;
}

function readBrief(options: { brief?: string; briefFile?: string }): string {
  if (options.brief && options.briefFile) {
    throw new CrewError('INVALID_BRIEF', 'Use either --brief or --brief-file, not both');
  }
  if (options.briefFile) {
    if (options.briefFile === '-') {
      return readFileSync(0, 'utf8');
    }
    return readFileSync(path.resolve(options.briefFile), 'utf8');
  }
  if (options.brief) {
    return options.brief;
  }
  throw new CrewError('INVALID_BRIEF', 'One of --brief or --brief-file is required');
}

function parseDeliveryMode(value: string): DeliveryMode {
  if (value === 'local' || value === 'pr' || value === 'auto_merge' || value === 'scout') {
    return value;
  }
  throw new CrewError('INVALID_DELIVERY_MODE', `Unknown delivery mode: ${value}`);
}

function renderTaskDetail(detail: ReturnType<Store['getTaskDetail']>): void {
  const { task, project } = detail;
  console.log(`${pc.bold('Task')} ${task.id} [${stateLabel(task.state)}]`);
  console.log(`Title:     ${task.title}`);
  console.log(`Project:   ${project ? `${project.name} (${project.id})` : task.projectId}`);
  console.log(`Base:      ${task.baseBranch}`);
  console.log(`Branch:    ${task.branch ?? '-'}`);
  console.log(`Worktree:  ${task.worktreePath ?? '-'}`);
  console.log(`Harness:   ${task.harnessId ?? '-'}`);
  console.log(`Stage:     ${task.stage} (review iterations: ${task.reviewIterations})`);
  console.log(`Commit:    ${task.commitSha ?? '-'}`);
  console.log(`PR:        ${task.prUrl ?? '-'}`);
  const ci = detail.artifacts.filter((artifact) => artifact.kind === 'ci').at(-1);
  if (ci) {
    const state = typeof ci.metadata?.state === 'string' ? ci.metadata.state : 'unknown';
    const summary =
      typeof ci.metadata?.summary === 'string' ? ci.metadata.summary : ci.ref;
    console.log(`CI:        ${state} - ${summary}`);
  }
  const merge = detail.artifacts
    .filter((artifact) => artifact.kind === 'merge')
    .at(-1);
  if (merge) {
    const state =
      typeof merge.metadata?.state === 'string' ? merge.metadata.state : 'unknown';
    const method =
      typeof merge.metadata?.method === 'string' ? merge.metadata.method : 'unknown';
    const actor =
      typeof merge.metadata?.actor === 'string' ? merge.metadata.actor : 'unknown';
    const reason =
      typeof merge.metadata?.reason === 'string' ? merge.metadata.reason : merge.ref;
    console.log(`Merge:     ${state} (${method} by ${actor}) - ${reason}`);
  }
  console.log(`Delivery:  ${task.deliveryMode}`);
  console.log(`Method:    ${task.methodology}`);
  console.log(`Created:   ${task.createdAt}`);
  console.log(`Updated:   ${task.updatedAt}`);
  if (task.spec) {
    console.log(`Spec:      ${task.spec.goal}`);
    for (const criterion of task.spec.acceptance_criteria) {
      console.log(`  ${criterion.id}: ${criterion.text}`);
    }
  }
  if (detail.report) {
    const verdict = detail.report.payload.verdict
      ? ` (${detail.report.payload.verdict})`
      : '';
    console.log(
      `Report:    ${detail.report.status}${verdict} - ${detail.report.summary}`,
    );
    for (const finding of detail.report.payload.findings ?? []) {
      console.log(`  [${finding.severity}] ${finding.message}`);
    }
    for (const evidence of detail.report.payload.acceptance ?? []) {
      console.log(
        `  ${evidence.criterion_id}: ${evidence.status} - ${evidence.evidence}`,
      );
    }
  }
  if (detail.verifications.length > 0) {
    console.log('\nVerification:');
    for (const verification of detail.verifications) {
      const exit =
        verification.exitCode === null ? verification.state : `exit=${verification.exitCode}`;
      console.log(
        `  ${verification.state} ${exit} ${verification.durationMs}ms ${verification.command}`,
      );
      if (verification.state !== 'passed') {
        const output = verification.output.trim();
        if (output) {
          for (const line of output.slice(-1000).split('\n')) {
            console.log(`    ${line}`);
          }
        }
        console.log(`    log: ${verification.logPath}`);
      }
    }
  }
  if (detail.runs.length > 0) {
    console.log('\nRuns:');
    for (const run of detail.runs) {
      console.log(
        `  ${run.id}  attempt=${run.attempt}  ${stateLabel(run.state)}  exit=${run.exitCode ?? '-'}  ${run.startedAt}`,
      );
    }
  }
  if (detail.messages.length > 0) {
    console.log('\nMessages:');
    for (const message of detail.messages) {
      console.log(`  [${message.direction}/${message.kind}] ${message.body}`);
    }
  }
  if (detail.artifacts.length > 0) {
    console.log('\nArtifacts:');
    for (const artifact of detail.artifacts) {
      console.log(`  ${artifact.kind} ${artifact.ref}`);
    }
  }
}

function taskRunExitCode(state: TaskState): number {
  if (state === 'done' || state === 'review') {
    return 0;
  }
  if (state === 'waiting_input' || state === 'blocked') {
    return 2;
  }
  return 1;
}

function buildProgram(): Command {
  const program = new Command();
  program
    .name('crew')
    .description('Language-agnostic multi-agent orchestrator')
    .version(VERSION)
    .option('--json', 'emit machine-readable JSON')
    .option('--db <path>', 'override the SQLite database path')
    .option('--verbose', 'show stack traces')
    .showHelpAfterError()
    .exitOverride();

  program
    .command('init')
    .description('write .crew/config.yaml for the current repository')
    .option('--force', 'overwrite an existing config')
    .action((options: { force?: boolean }) => {
      const result = initProject(process.cwd(), options.force);
      if (globalOptions().json) {
        printJson(result);
      } else {
        console.log(`Initialized ${result.configPath}`);
      }
    });

  const harness = program.command('harness').description('inspect harness adapters');

  harness
    .command('list')
    .description('list harness adapters, availability, and capabilities')
    .action(() => {
      const entries = listHarnessAdapters().map((adapter) => {
        const availability = detectHarness(adapter.manifest);
        return {
          id: adapter.manifest.metadata.id,
          name: adapter.manifest.metadata.name,
          available: availability.available,
          binary: availability.binary,
          modes: adapter.manifest.spec.execution.modes,
          capabilities: adapter.manifest.spec.capabilities,
          manifest: adapter.manifest,
        };
      });
      if (globalOptions().json) {
        printJson({ harnesses: entries });
        return;
      }
      printTable(
        entries.map((entry) => ({
          id: entry.id,
          name: entry.name,
          available: entry.available ? 'yes' : 'no',
          binary: entry.binary ?? '-',
          modes: entry.modes.join(','),
        })),
        [
          { key: 'id', label: 'ID' },
          { key: 'name', label: 'NAME' },
          { key: 'available', label: 'AVAILABLE' },
          { key: 'binary', label: 'BINARY' },
          { key: 'modes', label: 'MODES' },
        ],
      );
    });

  const project = program.command('project').description('manage registered projects');

  project
    .command('add <path>')
    .description('register a git repository')
    .option('--name <name>', 'project name')
    .action(async (inputPath: string, options: { name?: string }) => {
      const created = await withStore((store) =>
        addProject(store, inputPath, options.name),
      );
      if (globalOptions().json) {
        printJson({ project: created });
      } else {
        console.log(`Added project ${created.name} (${created.id})`);
      }
    });

  project
    .command('list')
    .description('list registered projects')
    .action(async () => {
      const projects = await withStore((store) => store.listProjects());
      if (globalOptions().json) {
        printJson({ projects });
      } else {
        printTable(
          projects.map((item) => ({
            id: item.id,
            name: item.name,
            branch: item.defaultBranch,
            forge: item.forge ?? '-',
            path: item.rootPath,
          })),
          [
            { key: 'id', label: 'ID' },
            { key: 'name', label: 'NAME' },
            { key: 'branch', label: 'BRANCH' },
            { key: 'forge', label: 'FORGE' },
            { key: 'path', label: 'PATH' },
          ],
        );
      }
    });

  const task = program.command('task').description('manage tasks');

  task
    .command('create')
    .description('create a task')
    .requiredOption('--project <ref>', 'project id or name')
    .requiredOption('--title <title>', 'task title')
    .option('--brief <text>', 'task brief or goal')
    .option('--brief-file <path>', 'read the brief from a file, or - for stdin')
    .option('--methodology <mode>', 'free, spec, or tdd')
    .option('--spec-file <path>', 'read a crew.spec/v1 JSON or YAML file')
    .option('--acceptance <text>', 'acceptance criterion (repeatable)', collect, [])
    .option('--non-goal <text>', 'non-goal (repeatable)', collect, [])
    .option('--delivery <mode>', 'local, pr, auto_merge, or scout')
    .action(
      async (options: {
        project: string;
        title: string;
        brief?: string;
        briefFile?: string;
        methodology?: string;
        specFile?: string;
        acceptance: string[];
        nonGoal: string[];
        delivery?: string;
      }) => {
        const created = await withStore((store, context) => {
          const selected = store.getProject(options.project);
          if (!selected) {
            throw new CrewError('PROJECT_NOT_FOUND', `Project not found: ${options.project}`);
          }
          const projectConfig = readProjectConfig(selected.rootPath);
          const deliveryMode = options.delivery
            ? parseDeliveryMode(options.delivery)
            : projectConfig?.delivery ?? context.config.delivery;
          const explicitMethodology = options.methodology
            ? parseMethodology(options.methodology)
            : undefined;
          const specInput =
            Boolean(options.specFile) ||
            options.acceptance.length > 0 ||
            options.nonGoal.length > 0;
          const methodology = resolveMethodology(
            explicitMethodology,
            specInput ? 'spec' : projectConfig?.methodology,
          );
          if (explicitMethodology === 'free' && specInput) {
            throw new CrewError(
              'INVALID_SPEC',
              'Acceptance criteria and spec files require the spec or tdd methodology',
            );
          }
          const briefText =
            options.brief || options.briefFile ? readBrief(options) : '';

          let spec: TaskSpec | null = null;
          if (options.specFile) {
            if (
              briefText ||
              options.acceptance.length > 0 ||
              options.nonGoal.length > 0
            ) {
              throw new CrewError(
                'INVALID_SPEC',
                '--spec-file cannot be combined with --brief, --brief-file, --acceptance, or --non-goal',
              );
            }
            spec = validateSpec(loadSpecFile(path.resolve(options.specFile)));
          } else if (methodologyRequiresSpec(methodology)) {
            if (!briefText) {
              throw new CrewError(
                'SPEC_REQUIRED',
                `The ${methodology} methodology requires --spec-file, --brief, or --brief-file`,
              );
            }
            spec = specFromOptions({
              goal: briefText,
              acceptance: options.acceptance,
              nonGoals: options.nonGoal,
            });
          }

          return store.createTask({
            projectId: selected.id,
            title: options.title,
            briefText,
            deliveryMode,
            methodology,
            spec,
          });
        });
        if (globalOptions().json) {
          printJson({ task: created });
        } else {
          console.log(`Created ${created.id} (${created.state}, ${created.methodology})`);
        }
      },
    );

  task
    .command('list')
    .description('list tasks')
    .option('--state <state>', 'filter by task state')
    .action(async (options: { state?: string }) => {
      const tasks = await withStore((store) =>
        store.listTasks(options.state as TaskState | undefined),
      );
      if (globalOptions().json) {
        printJson({ tasks });
      } else {
        printTable(
          tasks.map((item) => ({
            id: item.id,
            state: item.state,
            stage: item.stage,
            iterations: item.reviewIterations,
            title: item.title,
            harness: item.harnessId ?? '-',
            pr: item.prUrl ? 'yes' : '-',
            updated: item.updatedAt,
          })),
          [
            { key: 'id', label: 'ID' },
            { key: 'state', label: 'STATE' },
            { key: 'stage', label: 'STAGE' },
            { key: 'iterations', label: 'ITER' },
            { key: 'title', label: 'TITLE' },
            { key: 'harness', label: 'HARNESS' },
            { key: 'pr', label: 'PR' },
            { key: 'updated', label: 'UPDATED' },
          ],
        );
      }
    });

  task
    .command('show <id>')
    .description('show a task and its history')
    .action(async (id: string) => {
      const detail = await withStore((store) => store.getTaskDetail(id));
      if (globalOptions().json) {
        printJson(detail);
      } else {
        renderTaskDetail(detail);
      }
    });

  task
    .command('run <id>')
    .description('run a task in an isolated worktree')
    .option('--harness <id>', 'developer harness adapter: fake, opencode, or auto')
    .option('--tester-harness <id>', 'tester harness adapter')
    .option('--agent <name>', 'developer agent name for the harness')
    .option('--model <name>', 'developer model for the harness')
    .option('--tester-agent <name>', 'tester agent name for the harness')
    .option('--tester-model <name>', 'tester model for the harness')
    .option('--max-iterations <n>', 'maximum tester rejections before failing', Number)
    .option('--delivery <mode>', 'override the delivery mode')
    .option('--timeout <seconds>', 'timeout in seconds', Number)
    .option('--env <key=value>', 'extra environment variable', collect, [])
    .option('--quiet', 'do not stream agent output')
    .action(
      async (
        id: string,
        options: {
          harness?: string;
          testerHarness?: string;
          agent?: string;
          model?: string;
          testerAgent?: string;
          testerModel?: string;
          maxIterations?: number;
          delivery?: string;
          timeout?: number;
          env: string[];
          quiet?: boolean;
        },
      ) => {
        const json = globalOptions().json;
        const result = await withStore((store, context) =>
          runPipeline(store, context, {
            taskId: id,
            developerHarnessId: options.harness ?? context.config.harness,
            testerHarnessId: options.testerHarness,
            developerAgent: options.agent,
            developerModel: options.model,
            testerAgent: options.testerAgent,
            testerModel: options.testerModel,
            maxIterations: options.maxIterations,
            delivery: options.delivery
              ? parseDeliveryMode(options.delivery)
              : undefined,
            timeoutSeconds: options.timeout,
            env: parseEnv(options.env),
            quiet: Boolean(options.quiet || json),
          }),
        );

        if (json) {
          printJson(result);
        } else {
          const lastRun = result.runs.at(-1);
          if (lastRun) {
            console.log(`Run ${lastRun.id} finished (${lastRun.role}/${lastRun.stage})`);
          }
          console.log(`Task ${result.task.id}: ${stateLabel(result.task.state)}`);
          console.log(`Stage: ${result.stage} (review iterations: ${result.task.reviewIterations})`);
          if (result.developerReport) {
            console.log(
              `Developer: ${result.developerReport.status} - ${result.developerReport.summary}`,
            );
          }
          if (result.testerReport) {
            console.log(
              `Tester: ${result.testerReport.payload.verdict ?? result.testerReport.status} - ${result.testerReport.summary}`,
            );
          }
          for (const verification of result.verifications) {
            const exit =
              verification.exitCode === null
                ? verification.state
                : `exit=${verification.exitCode}`;
            console.log(
              `Verification: ${verification.state} (${exit}) ${verification.command}`,
            );
          }
          if (result.commitSha) {
            console.log(`Commit: ${result.commitSha}`);
          }
          if (result.prUrl) {
            console.log(`PR: ${result.prUrl}`);
          }
          if (result.ci) {
            console.log(`CI: ${result.ci.state} - ${result.ci.summary}`);
          }
          if (result.merge) {
            console.log(
              `Merge: ${result.merge.state} (${result.merge.method} by ${result.merge.actor}) - ${result.merge.reason}`,
            );
          }
          if (result.error) {
            console.log(`Error: ${result.error}`);
          }
        }
        if (result.task.state !== 'done' && result.task.state !== 'review') {
          process.exitCode = taskRunExitCode(result.task.state);
        }
      },
    );

  task
    .command('accept <id>')
    .description('accept a reviewed task after its PR is merged')
    .option('--force', 'accept even when the pull request is not merged')
    .action(async (id: string, options: { force?: boolean }) => {
      const updated = await withStore((store) => {
        const task = store.getTaskOrThrow(id);
        if (
          (task.deliveryMode === 'pr' || task.deliveryMode === 'auto_merge') &&
          !options.force
        ) {
          const project = store.getProject(task.projectId);
          if (!project) {
            throw new CrewError('PROJECT_NOT_FOUND', `Project not found for task ${id}`);
          }
          if (!task.prUrl) {
            throw new CrewError('PR_REQUIRED', `Task ${id} has no pull request to verify`);
          }
          const pullRequest = viewPullRequest(project.rootPath, task.prUrl);
          if (!pullRequest.merged) {
            throw new CrewError(
              'PR_NOT_MERGED',
              `Pull request ${task.prUrl} is ${pullRequest.state}; merge it or use --force`,
            );
          }
          if (readProjectConfig(project.rootPath)?.ci) {
            const ci = store
              .listArtifacts(id)
              .filter((artifact) => artifact.kind === 'ci')
              .at(-1);
            const state =
              typeof ci?.metadata?.state === 'string'
                ? ci.metadata.state
                : 'missing';
            if (state !== 'passed') {
              throw new CrewError(
                'CI_NOT_PASSED',
                `CI gate is ${state}; rerun the task or use --force`,
              );
            }
          }
        }
        return store.acceptTask(id);
      });
      if (globalOptions().json) {
        printJson({ task: updated });
      } else {
        console.log(`Task ${updated.id} is now ${updated.state}`);
      }
    });

  task
    .command('reject <id> [reason...]')
    .description('reject a reviewed task and send feedback to the developer')
    .option('--reason <text>', 'review feedback')
    .action(async (id: string, reasonParts: string[], options: { reason?: string }) => {
      const reason = options.reason ?? reasonParts.join(' ');
      const updated = await withStore((store, context) =>
        store.rejectReview(id, reason, context.config.review.maxIterations),
      );
      if (globalOptions().json) {
        printJson({ task: updated });
      } else {
        console.log(`Task ${updated.id} is now ${updated.state}`);
      }
    });

  task
    .command('answer <id>')
    .description('answer a waiting task and queue a new attempt')
    .requiredOption('--text <text>', 'answer text')
    .action(async (id: string, options: { text: string }) => {
      const updated = await withStore((store) => store.answerTask(id, options.text));
      if (globalOptions().json) {
        printJson({ task: updated });
      } else {
        console.log(`Task ${updated.id} is now ${updated.state}`);
      }
    });

  task
    .command('queue <id>')
    .description('queue a draft task for the daemon')
    .action(async (id: string) => {
      const updated = await withStore((store) => store.queueTask(id));
      if (globalOptions().json) {
        printJson({ task: updated });
      } else {
        console.log(`Task ${updated.id} is now ${updated.state}`);
      }
    });

  task
    .command('retry <id>')
    .description('re-queue a failed task')
    .action(async (id: string) => {
      const updated = await withStore((store) => store.retryTask(id));
      if (globalOptions().json) {
        printJson({ task: updated });
      } else {
        console.log(`Task ${updated.id} is now ${updated.state}`);
      }
    });

  task
    .command('cancel <id>')
    .description('cancel a task and its active process')
    .action(async (id: string) => {
      const updated = await withStore((store) => {
        const active = store.getActiveRun(id);
        if (active?.pid) {
          terminateProcessTree(active.pid, 'SIGTERM');
        }
        return store.cancelTask(id);
      });
      if (globalOptions().json) {
        printJson({ task: updated });
      } else {
        console.log(`Task ${updated.id} is now ${updated.state}`);
      }
    });

  task
    .command('clean <id>')
    .description('remove a task worktree without deleting its branch')
    .option('--force', 'discard a dirty worktree')
    .action(async (id: string, options: { force?: boolean }) => {
      const cleaned = await withStore((store) => {
        const detail = store.getTaskDetail(id);
        if (!detail.task.worktreePath) {
          throw new CrewError('NO_WORKTREE', `Task ${id} has no worktree`);
        }
        if (!detail.project) {
          throw new CrewError('PROJECT_NOT_FOUND', `Project not found for task ${id}`);
        }
        removeWorktree({
          repoPath: detail.project.rootPath,
          worktreePath: detail.task.worktreePath,
          force: options.force,
        });
        return store.clearWorktree(id);
      });
      if (globalOptions().json) {
        printJson({ task: cleaned });
      } else {
        console.log(`Removed worktree for ${cleaned.id}; branch ${cleaned.branch ?? '-'} kept`);
      }
    });

  const daemon = program.command('daemon').description('run and supervise queued tasks');

  daemon
    .command('run')
    .description('process queued tasks until stopped')
    .option('--once', 'process at most one task and exit')
    .option('--interval <seconds>', 'idle poll interval', Number, 5)
    .option('--max-tasks <n>', 'stop after N tasks', Number)
    .option('--harness <id>', 'developer harness adapter: fake, opencode, or auto')
    .option('--tester-harness <id>', 'tester harness adapter')
    .option('--max-iterations <n>', 'maximum tester rejections before failing', Number)
    .option('--timeout <seconds>', 'timeout per task', Number)
    .option('--env <key=value>', 'extra environment variable', collect, [])
    .option('--stale-after <seconds>', 'lost-run grace period', Number, 30)
    .option('--quiet', 'do not stream agent output')
    .action(
      async (options: {
        once?: boolean;
        interval: number;
        maxTasks?: number;
        harness?: string;
        testerHarness?: string;
        maxIterations?: number;
        timeout?: number;
        env: string[];
        staleAfter: number;
        quiet?: boolean;
      }) => {
        const json = globalOptions().json;
        const once = Boolean(options.once);
        const controller = new AbortController();
        const stop = (): void => controller.abort();
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);

        const printTask = (entry: DaemonTaskResult): void => {
          if (json && !once) {
            process.stdout.write(
              `${JSON.stringify({ event: 'task', ...entry }, jsonReplacer)}\n`,
            );
            return;
          }
          if (!json) {
            const detail = entry.error ? ` (${entry.error})` : '';
            console.log(`Task ${entry.taskId}: ${stateLabel(entry.taskState)}${detail}`);
          }
        };

        try {
          const result = await withStore((store, context) =>
            runDaemon(store, context, {
              once,
              intervalMs: options.interval * 1000,
              maxTasks: options.maxTasks,
              harnessId: options.harness,
              testerHarnessId: options.testerHarness,
              maxIterations: options.maxIterations,
              timeoutSeconds: options.timeout,
              env: parseEnv(options.env),
              quiet: Boolean(options.quiet || json),
              staleAfterMs: options.staleAfter * 1000,
              signal: controller.signal,
              onTask: printTask,
              onReclaim: (run) => {
                if (json && !once) {
                  process.stdout.write(
                    `${JSON.stringify({ event: 'run.lost', ...run }, jsonReplacer)}\n`,
                  );
                } else if (!json) {
                  console.log(
                    `Reclaimed run ${run.runId} (${run.reason}); task ${run.taskId} is ${run.taskState}`,
                  );
                }
              },
            }),
          );

          if (json) {
            if (once) {
              printJson(result);
            } else {
              process.stdout.write(
                `${JSON.stringify({ event: 'daemon.stopped', ...result }, jsonReplacer)}\n`,
              );
            }
          } else {
            console.log(
              `Daemon ${result.owner} stopped (${result.stopped}); ${result.processed.length} task(s), ${result.reclaimed.length} reclaimed`,
            );
          }

          if (
            once &&
            result.processed.some(
              (entry) =>
                entry.taskState !== 'done' && entry.taskState !== 'review',
            )
          ) {
            process.exitCode = 1;
          }
        } finally {
          process.off('SIGINT', stop);
          process.off('SIGTERM', stop);
        }
      },
    );

  daemon
    .command('status')
    .description('show the daemon lease, active runs, and queued tasks')
    .action(async () => {
      const status = await withStore((store) => {
        const lease = store.getLease('daemon');
        return {
          lease: lease
            ? { ...lease, active: Date.parse(lease.expiresAt) > Date.now() }
            : null,
          active_runs: store.listActiveRuns(),
          queued_tasks: store.listTasks('queued').length,
          now: new Date().toISOString(),
        };
      });
      if (globalOptions().json) {
        printJson(status);
        return;
      }
      if (status.lease) {
        console.log(
          `Lease: ${status.lease.owner} (${status.lease.active ? 'active' : 'expired'}, expires ${status.lease.expiresAt})`,
        );
      } else {
        console.log('Lease: none');
      }
      console.log(`Queued tasks: ${status.queued_tasks}`);
      console.log(`Active runs: ${status.active_runs.length}`);
      for (const run of status.active_runs) {
        const alive = run.pid !== null && isPidAlive(run.pid);
        console.log(
          `  ${run.id} task=${run.taskId} pid=${run.pid ?? '-'} alive=${alive ? 'yes' : 'no'}`,
        );
      }
    });

  daemon
    .command('reconcile')
    .description('mark dead active runs as lost and fail their tasks')
    .option('--stale-after <seconds>', 'grace period for runs without a pid', Number, 30)
    .action(async (options: { staleAfter: number }) => {
      const result = await withStore((store) => ({
        lost: store.reconcileStaleRuns({
          isAlive: isPidAlive,
          staleAfterMs: options.staleAfter * 1000,
        }),
      }));
      if (globalOptions().json) {
        printJson(result);
      } else if (result.lost.length === 0) {
        console.log('No stale runs');
      } else {
        for (const run of result.lost) {
          console.log(
            `Lost run ${run.runId} (${run.reason}); task ${run.taskId} is ${run.taskState}`,
          );
        }
      }
    });

  program
    .command('report')
    .description('record an agent report')
    .requiredOption('--task <id>', 'task id')
    .requiredOption('--run <id>', 'run id')
    .option('--file <path>', 'report file, or - for stdin')
    .option('--status <status>', 'status for an inline report')
    .option('--summary <text>', 'summary for an inline report')
    .action(
      async (options: {
        task: string;
        run: string;
        file?: string;
        status?: string;
        summary?: string;
      }) => {
        let raw: unknown;
        if (options.file) {
          const text =
            options.file === '-'
              ? readFileSync(0, 'utf8')
              : readFileSync(path.resolve(options.file), 'utf8');
          raw = parseReportText(text);
        } else if (process.env.CREW_REPORT_PATH && existsSync(process.env.CREW_REPORT_PATH)) {
          raw = parseReportText(readFileSync(process.env.CREW_REPORT_PATH, 'utf8'));
        } else if (options.status && options.summary) {
          raw = {};
        } else {
          throw new CrewError(
            'REPORT_REQUIRED',
            'Provide --file, set CREW_REPORT_PATH, or provide --status and --summary',
          );
        }

        const contextInfo = await withStore((store) => {
          const task = store.getTaskOrThrow(options.task);
          return { task, run: store.getRun(options.run) };
        });
        const normalized = normalizeReport(raw, {
          taskId: options.task,
          runId: options.run,
          status: options.status,
          summary: options.summary,
          methodology: contextInfo.task.methodology,
          role: contextInfo.run?.role,
          reviewIteration: contextInfo.task.reviewIterations,
        });
        const payload = validateReport(redactDeep(normalized));
        if (payload.task_id !== options.task || payload.run_id !== options.run) {
          throw new CrewError(
            'REPORT_MISMATCH',
            'Report task_id/run_id do not match --task/--run',
          );
        }
        const report = await withStore((store) => store.recordReport(payload));
        if (globalOptions().json) {
          printJson({ report });
        } else {
          console.log(`Recorded ${report.status} report for ${report.taskId} (${report.id})`);
        }
      },
    );

  program
    .command('events')
    .description('show the event log')
    .option('--task <id>', 'filter by task')
    .option('--follow', 'follow new events')
    .option('--limit <n>', 'maximum events', (value) => Number(value), 100)
    .action(
      async (options: { task?: string; follow?: boolean; limit: number }) => {
        if (!options.follow) {
          const events = await withStore((store) =>
            store.listEvents({
              taskId: options.task,
              limit: options.limit,
            }),
          );
          if (globalOptions().json) {
            printJson({ events });
          } else {
            for (const event of events) {
              console.log(
                `${event.seq}  ${event.createdAt}  ${event.type}  ${JSON.stringify(event.payload)}`,
              );
            }
          }
          return;
        }

        const context = loadContext({ dbPath: globalOptions().db });
        const store = new Store(context.paths.dbPath);
        let afterSeq = 0;
        const print = (): void => {
          const events = store.listEvents({
            taskId: options.task,
            afterSeq,
            limit: options.limit,
          });
          for (const event of events) {
            afterSeq = event.seq;
            if (globalOptions().json) {
              process.stdout.write(`${JSON.stringify(event, jsonReplacer)}\n`);
            } else {
              console.log(
                `${event.seq}  ${event.createdAt}  ${event.type}  ${JSON.stringify(event.payload)}`,
              );
            }
          }
        };
        print();
        await new Promise<void>((resolve) => {
          const timer = setInterval(print, 500);
          const stop = (): void => {
            clearInterval(timer);
            process.off('SIGINT', stop);
            process.off('SIGTERM', stop);
            store.close();
            resolve();
          };
          process.once('SIGINT', stop);
          process.once('SIGTERM', stop);
        });
      },
    );

  program
    .command('doctor')
    .description('check the local crew state')
    .action(async () => {
      const result = await withStore((store, context) => runDoctor(store, context));
      if (globalOptions().json) {
        printJson(result);
      } else {
        for (const check of result.checks) {
          const marker =
            check.status === 'ok'
              ? pc.green('ok')
              : check.status === 'warn'
                ? pc.yellow('warn')
                : pc.red('error');
          console.log(`${marker.padEnd(14)} ${check.name}: ${check.detail}`);
        }
      }
      if (!result.ok) {
        process.exitCode = 1;
      }
    });

  program
    .command('version')
    .description('print the version')
    .action(() => {
      console.log(VERSION);
    });


  return program;
}

export async function main(argv = process.argv): Promise<number> {
  process.exitCode = 0;
  const program = buildProgram();
  activeProgram = program;
  try {
    await program.parseAsync(argv);
    return process.exitCode ?? 0;
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.exitCode;
    }
    if (error instanceof CrewError) {
      console.error(`${pc.red('error')} [${error.code}]: ${error.message}`);
      if (globalOptions().verbose && error.stack) {
        console.error(error.stack);
      }
      return error.exitCode;
    }
    console.error(`${pc.red('error')}: ${errorMessage(error)}`);
    if (globalOptions().verbose && error instanceof Error && error.stack) {
      console.error(error.stack);
    }
    return 1;
  }
}

function entryPath(): string {
  const candidate = process.argv[1];
  if (!candidate) {
    return '';
  }
  try {
    return realpathSync(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

const entry = entryPath();
if (entry && fileURLToPath(import.meta.url) === entry) {
  main().then((code) => {
    process.exit(code);
  });
}
