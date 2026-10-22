import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
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

  it('full-text searches memory by relevance', () => {
    const store = createStore();
    const projectId = createProject(store);
    store.addMemory({
      projectId,
      kind: 'pitfall',
      title: 'pnpm version',
      body: 'pnpm 9 breaks the build; pin pnpm 8.',
    });
    store.addMemory({
      projectId,
      kind: 'convention',
      title: 'Tests',
      body: 'The project runs vitest, npm is banned: pnpm everywhere else.',
    });
    store.addMemory({
      projectId,
      kind: 'context',
      title: 'Deploy',
      body: 'Deploy happens via wrangler only.',
    });

    const hits = store.searchMemories('pnpm', { projectId });
    expect(hits).toHaveLength(2);
    expect(hits[0]?.title).toBe('pnpm version');

    expect(store.searchMemories('wrangler', { projectId })).toHaveLength(1);
    expect(store.searchMemories('nada', { projectId })).toHaveLength(0);
    expect(store.searchMemories('', { projectId })).toHaveLength(0);
    expect(store.searchMemories('pnpm', { projectId, kind: 'pitfall' })).toHaveLength(1);
    expect(store.searchMemories('pnpm', { projectId: 'prj_none' })).toHaveLength(0);
  });

  it('searches across projects when none is given', () => {
    const store = createStore();
    const projectId = createProject(store);
    store.addMemory({
      projectId,
      kind: 'context',
      title: 'Lint',
      body: 'eslint strict mode everywhere.',
    });
    const results = store.searchMemories('eslint');
    expect(results).toHaveLength(1);
    expect(results[0]?.projectId).toBe(projectId);
  });

  it('is tolerant to query punctuation', () => {
    const store = createStore();
    const projectId = createProject(store);
    store.addMemory({
      projectId,
      kind: 'decision',
      title: 'Node version',
      body: 'Pin node to 22.',
    });
    expect(store.searchMemories('(node): 22', { projectId })).toHaveLength(1);
  });

  it('backfills the index for a database created before the FTS migration', () => {
    const dbPath = path.join(tmpdir(), `crew-fts-${Date.now()}.db`);
    fs.rmSync(dbPath, { force: true });
    const store = new Store(dbPath);
    const projectId = createProject(store);
    store.addMemory({
      projectId,
      kind: 'context',
      title: 'Old memory',
      body: 'written before the search existed.',
    });
    // simulate a database from before the FTS migration
    store.close();
    const raw = new DatabaseSync(dbPath);
    raw.exec('DROP TRIGGER IF EXISTS memories_fts_ai');
    raw.exec('DROP TRIGGER IF EXISTS memories_fts_ad');
    raw.exec('DROP TABLE memories_fts');
    raw.exec('DELETE FROM schema_migrations WHERE version >= 7');
    raw.close();

    const reopened = new Store(dbPath);
    try {
      expect(reopened.schemaVersion()).toBe(7);
      const hits = reopened.searchMemories('search existed', { projectId });
      expect(hits).toHaveLength(1);
      expect(hits[0]?.title).toBe('Old memory');
    } finally {
      reopened.close();
      fs.rmSync(dbPath, { force: true });
    }
  });
});
