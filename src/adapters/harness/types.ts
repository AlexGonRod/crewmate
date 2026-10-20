import type { Project, Run, Task } from '../../core/types';

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
  reportPath: string;
  dbPath: string;
  env: Record<string, string>;
}

export interface LaunchCommand {
  command: string;
  args: string[];
  env: Record<string, string | undefined>;
}

export interface HarnessAdapter {
  manifest: HarnessManifest;
  buildLaunch(spec: LaunchSpec): LaunchCommand;
}
