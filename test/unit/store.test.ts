import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { newId } from '../../src/core/ids';
import type { ReportPayload, TaskSpec } from '../../src/core/types';
import { Store } from '../../src/store/store';

const tempDirs: string[] = [];

const stores: Store[] = [];

function createStore(): Store {
  const store = new Store(':memory:');
  stores.push(store);
  return store;
}

function createTask(store: Store) {
  const project = store.createProject({
    name: 'demo',
    rootPath: '/tmp/demo',
    defaultBranch: 'main',
    remoteUrl: null,
    forge: null,
  });
  return {
    project,
    task: store.createTask({
      projectId: project.id,
      title: 'Test task',
      briefText: 'Do the thing',
      deliveryMode: 'local',
      methodology: 'free',
      spec: null,
    }),
  };
}

const exampleSpec: TaskSpec = {
  schema: 'crew.spec/v1',
  goal: 'Do the thing',
  acceptance_criteria: [
    { id: 'AC1', text: 'The thing exists' },
    { id: 'AC2', text: 'The thing is verified' },
  ],
};

function createSpecTask(store: Store, methodology: 'spec' | 'tdd') {
  const project = store.createProject({
    name: `demo-${methodology}`,
    rootPath: `/tmp/demo-${methodology}`,
    defaultBranch: 'main',
    remoteUrl: null,
    forge: null,
  });
  return store.createTask({
    projectId: project.id,
    title: 'Spec task',
    briefText: 'Do the thing',
    deliveryMode: 'local',
    methodology,
    spec: exampleSpec,
  });
}

function startRun(store: Store, taskId: string) {
  const runId = newId('run');
  store.startRun({
    taskId,
    runId,
    attempt: store.nextAttempt(taskId),
    harnessId: 'fake',
    backend: 'process',
    logPath: '/tmp/demo.log',
    worktreePath: '/tmp/worktree',
    branch: 'crew/test',
  });
  return runId;
}

function reportFor(taskId: string, runId: string): ReportPayload {
  return {
    schema: 'crew.report/v1',
    task_id: taskId,
    run_id: runId,
    status: 'done',
    summary: 'Done',
    tests: [{ command: 'test', status: 'passed' }],
    artifacts: [{ kind: 'commit', ref: 'abc123' }],
  };
}

afterEach(() => {
  while (stores.length > 0) {
    stores.pop()?.close();
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('store', () => {
  it('creates a project and task with events', () => {
    const store = createStore();
    const { task } = createTask(store);
    expect(task.state).toBe('draft');
    expect(task.lastSeq).toBeGreaterThan(0);
    expect(store.listEvents({ taskId: task.id }).map((event) => event.type)).toEqual([
      'task.created',
    ]);
  });

  it('runs a task to done and stores a report', () => {
    const store = createStore();
    const { task } = createTask(store);
    const runId = startRun(store, task.id);
    expect(store.getTask(task.id)?.state).toBe('running');
    expect(store.getActiveRun(task.id)?.id).toBe(runId);

    store.markRunRunning(runId, process.pid);
    const report = store.recordReport(reportFor(task.id, runId));
    expect(report.status).toBe('done');
    expect(store.getTask(task.id)?.state).toBe('done');
    expect(store.listArtifacts(task.id)).toHaveLength(1);

    const finalTask = store.finishRun({
      runId,
      exitCode: 0,
      signal: null,
      timedOut: false,
    });
    expect(finalTask.state).toBe('done');
    expect(store.getRun(runId)?.state).toBe('exited');
  });

  it('marks a run failed when the agent exits without a report', () => {
    const store = createStore();
    const { task } = createTask(store);
    const runId = startRun(store, task.id);
    const finalTask = store.finishRun({
      runId,
      exitCode: 0,
      signal: null,
      timedOut: false,
    });
    expect(finalTask.state).toBe('failed');
    expect(finalTask.finishedAt).not.toBeNull();
  });

  it('supports needs_input and a second attempt', () => {
    const store = createStore();
    const { task } = createTask(store);
    const runId = startRun(store, task.id);
    store.recordReport({
      schema: 'crew.report/v1',
      task_id: task.id,
      run_id: runId,
      status: 'needs_input',
      summary: 'Need a decision',
      questions: [{ id: 'q1', text: 'Which option?', blocking: true }],
    });
    store.finishRun({ runId, exitCode: 0, signal: null, timedOut: false });
    expect(store.getTask(task.id)?.state).toBe('waiting_input');

    const answered = store.answerTask(task.id, 'Use option A');
    expect(answered.state).toBe('queued');
    expect(store.listMessages(task.id).some((message) => message.body === 'Use option A')).toBe(
      true,
    );

    const secondRun = startRun(store, task.id);
    store.recordReport(reportFor(task.id, secondRun));
    const done = store.finishRun({
      runId: secondRun,
      exitCode: 0,
      signal: null,
      timedOut: false,
    });
    expect(done.state).toBe('done');
    expect(store.listRuns(task.id)).toHaveLength(2);
  });

  it('rejects invalid transitions and terminal reports', () => {
    const store = createStore();
    const { task } = createTask(store);
    const runId = startRun(store, task.id);
    store.recordReport(reportFor(task.id, runId));
    store.finishRun({ runId, exitCode: 0, signal: null, timedOut: false });
    expect(() => store.answerTask(task.id, 'too late')).toThrow('expected waiting_input');
  });

  it('persists methodology and spec', () => {
    const store = createStore();
    const task = createSpecTask(store, 'spec');
    const loaded = store.getTaskOrThrow(task.id);
    expect(loaded.methodology).toBe('spec');
    expect(loaded.spec?.acceptance_criteria.map((criterion) => criterion.id)).toEqual([
      'AC1',
      'AC2',
    ]);
  });

  it('rejects incomplete acceptance evidence for spec tasks', () => {
    const store = createStore();
    const task = createSpecTask(store, 'spec');
    const runId = startRun(store, task.id);
    expect(() =>
      store.recordReport({
        schema: 'crew.report/v2',
        task_id: task.id,
        run_id: runId,
        methodology: 'spec',
        status: 'done',
        summary: 'Done',
        acceptance: [
          { criterion_id: 'AC1', status: 'passed', evidence: 'test/ac1.test.ts' },
        ],
      }),
    ).toThrow('Missing acceptance evidence for: AC2');
    expect(store.getTaskOrThrow(task.id).state).toBe('running');
  });

  it('accepts complete evidence and enforces tdd phases', () => {
    const store = createStore();
    const task = createSpecTask(store, 'tdd');
    const runId = startRun(store, task.id);
    const acceptance = [
      { criterion_id: 'AC1', status: 'passed' as const, evidence: 'test/ac1.test.ts' },
      { criterion_id: 'AC2', status: 'passed' as const, evidence: 'test/ac2.test.ts' },
    ];
    expect(() =>
      store.recordReport({
        schema: 'crew.report/v2',
        task_id: task.id,
        run_id: runId,
        methodology: 'tdd',
        status: 'done',
        summary: 'Done',
        acceptance,
        tests: [{ command: 'pnpm test', status: 'passed', phase: 'green' }],
      }),
    ).toThrow('phases: red');

    const report = store.recordReport({
      schema: 'crew.report/v2',
      task_id: task.id,
      run_id: runId,
      methodology: 'tdd',
      status: 'done',
      summary: 'Done',
      acceptance,
      tests: [
        { command: 'pnpm test', status: 'failed', phase: 'red' },
        { command: 'pnpm test', status: 'passed', phase: 'green' },
      ],
    });
    expect(report.status).toBe('done');
    expect(store.getTaskOrThrow(task.id).state).toBe('done');
  });

  it('migrates a phase 0 database in place', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'crew-migrate-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'crew.db');
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations (version, applied_at) VALUES (1, '2026-01-01T00:00:00.000Z');
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        slug TEXT NOT NULL,
        brief_text TEXT NOT NULL,
        state TEXT NOT NULL,
        delivery_mode TEXT NOT NULL DEFAULT 'local',
        base_branch TEXT NOT NULL,
        branch TEXT,
        worktree_path TEXT,
        harness_id TEXT,
        priority INTEGER NOT NULL DEFAULT 0,
        last_seq INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT
      );
    `);
    legacy.close();

    const store = new Store(dbPath);
    stores.push(store);
    expect(store.schemaVersion()).toBe(2);
    const project = store.createProject({
      name: 'legacy',
      rootPath: '/tmp/legacy',
      defaultBranch: 'main',
      remoteUrl: null,
      forge: null,
    });
    const task = store.createTask({
      projectId: project.id,
      title: 'Legacy task',
      briefText: 'Do it',
      deliveryMode: 'local',
      methodology: 'free',
      spec: null,
    });
    expect(task.methodology).toBe('free');
    expect(task.spec).toBeNull();
  });
});
