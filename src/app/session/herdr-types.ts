import type { HerdrAgentKind } from './types';

/** One `herdr` CLI answer, with the parsed JSON when the output is JSON. */
export interface HerdrResponse {
  ok: boolean;
  stdout: string;
  stderr: string;
  json: any;
}

export type HerdrRunner = (args: string[]) => HerdrResponse;

/** What crew records of a Herdr session on disk. */
export interface HerdrSessionState {
  name: string;
  workspaceId: string;
  paneId: string;
  exitFile: string | null;
  taskId: string | null;
  createdAt: string;
  mode?: 'batch' | 'interactive';
  tabId?: string | null;
  agentName?: string | null;
  agentKind?: HerdrAgentKind | null;
  reportPath?: string | null;
  prompt?: string | null;
  workspaceLabel?: string | null;
}

/**
 * A workspace plus the tab and root pane Herdr opens with it. `tabId` and
 * `paneId` are only present when crew just created the workspace: an existing
 * workspace is addressed with its id and needs a new tab.
 */
export interface WorkspaceHandle {
  id: string;
  tabId?: string;
  paneId?: string;
}

/** The two things the Herdr helpers need: the CLI and where state lives. */
export interface HerdrContext {
  run: HerdrRunner;
  stateDir: string;
}
