export type SessionBackendId = 'tmux' | 'herdr';

export type SessionMode = SessionBackendId | 'auto';

/** Herdr agent kinds crew can start interactively. */
export type HerdrAgentKind = 'opencode' | 'pi';

export interface SessionInfo {
  name: string;
  taskId: string | null;
  command: string;
  createdAt: string | null;
  dead: boolean;
  exitCode: number | null;
  backend: SessionBackendId;
  /** Lifecycle state of the agent, when the backend knows it. */
  agentState: string | null;
  /** Harness agent kind of an interactive session, when known. */
  agentKind?: string | null;
  /** How the human attaches to it. */
  attach: string;
}

export interface SessionRunResult {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
}

export interface SessionStatus {
  dead: boolean;
  exitCode: number | null;
  agentState: string | null;
}

export interface StartSessionOptions {
  name: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  stdinPath?: string;
  /** Where the backend records the exit code of the command. */
  exitFile?: string;
  /**
   * Run an interactive agent instead of a batch command. Only Herdr supports
   * it (ADR 0031); the batch fields are ignored when this is set.
   */
  interactive?: InteractiveStartOptions;
  /** Emit run events (tab created, prompt sent, state changes) to the log. */
  onEvent?: (message: string) => void;
}

export interface InteractiveStartOptions {
  kind: HerdrAgentKind;
  /** Short base name; the backend resolves collisions with live agents. */
  baseName: string;
  prompt: string;
  reportPath: string;
  workspaceLabel: string;
}

export interface WaitSessionOptions {
  timeoutMs: number;
  pollMs?: number;
  signal?: AbortSignal;
  onEvent?: (message: string) => void;
}

export interface SessionBackend {
  readonly id: SessionBackendId;
  available(): boolean;
  version(): string;
  start(options: StartSessionOptions): { ok: boolean; error?: string };
  pid(name: string): number | null;
  capture(name: string): string;
  status(name: string): SessionStatus;
  wait(name: string, options: WaitSessionOptions): Promise<SessionRunResult>;
  kill(name: string): boolean;
  list(): SessionInfo[];
}
