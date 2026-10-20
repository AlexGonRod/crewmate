import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CrewError } from '../core/errors';
import { newId, nowIso } from '../core/ids';
import { slugify } from '../core/slug';
import {
  assertTaskTransition,
  isActiveRunState,
  isTerminalTaskState,
  taskStateForReport,
} from '../core/state';
import type {
  Artifact,
  DeliveryMode,
  EventRecord,
  Message,
  Methodology,
  Project,
  Report,
  ReportPayload,
  ReportStatus,
  Run,
  RunState,
  Task,
  TaskDetail,
  TaskSpec,
  TaskState,
} from '../core/types';
import { assertReportMeetsMethodology } from '../protocol/methodology';
import { SCHEMA_SQL } from './schema';

interface ProjectRow {
  id: string;
  name: string;
  root_path: string;
  default_branch: string;
  remote_url: string | null;
  forge: string | null;
  created_at: string;
}

interface TaskRow {
  id: string;
  project_id: string;
  title: string;
  slug: string;
  brief_text: string;
  methodology: Methodology;
  spec_json: string | null;
  state: TaskState;
  delivery_mode: DeliveryMode;
  base_branch: string;
  branch: string | null;
  worktree_path: string | null;
  harness_id: string | null;
  priority: number;
  last_seq: number;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

interface RunRow {
  id: string;
  task_id: string;
  attempt: number;
  harness_id: string;
  backend: string;
  state: RunState;
  pid: number | null;
  exit_code: number | null;
  log_path: string;
  started_at: string;
  ended_at: string | null;
}

interface ReportRow {
  id: string;
  task_id: string;
  run_id: string;
  schema: string;
  status: ReportStatus;
  summary: string;
  payload_json: string;
  created_at: string;
}

interface MessageRow {
  id: string;
  task_id: string;
  run_id: string | null;
  direction: 'in' | 'out';
  kind: string;
  body: string;
  created_at: string;
  consumed_at: string | null;
}

interface ArtifactRow {
  id: string;
  task_id: string;
  run_id: string | null;
  kind: string;
  ref: string;
  metadata_json: string | null;
  created_at: string;
}

interface EventRow {
  seq: number;
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  task_id: string | null;
  type: string;
  actor: string;
  payload_json: string;
  created_at: string;
  correlation_id: string | null;
  causation_id: string | null;
}

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    rootPath: row.root_path,
    defaultBranch: row.default_branch,
    remoteUrl: row.remote_url,
    forge: row.forge,
    createdAt: row.created_at,
  };
}

function toTask(row: TaskRow): Task {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    slug: row.slug,
    briefText: row.brief_text,
    methodology: row.methodology ?? 'free',
    spec: row.spec_json ? (JSON.parse(row.spec_json) as TaskSpec) : null,
    state: row.state,
    deliveryMode: row.delivery_mode,
    baseBranch: row.base_branch,
    branch: row.branch,
    worktreePath: row.worktree_path,
    harnessId: row.harness_id,
    priority: row.priority,
    lastSeq: row.last_seq,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  };
}

function toRun(row: RunRow): Run {
  return {
    id: row.id,
    taskId: row.task_id,
    attempt: row.attempt,
    harnessId: row.harness_id,
    backend: row.backend,
    state: row.state,
    pid: row.pid,
    exitCode: row.exit_code,
    logPath: row.log_path,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

function toReport(row: ReportRow): Report {
  return {
    id: row.id,
    taskId: row.task_id,
    runId: row.run_id,
    schema: row.schema,
    status: row.status,
    summary: row.summary,
    payload: JSON.parse(row.payload_json) as ReportPayload,
    createdAt: row.created_at,
  };
}

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    taskId: row.task_id,
    runId: row.run_id,
    direction: row.direction,
    kind: row.kind,
    body: row.body,
    createdAt: row.created_at,
    consumedAt: row.consumed_at,
  };
}

function toArtifact(row: ArtifactRow): Artifact {
  return {
    id: row.id,
    taskId: row.task_id,
    runId: row.run_id,
    kind: row.kind,
    ref: row.ref,
    metadata: row.metadata_json ? (JSON.parse(row.metadata_json) as Record<string, unknown>) : null,
    createdAt: row.created_at,
  };
}

function toEvent(row: EventRow): EventRecord {
  return {
    seq: row.seq,
    id: row.id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    taskId: row.task_id,
    type: row.type,
    actor: row.actor,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    createdAt: row.created_at,
    correlationId: row.correlation_id,
    causationId: row.causation_id,
  };
}

export interface CreateProjectInput {
  name: string;
  rootPath: string;
  defaultBranch: string;
  remoteUrl: string | null;
  forge: string | null;
}

export interface CreateTaskInput {
  projectId: string;
  title: string;
  briefText: string;
  deliveryMode: DeliveryMode;
  methodology: Methodology;
  spec: TaskSpec | null;
}

export interface StartRunInput {
  taskId: string;
  runId: string;
  attempt: number;
  harnessId: string;
  backend: string;
  logPath: string;
  worktreePath: string;
  branch: string;
}

export interface FinishRunInput {
  runId: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  reportError?: string;
}

export class Store {
  readonly dbPath: string;
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    if (dbPath !== ':memory:') {
      mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA synchronous = NORMAL;
    `);
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  integrityCheck(): string {
    const row = this.db.prepare('PRAGMA integrity_check').get() as
      | { integrity_check: string }
      | undefined;
    return row?.integrity_check ?? 'unknown';
  }

  schemaVersion(): number {
    const row = this.db
      .prepare('SELECT MAX(version) AS version FROM schema_migrations')
      .get() as { version: number | null } | undefined;
    return Number(row?.version ?? 0);
  }

  private migrate(): void {
    this.db.exec(SCHEMA_SQL);
    const columns = this.db.prepare('PRAGMA table_info(tasks)').all() as unknown as Array<{
      name: string;
    }>;
    const names = new Set(columns.map((column) => column.name));
    if (!names.has('methodology')) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN methodology TEXT NOT NULL DEFAULT 'free'");
    }
    if (!names.has('spec_json')) {
      this.db.exec('ALTER TABLE tasks ADD COLUMN spec_json TEXT');
    }
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)',
    );
    insert.run(1, nowIso());
    insert.run(2, nowIso());
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Ignore rollback failures; the original error is more useful.
      }
      throw error;
    }
  }

  private appendEvent(input: {
    aggregateType: string;
    aggregateId: string;
    taskId?: string | null;
    type: string;
    payload: Record<string, unknown>;
    actor?: string;
    correlationId?: string | null;
    causationId?: string | null;
  }): EventRecord {
    const id = newId('evt');
    const createdAt = nowIso();
    const taskId = input.taskId ?? null;
    const payloadJson = JSON.stringify(input.payload);
    const result = this.db
      .prepare(
        `INSERT INTO events
          (id, aggregate_type, aggregate_id, task_id, type, actor, payload_json, created_at, correlation_id, causation_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.aggregateType,
        input.aggregateId,
        taskId,
        input.type,
        input.actor ?? 'crew',
        payloadJson,
        createdAt,
        input.correlationId ?? null,
        input.causationId ?? null,
      );

    const seq = Number(result.lastInsertRowid);
    if (taskId) {
      this.db
        .prepare('UPDATE tasks SET last_seq = ?, updated_at = ? WHERE id = ?')
        .run(seq, createdAt, taskId);
    }

    return {
      seq,
      id,
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      taskId,
      type: input.type,
      actor: input.actor ?? 'crew',
      payload: input.payload,
      createdAt,
      correlationId: input.correlationId ?? null,
      causationId: input.causationId ?? null,
    };
  }

  createProject(input: CreateProjectInput): Project {
    return this.transaction(() => {
      const existing = this.db
        .prepare('SELECT * FROM projects WHERE name = ? OR root_path = ?')
        .get(input.name, input.rootPath) as ProjectRow | undefined;
      if (existing) {
        throw new CrewError(
          'PROJECT_EXISTS',
          `Project already registered: ${existing.name} (${existing.root_path})`,
        );
      }

      const project: Project = {
        id: newId('prj'),
        name: input.name,
        rootPath: input.rootPath,
        defaultBranch: input.defaultBranch,
        remoteUrl: input.remoteUrl,
        forge: input.forge,
        createdAt: nowIso(),
      };

      this.db
        .prepare(
          `INSERT INTO projects (id, name, root_path, default_branch, remote_url, forge, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          project.id,
          project.name,
          project.rootPath,
          project.defaultBranch,
          project.remoteUrl,
          project.forge,
          project.createdAt,
        );

      this.appendEvent({
        aggregateType: 'project',
        aggregateId: project.id,
        type: 'project.added',
        payload: {
          name: project.name,
          root_path: project.rootPath,
          default_branch: project.defaultBranch,
        },
      });

      return project;
    });
  }

  getProject(ref: string): Project | null {
    const row = this.db
      .prepare('SELECT * FROM projects WHERE id = ? OR name = ?')
      .get(ref, ref) as ProjectRow | undefined;
    return row ? toProject(row) : null;
  }

  listProjects(): Project[] {
    const rows = this.db.prepare('SELECT * FROM projects ORDER BY name').all() as unknown as ProjectRow[];
    return rows.map(toProject);
  }

  createTask(input: CreateTaskInput): Task {
    return this.transaction(() => {
      const project = this.getProject(input.projectId);
      if (!project) {
        throw new CrewError('PROJECT_NOT_FOUND', `Project not found: ${input.projectId}`);
      }
      const title = input.title.trim();
      const briefText = input.briefText.trim() || input.spec?.goal.trim() || '';
      if (!title || !briefText) {
        throw new CrewError('INVALID_TASK', 'Task title and brief must not be empty');
      }
      if (input.methodology !== 'free' && !input.spec) {
        throw new CrewError(
          'SPEC_REQUIRED',
          `The ${input.methodology} methodology requires a task spec`,
        );
      }

      const task: Task = {
        id: newId('tsk'),
        projectId: project.id,
        title,
        slug: slugify(title),
        briefText,
        methodology: input.methodology,
        spec: input.spec,
        state: 'draft',
        deliveryMode: input.deliveryMode,
        baseBranch: project.defaultBranch,
        branch: null,
        worktreePath: null,
        harnessId: null,
        priority: 0,
        lastSeq: 0,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        finishedAt: null,
      };

      this.db
        .prepare(
          `INSERT INTO tasks
            (id, project_id, title, slug, brief_text, methodology, spec_json, state, delivery_mode, base_branch, branch, worktree_path, harness_id, priority, last_seq, created_at, updated_at, finished_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          task.id,
          task.projectId,
          task.title,
          task.slug,
          task.briefText,
          task.methodology,
          task.spec ? JSON.stringify(task.spec) : null,
          task.state,
          task.deliveryMode,
          task.baseBranch,
          task.branch,
          task.worktreePath,
          task.harnessId,
          task.priority,
          task.lastSeq,
          task.createdAt,
          task.updatedAt,
          task.finishedAt,
        );

      const event = this.appendEvent({
        aggregateType: 'task',
        aggregateId: task.id,
        taskId: task.id,
        type: 'task.created',
        payload: {
          title: task.title,
          project_id: task.projectId,
          delivery_mode: task.deliveryMode,
          methodology: task.methodology,
        },
      });

      return { ...task, lastSeq: event.seq };
    });
  }

  getTask(id: string): Task | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
    return row ? toTask(row) : null;
  }

  getTaskOrThrow(id: string): Task {
    const task = this.getTask(id);
    if (!task) {
      throw new CrewError('TASK_NOT_FOUND', `Task not found: ${id}`);
    }
    return task;
  }

  listTasks(state?: TaskState): Task[] {
    const rows = state
      ? (this.db
          .prepare('SELECT * FROM tasks WHERE state = ? ORDER BY created_at DESC')
          .all(state) as unknown as TaskRow[])
      : (this.db
          .prepare('SELECT * FROM tasks ORDER BY created_at DESC')
          .all() as unknown as TaskRow[]);
    return rows.map(toTask);
  }

  private setTaskState(
    task: Task,
    to: TaskState,
    eventType: string,
    payload: Record<string, unknown> = {},
  ): Task {
    assertTaskTransition(task.state, to);
    const updatedAt = nowIso();
    const finishedAt = isTerminalTaskState(to) ? updatedAt : null;
    this.db
      .prepare('UPDATE tasks SET state = ?, updated_at = ?, finished_at = ? WHERE id = ?')
      .run(to, updatedAt, finishedAt, task.id);
    this.appendEvent({
      aggregateType: 'task',
      aggregateId: task.id,
      taskId: task.id,
      type: eventType,
      payload: { from: task.state, to, ...payload },
    });
    return this.getTaskOrThrow(task.id);
  }

  nextAttempt(taskId: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(attempt), 0) + 1 AS next FROM runs WHERE task_id = ?')
      .get(taskId) as { next: number };
    return Number(row.next);
  }

  getActiveRun(taskId: string): Run | null {
    const row = this.db
      .prepare(
        `SELECT * FROM runs
         WHERE task_id = ? AND state IN ('starting', 'running')
         ORDER BY attempt DESC LIMIT 1`,
      )
      .get(taskId) as RunRow | undefined;
    return row ? toRun(row) : null;
  }

  getRun(id: string): Run | null {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRow | undefined;
    return row ? toRun(row) : null;
  }

  listRuns(taskId: string): Run[] {
    const rows = this.db
      .prepare('SELECT * FROM runs WHERE task_id = ? ORDER BY attempt ASC')
      .all(taskId) as unknown as RunRow[];
    return rows.map(toRun);
  }

  listActiveRuns(): Run[] {
    const rows = this.db
      .prepare("SELECT * FROM runs WHERE state IN ('starting', 'running') AND ended_at IS NULL")
      .all() as unknown as RunRow[];
    return rows.map(toRun);
  }

  startRun(input: StartRunInput): Run {
    return this.transaction(() => {
      let task = this.getTaskOrThrow(input.taskId);
      if (this.getActiveRun(task.id)) {
        throw new CrewError('RUN_ACTIVE', `Task ${task.id} already has an active run`);
      }
      if (task.state === 'draft') {
        task = this.setTaskState(task, 'queued', 'task.queued');
      }
      if (task.state !== 'queued') {
        throw new CrewError(
          'TASK_NOT_QUEUED',
          `Task ${task.id} is ${task.state}; expected draft or queued`,
        );
      }
      task = this.setTaskState(task, 'starting', 'task.starting');

      const runId = input.runId;
      const startedAt = nowIso();
      this.db
        .prepare(
          `INSERT INTO runs (id, task_id, attempt, harness_id, backend, state, pid, exit_code, log_path, started_at, ended_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          runId,
          task.id,
          input.attempt,
          input.harnessId,
          input.backend,
          'starting',
          null,
          null,
          input.logPath,
          startedAt,
          null,
        );

      this.db
        .prepare(
          `UPDATE tasks
           SET branch = ?, worktree_path = ?, harness_id = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(input.branch, input.worktreePath, input.harnessId, startedAt, task.id);

      this.appendEvent({
        aggregateType: 'run',
        aggregateId: runId,
        taskId: task.id,
        type: 'run.started',
        payload: {
          attempt: input.attempt,
          harness_id: input.harnessId,
          backend: input.backend,
          branch: input.branch,
          worktree_path: input.worktreePath,
        },
      });

      task = this.setTaskState(task, 'running', 'task.started');
      return this.getRun(runId) ?? (() => {
        throw new CrewError('RUN_NOT_FOUND', `Run not found after insert: ${runId}`);
      })();
    });
  }

  markRunRunning(runId: string, pid: number): Run {
    return this.transaction(() => {
      const run = this.getRun(runId);
      if (!run) {
        throw new CrewError('RUN_NOT_FOUND', `Run not found: ${runId}`);
      }
      if (run.state !== 'starting') {
        return run;
      }
      this.db
        .prepare('UPDATE runs SET state = ?, pid = ? WHERE id = ?')
        .run('running', pid, runId);
      this.appendEvent({
        aggregateType: 'run',
        aggregateId: runId,
        taskId: run.taskId,
        type: 'run.running',
        payload: { pid },
      });
      return this.getRun(runId) ?? run;
    });
  }

  getReportByRun(runId: string): Report | null {
    const row = this.db
      .prepare('SELECT * FROM reports WHERE run_id = ?')
      .get(runId) as ReportRow | undefined;
    return row ? toReport(row) : null;
  }

  getLatestReport(taskId: string): Report | null {
    const row = this.db
      .prepare('SELECT * FROM reports WHERE task_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(taskId) as ReportRow | undefined;
    return row ? toReport(row) : null;
  }

  listMessages(taskId: string): Message[] {
    const rows = this.db
      .prepare('SELECT * FROM messages WHERE task_id = ? ORDER BY created_at ASC')
      .all(taskId) as unknown as MessageRow[];
    return rows.map(toMessage);
  }

  listArtifacts(taskId: string): Artifact[] {
    const rows = this.db
      .prepare('SELECT * FROM artifacts WHERE task_id = ? ORDER BY created_at ASC')
      .all(taskId) as unknown as ArtifactRow[];
    return rows.map(toArtifact);
  }

  recordReport(input: ReportPayload): Report {
    return this.transaction(() => {
      const existing = this.getReportByRun(input.run_id);
      if (existing) {
        return existing;
      }

      const task = this.getTaskOrThrow(input.task_id);
      const run = this.getRun(input.run_id);
      if (!run) {
        throw new CrewError('RUN_NOT_FOUND', `Run not found: ${input.run_id}`);
      }
      if (run.taskId !== task.id) {
        throw new CrewError(
          'REPORT_MISMATCH',
          `Report run ${input.run_id} does not belong to task ${task.id}`,
        );
      }
      if (isTerminalTaskState(task.state)) {
        throw new CrewError(
          'TASK_TERMINAL',
          `Cannot record a report for terminal task ${task.id} (${task.state})`,
        );
      }

      assertReportMeetsMethodology(input, task);

      const report: Report = {
        id: newId('rep'),
        taskId: task.id,
        runId: run.id,
        schema: input.schema,
        status: input.status,
        summary: input.summary,
        payload: input,
        createdAt: nowIso(),
      };

      this.db
        .prepare(
          `INSERT INTO reports (id, task_id, run_id, schema, status, summary, payload_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          report.id,
          report.taskId,
          report.runId,
          report.schema,
          report.status,
          report.summary,
          JSON.stringify(input),
          report.createdAt,
        );

      for (const artifact of input.artifacts ?? []) {
        this.db
          .prepare(
            `INSERT INTO artifacts (id, task_id, run_id, kind, ref, metadata_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            newId('art'),
            task.id,
            run.id,
            artifact.kind,
            artifact.ref,
            artifact.label ? JSON.stringify({ label: artifact.label }) : null,
            nowIso(),
          );
      }

      for (const question of input.questions ?? []) {
        this.db
          .prepare(
            `INSERT INTO messages (id, task_id, run_id, direction, kind, body, created_at, consumed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            newId('msg'),
            task.id,
            run.id,
            'out',
            'question',
            question.text,
            nowIso(),
            null,
          );
      }

      this.appendEvent({
        aggregateType: 'run',
        aggregateId: run.id,
        taskId: task.id,
        type: 'run.report.received',
        payload: {
          report_id: report.id,
          status: report.status,
          summary: report.summary,
        },
        correlationId: run.id,
      });

      const target = taskStateForReport(input.status);
      if (target && (task.state === 'starting' || task.state === 'running')) {
        const eventType =
          target === 'done'
            ? 'task.completed'
            : target === 'failed'
              ? 'task.failed'
              : target === 'blocked'
                ? 'task.blocked'
                : 'task.input_requested';
        this.setTaskState(task, target, eventType, {
          report_id: report.id,
          status: report.status,
        });
      }

      return report;
    });
  }

  finishRun(input: FinishRunInput): Task {
    return this.transaction(() => {
      const run = this.getRun(input.runId);
      if (!run) {
        throw new CrewError('RUN_NOT_FOUND', `Run not found: ${input.runId}`);
      }
      if (!isActiveRunState(run.state)) {
        return this.getTaskOrThrow(run.taskId);
      }

      const runState: RunState =
        input.timedOut || input.signal || input.exitCode !== 0 ? 'failed' : 'exited';
      const endedAt = nowIso();
      this.db
        .prepare('UPDATE runs SET state = ?, exit_code = ?, ended_at = ? WHERE id = ?')
        .run(runState, input.exitCode, endedAt, run.id);
      this.appendEvent({
        aggregateType: 'run',
        aggregateId: run.id,
        taskId: run.taskId,
        type: 'run.exited',
        payload: {
          run_state: runState,
          exit_code: input.exitCode,
          signal: input.signal,
          timed_out: input.timedOut,
        },
      });

      const task = this.getTaskOrThrow(run.taskId);
      if (task.state !== 'starting' && task.state !== 'running') {
        return task;
      }

      const report = this.getReportByRun(run.id);
      if (input.timedOut) {
        return this.setTaskState(task, 'failed', 'task.failed', { reason: 'Agent timed out' });
      }
      if (report && report.status !== 'progress') {
        const target = taskStateForReport(report.status);
        if (target && task.state !== target) {
          return this.setTaskState(task, target, 'task.state_changed', {
            report_id: report.id,
            status: report.status,
          });
        }
        return task;
      }
      if (report && report.status === 'progress') {
        return this.setTaskState(task, 'failed', 'task.failed', {
          reason: 'Agent exited after a progress report without a terminal report',
        });
      }
      if (input.reportError) {
        return this.setTaskState(task, 'failed', 'task.failed', {
          reason: `Invalid agent report: ${input.reportError}`,
        });
      }
      return this.setTaskState(task, 'failed', 'task.failed', {
        reason:
          input.exitCode === 0
            ? 'Agent exited without a report'
            : `Agent exited with code ${input.exitCode ?? 'unknown'}`,
      });
    });
  }

  answerTask(taskId: string, text: string): Task {
    return this.transaction(() => {
      const task = this.getTaskOrThrow(taskId);
      if (task.state !== 'waiting_input' && task.state !== 'blocked') {
        throw new CrewError(
          'TASK_NOT_WAITING',
          `Task ${task.id} is ${task.state}; expected waiting_input or blocked`,
        );
      }
      const body = text.trim();
      if (!body) {
        throw new CrewError('EMPTY_ANSWER', 'Answer must not be empty');
      }
      this.db
        .prepare(
          `INSERT INTO messages (id, task_id, run_id, direction, kind, body, created_at, consumed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(newId('msg'), task.id, null, 'in', 'answer', body, nowIso(), null);
      this.appendEvent({
        aggregateType: 'task',
        aggregateId: task.id,
        taskId: task.id,
        type: 'message.added',
        payload: { direction: 'in', kind: 'answer' },
      });
      return this.setTaskState(task, 'queued', 'task.queued', { reason: 'answered' });
    });
  }

  cancelTask(taskId: string): Task {
    return this.transaction(() => {
      const task = this.getTaskOrThrow(taskId);
      if (isTerminalTaskState(task.state)) {
        throw new CrewError('TASK_TERMINAL', `Task ${task.id} is already ${task.state}`);
      }
      return this.setTaskState(task, 'cancelled', 'task.cancelled');
    });
  }

  clearWorktree(taskId: string): Task {
    return this.transaction(() => {
      const task = this.getTaskOrThrow(taskId);
      this.db
        .prepare('UPDATE tasks SET worktree_path = NULL, updated_at = ? WHERE id = ?')
        .run(nowIso(), task.id);
      this.appendEvent({
        aggregateType: 'task',
        aggregateId: task.id,
        taskId: task.id,
        type: 'task.cleaned',
        payload: { worktree_path: task.worktreePath },
      });
      return this.getTaskOrThrow(task.id);
    });
  }

  listEvents(options: {
    taskId?: string;
    afterSeq?: number;
    limit?: number;
  } = {}): EventRecord[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (options.taskId) {
      clauses.push('task_id = ?');
      params.push(options.taskId);
    }
    if (options.afterSeq !== undefined) {
      clauses.push('seq > ?');
      params.push(options.afterSeq);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.max(1, Math.min(options.limit ?? 1000, 10_000));
    const rows = this.db
      .prepare(`SELECT * FROM events ${where} ORDER BY seq ASC LIMIT ?`)
      .all(...params, limit) as unknown as EventRow[];
    return rows.map(toEvent);
  }

  getTaskDetail(taskId: string): TaskDetail {
    const task = this.getTaskOrThrow(taskId);
    return {
      task,
      project: this.getProject(task.projectId),
      runs: this.listRuns(task.id),
      report: this.getLatestReport(task.id),
      messages: this.listMessages(task.id),
      artifacts: this.listArtifacts(task.id),
      events: this.listEvents({ taskId: task.id }),
    };
  }
}
