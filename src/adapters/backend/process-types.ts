import type { RemoteRunner } from '../../app/runner';
import type { SessionMode } from '../../app/session';

export interface ProcessResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  outputTail: string;
}

/**
 * Interactive agent mode (Herdr only): the agent is a long-lived agent of the
 * run harness in its own tab, so the run has to point it at the brief and wait
 * for the report instead of piping the brief through stdin.
 */
export interface InteractiveRunOptions {
  briefPath: string;
  reportPath: string;
  worktreePath: string;
  role: string;
  runId: string;
  /** Task the run belongs to; enables the shared 3-pane Herdr task layout. */
  taskId?: string;
  /** Title of the task, shown in the Herdr tab label. */
  taskTitle?: string | null;
  /** Harness of the run; it decides the Herdr agent kind. */
  harnessId: string;
  /** Agent startup timeout in ms (config `session.startupTimeoutMs`). */
  startupTimeoutMs?: number;
}

export interface RunProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  logPath: string;
  timeoutMs: number;
  stdin?: string;
  quiet?: boolean;
  signal?: AbortSignal;
  onSpawn?: (pid: number) => void;
  session?: string;
  /** Which session backend runs the command. */
  sessionMode?: SessionMode;
  /** Where the session backends keep their state. */
  sessionStateDir?: string;
  stdinPath?: string;
  remote?: RemoteRunner | null;
  interactive?: InteractiveRunOptions;
}
