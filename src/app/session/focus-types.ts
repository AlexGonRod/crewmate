export type FocusReason =
  | 'attention'
  | 'interactive'
  | 'batch'
  | 'no-attention'
  | 'no-session'
  | 'focus-failed';

export interface FocusOutcome {
  focused: boolean;
  taskId: string | null;
  session: string | null;
  tabId: string | null;
  reason: FocusReason;
}

/** The pieces of a session the focus gesture needs. */
export interface SessionFocusState {
  mode: 'batch' | 'interactive';
  tabId: string | null;
  workspaceId: string;
  taskId: string | null;
}

/** The backend surface `focus` uses; HerdrBackend satisfies it. */
export interface FocusBackend {
  sessionState(name: string): SessionFocusState | null;
  sessionForTask(taskId: string): string | null;
  focusTab(tabId: string): boolean;
  focusWorkspace(workspaceId: string): boolean;
}
