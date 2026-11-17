import { describe, expect, it } from 'vitest';
import { CrewError } from '../../src/core/errors';
import {
  focusSession,
  selectAttentionTask,
} from '../../src/app/session/focus';
import { stubBackend, task } from './session-focus-fixture';

describe('attention task selection', () => {
  it('picks the most recently updated task in review, blocked or waiting_input', () => {
    const tasks = [
      task('tsk_old_review', 'review', '2026-01-01T10:00:00.000Z'),
      task('tsk_newer_blocked', 'blocked', '2026-01-02T10:00:00.000Z'),
      task('tsk_running', 'running', '2026-01-03T10:00:00.000Z'),
      task('tsk_waiting', 'waiting_input', '2026-01-01T12:00:00.000Z'),
      task('tsk_done', 'done', '2026-01-04T10:00:00.000Z'),
    ];
    expect(selectAttentionTask(tasks)?.id).toBe('tsk_newer_blocked');
  });

  it('returns null when no task needs attention', () => {
    expect(
      selectAttentionTask([
        task('tsk_running', 'running', '2026-01-01T10:00:00.000Z'),
        task('tsk_done', 'done', '2026-01-02T10:00:00.000Z'),
        task('tsk_failed', 'failed', '2026-01-03T10:00:00.000Z'),
      ]),
    ).toBeNull();
  });
});

describe('focus a named session', () => {
  it('focuses the tab of an interactive session', () => {
    const { backend, calls } = stubBackend({
      states: {
        'crew-tsk_1-developer': {
          mode: 'interactive',
          tabId: 'tab_1',
          workspaceId: 'w1',
          taskId: 'tsk_1',
        },
      },
    });
    expect(focusSession(backend, 'crew-tsk_1-developer')).toEqual({
      focused: true,
      taskId: 'tsk_1',
      session: 'crew-tsk_1-developer',
      tabId: 'tab_1',
      reason: 'interactive',
    });
    expect(calls).toEqual(['tab:tab_1']);
  });

  it('focuses the workspace of a batch session', () => {
    const { backend, calls } = stubBackend({
      states: {
        'crew-tsk_1-developer': {
          mode: 'batch',
          tabId: null,
          workspaceId: 'w7',
          taskId: 'tsk_1',
        },
      },
    });
    expect(focusSession(backend, 'crew-tsk_1-developer')).toMatchObject({
      focused: true,
      session: 'crew-tsk_1-developer',
      tabId: null,
      reason: 'batch',
    });
    expect(calls).toEqual(['workspace:w7']);
  });

  it('raises SESSION_NOT_FOUND for an unknown name', () => {
    const { backend } = stubBackend();
    try {
      focusSession(backend, 'crew-nope');
      expect.unreachable('focusSession should throw');
    } catch (error) {
      expect(error).toBeInstanceOf(CrewError);
      expect((error as CrewError).code).toBe('SESSION_NOT_FOUND');
    }
  });
});
