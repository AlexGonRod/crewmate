import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readProjectConfig } from '../../src/config/config';
import {
  isValidPort,
  pickFreePort,
  previewUrl,
} from '../../src/app/preview-ports';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function projectDir(config: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'crew-preview-'));
  tempDirs.push(dir);
  mkdirSync(path.join(dir, '.crew'), { recursive: true });
  writeFileSync(path.join(dir, '.crew', 'config.yaml'), config);
  return dir;
}

describe('preview config', () => {
  it('reads command and base port', () => {
    const dir = projectDir(
      ['preview:', '  command: npm run dev -- --port {port}', '  port: 4400', ''].join(
        '\n',
      ),
    );
    expect(readProjectConfig(dir)?.preview).toEqual({
      command: 'npm run dev -- --port {port}',
      port: 4400,
    });
  });

  it('leaves preview undefined when the project does not configure it', () => {
    expect(readProjectConfig(projectDir('verify: []\n'))?.preview).toBeUndefined();
  });

  it('rejects a non-object preview', () => {
    expect(() => readProjectConfig(projectDir('preview: yes\n'))).toThrow(
      'preview must be an object',
    );
  });

  it('rejects an empty command', () => {
    expect(() => readProjectConfig(projectDir('preview:\n  command: "  "\n'))).toThrow(
      'preview.command must be a non-empty string',
    );
  });

  it('rejects a port outside 1..65535', () => {
    expect(() =>
      readProjectConfig(projectDir('preview:\n  command: npm run dev\n  port: 70000\n')),
    ).toThrow('preview.port must be an integer');
    expect(() =>
      readProjectConfig(projectDir('preview:\n  command: npm run dev\n  port: 4.5\n')),
    ).toThrow('preview.port must be an integer');
  });
});

describe('preview port allocator', () => {
  it('validates ports and builds the local URL', () => {
    expect(isValidPort(4321)).toBe(true);
    expect(isValidPort(0)).toBe(false);
    expect(isValidPort(65536)).toBe(false);
    expect(isValidPort(4.5)).toBe(false);
    expect(previewUrl(4321)).toBe('http://localhost:4321');
  });

  it('picks the base when it is free', async () => {
    await expect(
      pickFreePort(4321, { isAvailable: async () => true }),
    ).resolves.toBe(4321);
  });

  it('skips ports of other live previews and occupied ports', async () => {
    const used = new Set([4321]);
    const occupied = new Set([4322]);
    await expect(
      pickFreePort(4321, {
        isUsed: (port) => used.has(port),
        isAvailable: async (port) => !occupied.has(port),
      }),
    ).resolves.toBe(4323);
  });

  it('fails when every candidate is taken', async () => {
    await expect(
      pickFreePort(4321, {
        attempts: 2,
        isAvailable: async () => false,
      }),
    ).rejects.toThrow('No free preview port');
  });

  it('fails on an invalid base port', async () => {
    await expect(pickFreePort(0)).rejects.toThrow('Invalid preview base port');
  });
});
