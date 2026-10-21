import { afterEach, describe, expect, it } from 'vitest';
import { applyPlan, parsePlan, validatePlan } from '../../src/app/plan';
import { CrewError } from '../../src/core/errors';
import { Store } from '../../src/store/store';

const stores: Store[] = [];

function createStore(): Store {
  const store = new Store(':memory:');
  stores.push(store);
  return store;
}

function createProject(store: Store): string {
  const project = store.createProject({
    name: 'demo',
    rootPath: '/tmp/demo',
    defaultBranch: 'main',
    remoteUrl: null,
    forge: null,
  });
  return project.id;
}

const PLAN = `
schema: crew.plan/v1
tasks:
  - key: api
    title: Add health endpoint
    brief: Implement GET /health
    acceptance:
      - Returns 200
      - Has an integration test
  - key: docs
    title: Document the endpoint
    brief: Update the README
    acceptance:
      - Mentions the endpoint
    depends_on:
      - api
  - key: ci
    title: Fix the pipeline
    brief: Repair the CI workflow
    depends_on:
      - api
`;

afterEach(() => {
  while (stores.length > 0) {
    stores.pop()?.close();
  }
});

describe('parsePlan', () => {
  it('parses yaml plans with keys, criteria and dependencies', () => {
    const plan = parsePlan(PLAN);
    expect(plan.schema).toBe('crew.plan/v1');
    expect(plan.tasks).toHaveLength(3);
    expect(plan.tasks[0]).toMatchObject({
      key: 'api',
      title: 'Add health endpoint',
      methodology: 'spec',
      acceptance: ['Returns 200', 'Has an integration test'],
    });
    expect(plan.tasks[1]?.dependsOn).toEqual(['api']);
  });

  it('fails on invalid yaml', () => {
    let code = '';
    try {
      parsePlan('tasks: [oops');
    } catch (error) {
      code = error instanceof CrewError ? error.code : 'unknown';
    }
    expect(code).toBe('PLAN_INVALID');
  });
});

describe('validatePlan', () => {
  it('accepts a valid plan and computes the execution groups', () => {
    const validation = validatePlan(parsePlan(PLAN));
    expect(validation.ok).toBe(true);
    expect(validation.errors).toEqual([]);
    expect(validation.groups).toEqual([['api'], ['docs', 'ci']]);
  });

  it('warns when too many tasks would start in parallel', () => {
    const validation = validatePlan(
      parsePlan(`
schema: crew.plan/v1
tasks:
  - key: a
    title: A
    brief: A
  - key: b
    title: B
    brief: B
  - key: c
    title: C
    brief: C
`),
    );
    expect(validation.warnings.join(' ')).toContain('in parallel');
  });

  it('reports missing criteria for spec tasks and unknown dependencies', () => {
    const validation = validatePlan(
      parsePlan(`
schema: crew.plan/v1
tasks:
  - key: a
    title: A
    brief: A
    methodology: spec
    depends_on:
      - missing
`),
    );
    expect(validation.ok).toBe(false);
    expect(validation.errors.join(' ')).toContain('requires acceptance criteria');
    expect(validation.errors.join(' ')).toContain('unknown dependency');
  });

  it('detects dependency cycles', () => {
    const validation = validatePlan(
      parsePlan(`
schema: crew.plan/v1
tasks:
  - key: a
    title: A
    brief: A
    depends_on:
      - b
  - key: b
    title: B
    brief: B
    depends_on:
      - a
`),
    );
    expect(validation.ok).toBe(false);
    expect(validation.errors.join(' ')).toContain('cycle');
  });
});

function markReview(store: Store, taskId: string): void {
  const runId = `run_${Math.random().toString(36).slice(2)}`;
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
  store.markRunRunning(runId, process.pid);
  store.requestReview(taskId);
  store.finishRun({ runId, exitCode: 0, signal: null, timedOut: false });
}

describe('task dependencies', () => {
  it('does not pick a task whose dependency is not finished', () => {
    const store = createStore();
    const projectId = createProject(store);
    const first = store.createTask({
      projectId,
      title: 'First',
      briefText: 'First task',
      deliveryMode: 'local',
      methodology: 'free',
      spec: null,
    });
    const second = store.createTask({
      projectId,
      title: 'Second',
      briefText: 'Second task',
      deliveryMode: 'local',
      methodology: 'free',
      spec: null,
    });
    store.queueTask(first.id);
    store.queueTask(second.id);
    store.addDependency(second.id, first.id);

    expect(store.nextQueuedTask()?.id).toBe(first.id);
    expect(store.unresolvedDependencies(second.id)).toEqual([first.id]);
  });

  it('releases a dependent task when the dependency reaches review', () => {
    const store = createStore();
    const projectId = createProject(store);
    const first = store.createTask({
      projectId,
      title: 'First',
      briefText: 'First task',
      deliveryMode: 'local',
      methodology: 'free',
      spec: null,
    });
    const second = store.createTask({
      projectId,
      title: 'Second',
      briefText: 'Second task',
      deliveryMode: 'local',
      methodology: 'free',
      spec: null,
    });
    store.queueTask(first.id);
    store.queueTask(second.id);
    store.addDependency(second.id, first.id);
    markReview(store, first.id);
    expect(store.getTaskOrThrow(first.id).state).toBe('review');

    expect(store.nextQueuedTask()?.id).toBe(second.id);
    expect(store.unresolvedDependencies(second.id)).toEqual([]);
  });

  it('blocks a dependent task when the dependency fails', () => {
    const store = createStore();
    const projectId = createProject(store);
    const first = store.createTask({
      projectId,
      title: 'First',
      briefText: 'First task',
      deliveryMode: 'local',
      methodology: 'free',
      spec: null,
    });
    const second = store.createTask({
      projectId,
      title: 'Second',
      briefText: 'Second task',
      deliveryMode: 'local',
      methodology: 'free',
      spec: null,
    });
    store.queueTask(first.id);
    store.queueTask(second.id);
    store.addDependency(second.id, first.id);
    store.failTask(first.id, 'boom', { retryable: false });

    const blocked = store.blockTasksWithFailedDependencies();
    expect(blocked).toEqual([second.id]);
    expect(store.getTaskOrThrow(second.id).state).toBe('blocked');
    expect(store.getTaskOrThrow(second.id).lastError).toContain('Dependency failed');
  });
});

describe('applyPlan', () => {
  it('creates the tasks with their dependencies', () => {
    const store = createStore();
    const projectId = createProject(store);
    const result = applyPlan(store, parsePlan(PLAN), { projectId });

    expect(result.tasks).toHaveLength(3);
    expect(result.groups).toEqual([['api'], ['docs', 'ci']]);
    const api = result.tasks.find((task) => task.key === 'api');
    const docs = result.tasks.find((task) => task.key === 'docs');
    expect(api?.state).toBe('draft');
    expect(store.listDependencies(docs?.id as string)).toEqual([api?.id]);
  });

  it('queues the tasks when asked', () => {
    const store = createStore();
    const projectId = createProject(store);
    const result = applyPlan(store, parsePlan(PLAN), { projectId, queue: true });
    expect(result.queued).toBe(true);
    for (const task of result.tasks) {
      expect(store.getTaskOrThrow(task.id).state).toBe('queued');
    }
  });

  it('refuses to apply an invalid plan', () => {
    const store = createStore();
    const projectId = createProject(store);
    let code = '';
    try {
      applyPlan(store, parsePlan('schema: crew.plan/v1\ntasks: []'), { projectId });
    } catch (error) {
      code = error instanceof CrewError ? error.code : 'unknown';
    }
    expect(code).toBe('PLAN_INVALID');
  });
});
