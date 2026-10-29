import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../../src/store/store';

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }
});

function createStore(): Store {
  const store = new Store(':memory:');
  stores.push(store);
  return store;
}

const projectsByStore = new WeakMap<Store, ReturnType<Store['createProject']>>();

function createTask(store: Store) {
  let project = projectsByStore.get(store);
  if (!project) {
    project = store.createProject({
      name: 'demo',
      rootPath: '/tmp/demo',
      defaultBranch: 'main',
      remoteUrl: null,
      forge: null,
    });
    projectsByStore.set(store, project);
  }
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

describe('recordReviewRoute', () => {
  it('stores the else-free route of a task as artifact and event', () => {
    const store = createStore();
    const { task } = createTask(store);
    const skipped = store.recordReviewRoute(task.id, {
      route: 'skipped',
      reason: 'pre-commit risk is low',
      mode: 'proportionate',
      risk: { level: 'low', score: 0, reasons: ['small change'], change: { files: 1, additions: 2, deletions: 0, paths: ['a.ts'] } },
    });
    expect(skipped.lastSeq).toBeGreaterThan(0);
    const stored = store.listArtifacts(task.id);
    const route = stored.filter((artifact) => artifact.kind === 'review_route');
    expect(route).toHaveLength(1);
    expect(route[0]?.metadata).toMatchObject({ route: 'skipped', reason: 'pre-commit risk is low', mode: 'proportionate' });
    expect(stored.filter((artifact) => artifact.kind === 'change')).toHaveLength(0);

    const tested = store.recordReviewRoute(task.id, {
      route: 'tester',
      reason: 'mode is full',
      mode: 'full',
      risk: null,
    });
    expect(tested.lastSeq).toBeGreaterThan(skipped.lastSeq);
    expect(store.listArtifacts(task.id).filter((artifact) => artifact.kind === 'review_route')).toHaveLength(2);
  });
});

describe('reviewMetrics', () => {
  it('counts only the last route of each task and averages run durations', () => {
    const store = createStore();
    const { task } = createTask(store);
    store.recordReviewRoute(task.id, {
      route: 'tester',
      reason: 'ok',
      mode: 'proportionate',
      risk: null,
    });
    store.recordReviewRoute(task.id, {
      route: 'skipped',
      reason: 'pre-commit risk is low',
      mode: 'proportionate',
      risk: null,
    });

    const other = createTask(store);
    store.recordReviewRoute(other.task.id, {
      route: 'tester',
      reason: 'route taker',
      mode: 'proportionate',
      risk: null,
    });

    expect(store.reviewMetrics().testerRunsSaved).toBe(1);
    expect(store.reviewMetrics().routes).toEqual({ tester: 1, skipped: 1 });
  });

  it('returns zeroed metrics without routes or runs', () => {
    const store = createStore();
    expect(store.reviewMetrics()).toEqual({
      routes: { tester: 0, skipped: 0 },
      testerRunsSaved: 0,
      avgRunDurationMs: { developer: null, tester: null },
    });
  });
});
