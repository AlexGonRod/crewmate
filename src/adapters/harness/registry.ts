import { CrewError } from '../../core/errors';
import { FakeHarness } from './fake';
import type { HarnessAdapter, HarnessManifest } from './types';

const OPENCODE_MANIFEST: HarnessManifest = {
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
      command: ['opencode', 'run'],
      prompt: { mode: 'stdin' },
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

const fake = new FakeHarness();

export function getHarness(id: string): HarnessAdapter {
  if (id === 'fake') {
    return fake;
  }
  if (id === 'opencode') {
    throw new CrewError(
      'HARNESS_NOT_IMPLEMENTED',
      'The opencode adapter is planned for Phase 1; use --harness fake in Phase 0',
    );
  }
  throw new CrewError('HARNESS_NOT_FOUND', `Unknown harness: ${id}`);
}

export function listHarnessManifests(): HarnessManifest[] {
  return [fake.manifest, OPENCODE_MANIFEST];
}
