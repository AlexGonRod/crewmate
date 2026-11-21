import { describe, expect, it } from 'vitest';
import { focusAttentionTask } from '../../src/app/session/focus';
import { HerdrBackend } from '../../src/app/session/herdr';
import { createFakeHerdr } from './fake-herdr';
import {
  stubBackend,
  task,
  tempDir,
  writeLayout,
  writeState,
} from './session-focus-fixture';

describe('focus the task that needs attention', () => {
  it('focuses the tab recorded in the task layout', () => {
    const stateDir = tempDir();
    writeLayout(stateDir, 'tsk_2', 'tab_attention');
    const { backend, calls } = stubBackend({ session: 'crew-tsk_2-developer' });

    const outcome = focusAttentionTask(
      [task('tsk_2', 'review', '2026-01-05T10:00:00.000Z')],
      backend,
      stateDir,
    );

    expect(outcome).toEqual({
      focused: true,
      taskId: 'tsk_2',
      session: 'crew-tsk_2-developer',
      tabId: 'tab_attention',
      reason: 'attention',
    });
    expect(calls).toEqual(['tab:tab_attention']);
  });

  it('falls back to the task session when the layout is gone', () => {
    const stateDir = tempDir();
    const { backend, calls } = stubBackend({
      session: 'crew-tsk_3-developer',
      states: {
        'crew-tsk_3-developer': {
          mode: 'interactive',
          tabId: 'tab_session',
          workspaceId: 'w3',
          taskId: 'tsk_3',
        },
      },
    });

    const outcome = focusAttentionTask(
      [task('tsk_3', 'waiting_input', '2026-01-05T10:00:00.000Z')],
      backend,
      stateDir,
    );

    expect(outcome).toMatchObject({
      focused: true,
      tabId: 'tab_session',
      reason: 'attention',
    });
    expect(calls).toEqual(['tab:tab_session']);
  });

  it('reports no-attention without touching Herdr', () => {
    const stateDir = tempDir();
    const { backend, calls } = stubBackend();
    expect(
      focusAttentionTask(
        [task('tsk_4', 'running', '2026-01-05T10:00:00.000Z')],
        backend,
        stateDir,
      ),
    ).toEqual({
      focused: false,
      taskId: null,
      session: null,
      tabId: null,
      reason: 'no-attention',
    });
    expect(calls).toEqual([]);
  });

  it('reports no-session when the task has no layout and no session', () => {
    const stateDir = tempDir();
    const { backend } = stubBackend();
    expect(
      focusAttentionTask(
        [task('tsk_5', 'blocked', '2026-01-05T10:00:00.000Z')],
        backend,
        stateDir,
      ),
    ).toMatchObject({ focused: false, taskId: 'tsk_5', reason: 'no-session' });
  });
});

describe('Herdr backend focus primitives', () => {
  it('reads the focusable state recorded for a session', () => {
    const stateDir = tempDir();
    writeState(stateDir, 'crew-tsk_6-developer', {
      mode: 'interactive',
      workspaceId: 'w6',
      paneId: 'p6',
      tabId: 'tab_6',
      taskId: 'tsk_6',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const backend = new HerdrBackend(stateDir, createFakeHerdr().run);

    expect(backend.sessionState('crew-tsk_6-developer')).toEqual({
      mode: 'interactive',
      tabId: 'tab_6',
      workspaceId: 'w6',
      taskId: 'tsk_6',
    });
    expect(backend.sessionState('crew-missing')).toBeNull();
  });

  it('runs herdr tab focus and herdr workspace focus', () => {
    const stateDir = tempDir();
    const fake = createFakeHerdr();
    const calls: string[][] = [];
    const backend = new HerdrBackend(stateDir, (args) => {
      if ((args[0] === 'tab' || args[0] === 'workspace') && args[1] === 'focus') {
        calls.push(args);
        return { ok: true, stdout: '{}', stderr: '', json: { ok: true } };
      }
      return fake.run(args);
    });

    expect(backend.focusTab('tab_1')).toBe(true);
    expect(backend.focusWorkspace('w1')).toBe(true);
    expect(calls).toEqual([
      ['tab', 'focus', 'tab_1'],
      ['workspace', 'focus', 'w1'],
    ]);
  });

  it('finds the session recorded for a task', () => {
    const stateDir = tempDir();
    writeState(stateDir, 'crew-tsk_7-developer', {
      mode: 'interactive',
      workspaceId: 'w7',
      paneId: 'p7',
      tabId: 'tab_7',
      taskId: 'tsk_7',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    writeState(stateDir, 'crew-tsk_7-batch', {
      mode: 'batch',
      workspaceId: 'w8',
      paneId: 'p8',
      taskId: 'tsk_7',
      createdAt: '2026-01-02T00:00:00.000Z',
    });
    const backend = new HerdrBackend(stateDir, createFakeHerdr().run);

    expect(backend.sessionForTask('tsk_7')).toBe('crew-tsk_7-developer');
    expect(backend.sessionForTask('tsk_nope')).toBeNull();
  });
});
