import { afterEach, describe, expect, it } from 'vitest';
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

afterEach(() => {
  while (stores.length > 0) {
    stores.pop()?.close();
  }
});

describe('project memory', () => {
  it('stores and lists memories by project', () => {
    const store = createStore();
    const projectId = createProject(store);
    const other = store.createProject({
      name: 'other',
      rootPath: '/tmp/other',
      defaultBranch: 'main',
      remoteUrl: null,
      forge: null,
    });

    const memory = store.addMemory({
      projectId,
      kind: 'convention',
      title: 'Use pnpm',
      body: 'The project uses pnpm, never npm install.',
      source: 'user',
    });

    expect(memory.projectId).toBe(projectId);
    expect(memory.source).toBe('user');
    expect(store.listMemories(projectId)).toHaveLength(1);
    expect(store.listMemories(other.id)).toHaveLength(0);
    expect(store.getMemory(memory.id)?.title).toBe('Use pnpm');
  });

  it('filters memories by kind', () => {
    const store = createStore();
    const projectId = createProject(store);
    store.addMemory({
      projectId,
      kind: 'convention',
      title: 'A',
      body: 'a',
    });
    store.addMemory({
      projectId,
      kind: 'pitfall',
      title: 'B',
      body: 'b',
    });

    expect(store.listMemories(projectId, { kind: 'pitfall' })).toHaveLength(1);
    expect(store.listMemories(projectId, { kind: 'pitfall' })[0]?.title).toBe('B');
  });

  it('rejects empty titles and bodies', () => {
    const store = createStore();
    const projectId = createProject(store);
    for (const input of [
      { kind: 'context' as const, title: '  ', body: 'body' },
      { kind: 'context' as const, title: 'title', body: '  ' },
    ]) {
      let code = '';
      try {
        store.addMemory({ projectId, ...input });
      } catch (error) {
        code = error instanceof CrewError ? error.code : 'unknown';
      }
      expect(code).toBe('INVALID_MEMORY');
    }
  });

  it('removes a memory and records the event', () => {
    const store = createStore();
    const projectId = createProject(store);
    const memory = store.addMemory({
      projectId,
      kind: 'decision',
      title: 'Decision',
      body: 'body',
    });

    expect(store.deleteMemory(memory.id)).toBe(true);
    expect(store.deleteMemory(memory.id)).toBe(false);
    expect(store.listMemories(projectId)).toHaveLength(0);
    const types = store.listEvents().map((event) => event.type);
    expect(types).toContain('memory.added');
    expect(types).toContain('memory.removed');
  });
});
