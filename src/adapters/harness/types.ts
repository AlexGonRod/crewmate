import type { AgentRole, Project, Run, Task } from '../../core/types';

export interface HarnessManifest {
  apiVersion: 'crew.dev/v1';
  kind: 'Harness';
  metadata: {
    id: string;
    name: string;
  };
  spec: {
    detect: {
      binaries: string[];
    };
    execution: {
      modes: Array<'oneshot' | 'interactive'>;
      command: string[];
      prompt: {
        mode: 'stdin' | 'argument' | 'file';
      };
      timeout_seconds: number;
      env?: Record<string, string>;
    };
    provisioning: {
      supported: boolean;
      format?: string;
    };
    capabilities: {
      resume: boolean;
      interactive: boolean;
      hooks: boolean;
      subagents: boolean;
      mcp: boolean;
    };
  };
}

export interface LaunchSpec {
  task: Task;
  project: Project;
  run: Run;
  worktreePath: string;
  briefPath: string;
  brief: string;
  reportPath: string;
  dbPath: string;
  role: AgentRole;
  agent?: string;
  model?: string;
  env: Record<string, string>;
}

export interface LaunchCommand {
  command: string;
  args: string[];
  env: Record<string, string | undefined>;
}

/**
 * A conversation turn with the main agent (the captain).
 *
 * It is not a task: there is no worktree, no report and no run in the
 * pipeline. The prompt goes in, the answer comes back.
 */
export interface ChatLaunchSpec {
  prompt: string;
  cwd: string;
  /** Continue an existing conversation, when the harness supports it. */
  sessionId?: string | null;
  agent?: string;
  model?: string;
  env: Record<string, string>;
}

export interface HarnessAdapter {
  manifest: HarnessManifest;
  buildLaunch(spec: LaunchSpec): LaunchCommand;
  /** Launches the agent for a conversation turn, when it supports it. */
  buildChatLaunch?(spec: ChatLaunchSpec): LaunchCommand;
}
