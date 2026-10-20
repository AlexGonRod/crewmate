import { CrewError } from '../../core/errors';
import { detectHarness } from './detect';
import { FakeHarness } from './fake';
import { OpencodeHarness } from './opencode';
import type { HarnessAdapter, HarnessManifest } from './types';

const fake = new FakeHarness();
const opencode = new OpencodeHarness();

const adapters = new Map<string, HarnessAdapter>([
  [fake.manifest.metadata.id, fake],
  [opencode.manifest.metadata.id, opencode],
]);

export function getHarness(id: string): HarnessAdapter {
  const adapter = adapters.get(id);
  if (!adapter) {
    throw new CrewError('HARNESS_NOT_FOUND', `Unknown harness: ${id}`);
  }
  return adapter;
}

export function listHarnessAdapters(): HarnessAdapter[] {
  return [...adapters.values()];
}

export function listHarnessManifests(): HarnessManifest[] {
  return listHarnessAdapters().map((adapter) => adapter.manifest);
}

export interface ResolveHarnessOptions {
  envPath?: string;
}

export function resolveHarnessId(
  requested: string,
  options: ResolveHarnessOptions = {},
): string {
  if (requested !== 'auto') {
    return getHarness(requested).manifest.metadata.id;
  }

  for (const adapter of adapters.values()) {
    if (adapter.manifest.metadata.id === 'fake') {
      continue;
    }
    if (detectHarness(adapter.manifest, options.envPath).available) {
      return adapter.manifest.metadata.id;
    }
  }

  throw new CrewError(
    'HARNESS_UNAVAILABLE',
    'No real harness detected on PATH; install opencode or pass --harness explicitly',
  );
}
