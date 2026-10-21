import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  globalConfigPath,
  loadContext,
  readGlobalConfigFile,
  writeGlobalConfigValue,
} from '../../src/config/config';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'crew-config-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    rmSync(dirs.pop() as string, { recursive: true, force: true });
  }
});

describe('global configuration', () => {
  it('writes a value and keeps the rest of the file', () => {
    const dir = tempDir();
    writeFileSync(
      globalConfigPath(dir),
      'harness: fake\ncustom: keep-me\n',
      'utf8',
    );

    const result = writeGlobalConfigValue(dir, 'harness', 'opencode');
    expect(result.path).toBe(globalConfigPath(dir));

    const file = readGlobalConfigFile(dir);
    expect(file.harness).toBe('opencode');
    expect(file.custom).toBe('keep-me');
  });

  it('writes nested values', () => {
    const dir = tempDir();
    writeGlobalConfigValue(dir, 'scheduling.concurrency', 3);
    writeGlobalConfigValue(dir, 'scheduling.mode', 'parallel');
    writeGlobalConfigValue(dir, 'agents.developer.harness', 'opencode');

    const file = readGlobalConfigFile(dir);
    expect(file.scheduling).toEqual({ concurrency: 3, mode: 'parallel' });
    expect(file.agents).toEqual({ developer: { harness: 'opencode' } });
  });

  it('rejects unknown keys', () => {
    const dir = tempDir();
    expect(() =>
      writeGlobalConfigValue(dir, 'nope' as 'harness', 'x'),
    ).toThrow(/Unknown config key/);
  });

  it('returns an empty file when there is no configuration', () => {
    const dir = tempDir();
    expect(readGlobalConfigFile(dir)).toEqual({});
  });

  it('is used by the resolved context', () => {
    const dir = tempDir();
    writeGlobalConfigValue(dir, 'harness', 'opencode');
    writeGlobalConfigValue(dir, 'timeout_seconds', 900);

    const previous = process.env.CREW_CONFIG_DIR;
    process.env.CREW_CONFIG_DIR = dir;
    try {
      const context = loadContext({});
      expect(context.config.harness).toBe('opencode');
      expect(context.config.timeoutSeconds).toBe(900);
      expect(
        readFileSync(globalConfigPath(context.paths.configDir), 'utf8'),
      ).toContain('harness: opencode');
    } finally {
      if (previous === undefined) {
        delete process.env.CREW_CONFIG_DIR;
      } else {
        process.env.CREW_CONFIG_DIR = previous;
      }
    }
  });
});
