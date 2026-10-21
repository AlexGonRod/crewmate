import { describe, expect, it } from 'vitest';
import {
  assertTaskTransition,
  canTransitionTask,
  isActiveRunState,
  isTerminalTaskState,
  taskStateForReport,
} from '../../src/core/state';

describe('task state machine', () => {
  it('allows the phase 0 lifecycle', () => {
    expect(canTransitionTask('draft', 'queued')).toBe(true);
    expect(canTransitionTask('queued', 'starting')).toBe(true);
    expect(canTransitionTask('queued', 'failed')).toBe(true);
    expect(canTransitionTask('queued', 'blocked')).toBe(true);
    expect(canTransitionTask('blocked', 'queued')).toBe(true);
    expect(canTransitionTask('starting', 'running')).toBe(true);
    expect(canTransitionTask('running', 'done')).toBe(true);
    expect(canTransitionTask('running', 'failed')).toBe(true);
  });

  it('rejects invalid transitions', () => {
    expect(() => assertTaskTransition('done', 'running')).toThrow(
      'Invalid task transition',
    );
    expect(canTransitionTask('waiting_input', 'done')).toBe(false);
  });

  it('maps reports to task states', () => {
    expect(taskStateForReport('done')).toBe('done');
    expect(taskStateForReport('failed')).toBe('failed');
    expect(taskStateForReport('blocked')).toBe('blocked');
    expect(taskStateForReport('needs_input')).toBe('waiting_input');
    expect(taskStateForReport('progress')).toBeNull();
  });

  it('classifies terminal and active states', () => {
    expect(isTerminalTaskState('done')).toBe(true);
    expect(isTerminalTaskState('failed')).toBe(true);
    expect(isTerminalTaskState('cancelled')).toBe(true);
    expect(isTerminalTaskState('running')).toBe(false);
    expect(isActiveRunState('starting')).toBe(true);
    expect(isActiveRunState('running')).toBe(true);
    expect(isActiveRunState('exited')).toBe(false);
  });
});
