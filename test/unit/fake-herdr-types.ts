import type { HerdrResponse, HerdrRunner } from '../../src/app/session/herdr';

export interface FakeHerdrOptions {
  reportPath?: string;
  report?: unknown;
  promptBehavior?: 'report' | 'blocked' | 'never';
  readOutput?: string;
  existingAgents?: string[];
}

export interface FakeAgent {
  name: string | null;
  agent: string;
  agent_status: string;
  pane_id: string;
  tab_id: string;
  workspace_id: string;
}

export interface FakeTab {
  tab_id: string;
  workspace_id: string;
  label: string;
  cwd: string;
  pane_id: string;
}

export interface FakeHerdr {
  run: HerdrRunner;
  calls: string[][];
  workspaces: Array<{ workspace_id: string; label: string }>;
  tabs: FakeTab[];
  agents: FakeAgent[];
  prompts: string[];
  workspaceCloses: string[];
}

export function response(result: unknown): HerdrResponse {
  return {
    ok: true,
    stdout: JSON.stringify({ result }),
    stderr: '',
    json: { result },
  };
}

export function failure(message: string): HerdrResponse {
  return { ok: false, stdout: '', stderr: message, json: null };
}

export function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}
