import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { evaluateMerge, mergeTask } from '../../src/app/merge';
import { CrewError } from '../../src/core/errors';
import type { ReportPayload } from '../../src/core/types';
import { Store } from '../../src/store/store';

const stores: Store[] = [];
const rootDirs: string[] = [];

function createStore(): Store {
  const store = new Store(':memory:');
  stores.push(store);
  return store;
}

function createTask(store: Store, deliveryMode: 'local' | 'pr' = 'local'): string {
  const project = store.createProject({
    name: 'demo',
    rootPath: '/tmp/demo',
    defaultBranch: 'main',
    remoteUrl: null,
    forge: null,
  });
  const task = store.createTask({
    projectId: project.id,
    title: 'Merge task',
    briefText: 'Do the thing',
    deliveryMode,
    methodology: 'free',
    spec: null,
  });
  return task.id;
}

function reportPayload(
  taskId: string,
  runId: string,
  overrides: Partial<ReportPayload> = {},
): ReportPayload {
  return {
    schema: 'crew.report/v3',
    task_id: taskId,
    run_id: runId,
    status: 'done',
    summary: 'Done',
    verdict: 'approve',
    ...overrides,
  };
}

function prepareTask(
  store: Store,
  taskId: string,
  options: { verification?: 'passed' | 'failed'; ci?: 'passed' | 'failed' } = {},
): void {
  store.queueTask(taskId);
  const developerRun = `run_dev_${taskId}`;
  store.startRun({
    taskId,
    runId: developerRun,
    attempt: store.nextAttempt(taskId),
    harnessId: 'fake',
    backend: 'process',
    logPath: '/tmp/dev.log',
    worktreePath: '/tmp/worktree',
    branch: 'crew/test',
  });
  store.markRunRunning(developerRun, process.pid);
  store.recordReport(reportPayload(taskId, developerRun, { schema: 'crew.report/v1' }));
  store.recordVerification({
    taskId,
    runId: developerRun,
    command: 'npm test',
    state: options.verification === 'failed' ? 'failed' : 'passed',
    exitCode: options.verification === 'failed' ? 1 : 0,
    signal: null,
    timedOut: false,
    durationMs: 12,
    output: '',
    logPath: '/tmp/verify.log',
  });
  store.finishRun({
    runId: developerRun,
    exitCode: 0,
    signal: null,
    timedOut: false,
    keepTaskRunning: true,
  });

  const testerRun = `run_test_${taskId}`;
  store.startRun({
    taskId,
    runId: testerRun,
    attempt: store.nextAttempt(taskId),
    harnessId: 'fake',
    backend: 'process',
    logPath: '/tmp/tester.log',
    worktreePath: '/tmp/worktree',
    branch: 'crew/test',
    role: 'tester',
    continuePipeline: true,
  });
  store.markRunRunning(testerRun, process.pid);
  store.recordReport(reportPayload(taskId, testerRun, { role: 'tester' }));
  store.finishRun({
    runId: testerRun,
    exitCode: 0,
    signal: null,
    timedOut: false,
    keepTaskRunning: true,
  });
  store.requestReview(taskId);

  if (options.ci) {
    store.recordCiCheck(taskId, {
      provider: 'github_actions',
      state: options.ci,
      summary: `CI ${options.ci}`,
      url: 'https://example.test/ci',
      checks: [],
      durationMs: 10,
    });
  }
}

function authorize(store: Store, taskId: string, authorizedBy = 'captain'): void {
  store.recordReview(taskId, {
    decision: 'accept',
    reason: 'reviewed in the editor',
    bufferPath: '/tmp/review.md',
    authorizedBy,
    diffLines: 12,
  });
}

afterEach(() => {
  while (stores.length > 0) {
    stores.pop()?.close();
  }
  while (rootDirs.length > 0) {
    const dir = rootDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('evaluateMerge', () => {
  it('allows the merge when every gate passes and the captain authorized', () => {
    const store = createStore();
    const taskId = createTask(store);
    prepareTask(store, taskId, { ci: 'passed' });
    authorize(store, taskId);

    const decision = evaluateMerge(store.getTaskDetail(taskId));
    expect(decision.allowed).toBe(true);
    expect(decision.missing).toEqual([]);
    expect(decision.gates.map((gate) => gate.name)).toContain('CI passed');
    expect(decision.authority).toBe('captain');
  });

  it('refuses the merge when nobody authorized it', () => {
    const store = createStore();
    const taskId = createTask(store);
    prepareTask(store, taskId, { ci: 'passed' });

    const decision = evaluateMerge(store.getTaskDetail(taskId));
    expect(decision.allowed).toBe(false);
    expect(decision.missing.join(' ')).toContain('merge authority');
    expect(decision.authority).toBe('captain');
  });

  it('lets the captain merge on its own when the project grants yolo', () => {
    const store = createStore();
    const taskId = createTask(store);
    prepareTask(store, taskId, { ci: 'passed' });

    const decision = evaluateMerge(store.getTaskDetail(taskId), {
      projectConfig: { delivery: { mode: 'no-mistakes', yolo: true } },
    });
    expect(decision.allowed).toBe(true);
    expect(decision.yolo).toBe(true);
    expect(decision.authority).toBe('captain-with-yolo');
  });

  it('never lets yolo merge a high risk change', () => {
    const store = createStore();
    const taskId = createTask(store);
    prepareTask(store, taskId, { ci: 'passed' });
    store.recordChangeStats(taskId, {
      files: 1,
      additions: 4,
      deletions: 0,
      paths: ['src/auth/login.ts'],
    });

    const decision = evaluateMerge(store.getTaskDetail(taskId), {
      projectConfig: { delivery: { mode: 'no-mistakes', yolo: true } },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.missing.join(' ')).toContain('risk authorization');
  });

  it('refuses a merge when CI is configured but no check reported', () => {
    const store = createStore();
    const taskId = createTask(store);
    prepareTask(store, taskId);

    const decision = evaluateMerge(store.getTaskDetail(taskId), {
      projectConfig: { ci: { provider: 'github_actions' } },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.missing.join(' ')).toContain('CI passed');
    expect(decision.missing.join(' ')).toContain('no check has reported');
  });

  it('skips the tester and the verification on the direct-PR path', () => {
    const store = createStore();
    const taskId = createTask(store, 'pr');
    prepareTask(store, taskId, { verification: 'failed', ci: 'passed' });
    authorize(store, taskId);

    const decision = evaluateMerge(store.getTaskDetail(taskId), {
      projectConfig: { delivery: { mode: 'direct-PR' } },
      pr: {
        url: 'https://example.test/pr/1',
        state: 'OPEN',
        merged: false,
        draft: false,
        mergeable: 'MERGEABLE',
      },
    });
    expect(decision.path).toBe('direct-PR');
    expect(decision.gates.map((gate) => gate.name)).not.toContain('tester approved');
    expect(decision.allowed).toBe(true);
  });

  it('blocks the merge when the verification failed', () => {
    const store = createStore();
    const taskId = createTask(store);
    prepareTask(store, taskId, { verification: 'failed' });
    authorize(store, taskId);

    const decision = evaluateMerge(store.getTaskDetail(taskId));
    expect(decision.allowed).toBe(false);
    expect(decision.missing.join(' ')).toContain('verification passed');
  });

  it('blocks the merge when CI failed', () => {
    const store = createStore();
    const taskId = createTask(store);
    prepareTask(store, taskId, { ci: 'failed' });

    const decision = evaluateMerge(store.getTaskDetail(taskId));
    expect(decision.allowed).toBe(false);
    expect(decision.missing.join(' ')).toContain('CI passed');
  });

  it('blocks the merge when the pull request is missing', () => {
    const store = createStore();
    const taskId = createTask(store, 'pr');
    prepareTask(store, taskId);

    const decision = evaluateMerge(store.getTaskDetail(taskId));
    expect(decision.allowed).toBe(false);
    expect(decision.missing.join(' ')).toContain('pull request open');
  });

  it('accepts the merge when the head is still the reviewed commit', () => {
    const store = createStore();
    const taskId = createTask(store);
    prepareTask(store, taskId, { ci: 'passed' });
    authorize(store, taskId);
    store.recordCommit(taskId, 'acadef00');

    const decision = evaluateMerge(store.getTaskDetail(taskId), {
      receipt: { headSha: 'acadef00', source: 'local' },
    });
    expect(decision.allowed).toBe(true);
    expect(decision.receipt).toEqual({ headSha: 'acadef00', source: 'local' });
  });

  it('blocks the merge when the branch moved after the review', () => {
    const store = createStore();
    const taskId = createTask(store);
    prepareTask(store, taskId, { ci: 'passed' });
    authorize(store, taskId);
    store.recordCommit(taskId, 'acadef00');

    const decision = evaluateMerge(store.getTaskDetail(taskId), {
      receipt: { headSha: 'baddcafe', source: 'remote' },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.receipt).toBeNull();
    const missing = decision.missing.join(' ');
    expect(missing).toContain('head matches the reviewed commit');
    expect(missing).toContain('the branch moved after the review');
  });

  it('blocks the merge when the head cannot be verified', () => {
    const store = createStore();
    const taskId = createTask(store);
    prepareTask(store, taskId, { ci: 'passed' });
    authorize(store, taskId);
    store.recordCommit(taskId, 'acadef00');

    const decision = evaluateMerge(store.getTaskDetail(taskId), {
      receipt: { headSha: null, source: 'remote', error: 'no route to host' },
    });
    expect(decision.allowed).toBe(false);
    const missing = decision.missing.join(' ');
    expect(missing).toContain('head matches the reviewed commit');
    expect(missing).toContain('could not be verified');
  });

  it('skips the receipt gate when there is no reviewed commit yet', () => {
    const store = createStore();
    const taskId = createTask(store);
    prepareTask(store, taskId);
    authorize(store, taskId);

    const decision = evaluateMerge(store.getTaskDetail(taskId), {
      receipt: { headSha: 'acadef00', source: 'remote' },
    });
    expect(decision.receipt).toBeNull();
  });
});

function createGitRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'crew-merge-'));
  rootDirs.push(dir);
  const run = (args: string[]) =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  run(['init', '-b', 'main']);
  run(['config', 'user.email', 'crew@test']);
  run(['config', 'user.name', 'crew']);
  writeFileSync(path.join(dir, 'README.md'), 'crew\n');
  run(['add', '.']);
  run(['commit', '-m', 'initial']);
  run(['checkout', '-b', 'crew/test']);
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

describe('mergeTask', () => {
  it('accepts the task and records the authorization', () => {
    const store = createStore();
    const taskId = createTask(store);
    prepareTask(store, taskId);

    const outcome = mergeTask(store, taskId, {
      projectRootPath: '/tmp/demo',
      method: 'squash',
      authorizedBy: 'captain',
      skipMerge: true,
      livePr: false,
      authorization: { authorizedBy: 'captain', reason: 'reviewed' },
    });

    expect(outcome.decision.allowed).toBe(true);
    expect(outcome.accepted).toBe(true);
    expect(outcome.taskState).toBe('done');
    const events = store.listEvents({ taskId });
    const authorization = events.find((event) => event.type === 'task.authorized');
    expect(authorization?.actor).toBe('captain');
    expect(authorization?.payload.action).toBe('merge');
  });

  it('refuses to merge without a captain authorization', () => {
    const store = createStore();
    const taskId = createTask(store);
    prepareTask(store, taskId);

    let code = '';
    let message = '';
    try {
      mergeTask(store, taskId, {
        projectRootPath: '/tmp/demo',
        method: 'squash',
        authorizedBy: 'captain',
        skipMerge: true,
        livePr: false,
      });
    } catch (error) {
      code = error instanceof CrewError ? error.code : 'unknown';
      message = error instanceof Error ? error.message : '';
    }
    expect(code).toBe('MERGE_BLOCKED');
    expect(message).toContain('merge authority');
    expect(store.getTaskOrThrow(taskId).state).toBe('review');
  });

  it('refuses to merge and explains what is missing', () => {
    const store = createStore();
    const taskId = createTask(store);
    prepareTask(store, taskId, { verification: 'failed' });

    let code = '';
    let message = '';
    try {
      mergeTask(store, taskId, {
        projectRootPath: '/tmp/demo',
        method: 'squash',
        authorizedBy: 'captain',
        skipMerge: true,
        livePr: false,
        authorization: { authorizedBy: 'captain', reason: 'reviewed' },
      });
    } catch (error) {
      code = error instanceof CrewError ? error.code : 'unknown';
      message = error instanceof Error ? error.message : '';
    }
    expect(code).toBe('MERGE_BLOCKED');
    expect(message).toContain('verification passed');
    expect(store.getTaskOrThrow(taskId).state).toBe('review');
  });
});

describe('mergeTask receipt with a real repository', () => {
  it('merges when the head is still the reviewed commit', () => {
    const root = createGitRepo();
    const store = createStore();
    const project = store.createProject({
      name: 'repo',
      rootPath: root,
      defaultBranch: 'main',
      remoteUrl: null,
      forge: null,
    });
    const task = store.createTask({
      projectId: project.id,
      title: 'Receipt merge',
      briefText: 'Do the thing',
      deliveryMode: 'local',
      methodology: 'free',
      spec: null,
    });
    prepareTask(store, task.id);
    const sha = git(root, 'rev-parse', 'HEAD');
    store.recordCommit(task.id, sha);
    authorize(store, task.id);

    const outcome = mergeTask(store, task.id, {
      projectRootPath: root,
      method: 'squash',
      authorizedBy: 'captain',
      livePr: false,
      authorization: { authorizedBy: 'captain', reason: 'reviewed' },
    });

    expect(outcome.decision.allowed).toBe(true);
    expect(outcome.decision.receipt).toEqual({ headSha: sha, source: 'local' });
    expect(outcome.accepted).toBe(true);
    expect(outcome.taskState).toBe('done');
  });

  it('blocks the merge when the branch moved and --force skips only the receipt', () => {
    const root = createGitRepo();
    const store = createStore();
    const project = store.createProject({
      name: 'repo',
      rootPath: root,
      defaultBranch: 'main',
      remoteUrl: null,
      forge: null,
    });
    const task = store.createTask({
      projectId: project.id,
      title: 'Receipt drift',
      briefText: 'Do the thing',
      deliveryMode: 'local',
      methodology: 'free',
      spec: null,
    });
    prepareTask(store, task.id);
    const sha = git(root, 'rev-parse', 'HEAD');
    store.recordCommit(task.id, sha);
    authorize(store, task.id);
    git(root, 'commit', '--allow-empty', '-m', 'human fix after the review');
    const drifted = git(root, 'rev-parse', 'HEAD');
    expect(drifted).not.toBe(sha);

    let message = '';
    try {
      mergeTask(store, task.id, {
        projectRootPath: root,
        method: 'squash',
        authorizedBy: 'captain',
        livePr: false,
        authorization: { authorizedBy: 'captain', reason: 'reviewed' },
      });
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }
    expect(message).toContain('head matches the reviewed commit');
    expect(message).toContain('the branch moved after the review');
    expect(store.getTaskOrThrow(task.id).state).toBe('review');

    const forced = mergeTask(store, task.id, {
      projectRootPath: root,
      method: 'squash',
      authorizedBy: 'captain',
      livePr: false,
      force: true,
      authorization: { authorizedBy: 'captain', reason: 'reviewed again' },
    });
    expect(forced.decision.allowed).toBe(true);
    expect(forced.decision.receipt).toBeNull();
    expect(forced.decision.gates.map((gate) => gate.name)).not.toContain(
      'head matches the reviewed commit',
    );
    expect(forced.accepted).toBe(true);
  });
});
