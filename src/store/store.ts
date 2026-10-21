import { mkdirSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CrewError } from '../core/errors';
import { newId, nowIso } from '../core/ids';
import { isPidAlive } from '../core/process';
import { backoffDelayMs, DEFAULT_BACKOFF_MS } from '../core/backoff';
import { slugify } from '../core/slug';
import {
  assertTaskTransition,
  isActiveRunState,
  isTerminalTaskState,
  taskStateForReport,
} from '../core/state';
import type {
  AgentRole,
  Artifact,
  ChangeStats,
  CiResult,
  DeliveryMode,
  EventRecord,
  MergeResult,
  Message,
  Methodology,
  PipelineStage,
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
  VerificationResult,
  VerificationState,
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
  stage: PipelineStage;
  review_iterations: number;
  commit_sha: string | null;
  pr_url: string | null;
  state: TaskState;
  delivery_mode: DeliveryMode;
  base_branch: string;
  branch: string | null;
  worktree_path: string | null;
  harness_id: string | null;
  priority: number;
  last_seq: number;
  attempts: number;
  next_attempt_at: string | null;
  last_error: string | null;
  retryable: number;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

interface RunRow {
  id: string;
  task_id: string;
  attempt: number;
  harness_id: string;
  role: AgentRole;
  stage: PipelineStage;
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
  role: AgentRole;
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

interface VerificationRow {
  id: string;
  task_id: string;
  run_id: string;
  command: string;
  state: VerificationState;
  exit_code: number | null;
  signal: string | null;
  timed_out: number;
  duration_ms: number;
  output: string;
  log_path: string;
  error: string | null;
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

interface LeaseRow {
  resource: string;
  owner: string;
  acquired_at: string;
  expires_at: string;
  heartbeat_at: string;
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
    stage: (row.stage ?? 'develop') as PipelineStage,
    reviewIterations: Number(row.review_iterations ?? 0),
    commitSha: row.commit_sha ?? null,
    prUrl: row.pr_url ?? null,
    state: row.state,
    deliveryMode: row.delivery_mode,
    baseBranch: row.base_branch,
    branch: row.branch,
    worktreePath: row.worktree_path,
    harnessId: row.harness_id,
    priority: row.priority,
    lastSeq: row.last_seq,
    attempts: Number(row.attempts ?? 0),
    nextAttemptAt: row.next_attempt_at ?? null,
    lastError: row.last_error ?? null,
    retryable: Number(row.retryable ?? 0) === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  };
}

function leaseHolderIsDead(lease: Lease, now = Date.now()): boolean {
  if (Date.parse(lease.expiresAt) <= now) {
    return true;
  }
  const parts = lease.owner.split(':');
  if (parts.length < 2) {
    return false;
  }
  const host = parts[0] as string;
  const pid = Number(parts[1]);
  if (host !== hostname() || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  return !isPidAlive(pid);
}

function toRun(row: RunRow): Run {
  return {
    id: row.id,
    taskId: row.task_id,
    attempt: row.attempt,
    harnessId: row.harness_id,
    role: (row.role ?? 'developer') as AgentRole,
    stage: (row.stage ?? 'develop') as PipelineStage,
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
    role: (row.role ?? 'developer') as AgentRole,
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

function toVerification(row: VerificationRow): VerificationResult {
  return {
    id: row.id,
    taskId: row.task_id,
    runId: row.run_id,
    command: row.command,
    state: row.state,
    exitCode: row.exit_code,
    signal: row.signal,
    timedOut: Boolean(row.timed_out),
    durationMs: Number(row.duration_ms),
    output: row.output,
    logPath: row.log_path,
    ...(row.error ? { error: row.error } : {}),
    createdAt: row.created_at,
  };
}

function toLease(row: LeaseRow): Lease {
  return {
    resource: row.resource,
    owner: row.owner,
    acquiredAt: row.acquired_at,
    expiresAt: row.expires_at,
    heartbeatAt: row.heartbeat_at,
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
  role?: AgentRole;
  stage?: PipelineStage;
  backend: string;
  logPath: string;
  worktreePath: string;
  branch: string;
  continuePipeline?: boolean;
}

export interface FinishRunInput {
  runId: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  reportError?: string;
  keepTaskRunning?: boolean;
}

export interface RecordVerificationInput {
  taskId: string;
  runId: string;
  command: string;
  state: VerificationState;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  output: string;
  logPath: string;
  error?: string;
}

export interface Lease {
  resource: string;
  owner: string;
  acquiredAt: string;
  expiresAt: string;
  heartbeatAt: string;
}

export interface LostRun {
  runId: string;
  taskId: string;
  pid: number | null;
  reason: string;
  taskState: TaskState;
}

export interface ReconcileOptions {
  isAlive?: (pid: number) => boolean;
  staleAfterMs?: number;
  now?: number;
  requeue?: boolean;
  maxAttempts?: number;
  backoffMs?: number;
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
    if (!names.has('stage')) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN stage TEXT NOT NULL DEFAULT 'develop'");
    }
    if (!names.has('review_iterations')) {
      this.db.exec('ALTER TABLE tasks ADD COLUMN review_iterations INTEGER NOT NULL DEFAULT 0');
    }
    if (!names.has('commit_sha')) {
      this.db.exec('ALTER TABLE tasks ADD COLUMN commit_sha TEXT');
    }
    if (!names.has('pr_url')) {
      this.db.exec('ALTER TABLE tasks ADD COLUMN pr_url TEXT');
    }
    if (!names.has('attempts')) {
      this.db.exec('ALTER TABLE tasks ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0');
    }
    if (!names.has('next_attempt_at')) {
      this.db.exec('ALTER TABLE tasks ADD COLUMN next_attempt_at TEXT');
    }
    if (!names.has('last_error')) {
      this.db.exec('ALTER TABLE tasks ADD COLUMN last_error TEXT');
    }
    if (!names.has('retryable')) {
      this.db.exec('ALTER TABLE tasks ADD COLUMN retryable INTEGER NOT NULL DEFAULT 0');
    }

    const runColumns = this.db.prepare('PRAGMA table_info(runs)').all() as unknown as Array<{
      name: string;
    }>;
    const runNames = new Set(runColumns.map((column) => column.name));
    if (!runNames.has('role')) {
      this.db.exec("ALTER TABLE runs ADD COLUMN role TEXT NOT NULL DEFAULT 'developer'");
    }
    if (!runNames.has('stage')) {
      this.db.exec("ALTER TABLE runs ADD COLUMN stage TEXT NOT NULL DEFAULT 'develop'");
    }

    const reportColumns = this.db
      .prepare('PRAGMA table_info(reports)')
      .all() as unknown as Array<{ name: string }>;
    const reportNames = new Set(reportColumns.map((column) => column.name));
    if (!reportNames.has('role')) {
      this.db.exec("ALTER TABLE reports ADD COLUMN role TEXT NOT NULL DEFAULT 'developer'");
    }

    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)',
    );
    insert.run(1, nowIso());
    insert.run(2, nowIso());
    insert.run(3, nowIso());
    insert.run(4, nowIso());
    insert.run(5, nowIso());
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

  appendAuthorizationEvent(
    taskId: string,
    payload: {
      actor: string;
      action: string;
      gates?: Array<{ name: string; ok: boolean }>;
      [key: string]: unknown;
    },
  ): EventRecord {
    return this.transaction(() => {
      const task = this.getTaskOrThrow(taskId);
      return this.appendEvent({
        aggregateType: 'task',
        aggregateId: task.id,
        taskId: task.id,
        type: 'task.authorized',
        actor: payload.actor,
        payload: { ...payload },
      });
    });
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
        stage: 'develop',
        reviewIterations: 0,
        commitSha: null,
        prUrl: null,
        state: 'draft',
        deliveryMode: input.deliveryMode,
        baseBranch: project.defaultBranch,
        branch: null,
        worktreePath: null,
        harnessId: null,
        priority: 0,
        lastSeq: 0,
        attempts: 0,
        nextAttemptAt: null,
        lastError: null,
        retryable: false,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        finishedAt: null,
      };

      this.db
        .prepare(
          `INSERT INTO tasks
            (id, project_id, title, slug, brief_text, methodology, spec_json, stage, review_iterations, commit_sha, pr_url, state, delivery_mode, base_branch, branch, worktree_path, harness_id, priority, last_seq, created_at, updated_at, finished_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          task.id,
          task.projectId,
          task.title,
          task.slug,
          task.briefText,
          task.methodology,
          task.spec ? JSON.stringify(task.spec) : null,
          task.stage,
          task.reviewIterations,
          task.commitSha,
          task.prUrl,
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

  private markFailure(taskId: string, reason: string, retryable: boolean): void {
    this.db
      .prepare(
        'UPDATE tasks SET last_error = ?, retryable = ?, updated_at = ? WHERE id = ?',
      )
      .run(reason, retryable ? 1 : 0, nowIso(), taskId);
  }

  private failTaskWith(
    task: Task,
    reason: string,
    retryable: boolean,
    eventType = 'task.failed',
  ): Task {
    const failed = this.setTaskState(task, 'failed', eventType, { reason });
    this.markFailure(task.id, reason, retryable);
    return this.getTaskOrThrow(failed.id);
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

  private setTaskStage(taskId: string, stage: PipelineStage): void {
    this.db
      .prepare('UPDATE tasks SET stage = ?, updated_at = ? WHERE id = ?')
      .run(stage, nowIso(), taskId);
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

      const role: AgentRole = input.role ?? 'developer';
      const stage: PipelineStage = input.stage ?? task.stage;

      if (task.state === 'running' && input.continuePipeline) {
        // A pipeline stage follows the previous one without leaving `running`.
      } else {
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
      }

      const runId = input.runId;
      const startedAt = nowIso();
      this.db
        .prepare(
          `INSERT INTO runs (id, task_id, attempt, harness_id, role, stage, backend, state, pid, exit_code, log_path, started_at, ended_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          runId,
          task.id,
          input.attempt,
          input.harnessId,
          role,
          stage,
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
           SET branch = ?, worktree_path = ?, harness_id = ?, stage = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          input.branch,
          input.worktreePath,
          role === 'developer' ? input.harnessId : task.harnessId,
          stage,
          startedAt,
          task.id,
        );

      this.appendEvent({
        aggregateType: 'run',
        aggregateId: runId,
        taskId: task.id,
        type: 'run.started',
        payload: {
          attempt: input.attempt,
          harness_id: input.harnessId,
          role,
          stage,
          backend: input.backend,
          branch: input.branch,
          worktree_path: input.worktreePath,
        },
      });

      if (task.state !== 'running') {
        task = this.setTaskState(task, 'running', 'task.started', { role, stage });
      }
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

  listReports(taskId: string): Report[] {
    const rows = this.db
      .prepare('SELECT * FROM reports WHERE task_id = ? ORDER BY created_at ASC')
      .all(taskId) as unknown as ReportRow[];
    return rows.map(toReport);
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

  listVerifications(taskId: string): VerificationResult[] {
    const rows = this.db
      .prepare('SELECT * FROM verifications WHERE task_id = ? ORDER BY created_at ASC')
      .all(taskId) as unknown as VerificationRow[];
    return rows.map(toVerification);
  }

  listVerificationsForRun(runId: string): VerificationResult[] {
    const rows = this.db
      .prepare('SELECT * FROM verifications WHERE run_id = ? ORDER BY created_at ASC')
      .all(runId) as unknown as VerificationRow[];
    return rows.map(toVerification);
  }

  recordVerification(input: RecordVerificationInput): VerificationResult {
    return this.transaction(() => {
      const task = this.getTaskOrThrow(input.taskId);
      const run = this.getRun(input.runId);
      if (!run || run.taskId !== task.id) {
        throw new CrewError('RUN_NOT_FOUND', `Run not found for task ${task.id}: ${input.runId}`);
      }
      const verification: VerificationResult = {
        id: newId('ver'),
        taskId: task.id,
        runId: run.id,
        command: input.command,
        state: input.state,
        exitCode: input.exitCode,
        signal: input.signal,
        timedOut: input.timedOut,
        durationMs: input.durationMs,
        output: input.output,
        logPath: input.logPath,
        ...(input.error ? { error: input.error } : {}),
        createdAt: nowIso(),
      };
      this.db
        .prepare(
          `INSERT INTO verifications
            (id, task_id, run_id, command, state, exit_code, signal, timed_out, duration_ms, output, log_path, error, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          verification.id,
          verification.taskId,
          verification.runId,
          verification.command,
          verification.state,
          verification.exitCode,
          verification.signal,
          verification.timedOut ? 1 : 0,
          verification.durationMs,
          verification.output,
          verification.logPath,
          verification.error ?? null,
          verification.createdAt,
        );
      this.appendEvent({
        aggregateType: 'run',
        aggregateId: run.id,
        taskId: task.id,
        type: 'verification.completed',
        payload: {
          verification_id: verification.id,
          command: verification.command,
          state: verification.state,
          exit_code: verification.exitCode,
          timed_out: verification.timedOut,
          duration_ms: verification.durationMs,
          log_path: verification.logPath,
        },
        correlationId: run.id,
      });
      return verification;
    });
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

      assertReportMeetsMethodology(input, task, run.role);

      const report: Report = {
        id: newId('rep'),
        taskId: task.id,
        runId: run.id,
        schema: input.schema,
        role: run.role,
        status: input.status,
        summary: input.summary,
        payload: input,
        createdAt: nowIso(),
      };

      this.db
        .prepare(
          `INSERT INTO reports (id, task_id, run_id, schema, role, status, summary, payload_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          report.id,
          report.taskId,
          report.runId,
          report.schema,
          report.role,
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
          role: report.role,
          status: report.status,
          summary: report.summary,
          verdict: input.verdict,
        },
        correlationId: run.id,
      });

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
      if (input.keepTaskRunning) {
        if (input.timedOut) {
          return this.failTaskWith(task, 'Agent timed out', true);
        }
        if (input.reportError) {
          return this.failTaskWith(task, `Invalid agent report: ${input.reportError}`, false);
        }
        if (!report) {
          return this.failTaskWith(task, 'Agent exited without a report', true);
        }
        if (report.status === 'progress') {
          return this.failTaskWith(
            task,
            'Agent exited after a progress report without a terminal report',
            true,
          );
        }
        return task;
      }
      if (input.timedOut) {
        return this.failTaskWith(task, 'Agent timed out', true);
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
        return this.failTaskWith(
          task,
          'Agent exited after a progress report without a terminal report',
          true,
        );
      }
      if (input.reportError) {
        return this.failTaskWith(task, `Invalid agent report: ${input.reportError}`, false);
      }
      return this.failTaskWith(
        task,
        input.exitCode === 0
          ? 'Agent exited without a report'
          : `Agent exited with code ${input.exitCode ?? 'unknown'}`,
        true,
      );
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
      this.setTaskStage(task.id, 'develop');
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

  nextQueuedTask(
    excludeTaskIds: string[] = [],
    options: { now?: number; excludeProjectIds?: string[] } = {},
  ): Task | null {
    const exclusion =
      excludeTaskIds.length > 0
        ? ` AND id NOT IN (${excludeTaskIds.map(() => '?').join(', ')})`
        : '';
    const projectExclusion =
      options.excludeProjectIds && options.excludeProjectIds.length > 0
        ? ` AND project_id NOT IN (${options.excludeProjectIds.map(() => '?').join(', ')})`
        : '';
    const now = new Date(options.now ?? Date.now()).toISOString();
    const row = this.db
      .prepare(
        `SELECT * FROM tasks
         WHERE state = 'queued' AND stage = 'develop'
           AND (next_attempt_at IS NULL OR next_attempt_at <= ?)${exclusion}
           AND NOT EXISTS (
             SELECT 1 FROM task_dependencies d
             JOIN tasks dep ON dep.id = d.depends_on_task_id
             WHERE d.task_id = tasks.id AND dep.state NOT IN ('done', 'review')
           )${projectExclusion}
         ORDER BY priority DESC, created_at ASC
         LIMIT 1`,
      )
      .get(now, ...excludeTaskIds, ...(options.excludeProjectIds ?? [])) as TaskRow | undefined;
    return row ? toTask(row) : null;
  }

  addDependency(taskId: string, dependsOnTaskId: string): void {
    this.transaction(() => {
      const task = this.getTaskOrThrow(taskId);
      const dependency = this.getTaskOrThrow(dependsOnTaskId);
      if (task.id === dependency.id) {
        throw new CrewError(
          'TASK_DEPENDENCY_SELF',
          `Task ${task.id} cannot depend on itself`,
        );
      }
      this.db
        .prepare(
          `INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_task_id, created_at)
           VALUES (?, ?, ?)`,
        )
        .run(task.id, dependency.id, nowIso());
      this.appendEvent({
        aggregateType: 'task',
        aggregateId: task.id,
        taskId: task.id,
        type: 'task.dependency_added',
        payload: { depends_on_task_id: dependency.id },
      });
    });
  }

  listDependencies(taskId: string): string[] {
    const rows = this.db
      .prepare(
        'SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ? ORDER BY created_at ASC',
      )
      .all(taskId) as unknown as Array<{ depends_on_task_id: string }>;
    return rows.map((row) => row.depends_on_task_id);
  }

  listDependents(taskId: string): string[] {
    const rows = this.db
      .prepare(
        'SELECT task_id FROM task_dependencies WHERE depends_on_task_id = ? ORDER BY created_at ASC',
      )
      .all(taskId) as unknown as Array<{ task_id: string }>;
    return rows.map((row) => row.task_id);
  }

  unresolvedDependencies(taskId: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT dep.id AS id FROM task_dependencies d
         JOIN tasks dep ON dep.id = d.depends_on_task_id
         WHERE d.task_id = ? AND dep.state NOT IN ('done', 'review')
         ORDER BY dep.created_at ASC`,
      )
      .all(taskId) as unknown as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  blockTasksWithFailedDependencies(): string[] {
    return this.transaction(() => {
      const blocked: string[] = [];
      for (const task of this.listTasks('queued')) {
        const failed = this.listDependencies(task.id).filter((id) => {
          const dependency = this.getTask(id);
          return dependency?.state === 'failed' || dependency?.state === 'cancelled';
        });
        if (failed.length === 0) {
          continue;
        }
        const reason = `Dependency failed: ${failed.join(', ')}`;
        this.db
          .prepare(
            'UPDATE tasks SET last_error = ?, retryable = 0, updated_at = ? WHERE id = ?',
          )
          .run(reason, nowIso(), task.id);
        const updated = this.setTaskState(task, 'blocked', 'task.blocked', { reason });
        blocked.push(updated.id);
      }
      return blocked;
    });
  }

  queueTask(taskId: string): Task {
    return this.transaction(() => {
      const task = this.getTaskOrThrow(taskId);
      if (task.state === 'queued') {
        return task;
      }
      if (task.state !== 'draft') {
        throw new CrewError(
          'TASK_NOT_DRAFT',
          `Task ${task.id} is ${task.state}; expected draft`,
        );
      }
      this.setTaskStage(task.id, 'develop');
      return this.setTaskState(task, 'queued', 'task.queued');
    });
  }

  retryTask(taskId: string): Task {
    return this.transaction(() => {
      const task = this.getTaskOrThrow(taskId);
      if (task.state !== 'failed') {
        throw new CrewError(
          'TASK_NOT_FAILED',
          `Task ${task.id} is ${task.state}; only failed tasks can be retried`,
        );
      }
      this.setTaskStage(task.id, 'develop');
      this.db
        .prepare(
          `UPDATE tasks
           SET attempts = 0, next_attempt_at = NULL, last_error = NULL, retryable = 0,
               updated_at = ?
           WHERE id = ?`,
        )
        .run(nowIso(), task.id);
      return this.setTaskState(task, 'queued', 'task.queued', { reason: 'retry' });
    });
  }

  failTask(taskId: string, reason: string, options: { retryable?: boolean } = {}): Task {
    return this.transaction(() => {
      const task = this.getTaskOrThrow(taskId);
      if (isTerminalTaskState(task.state)) {
        return task;
      }
      assertTaskTransition(task.state, 'failed');
      const failed = this.setTaskState(task, 'failed', 'task.failed', {
        reason,
        retryable: Boolean(options.retryable),
      });
      this.markFailure(task.id, reason, Boolean(options.retryable));
      return this.getTaskOrThrow(failed.id);
    });
  }

  requeueTask(
    taskId: string,
    options: { reason?: string; delayMs?: number; incrementAttempt?: boolean } = {},
  ): Task {
    return this.transaction(() => this.requeueTaskLocked(taskId, options));
  }

  private requeueTaskLocked(
    taskId: string,
    options: { reason?: string; delayMs?: number; incrementAttempt?: boolean } = {},
  ): Task {
    const task = this.getTaskOrThrow(taskId);
    if (task.state === 'queued') {
      return task;
    }
    assertTaskTransition(task.state, 'queued');
    const delayMs = Math.max(0, Math.floor(options.delayMs ?? 0));
    const nextAttemptAt = new Date(Date.now() + delayMs).toISOString();
    const attempts = task.attempts + (options.incrementAttempt === false ? 0 : 1);
    this.setTaskStage(task.id, 'develop');
    const queued = this.setTaskState(task, 'queued', 'task.requeued', {
      reason: options.reason ?? 'retry',
      delay_ms: delayMs,
      attempt: attempts,
      next_attempt_at: nextAttemptAt,
    });
    this.db
      .prepare(
        `UPDATE tasks
         SET attempts = ?, next_attempt_at = ?, retryable = 0, updated_at = ?
         WHERE id = ?`,
      )
      .run(attempts, nextAttemptAt, nowIso(), task.id);
    return this.getTaskOrThrow(queued.id);
  }

  setDeliveryMode(taskId: string, mode: DeliveryMode): Task {
    return this.transaction(() => {
      const task = this.getTaskOrThrow(taskId);
      if (task.deliveryMode === mode) {
        return task;
      }
      this.db
        .prepare('UPDATE tasks SET delivery_mode = ?, updated_at = ? WHERE id = ?')
        .run(mode, nowIso(), task.id);
      this.appendEvent({
        aggregateType: 'task',
        aggregateId: task.id,
        taskId: task.id,
        type: 'task.delivery_changed',
        payload: { from: task.deliveryMode, to: mode },
      });
      return this.getTaskOrThrow(task.id);
    });
  }

  applyReportOutcome(
    taskId: string,
    status: ReportStatus,
    reason?: string,
  ): Task {
    return this.transaction(() => {
      const task = this.getTaskOrThrow(taskId);
      if (status === 'done' || status === 'progress') {
        return task;
      }
      const target: TaskState =
        status === 'needs_input'
          ? 'waiting_input'
          : status === 'blocked'
            ? 'blocked'
            : 'failed';
      if (task.state === target) {
        return task;
      }
      const eventType =
        target === 'failed'
          ? 'task.failed'
          : target === 'blocked'
            ? 'task.blocked'
            : 'task.input_requested';
      const updated = this.setTaskState(task, target, eventType, {
        status,
        ...(reason ? { reason } : {}),
      });
      if (target === 'failed') {
        this.markFailure(task.id, reason ?? 'agent reported failure', true);
      }
      return this.getTaskOrThrow(updated.id);
    });
  }

  requestReview(taskId: string): Task {
    return this.transaction(() => {
      const task = this.getTaskOrThrow(taskId);
      if (task.state !== 'running') {
        throw new CrewError(
          'TASK_NOT_RUNNING',
          `Task ${task.id} is ${task.state}; expected running`,
        );
      }
      this.setTaskStage(task.id, 'review');
      return this.setTaskState(task, 'review', 'task.review.requested', {
        commit_sha: task.commitSha,
        pr_url: task.prUrl,
      });
    });
  }

  rejectReview(taskId: string, reason: string, maxIterations = 3): Task {
    return this.transaction(() => {
      const task = this.getTaskOrThrow(taskId);
      if (task.state !== 'running' && task.state !== 'review') {
        throw new CrewError(
          'TASK_NOT_REVIEWABLE',
          `Task ${task.id} is ${task.state}; expected running or review`,
        );
      }
      const iteration = task.reviewIterations + 1;
      const body = reason.trim() || 'Review rejected without a reason';
      const createdAt = nowIso();

      this.db
        .prepare(
          `INSERT INTO messages (id, task_id, run_id, direction, kind, body, created_at, consumed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          newId('msg'),
          task.id,
          null,
          'in',
          'review_feedback',
          body,
          createdAt,
          null,
        );
      this.db
        .prepare(
          'UPDATE tasks SET review_iterations = ?, updated_at = ? WHERE id = ?',
        )
        .run(iteration, createdAt, task.id);

      this.appendEvent({
        aggregateType: 'task',
        aggregateId: task.id,
        taskId: task.id,
        type: 'task.review.rejected',
        payload: { iteration, reason: body, max_iterations: maxIterations },
      });

      if (iteration > maxIterations) {
        this.setTaskStage(task.id, 'review');
        return this.setTaskState(task, 'failed', 'task.failed', {
          reason: `Review rejected ${iteration} times (max ${maxIterations}): ${body}`,
          review_iterations: iteration,
        });
      }

      this.setTaskStage(task.id, 'develop');
      return this.setTaskState(task, 'queued', 'task.queued', {
        reason: 'review rejected',
        review_iterations: iteration,
      });
    });
  }

  acceptTask(taskId: string): Task {
    return this.transaction(() => {
      const task = this.getTaskOrThrow(taskId);
      if (task.state !== 'review') {
        throw new CrewError(
          'TASK_NOT_IN_REVIEW',
          `Task ${task.id} is ${task.state}; expected review`,
        );
      }
      this.setTaskStage(task.id, 'review');
      const delivering = this.setTaskState(task, 'delivering', 'task.delivering', {
        commit_sha: task.commitSha,
        pr_url: task.prUrl,
      });
      return this.setTaskState(delivering, 'done', 'task.accepted', {
        commit_sha: task.commitSha,
        pr_url: task.prUrl,
      });
    });
  }

  recordCommit(taskId: string, sha: string): Task {
    return this.transaction(() => {
      const task = this.getTaskOrThrow(taskId);
      this.db
        .prepare('UPDATE tasks SET commit_sha = ?, updated_at = ? WHERE id = ?')
        .run(sha, nowIso(), task.id);
      this.db
        .prepare(
          `INSERT INTO artifacts (id, task_id, run_id, kind, ref, metadata_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(newId('art'), task.id, null, 'commit', sha, null, nowIso());
      this.appendEvent({
        aggregateType: 'task',
        aggregateId: task.id,
        taskId: task.id,
        type: 'git.committed',
        payload: { commit_sha: sha },
      });
      return this.getTaskOrThrow(task.id);
    });
  }

  recordChangeStats(taskId: string, stats: ChangeStats): Task {
    return this.transaction(() => {
      const task = this.getTaskOrThrow(taskId);
      const createdAt = nowIso();
      this.db
        .prepare(
          `INSERT INTO artifacts (id, task_id, run_id, kind, ref, metadata_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          newId('art'),
          task.id,
          null,
          'change',
          `${stats.files} file(s), +${stats.additions}/-${stats.deletions}`,
          JSON.stringify(stats),
          createdAt,
        );
      this.appendEvent({
        aggregateType: 'task',
        aggregateId: task.id,
        taskId: task.id,
        type: 'change.recorded',
        payload: {
          files: stats.files,
          additions: stats.additions,
          deletions: stats.deletions,
          paths: stats.paths,
        },
      });
      return this.getTaskOrThrow(taskId);
    });
  }

  recordCiCheck(taskId: string, result: CiResult): Task {
    return this.transaction(() => {
      const task = this.getTaskOrThrow(taskId);
      const createdAt = nowIso();
      this.db
        .prepare(
          `INSERT INTO artifacts (id, task_id, run_id, kind, ref, metadata_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          newId('art'),
          task.id,
          null,
          'ci',
          result.url,
          JSON.stringify(result),
          createdAt,
        );
      this.appendEvent({
        aggregateType: 'task',
        aggregateId: task.id,
        taskId: task.id,
        type: 'ci.completed',
        payload: {
          state: result.state,
          summary: result.summary,
          url: result.url,
          provider: result.provider,
        },
      });
      return this.getTaskOrThrow(task.id);
    });
  }

  recordMergeResult(taskId: string, result: MergeResult): Task {
    return this.transaction(() => {
      const task = this.getTaskOrThrow(taskId);
      this.db
        .prepare(
          `INSERT INTO artifacts (id, task_id, run_id, kind, ref, metadata_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          newId('art'),
          task.id,
          null,
          'merge',
          result.url,
          JSON.stringify(result),
          nowIso(),
        );
      this.appendEvent({
        aggregateType: 'task',
        aggregateId: task.id,
        taskId: task.id,
        type: 'merge.completed',
        payload: {
          state: result.state,
          method: result.method,
          actor: result.actor,
          reason: result.reason,
          url: result.url,
        },
      });
      return this.getTaskOrThrow(task.id);
    });
  }

  recordPullRequest(taskId: string, url: string): Task {
    return this.transaction(() => {
      const task = this.getTaskOrThrow(taskId);
      this.db
        .prepare('UPDATE tasks SET pr_url = ?, updated_at = ? WHERE id = ?')
        .run(url, nowIso(), task.id);
      this.db
        .prepare(
          `INSERT INTO artifacts (id, task_id, run_id, kind, ref, metadata_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(newId('art'), task.id, null, 'pr', url, null, nowIso());
      this.appendEvent({
        aggregateType: 'task',
        aggregateId: task.id,
        taskId: task.id,
        type: 'pr.created',
        payload: { url },
      });
      return this.getTaskOrThrow(task.id);
    });
  }

  getLatestReportByRole(taskId: string, role: AgentRole): Report | null {
    const row = this.db
      .prepare(
        `SELECT * FROM reports WHERE task_id = ? AND role = ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(taskId, role) as ReportRow | undefined;
    return row ? toReport(row) : null;
  }

  reconcileStaleRuns(options: ReconcileOptions = {}): LostRun[] {
    const isAlive = options.isAlive ?? isPidAlive;
    const staleAfterMs = options.staleAfterMs ?? 30_000;
    const now = options.now ?? Date.now();

    return this.transaction(() => {
      const lost: LostRun[] = [];
      for (const run of this.listActiveRuns()) {
        let reason: string;
        if (run.pid !== null) {
          if (isAlive(run.pid)) {
            continue;
          }
          reason = `process ${run.pid} is not running`;
        } else {
          const age = now - Date.parse(run.startedAt);
          if (age < staleAfterMs) {
            continue;
          }
          reason = 'run never recorded a pid';
        }

        const endedAt = new Date(now).toISOString();
        this.db
          .prepare(
            `UPDATE runs SET state = 'lost', ended_at = ?
             WHERE id = ? AND state IN ('starting', 'running')`,
          )
          .run(endedAt, run.id);
        this.appendEvent({
          aggregateType: 'run',
          aggregateId: run.id,
          taskId: run.taskId,
          type: 'run.lost',
          payload: { pid: run.pid, reason },
        });

        const task = this.getTaskOrThrow(run.taskId);
        let taskState = task.state;
        if (task.state === 'starting' || task.state === 'running') {
          const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 1));
          const canRequeue =
            options.requeue === true && task.attempts + 1 < maxAttempts;
          if (canRequeue) {
            const delayMs = backoffDelayMs(
              options.backoffMs ?? DEFAULT_BACKOFF_MS,
              task.attempts + 1,
            );
            const requeued = this.requeueTaskLocked(task.id, {
              reason: `Run ${run.id} lost: ${reason}`,
              delayMs,
            });
            taskState = requeued.state;
          } else {
            const failed = this.setTaskState(task, 'failed', 'task.failed', {
              reason: `Run ${run.id} lost: ${reason}`,
            });
            taskState = failed.state;
          }
        }
        lost.push({
          runId: run.id,
          taskId: run.taskId,
          pid: run.pid,
          reason,
          taskState,
        });
      }
      return lost;
    });
  }

  getLease(resource: string): Lease | null {
    const row = this.db
      .prepare('SELECT * FROM leases WHERE resource = ?')
      .get(resource) as LeaseRow | undefined;
    return row ? toLease(row) : null;
  }

  acquireLease(
    resource: string,
    owner: string,
    ttlSeconds: number,
    now = Date.now(),
  ): Lease | null {
    const held = this.getLease(resource);
    if (held) {
      const expired = Date.parse(held.expiresAt) <= now;
      const holderDead = leaseHolderIsDead(held, now);
      if (!expired && !holderDead) {
        return null;
      }
      if (!expired) {
        this.db.prepare('DELETE FROM leases WHERE resource = ?').run(resource);
      }
    }
    const acquiredAt = new Date(now).toISOString();
    const expiresAt = new Date(now + Math.max(1, ttlSeconds) * 1000).toISOString();
    this.db
      .prepare(
        `INSERT INTO leases (resource, owner, acquired_at, expires_at, heartbeat_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(resource) DO UPDATE SET
           owner = excluded.owner,
           acquired_at = excluded.acquired_at,
           expires_at = excluded.expires_at,
           heartbeat_at = excluded.heartbeat_at`,
      )
      .run(resource, owner, acquiredAt, expiresAt, acquiredAt);
    return this.getLease(resource);
  }

  renewLease(
    resource: string,
    owner: string,
    ttlSeconds: number,
    now = Date.now(),
  ): boolean {
    const heartbeatAt = new Date(now).toISOString();
    const expiresAt = new Date(now + Math.max(1, ttlSeconds) * 1000).toISOString();
    const result = this.db
      .prepare(
        `UPDATE leases SET expires_at = ?, heartbeat_at = ?
         WHERE resource = ? AND owner = ?`,
      )
      .run(expiresAt, heartbeatAt, resource, owner);
    return Number(result.changes) > 0;
  }

  releaseLease(resource: string, owner: string): boolean {
    const result = this.db
      .prepare('DELETE FROM leases WHERE resource = ? AND owner = ?')
      .run(resource, owner);
    return Number(result.changes) > 0;
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
      reports: this.listReports(task.id),
      messages: this.listMessages(task.id),
      artifacts: this.listArtifacts(task.id),
      verifications: this.listVerifications(task.id),
      dependencies: this.listDependencies(task.id),
      events: this.listEvents({ taskId: task.id }),
    };
  }
}
