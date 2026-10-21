import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command, CommanderError } from 'commander';
import pc from 'picocolors';
import { runDaemon, type DaemonTaskResult } from '../app/daemon';
import { buildCaptainBrief, writeCaptainInstructions } from '../app/captain';
import { mergeTask } from '../app/merge';
import { startUiServer } from '../app/ui';
import {
  buildServiceDefinition,
  detectServiceManager,
  installService,
  readLogTail,
  resolveCrewCommand,
  serviceEnvironment,
  serviceStatus,
  uninstallService,
  type ServiceManager,
} from '../app/service';
import { killSession, listSessions, tmuxAvailable } from '../app/session';
import { intakeProject } from '../app/intake';
import { applyPlan, parsePlan, validatePlan } from '../app/plan';
import { buildProgress, renderProgress } from '../app/progress';
import { addProject, initProject } from '../app/projects';
import { detectHarness } from '../adapters/harness/detect';
import { listHarnessAdapters } from '../adapters/harness/registry';
import { runPipeline } from '../app/pipeline';
import { summarizeDetail } from '../app/summary';
import { loadContext, readProjectConfig, type ResolvedContext } from '../config/config';
import { CrewError, errorMessage } from '../core/errors';
import { isPidAlive, terminateProcessTree } from '../core/process';
import { redactDeep } from '../core/redact';
import type {
  DeliveryMode,
  MemoryKind,
  MemorySource,
  MergeMethod,
  Project,
  TaskSpec,
  TaskState,
  TaskSummary,
} from '../core/types';
import { runDoctor } from '../doctor/doctor';
import {
  createLocationResolver,
  removeWorkspace,
  resolveWorkspace,
} from '../app/workspace';
import { answerTaskInEditor, reviewTask } from '../app/review-flow';
import { getForge } from '../forges';
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

function renderTaskDetail(
  detail: ReturnType<Store['getTaskDetail']>,
  summary: TaskSummary,
): void {
  const { task, project } = detail;
  console.log(`${pc.bold('Task')} ${task.id} [${stateLabel(task.state)}]`);
  console.log(`Title:     ${task.title}`);
  console.log(`Project:   ${project ? `${project.name} (${project.id})` : task.projectId}`);
  console.log(`Base:      ${task.baseBranch}`);
  console.log(`Branch:    ${task.branch ?? '-'}`);
  console.log(`Worktree:  ${task.worktreePath ?? '-'}`);
  console.log(
    `Runs on:   ${
      summary.location.where === 'local'
        ? 'local'
        : `${summary.location.host ?? 'remote'} (${summary.location.where})`
    }`,
  );
  console.log(`Harness:   ${task.harnessId ?? '-'}`);
  console.log(`Stage:     ${task.stage} (review iterations: ${task.reviewIterations})`);
  console.log(`Commit:    ${task.commitSha ?? '-'}`);
  console.log(`PR:        ${task.prUrl ?? '-'}${summary.pr ? ` (${summary.pr.state})` : ''}`);
  const risk = summary.risk;
  console.log(
    `Risk:      ${risk ? `${risk.level} (score ${risk.score}) - ${risk.reasons.join('; ')}` : 'unknown (no change recorded)'}`,
  );
  console.log(
    `Verify:    ${summary.verification.state} (${summary.verification.passed}/${summary.verification.total} passed)`,
  );
  if (summary.tester) {
    console.log(
      `Tester:    ${summary.tester.verdict ?? summary.tester.status} - ${summary.tester.findings} finding(s), ${summary.tester.blocking} blocking`,
    );
  }
  if (summary.scout) {
    console.log(`Scout:     ${summary.scout.summary}`);
    for (const finding of summary.scout.findings) {
      console.log(`  [${finding.severity}] ${finding.message}`);
    }
  }
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
    .command('clone <url>')
    .description('clone a GitHub repository, detect its toolchain and register it')
    .option('--dir <path>', 'target directory for the clone')
    .option('--name <name>', 'project name')
    .action(async (url: string, options: { dir?: string; name?: string }) => {
      const result = await withStore((store, context) =>
        intakeProject(store, {
          url,
          projectsDir: context.paths.projectsDir,
          dir: options.dir,
          name: options.name,
        }),
      );
      if (globalOptions().json) {
        printJson(result);
        return;
      }
      console.log(
        `Cloned ${result.clone.url} into ${result.clone.path} (branch ${result.clone.defaultBranch})`,
      );
      console.log(`Registered project ${result.project.name} (${result.project.id})`);
      console.log(`Config: ${result.config.path}`);
      if (result.config.verify.length > 0) {
        console.log(`Verify commands: ${result.config.verify.join(', ')}`);
      }
      if (result.consent.length > 0) {
        console.log('\nNeeds your consent before any toolchain or dependency install:');
        for (const item of result.consent) {
          console.log(`  - ${item.reason}${item.command ? ` (suggested: ${item.command})` : ''}`);
        }
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
      const tasks = await withStore((store) => {
        const listed = store.listTasks(options.state as TaskState | undefined);
        const resolveLocation = createLocationResolver();
        return listed.map((item) => ({
          ...item,
          location: resolveLocation(store.getProject(item.projectId), item),
        }));
      });
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
            host:
              item.location.where === 'local'
                ? 'local'
                : (item.location.host ?? 'remote'),
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
            { key: 'host', label: 'HOST' },
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
      const summary = summarizeDetail(detail);
      if (globalOptions().json) {
        printJson({ ...detail, summary });
      } else {
        renderTaskDetail(detail, summary);
      }
    });

  task
    .command('merge <id>')
    .description('check the gates and merge or accept a task in review')
    .option('--by <who>', 'who authorized the merge', 'user')
    .option('--method <method>', 'merge method: merge, squash or rebase')
    .option('--delete-branch', 'delete the branch after merging')
    .option('--accept-only', 'only accept the task, do not touch the pull request')
    .action(
      async (
        id: string,
        options: {
          by: string;
          method?: string;
          deleteBranch?: boolean;
          acceptOnly?: boolean;
        },
      ) => {
        const result = await withStore((store) => {
          const detail = store.getTaskDetail(id);
          const project = detail.project;
          if (!project) {
            throw new CrewError('PROJECT_NOT_FOUND', `Task ${id} has no project`);
          }
          const projectConfig = readProjectConfig(project.rootPath);
          const method =
            (options.method as MergeMethod | undefined) ??
            projectConfig?.auto_merge?.method ??
            'squash';
          if (!['merge', 'squash', 'rebase'].includes(method)) {
            throw new CrewError('INVALID_MERGE_METHOD', `Unknown merge method: ${method}`);
          }
          return mergeTask(store, id, {
            projectRootPath: project.rootPath,
            forge: project.forge,
            method,
            deleteBranch: options.deleteBranch ?? projectConfig?.auto_merge?.delete_branch,
            authorizedBy: options.by,
            skipMerge: options.acceptOnly,
          });
        });
        if (globalOptions().json) {
          printJson(result);
          return;
        }
        console.log(`Task ${result.decision.taskId}: ${result.taskState}`);
        for (const gate of result.decision.gates) {
          console.log(`  ${gate.ok ? 'ok' : 'no'} ${gate.name}: ${gate.detail}`);
        }
        if (result.merge) {
          console.log(`Merge: ${result.merge.state} (${result.merge.method}) - ${result.merge.reason}`);
        }
        if (result.decision.risk) {
          console.log(`Risk: ${result.decision.risk.level} (score ${result.decision.risk.score})`);
        }
      },
    );

  task
    .command('review <id>')
    .description('review a task in the editor and accept or reject it there')
    .option('--by <who>', 'who authorized the decision', 'user')
    .option('--method <method>', 'merge method: merge, squash or rebase')
    .option('--delete-branch', 'delete the branch after merging')
    .option('--max-diff <lines>', 'maximum number of diff lines to show', Number, 2000)
    .option('--no-open', 'write the review buffer without opening the editor')
    .action(
      async (
        id: string,
        options: {
          by: string;
          method?: string;
          deleteBranch?: boolean;
          maxDiff: number;
          open?: boolean;
        },
      ) => {
        const method = options.method as MergeMethod | undefined;
        if (method && !['merge', 'squash', 'rebase'].includes(method)) {
          throw new CrewError('INVALID_MERGE_METHOD', `Unknown merge method: ${method}`);
        }
        const outcome = await withStore((store, context) =>
          reviewTask(store, context, {
            taskId: id,
            method,
            deleteBranch: options.deleteBranch,
            authorizedBy: options.by,
            maxDiffLines: options.maxDiff,
            open: options.open,
          }),
        );
        if (globalOptions().json) {
          printJson(outcome);
          return;
        }
        console.log(`Review buffer: ${outcome.bufferPath}`);
        if (outcome.decision.decision === 'none') {
          console.log('No decision written; nothing changed');
          return;
        }
        if (outcome.decision.decision === 'reject') {
          console.log(`Task ${outcome.taskId} rejected: ${outcome.reason ?? 'no reason given'}`);
          console.log(`State: ${outcome.taskState}`);
          return;
        }
        console.log(`Task ${outcome.taskId}: ${outcome.taskState}`);
        if (outcome.merge) {
          console.log(`Merge: ${outcome.merge.state} (${outcome.merge.method}) - ${outcome.merge.reason}`);
        }
      },
    );

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
    .option('--session <mode>', 'run the agent in a visible tmux session')
    .option('--host <host>', 'run the agent and the verification over ssh on this host')
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
          session?: string;
          host?: string;
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
            session: options.session === 'tmux' ? 'tmux' : undefined,
            remoteHost: options.host,
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
          const pullRequest = getForge(project.forge).viewPullRequest(
            project.rootPath,
            task.prUrl,
          );
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
    .description('answer a waiting task, in the editor by default')
    .option('--text <text>', 'answer text (skips the editor)')
    .action(async (id: string, options: { text?: string }) => {
      if (options.text) {
        const answer = options.text;
        const updated = await withStore((store) => store.answerTask(id, answer));
        if (globalOptions().json) {
          printJson({ task: updated });
        } else {
          console.log(`Task ${updated.id} is now ${updated.state}`);
        }
        return;
      }
      const outcome = await withStore((store, context) =>
        answerTaskInEditor(store, context, { taskId: id }),
      );
      if (globalOptions().json) {
        printJson(outcome);
        return;
      }
      if (!outcome.answered) {
        console.log(`No answer written; task ${outcome.taskId} is still ${outcome.taskState}`);
        console.log(`buffer: ${outcome.bufferPath}`);
        return;
      }
      console.log(`Task ${outcome.taskId} is now ${outcome.taskState}`);
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
      const cleaned = await withStore((store, context) => {
        const detail = store.getTaskDetail(id);
        if (!detail.task.worktreePath) {
          throw new CrewError('NO_WORKTREE', `Task ${id} has no worktree`);
        }
        if (!detail.project) {
          throw new CrewError('PROJECT_NOT_FOUND', `Project not found for task ${id}`);
        }
        const resolution = resolveWorkspace({
          project: detail.project,
          projectConfig: readProjectConfig(detail.project.rootPath),
          task: detail.task,
          worktreesDir: context.paths.worktreesDir,
        });
        removeWorkspace(resolution.workspace, {
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
    .option(
      '--concurrency <n>',
      'tasks to run in parallel (default: scheduling.concurrency)',
      Number,
    )
    .option(
      '--scheduling <mode>',
      'execution policy for tasks of the same project: serial or parallel',
    )
    .option('--max-attempts <n>', 'attempts per task before giving up', Number, 1)
    .option('--backoff <seconds>', 'base delay between automatic retries', Number, 60)
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
        concurrency?: number;
        scheduling?: string;
        maxAttempts: number;
        backoff: number;
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
            const risk = entry.risk ? `, risk ${entry.risk}` : '';
            const ci = entry.ciState ? `, ci ${entry.ciState}` : '';
            const retry =
              entry.retryInMs !== null
                ? `, retry in ${Math.ceil(entry.retryInMs / 1000)}s`
                : '';
            console.log(
              `Task ${entry.taskId}: ${stateLabel(entry.taskState)}${risk}${ci}${retry}${detail}`,
            );
          }
        };

        try {
          const result = await withStore((store, context) =>
            runDaemon(store, context, {
              once,
              intervalMs: options.interval * 1000,
              maxTasks: options.maxTasks,
              concurrency: options.concurrency,
              schedulingMode:
                options.scheduling === 'serial' || options.scheduling === 'parallel'
                  ? options.scheduling
                  : undefined,
              maxAttempts: options.maxAttempts,
              backoffMs: options.backoff * 1000,
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
    .option('--requeue', 'requeue lost tasks instead of failing them')
    .option('--max-attempts <n>', 'attempts per task before giving up', Number, 1)
    .option('--backoff <seconds>', 'base delay between automatic retries', Number, 60)
    .action(async (options: {
      staleAfter: number;
      requeue?: boolean;
      maxAttempts: number;
      backoff: number;
    }) => {
      const result = await withStore((store) => ({
        lost: store.reconcileStaleRuns({
          isAlive: isPidAlive,
          staleAfterMs: options.staleAfter * 1000,
          requeue: Boolean(options.requeue),
          maxAttempts: options.maxAttempts,
          backoffMs: options.backoff * 1000,
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

  const plan = program
    .command('plan')
    .description('validate and apply multi-task plans');

  plan
    .command('validate <file>')
    .description('validate a plan file and show the execution groups')
    .action(async (file: string) => {
      const validation = await withStore(() => {
        const text = readFileSync(path.resolve(file), 'utf8');
        return validatePlan(parsePlan(text));
      });
      if (globalOptions().json) {
        printJson(validation);
        return;
      }
      if (validation.errors.length > 0) {
        for (const error of validation.errors) {
          console.log(`error: ${error}`);
        }
      }
      for (const warning of validation.warnings) {
        console.log(`warning: ${warning}`);
      }
      console.log(`Plan ${validation.ok ? 'is valid' : 'has errors'} (${validation.tasks.length} tasks)`);
      validation.groups.forEach((group, index) => {
        console.log(`  group ${index + 1}: ${group.join(', ')}`);
      });
      if (!validation.ok) {
        process.exitCode = 1;
      }
    });

  plan
    .command('apply <file>')
    .description('create the tasks of a plan and, optionally, queue them')
    .option('--project <ref>', 'project id or name')
    .option('--queue', 'queue the tasks for the daemon')
    .option('--delivery <mode>', 'delivery mode for the tasks')
    .action(
      async (
        file: string,
        options: { project?: string; queue?: boolean; delivery?: string },
      ) => {
        const result = await withStore((store) => {
          const text = readFileSync(path.resolve(file), 'utf8');
          const parsed = parsePlan(text);
          const projects = store.listProjects();
          const project = options.project
            ? projects.find(
                (item) => item.id === options.project || item.name === options.project,
              )
            : projects[0];
          if (!project) {
            throw new CrewError(
              'PROJECT_NOT_FOUND',
              `Project not found: ${options.project ?? '(default)'}`,
            );
          }
          return applyPlan(store, parsed, {
            projectId: project.id,
            queue: options.queue,
            delivery: options.delivery as DeliveryMode | undefined,
          });
        });
        if (globalOptions().json) {
          printJson(result);
          return;
        }
        for (const task of result.tasks) {
          console.log(`${task.key}: ${task.id} [${task.state}] ${task.title}`);
        }
        result.groups.forEach((group, index) => {
          console.log(`group ${index + 1}: ${group.join(', ')}`);
        });
      },
    );

  const captain = program
    .command('captain')
    .description('captain helpers: briefing and AGENTS.md instructions');

  captain
    .command('brief')
    .description('compact briefing with projects, tasks, risk and what needs attention')
    .option('--project <ref>', 'limit the briefing to a project id or name')
    .option('--limit <n>', 'number of tasks to include', Number, 20)
    .action(async (options: { project?: string; limit: number }) => {
      const brief = await withStore((store) => {
        const projects = store.listProjects();
        let projectId: string | undefined;
        if (options.project) {
          const match = projects.find(
            (project) =>
              project.id === options.project || project.name === options.project,
          );
          if (!match) {
            throw new CrewError(
              'PROJECT_NOT_FOUND',
              `Project not found: ${options.project}`,
            );
          }
          projectId = match.id;
        }
        return buildCaptainBrief(store, {
          limit: options.limit,
          projectId,
        });
      });
      if (globalOptions().json) {
        printJson(brief);
        return;
      }
      console.log(`Tasks: ${brief.totalTasks}`);
      for (const [state, count] of Object.entries(brief.counts)) {
        console.log(`  ${state}: ${count}`);
      }
      console.log(
        `Lease: ${brief.lease ? `${brief.lease.owner} (${brief.lease.active ? 'active' : 'expired'})` : 'none'}`,
      );
      console.log(`Active runs: ${brief.activeRuns.length}`);
      if (brief.attention.length > 0) {
        console.log('\nNeeds attention:');
        for (const item of brief.attention) {
          console.log(`  ${item.taskId} [${item.state}] ${item.title} - ${item.reason}`);
        }
      }
      if (brief.tasks.length > 0) {
        console.log('\nTasks:');
        printTable(
          brief.tasks.map((summary) => ({
            id: summary.taskId,
            state: summary.state,
            risk: summary.risk?.level ?? '-',
            ci: summary.ci?.state ?? '-',
            verify: summary.verification.state,
            tester: summary.tester?.verdict ?? '-',
            pr: summary.pr?.state ?? '-',
            title: summary.title,
          })),
          [
            { key: 'id', label: 'ID' },
            { key: 'state', label: 'STATE' },
            { key: 'risk', label: 'RISK' },
            { key: 'ci', label: 'CI' },
            { key: 'verify', label: 'VERIFY' },
            { key: 'tester', label: 'TESTER' },
            { key: 'pr', label: 'PR' },
            { key: 'title', label: 'TITLE' },
          ],
        );
      }
    });

  captain
    .command('init')
    .description('write the captain AGENTS.md instructions in the current repository')
    .option('--force', 'overwrite an existing AGENTS.md')
    .action((options: { force?: boolean }) => {
      const result = writeCaptainInstructions(process.cwd(), { force: options.force });
      if (globalOptions().json) {
        printJson(result);
      } else {
        console.log(
          result.created
            ? `Wrote ${result.path}`
            : `Overwrote ${result.path}`,
        );
      }
    });

  const sessions = program
    .command('sessions')
    .description('list the visible agent sessions (tmux)');

  sessions
    .command('list')
    .description('list the crew tmux sessions and how to attach to them')
    .action(() => {
      const available = tmuxAvailable();
      const list = available ? listSessions() : [];
      if (globalOptions().json) {
        printJson({ available, sessions: list });
        return;
      }
      if (!available) {
        console.log('tmux is not available on this machine');
        return;
      }
      if (list.length === 0) {
        console.log('No crew sessions');
        return;
      }
      printTable(
        list.map((session) => ({
          name: session.name,
          task: session.taskId ?? '-',
          state: session.dead ? `finished (${session.exitCode ?? '?'})` : 'running',
          attach: `tmux attach -t ${session.name}`,
        })),
        [
          { key: 'name', label: 'SESSION' },
          { key: 'task', label: 'TASK' },
          { key: 'state', label: 'STATE' },
          { key: 'attach', label: 'ATTACH' },
        ],
      );
    });

  sessions
    .command('kill <name>')
    .description('close a crew session')
    .action((name: string) => {
      const killed = killSession(name);
      if (!killed) {
        throw new CrewError('SESSION_NOT_FOUND', `Session not found: ${name}`);
      }
      if (globalOptions().json) {
        printJson({ killed: true, name });
      } else {
        console.log(`Session ${name} closed`);
      }
    });

  program
    .command('ui')
    .description('serve a read-only web dashboard of the crew state')
    .option('--port <n>', 'port to listen on', Number, 4173)
    .option('--host <host>', 'host to bind', '127.0.0.1')
    .action(async (options: { port: number; host: string }) => {
      const context = loadContext({ dbPath: globalOptions().db });
      const store = new Store(context.paths.dbPath);
      try {
        const server = await startUiServer(store, {
          port: options.port,
          host: options.host,
        });
        console.log(`crew ui listening on ${server.url}`);
        console.log('Press Ctrl+C to stop');
        await new Promise<void>((resolve) => {
          const stop = (): void => {
            void server.close().then(resolve);
          };
          process.once('SIGINT', stop);
          process.once('SIGTERM', stop);
        });
      } finally {
        store.close();
      }
    });

  program
    .command('scout')
    .description('create a research task that produces a report instead of a change')
    .requiredOption('--project <ref>', 'project id or name')
    .requiredOption('--title <title>', 'task title')
    .requiredOption('--question <text>', 'what to investigate')
    .option('--queue', 'queue the task for the daemon')
    .action(
      async (options: {
        project: string;
        title: string;
        question: string;
        queue?: boolean;
      }) => {
        const result = await withStore((store) => {
          const project = store.getProject(options.project);
          if (!project) {
            throw new CrewError('PROJECT_NOT_FOUND', `Project not found: ${options.project}`);
          }
          const task = store.createTask({
            projectId: project.id,
            title: options.title,
            briefText: options.question,
            methodology: 'free',
            spec: null,
            deliveryMode: 'scout',
          });
          return options.queue ? store.queueTask(task.id) : task;
        });
        if (globalOptions().json) {
          printJson({ task: result });
        } else {
          console.log(`Scout task ${result.id} [${result.state}] ${result.title}`);
        }
      },
    );

  const memory = program
    .command('memory')
    .description('durable project memory: conventions, decisions and pitfalls');

  memory
    .command('add')
    .description('add a memory to a project')
    .requiredOption('--project <ref>', 'project id or name')
    .requiredOption('--title <title>', 'short title')
    .requiredOption('--body <text>', 'what to remember')
    .option('--kind <kind>', 'convention, decision, pitfall, glossary or context', 'context')
    .option('--source <source>', 'captain, user or agent', 'captain')
    .option('--task <id>', 'task the memory comes from')
    .action(
      async (options: {
        project: string;
        title: string;
        body: string;
        kind: string;
        source: string;
        task?: string;
      }) => {
        const result = await withStore((store) => {
          const project = store.getProject(options.project);
          if (!project) {
            throw new CrewError('PROJECT_NOT_FOUND', `Project not found: ${options.project}`);
          }
          return store.addMemory({
            projectId: project.id,
            kind: options.kind as MemoryKind,
            title: options.title,
            body: options.body,
            source: options.source as MemorySource,
            taskId: options.task ?? null,
          });
        });
        if (globalOptions().json) {
          printJson(result);
        } else {
          console.log(`Memory ${result.id} (${result.kind}) added to ${result.projectId}`);
        }
      },
    );

  memory
    .command('list')
    .description('list the memory of a project')
    .option('--project <ref>', 'project id or name')
    .option('--kind <kind>', 'filter by kind')
    .action(async (options: { project?: string; kind?: string }) => {
      const result = await withStore((store) => {
        const projects = options.project
          ? [store.getProject(options.project)].filter((project): project is Project => project !== null)
          : store.listProjects();
        if (projects.length === 0) {
          throw new CrewError('PROJECT_NOT_FOUND', `Project not found: ${options.project ?? '(any)'}`);
        }
        return projects.flatMap((project) =>
          store.listMemories(project.id, { kind: options.kind as MemoryKind | undefined }),
        );
      });
      if (globalOptions().json) {
        printJson({ memories: result });
        return;
      }
      if (result.length === 0) {
        console.log('No memories');
        return;
      }
      printTable(
        result.map((item) => ({
          id: item.id,
          kind: item.kind,
          title: item.title,
          source: item.source,
          body: item.body,
        })),
        [
          { key: 'id', label: 'ID' },
          { key: 'kind', label: 'KIND' },
          { key: 'title', label: 'TITLE' },
          { key: 'source', label: 'SOURCE' },
          { key: 'body', label: 'BODY' },
        ],
      );
    });

  memory
    .command('rm <id>')
    .description('remove a memory')
    .action(async (id: string) => {
      const removed = await withStore((store) => store.deleteMemory(id));
      if (!removed) {
        throw new CrewError('MEMORY_NOT_FOUND', `Memory not found: ${id}`);
      }
      if (globalOptions().json) {
        printJson({ removed: true, id });
      } else {
        console.log(`Memory ${id} removed`);
      }
    });

  program
    .command('progress <id>')
    .description('report the progress of a task in plain language')
    .option('--events <n>', 'number of recent events to include', Number, 8)
    .action(async (id: string, options: { events: number }) => {
      const progress = await withStore((store) =>
        buildProgress(store.getTaskDetail(id), { events: options.events }),
      );
      if (globalOptions().json) {
        printJson(progress);
        return;
      }
      console.log(renderProgress(progress));
    });

  program
    .command('status')
    .description('show the crew status: lease, task counts, and risk/CI summaries')
    .option('--limit <n>', 'number of recent tasks to summarize', Number, 10)
    .action(async (options: { limit: number }) => {
      const limit = Math.max(1, Math.min(options.limit ?? 10, 100));
      const status = await withStore((store) => {
        const lease = store.getLease('daemon');
        const tasks = store.listTasks();
        const counts: Record<string, number> = {};
        for (const task of tasks) {
          counts[task.state] = (counts[task.state] ?? 0) + 1;
        }
        const recent = tasks.slice(0, limit).map((task) =>
          summarizeDetail(store.getTaskDetail(task.id)),
        );
        const now = Date.now();
        return {
          generated_at: new Date().toISOString(),
          lease: lease
            ? { ...lease, active: Date.parse(lease.expiresAt) > Date.now() }
            : null,
          counts,
          total_tasks: tasks.length,
          active_runs: store.listActiveRuns().length,
          retrying: tasks.filter(
            (task) =>
              task.state === 'queued' &&
              task.nextAttemptAt !== null &&
              Date.parse(task.nextAttemptAt) > now,
          ).length,
          tasks: recent,
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
      console.log(`Tasks: ${status.total_tasks}`);
      for (const [state, count] of Object.entries(status.counts)) {
        console.log(`  ${state}: ${count}`);
      }
      console.log(`Active runs: ${status.active_runs}`);
      console.log(`Waiting for backoff: ${status.retrying}`);
      if (status.tasks.length > 0) {
        console.log('\nRecent tasks:');
        printTable(
          status.tasks.map((summary) => ({
            id: summary.taskId,
            state: summary.state,
            risk: summary.risk?.level ?? '-',
            ci: summary.ci?.state ?? '-',
            verify: summary.verification.state,
            tester: summary.tester?.verdict ?? '-',
            pr: summary.pr?.state ?? '-',
            host:
              summary.location.where === 'local'
                ? 'local'
                : (summary.location.host ?? 'remote'),
            title: summary.title,
          })),
          [
            { key: 'id', label: 'ID' },
            { key: 'state', label: 'STATE' },
            { key: 'risk', label: 'RISK' },
            { key: 'ci', label: 'CI' },
            { key: 'verify', label: 'VERIFY' },
            { key: 'tester', label: 'TESTER' },
            { key: 'pr', label: 'PR' },
            { key: 'host', label: 'HOST' },
            { key: 'title', label: 'TITLE' },
          ],
        );
      }
    });

  const service = program
    .command('service')
    .description('install the crew daemon as a system service');

  const serviceManagerOption = (manager?: string): ServiceManager | undefined => {
    if (manager === 'launchd' || manager === 'systemd') {
      return manager;
    }
    return detectServiceManager() ?? undefined;
  };

  service
    .command('install')
    .description('install and enable the daemon service')
    .option('--manager <manager>', 'service manager: launchd or systemd')
    .option('--label <label>', 'launchd label for the service')
    .option('--interval <seconds>', 'idle poll interval', Number, 5)
    .option('--concurrency <n>', 'tasks to run in parallel', Number)
    .option('--max-attempts <n>', 'attempts per task before giving up', Number)
    .option('--backoff <seconds>', 'base delay between automatic retries', Number)
    .option('--dry-run', 'print the unit file and the commands without applying them')
    .action(
      (options: {
        manager?: string;
        label?: string;
        interval: number;
        concurrency?: number;
        maxAttempts?: number;
        backoff?: number;
        dryRun?: boolean;
      }) => {
        const manager = serviceManagerOption(options.manager);
        if (!manager) {
          throw new CrewError(
            'SERVICE_MANAGER_UNSUPPORTED',
            `No supported service manager for this platform (${process.platform}). Use --manager launchd or --manager systemd.`,
          );
        }
        const context = loadContext({ dbPath: globalOptions().db });
        const command = [
          ...resolveCrewCommand(),
          'daemon',
          'run',
          '--json',
          '--interval',
          String(options.interval),
        ];
        if (options.concurrency !== undefined) {
          command.push('--concurrency', String(options.concurrency));
        }
        if (options.maxAttempts !== undefined) {
          command.push('--max-attempts', String(options.maxAttempts));
        }
        if (options.backoff !== undefined) {
          command.push('--backoff', String(options.backoff));
        }
        const definition = buildServiceDefinition(
          {
            command,
            env: serviceEnvironment(context.paths),
            workDir: context.paths.dataDir,
            logDir: context.paths.logsDir,
            label: options.label,
          },
          manager,
        );

        if (options.dryRun) {
          if (globalOptions().json) {
            printJson({
              manager: definition.manager,
              unitPath: definition.unitPath,
              content: definition.content,
              commands: definition.install,
            });
          } else {
            console.log(definition.content);
            console.log(
              `\nunit: ${definition.unitPath}\ncommands: ${definition.install
                .map((entry) => entry.join(' '))
                .join(' | ')}`,
            );
          }
          return;
        }

        const result = installService(definition);
        if (globalOptions().json) {
          printJson({
            manager: result.definition.manager,
            label: result.definition.label,
            unitPath: result.unitPath,
            installed: result.installed,
            commands: result.commands,
            logPath: result.definition.logPath,
          });
        } else {
          console.log(`Service ${result.definition.label} installed (${result.definition.manager})`);
          console.log(`unit:  ${result.unitPath}`);
          console.log(`logs:  ${result.definition.logPath}`);
        }
      },
    );

  service
    .command('status')
    .description('show whether the daemon service is installed and running')
    .option('--manager <manager>', 'service manager: launchd or systemd')
    .option('--label <label>', 'launchd label for the service')
    .action((options: { manager?: string; label?: string }) => {
      const manager = serviceManagerOption(options.manager);
      if (!manager) {
        throw new CrewError(
          'SERVICE_MANAGER_UNSUPPORTED',
          `No supported service manager for this platform (${process.platform}). Use --manager launchd or --manager systemd.`,
        );
      }
      const context = loadContext({ dbPath: globalOptions().db });
      const definition = buildServiceDefinition(
        {
          command: [...resolveCrewCommand(), 'daemon', 'run'],
          env: serviceEnvironment(context.paths),
          workDir: context.paths.dataDir,
          logDir: context.paths.logsDir,
          label: options.label,
        },
        manager,
      );
      const status = serviceStatus(definition);
      if (globalOptions().json) {
        printJson(status);
      } else {
        console.log(`manager:  ${status.manager}`);
        console.log(`label:    ${status.label}`);
        console.log(`unit:     ${status.unitPath}`);
        console.log(`state:    ${status.state}`);
        console.log(`pid:      ${status.pid ?? '-'}`);
        console.log(`logs:     ${status.logPath}`);
        if (status.detail) {
          console.log(`detail:   ${status.detail}`);
        }
      }
      if (!status.running) {
        process.exitCode = 1;
      }
    });

  service
    .command('uninstall')
    .description('stop and remove the daemon service')
    .option('--manager <manager>', 'service manager: launchd or systemd')
    .option('--label <label>', 'launchd label for the service')
    .action((options: { manager?: string; label?: string }) => {
      const manager = serviceManagerOption(options.manager);
      if (!manager) {
        throw new CrewError(
          'SERVICE_MANAGER_UNSUPPORTED',
          `No supported service manager for this platform (${process.platform}). Use --manager launchd or --manager systemd.`,
        );
      }
      const context = loadContext({ dbPath: globalOptions().db });
      const definition = buildServiceDefinition(
        {
          command: [...resolveCrewCommand(), 'daemon', 'run'],
          env: serviceEnvironment(context.paths),
          workDir: context.paths.dataDir,
          logDir: context.paths.logsDir,
          label: options.label,
        },
        manager,
      );
      const result = uninstallService(definition);
      if (globalOptions().json) {
        printJson({
          manager: definition.manager,
          label: definition.label,
          unitPath: result.unitPath,
          removed: result.removed,
          commands: result.commands,
        });
      } else {
        console.log(
          `Service ${definition.label} ${result.removed ? 'removed' : 'was not installed'}`,
        );
        console.log(`unit: ${result.unitPath}`);
      }
    });

  service
    .command('logs')
    .description('show the last lines of the daemon service log')
    .option('--manager <manager>', 'service manager: launchd or systemd')
    .option('--label <label>', 'launchd label for the service')
    .option('--lines <n>', 'number of lines to show', Number, 20)
    .option('--errors', 'show the error log instead of the main log')
    .action(
      (options: { manager?: string; label?: string; lines: number; errors?: boolean }) => {
      const manager = serviceManagerOption(options.manager);
      if (!manager) {
        throw new CrewError(
          'SERVICE_MANAGER_UNSUPPORTED',
          `No supported service manager for this platform (${process.platform}).`,
        );
      }
      const context = loadContext({ dbPath: globalOptions().db });
      const definition = buildServiceDefinition(
        {
          command: [...resolveCrewCommand(), 'daemon', 'run'],
          env: serviceEnvironment(context.paths),
          workDir: context.paths.dataDir,
          logDir: context.paths.logsDir,
          label: options.label,
        },
        manager,
      );
      const file = options.errors ? definition.errorLogPath : definition.logPath;
      const lines = readLogTail(file, Math.max(1, options.lines));
      if (globalOptions().json) {
        printJson({ path: file, lines });
      } else {
        console.log(`log: ${file}`);
        for (const line of lines) {
          console.log(line);
        }
      }
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
