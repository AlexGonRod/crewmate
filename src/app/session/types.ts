export type SessionBackendId = 'tmux' | 'herdr';

export type SessionMode = SessionBackendId | 'auto';

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
}

export interface WaitSessionOptions {
  timeoutMs: number;
  pollMs?: number;
  signal?: AbortSignal;
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
