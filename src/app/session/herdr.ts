import { CrewError } from '../../core/errors';
import type { SessionFocusState } from './focus-types';
import { runHerdr } from './herdr-cli';
import { startInteractive } from './herdr-interactive';
import { captureSession, sessionPid } from './herdr-capture';
import {
  killSession,
  listSessions,
  sessionStatus,
  startBatch,
} from './herdr-session';
import { listStates, readState } from './herdr-state';
import type { HerdrContext, HerdrRunner } from './herdr-types';
import { waitSession } from './herdr-wait';
import { focusTab, focusWorkspace } from './herdr-workspaces';
import type {
  SessionBackend,
  SessionInfo,
  SessionRunResult,
  SessionStatus,
  StartSessionOptions,
  WaitSessionOptions,
} from './types';

export type { HerdrResponse, HerdrRunner } from './herdr-types';
export { runHerdr } from './herdr-cli';

/**
 * Runs the crew agents inside Herdr instead of tmux.
 *
 * A crew session is either a Herdr workspace labelled with the session name,
 * whose root pane runs the agent (batch), or an interactive agent of the run
 * harness in its own tab of the shared `crew-sessions` workspace (ADR 0031).
 *
 * The behavior lives in the `herdr-*` modules; this class is the stable
 * SessionBackend facade and the place where the CLI runner is injected.
 */
export class HerdrBackend implements SessionBackend {
  readonly id = 'herdr' as const;

  constructor(
    private readonly stateDir: string,
    private readonly run: HerdrRunner = runHerdr,
  ) {}

  private context(): HerdrContext {
    return { run: this.run, stateDir: this.stateDir };
  }

  available(): boolean {
    return this.run(['status', 'server']).ok;
  }

  version(): string {
    const result = this.run(['--version']);
    return result.ok ? result.stdout.trim() : '';
  }

  /** The focusable state of a session, or null when crew does not know it. */
  sessionState(name: string): SessionFocusState | null {
    const state = readState(this.stateDir, name);
    if (!state) {
      return null;
    }
    return {
      mode: state.mode === 'interactive' ? 'interactive' : 'batch',
      tabId: state.tabId ?? null,
      workspaceId: state.workspaceId,
      taskId: state.taskId ?? null,
    };
  }

  /** The session name recorded for a task, preferring an interactive run. */
  sessionForTask(taskId: string): string | null {
    const states = listStates(this.stateDir).filter((state) => state.taskId === taskId);
    const interactive = states.find((state) => state.mode === 'interactive');
    return interactive?.name ?? states[0]?.name ?? null;
  }

  focusTab(tabId: string): boolean {
    return focusTab(this.run, tabId);
  }

  focusWorkspace(workspaceId: string): boolean {
    return focusWorkspace(this.run, workspaceId);
  }

  start(options: StartSessionOptions): { ok: boolean; error?: string } {
    if (!this.available()) {
      return {
        ok: false,
        error:
          'herdr is not available (the binary or its background server is not running)',
      };
    }
    if (options.interactive) {
      return startInteractive(this.context(), options, options.interactive);
    }
    return startBatch(this.context(), options);
  }

  pid(name: string): number | null {
    return sessionPid(this.context(), name);
  }

  capture(name: string): string {
    return captureSession(this.context(), name);
  }

  status(name: string): SessionStatus {
    return sessionStatus(this.context(), name);
  }

  wait(name: string, options: WaitSessionOptions): Promise<SessionRunResult> {
    return waitSession(this.context(), name, options);
  }

  kill(name: string, options?: { graceful?: boolean }): boolean {
    return killSession(this.context(), name, options);
  }

  list(): SessionInfo[] {
    return listSessions(this.context());
  }
}

export function assertHerdrAvailable(backend: HerdrBackend): void {
  if (!backend.available()) {
    throw new CrewError(
      'HERDR_UNAVAILABLE',
      'herdr is not available. Start it with "herdr" or use --session tmux.',
    );
  }
}
