import { CrewError } from '../core/errors';
import { HerdrBackend } from './session/herdr';
import { TmuxBackend } from './session/tmux';
import type {
  SessionBackend,
  SessionBackendId,
  SessionInfo,
  SessionMode,
} from './session/types';

export type {
  SessionBackend,
  SessionBackendId,
  SessionInfo,
  SessionMode,
  SessionRunResult,
  SessionStatus,
  StartSessionOptions,
  WaitSessionOptions,
} from './session/types';
export { HerdrBackend } from './session/herdr';
export { TmuxBackend } from './session/tmux';

export const DEFAULT_SESSION_STATE_DIR = '.crew-sessions';

export function sessionNameForTask(taskId: string, role?: string): string {
  return role ? `crew-${taskId}-${role}` : `crew-${taskId}`;
}

export interface BackendOptions {
  /** Where the backends keep their own state (herdr keeps the pane mapping). */
  stateDir?: string;
}

/**
 * Resolves the session backend to use.
 *
 * `auto` prefers herdr when its server is running and falls back to tmux,
 * which keeps the crew usable in either world.
 */
export function resolveBackend(
  mode: SessionMode = 'auto',
  options: BackendOptions = {},
): SessionBackend {
  if (mode === 'tmux') {
    return new TmuxBackend();
  }
  if (mode === 'herdr') {
    return new HerdrBackend(options.stateDir ?? DEFAULT_SESSION_STATE_DIR);
  }
  const herdr = new HerdrBackend(options.stateDir ?? DEFAULT_SESSION_STATE_DIR);
  if (herdr.available()) {
    return herdr;
  }
  const tmux = new TmuxBackend();
  if (tmux.available()) {
    return tmux;
  }
  throw new CrewError(
    'SESSION_BACKEND_UNAVAILABLE',
    'No session backend is available: install tmux or run the herdr server.',
  );
}

export function backendAvailable(id: SessionBackendId, options: BackendOptions = {}): boolean {
  if (id === 'tmux') {
    return new TmuxBackend().available();
  }
  return new HerdrBackend(options.stateDir ?? DEFAULT_SESSION_STATE_DIR).available();
}

/**
 * Every crew session, whatever backend owns it.
 */
export function listAllSessions(options: BackendOptions = {}): {
  backends: Array<{ id: SessionBackendId; available: boolean; version: string }>;
  sessions: SessionInfo[];
} {
  const tmux = new TmuxBackend();
  const herdr = new HerdrBackend(options.stateDir ?? DEFAULT_SESSION_STATE_DIR);
  const sessions: SessionInfo[] = [];
  if (tmux.available()) {
    sessions.push(...tmux.list());
  }
  if (herdr.available()) {
    sessions.push(...herdr.list());
  }
  return {
    backends: [
      { id: 'tmux', available: tmux.available(), version: tmux.version() },
      { id: 'herdr', available: herdr.available(), version: herdr.version() },
    ],
    sessions,
  };
}

export function killSessionByName(
  name: string,
  options: BackendOptions = {},
): { killed: boolean; backend: SessionBackendId | null } {
  const herdr = new HerdrBackend(options.stateDir ?? DEFAULT_SESSION_STATE_DIR);
  if (herdr.available() && herdr.kill(name)) {
    return { killed: true, backend: 'herdr' };
  }
  const tmux = new TmuxBackend();
  if (tmux.available() && tmux.kill(name)) {
    return { killed: true, backend: 'tmux' };
  }
  return { killed: false, backend: null };
}
