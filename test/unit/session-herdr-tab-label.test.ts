import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HerdrBackend } from '../../src/app/session/herdr';
import { createFakeHerdr, type FakeHerdr } from './fake-herdr';
import { cleanupDirs, startInteractive, tempDir } from './session-herdr-fixture';

afterEach(cleanupDirs);

const TASK = 'tsk_01M6VCD1QSK57YAKYTPG9M55G6';

/** The crew tab is announced by the backend; the workspace also has its own root tab. */
function createdTab(events: string[]): string {
  return events.find((m) => m.startsWith('herdr tab created:'))?.split(' ')[3] ?? '';
}

function tabLabel(fake: FakeHerdr, tabId: string): string | undefined {
  return fake.tabs.find((tab) => tab.tab_id === tabId)?.label;
}

function setup(): { dir: string; worktree: string; reportPath: string; fake: FakeHerdr } {
  const dir = tempDir();
  const worktree = path.join(dir, 'worktree');
  return {
    dir,
    worktree,
    reportPath: path.join(worktree, '.crew', 'reports', 'run_1.json'),
    fake: createFakeHerdr(),
  };
}

describe('Herdr tab labels', () => {
  it('labels the task layout tab with the task title', () => {
    const { dir, worktree, reportPath, fake } = setup();
    const backend = new HerdrBackend(path.join(dir, 'state'), fake.run);
    const events: string[] = [];

    expect(
      startInteractive(backend, {
        name: 'crew-run1-dev',
        worktree,
        reportPath,
        taskId: TASK,
        role: 'developer',
        taskTitle: 'Tab de Herdr con el título de la tarea',
        onEvent: (message) => events.push(message),
      }).ok,
    ).toBe(true);

    expect(tabLabel(fake, createdTab(events))).toBe('Tab de Herdr con el título de la tarea');
  });

  it('truncates a long task title to 60 characters', () => {
    const { dir, worktree, reportPath, fake } = setup();
    const backend = new HerdrBackend(path.join(dir, 'state'), fake.run);
    const events: string[] = [];

    expect(
      startInteractive(backend, {
        name: 'crew-run1-dev',
        worktree,
        reportPath,
        taskId: TASK,
        role: 'developer',
        taskTitle: 'X'.repeat(90),
        onEvent: (message) => events.push(message),
      }).ok,
    ).toBe(true);

    const label = tabLabel(fake, createdTab(events));
    expect(label).toBe('X'.repeat(60));
    expect(label?.length).toBeLessThanOrEqual(60);
  });

  it('labels a single-role tab with the title and the short role', () => {
    const { dir, worktree, reportPath, fake } = setup();
    const backend = new HerdrBackend(path.join(dir, 'state'), fake.run);
    const events: string[] = [];

    // A tester with no developer layout yet gets its own tab.
    expect(
      startInteractive(backend, {
        name: 'crew-run1-test',
        worktree,
        reportPath,
        taskId: TASK,
        role: 'tester',
        taskTitle: 'Revisar el parser',
        onEvent: (message) => events.push(message),
      }).ok,
    ).toBe(true);

    expect(tabLabel(fake, createdTab(events))).toBe('Revisar el parser · test');
  });

  it('keeps the session name as label when the task has no title', () => {
    const { dir, worktree, reportPath, fake } = setup();
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

    expect(tabLabel(fake, createdTab(events))).toBe('crew-run1-dev');
    // The state file keeps the session name: it is the handle of the run.
    expect(existsSync(path.join(dir, 'state', 'crew-run1-dev.json'))).toBe(true);
  });
});
