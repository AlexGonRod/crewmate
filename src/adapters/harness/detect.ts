import { accessSync, constants, statSync } from 'node:fs';
import path from 'node:path';
import { CrewError } from '../../core/errors';
import type { HarnessAdapter, HarnessManifest } from './types';

export interface HarnessAvailability {
  available: boolean;
  binary: string | null;
}

function isExecutable(candidate: string): boolean {
  try {
    if (!statSync(candidate).isFile()) {
      return false;
    }
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function findBinary(
  binary: string,
  envPath: string | undefined = process.env.PATH,
): string | null {
  if (binary.includes('/') || binary.includes('\\')) {
    const absolute = path.resolve(binary);
    return isExecutable(absolute) ? absolute : null;
  }

  const extensions =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
      : [''];

  for (const directory of (envPath ?? '').split(path.delimiter)) {
    if (directory === '') {
      continue;
    }
    for (const extension of extensions) {
      const candidate = path.join(directory, `${binary}${extension}`);
      if (isExecutable(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

export function detectHarness(
  manifest: HarnessManifest,
  envPath?: string,
): HarnessAvailability {
  if (manifest.spec.detect.binaries.length === 0) {
    return { available: true, binary: null };
  }
  for (const binary of manifest.spec.detect.binaries) {
    const resolved = findBinary(binary, envPath);
    if (resolved) {
      return { available: true, binary: resolved };
    }
  }
  return { available: false, binary: null };
}

export function assertHarnessAvailable(
  adapter: HarnessAdapter,
  envPath?: string,
): HarnessAvailability {
  const availability = detectHarness(adapter.manifest, envPath);
  if (
    adapter.manifest.spec.detect.binaries.length > 0 &&
    !availability.available
  ) {
    throw new CrewError(
      'HARNESS_UNAVAILABLE',
      `Harness ${adapter.manifest.metadata.id} is not installed: expected one of ${adapter.manifest.spec.detect.binaries.join(', ')} on PATH`,
    );
  }
  return availability;
}
