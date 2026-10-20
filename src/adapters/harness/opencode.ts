import type { HarnessAdapter, HarnessManifest, LaunchSpec } from './types';

const manifest: HarnessManifest = {
  apiVersion: 'crew.dev/v1',
  kind: 'Harness',
  metadata: {
    id: 'opencode',
    name: 'OpenCode',
  },
  spec: {
    detect: { binaries: ['opencode'] },
    execution: {
      modes: ['oneshot'],
      command: ['opencode', 'run', '--format', 'json', '--auto'],
      prompt: { mode: 'argument' },
      timeout_seconds: 1800,
    },
    provisioning: { supported: true, format: 'json' },
    capabilities: {
      resume: true,
      interactive: false,
      hooks: false,
      subagents: true,
      mcp: true,
    },
  },
};

export class OpencodeHarness implements HarnessAdapter {
  readonly manifest = manifest;

  buildLaunch(spec: LaunchSpec): {
    command: string;
    args: string[];
    env: Record<string, string | undefined>;
  } {
    const args = ['run', '--format', 'json', '--auto'];
    if (spec.agent) {
      args.push('--agent', spec.agent);
    }
    if (spec.model) {
      args.push('--model', spec.model);
    }
    args.push('--title', spec.task.title, spec.brief);
    return {
      command: 'opencode',
      args,
      env: {
        ...process.env,
        ...spec.env,
        CREW_TASK_ID: spec.task.id,
        CREW_RUN_ID: spec.run.id,
        CREW_PROJECT_ID: spec.project.id,
        CREW_ROLE: spec.role,
        CREW_WORKTREE: spec.worktreePath,
        CREW_BRIEF_PATH: spec.briefPath,
        CREW_REPORT_PATH: spec.reportPath,
        CREW_DB_PATH: spec.dbPath,
      },
    };
  }
}
