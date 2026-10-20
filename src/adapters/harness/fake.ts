import { fileURLToPath } from 'node:url';
import type { HarnessAdapter, HarnessManifest, LaunchSpec } from './types';

const fakeAgentUrl = new URL('../../../test/fake-agent/index.mjs', import.meta.url);

export function fakeAgentPath(): string {
  return fileURLToPath(fakeAgentUrl);
}

const manifest: HarnessManifest = {
  apiVersion: 'crew.dev/v1',
  kind: 'Harness',
  metadata: {
    id: 'fake',
    name: 'Fake Agent',
  },
  spec: {
    detect: { binaries: [] },
    execution: {
      modes: ['oneshot'],
      command: ['node', fakeAgentPath()],
      prompt: { mode: 'stdin' },
      timeout_seconds: 300,
    },
    provisioning: { supported: false },
    capabilities: {
      resume: false,
      interactive: false,
      hooks: false,
      subagents: false,
      mcp: false,
    },
  },
};

export class FakeHarness implements HarnessAdapter {
  readonly manifest = manifest;

  buildLaunch(spec: LaunchSpec): { command: string; args: string[]; env: Record<string, string | undefined> } {
    return {
      command: process.execPath,
      args: [fakeAgentPath()],
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
        CREW_FAKE_SCENARIO: spec.env.CREW_FAKE_SCENARIO ?? 'success',
      },
    };
  }
}
