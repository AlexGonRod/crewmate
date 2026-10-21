import { describe, expect, it } from 'vitest';
import {
  listAllSessions,
  resolveBackend,
  sessionNameForTask,
} from '../../src/app/session';

describe('session names', () => {
  it('names the session after the task and the role', () => {
    expect(sessionNameForTask('tsk_1')).toBe('crew-tsk_1');
    expect(sessionNameForTask('tsk_1', 'developer')).toBe('crew-tsk_1-developer');
  });
});

describe('session backend resolution', () => {
  it('resolves tmux explicitly', () => {
    expect(resolveBackend('tmux').id).toBe('tmux');
  });

  it('resolves herdr explicitly', () => {
    expect(resolveBackend('herdr').id).toBe('herdr');
  });

  it('falls back to an available backend in auto mode', () => {
    const backend = resolveBackend('auto');
    expect(['tmux', 'herdr']).toContain(backend.id);
  });
});

describe('session listing', () => {
  it('reports the backends and the sessions', () => {
    const result = listAllSessions();
    const ids = result.backends.map((backend) => backend.id);
    expect(ids).toContain('tmux');
    expect(ids).toContain('herdr');
    for (const session of result.sessions) {
      expect(['tmux', 'herdr']).toContain(session.backend);
      expect(session.name.startsWith('crew-')).toBe(true);
    }
  });
});
