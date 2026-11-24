import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HerdrBackend } from '../../src/app/session/herdr';
import {
  layoutGeometryMatches,
  readTaskLayout,
} from '../../src/app/session/layout';
import { createFakeHerdr } from './fake-herdr';
import { cleanupDirs, report, startInteractive, tempDir } from './session-herdr-fixture';

afterEach(cleanupDirs);

const TASK = 'tsk_01M6VCD1QSK57YAKYTPG9M55G6';

/** The crew tab is announced by the backend; the workspace also has its own root tab. */
function createdTab(events: string[]): string {
  return events.find((m) => m.startsWith('herdr tab created:'))?.split(' ')[3] ?? '';
}

describe('Herdr task layout (3 panes per task)', () => {
  it('creates ONE tab with two splits (--no-focus) when the developer starts', () => {
    const dir = tempDir();
    const worktree = path.join(dir, 'worktree');
    const reportPath = path.join(worktree, '.crew', 'reports', 'run_1.json');
    const fake = createFakeHerdr();
    const backend = new HerdrBackend(path.join(dir, 'state'), fake.run);
    const events: string[] = [];

    const started = startInteractive(backend, {
      name: `crew-run1-dev`,
      worktree,
      reportPath,
      taskId: TASK,
      role: 'developer',
      onEvent: (message) => events.push(message),
    });

    expect(started.ok).toBe(true);
    // The workspace's own tab is reused, so no second (empty) tab is created.
    expect(fake.calls.filter((call) => call[0] === 'tab' && call[1] === 'create')).toHaveLength(0);
    const tabId = createdTab(events);
    expect(new Set(fake.tabs.map((tab) => tab.tab_id))).toEqual(new Set([tabId]));
    const panes = fake.tabs.filter((tab) => tab.tab_id === tabId);
    expect(panes).toHaveLength(3);
    const splits = fake.calls.filter((call) => call[0] === 'pane' && call[1] === 'split');
    expect(splits.map((call) => call[call.indexOf('--direction') + 1])).toEqual(['right', 'down']);
    for (const split of splits) {
      expect(split).toContain('--no-focus');
      expect(split[split.indexOf('--cwd') + 1]).toBe(worktree);
    }
    // The developer agent runs in the root pane of the tab.
    const agent = fake.calls.find((call) => call[0] === 'agent' && call[1] === 'start');
    expect(agent?.[agent.indexOf('--pane') + 1]).toBe(panes[0]?.pane_id);
  });

  it('records the layout with the three pane ids', () => {
    const dir = tempDir();
    const worktree = path.join(dir, 'worktree');
    const reportPath = path.join(worktree, '.crew', 'reports', 'run_1.json');
    const fake = createFakeHerdr();
    const backend = new HerdrBackend(path.join(dir, 'state'), fake.run);
    const events: string[] = [];

    expect(
      startInteractive(backend, {
        name: 'crew-run1-dev',
        worktree,
        reportPath,
        taskId: TASK,
        role: 'developer',
        onEvent: (message) => events.push(message),
      }).ok,
    ).toBe(true);

    const layout = readTaskLayout(path.join(dir, 'state'), TASK);
    expect(layout?.schema).toBe('crew.herdr-layout/v1');
    expect(layout?.tabId).toBe(createdTab(events));
    expect(layout?.developerPaneId).toBe(
      fake.tabs.find((tab) => tab.tab_id === layout?.tabId)?.pane_id,
    );
    const splitPanes = fake.tabs
      .filter((tab) => tab.tab_id === layout?.tabId)
      .map((tab) => tab.pane_id)
      .slice(1);
    expect(layout?.reviewerPaneId).toBe(splitPanes[0]);
    expect(layout?.testerPaneId).toBe(splitPanes[1]);
  });

  it('the tester reuses the same tab and takes the bottom-left pane', () => {
    const dir = tempDir();
    const worktree = path.join(dir, 'worktree');
    const reportPath = path.join(worktree, '.crew', 'reports', 'run_1.json');
    const fake = createFakeHerdr();
    const backend = new HerdrBackend(path.join(dir, 'state'), fake.run);
    const start = (name: string, role: string, report: string): boolean =>
      startInteractive(backend, {
        name,
        worktree,
        reportPath: report,
        taskId: TASK,
        role,
      }).ok;

    expect(start('crew-run1-dev', 'developer', reportPath)).toBe(true);
    const tabCreations = fake.calls.filter((call) => call[0] === 'tab' && call[1] === 'create');

    expect(start('crew-run1-test', 'tester', path.join(worktree, '.crew', 'reports', 'run_2.json'))).toBe(true);

    // No new tab for the tester run.
    expect(fake.calls.filter((call) => call[0] === 'tab' && call[1] === 'create')).toHaveLength(
      tabCreations.length,
    );
    const agent = fake.calls
      .filter((call) => call[0] === 'agent' && call[1] === 'start')
      .pop();
    const layout = readTaskLayout(path.join(dir, 'state'), TASK);
    expect(agent?.[agent.indexOf('--pane') + 1]).toBe(layout?.testerPaneId);
  });

  it('falls back to one tab per run when the layout tab is gone', () => {
    const dir = tempDir();
    const worktree = path.join(dir, 'worktree');
    const reportPath = path.join(worktree, '.crew', 'reports', 'run_1.json');
    const fake = createFakeHerdr();
    const backend = new HerdrBackend(path.join(dir, 'state'), fake.run);
    const events: string[] = [];

    expect(
      startInteractive(backend, {
        name: 'crew-run1-dev',
        worktree,
        reportPath,
        taskId: TASK,
        role: 'developer',
        onEvent: (message) => events.push(message),
      }).ok,
    ).toBe(true);
    // Simulate the tab being closed outside the session lifecycle.
    const tabId = createdTab(events);
    fake.tabs = fake.tabs.filter((tab) => tab.tab_id !== tabId);

    const started = startInteractive(backend, {
      name: 'crew-run2-dev',
      worktree,
      reportPath,
      taskId: TASK,
      role: 'developer',
    });
    expect(started.ok).toBe(true);
    // The workspace survived with no tabs, so crew adds one tab there instead
    // of creating a duplicate workspace (or an empty first tab).
    expect(fake.calls.filter((call) => call[0] === 'workspace' && call[1] === 'create')).toHaveLength(1);
    expect(fake.calls.filter((call) => call[0] === 'tab' && call[1] === 'create')).toHaveLength(1);
  });

  it('a graceful finish keeps the tab; killing the last run closes it and the layout', async () => {
    const dir = tempDir();
    const worktree = path.join(dir, 'worktree');
    const reportPath = path.join(worktree, '.crew', 'reports', 'run_1.json');
    const fake = createFakeHerdr({
      promptBehavior: 'report',
      reportPath,
      report: report(),
    });
    const backend = new HerdrBackend(path.join(dir, 'state'), fake.run);
    const events: string[] = [];

    expect(
      startInteractive(backend, {
        name: 'crew-run1-dev',
        worktree,
        reportPath,
        taskId: TASK,
        role: 'developer',
        onEvent: (message) => events.push(message),
      }).ok,
    ).toBe(true);
    const result = await backend.wait('crew-run1-dev', { timeoutMs: 2000, pollMs: 100 });
    expect(result.exitCode).toBe(0);
    const tabId = createdTab(events);
    expect(fake.tabs.some((tab) => tab.tab_id === tabId)).toBe(true);
    expect(readTaskLayout(path.join(dir, 'state'), TASK)).not.toBeNull();

    // A later non-graceful kill of the task's last run tears it all down.
    expect(
      startInteractive(backend, {
        name: 'crew-run2-dev',
        worktree,
        reportPath,
        taskId: TASK,
        role: 'developer',
      }).ok,
    ).toBe(true);
    backend.kill('crew-run2-dev');
    expect(fake.tabs.some((tab) => tab.tab_id === tabId)).toBe(false);
    expect(readTaskLayout(path.join(dir, 'state'), TASK)).toBeNull();
  });

  it('verifies the observed geometry of the 3-pane layout', () => {
    const layout = {
      developerPaneId: 'dev',
      testerPaneId: 'test',
      reviewerPaneId: 'review',
    };
    expect(
      layoutGeometryMatches(
        [
          { pane_id: 'dev', rect: { x: 0, y: 0, width: 79, height: 24 } },
          { pane_id: 'test', rect: { x: 0, y: 24, width: 79, height: 23 } },
          { pane_id: 'review', rect: { x: 79, y: 0, width: 78, height: 47 } },
        ],
        layout,
      ),
    ).toBe(true);
    // A reviewer limited to the bottom row is not the requested geometry.
    expect(
      layoutGeometryMatches(
        [
          { pane_id: 'dev', rect: { x: 0, y: 0, width: 157, height: 24 } },
          { pane_id: 'test', rect: { x: 0, y: 24, width: 79, height: 23 } },
          { pane_id: 'review', rect: { x: 79, y: 24, width: 78, height: 23 } },
        ],
        layout,
      ),
    ).toBe(false);
    expect(layoutGeometryMatches([], layout)).toBe(false);
  });
});
