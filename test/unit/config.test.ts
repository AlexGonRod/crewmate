import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadContext, readProjectConfig } from '../../src/config/config';

const tempDirs: string[] = [];
const original = {
  config: process.env.CREW_CONFIG_DIR,
  data: process.env.CREW_DATA_DIR,
  state: process.env.CREW_STATE_DIR,
  db: process.env.CREW_DB_PATH,
};

afterEach(() => {
  for (const [key, value] of Object.entries(original)) {
    const name =
      key === 'config'
        ? 'CREW_CONFIG_DIR'
        : key === 'data'
          ? 'CREW_DATA_DIR'
          : key === 'state'
            ? 'CREW_STATE_DIR'
            : 'CREW_DB_PATH';
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('config', () => {
  it('reads and validates project verification config', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'crew-config-'));
    tempDirs.push(dir);
    mkdirSync(path.join(dir, '.crew'), { recursive: true });
    const configPath = path.join(dir, '.crew', 'config.yaml');
    writeFileSync(
      configPath,
      ['verify:', '  - pnpm test', '  - pnpm lint', 'verify_timeout_seconds: 120', ''].join('\n'),
    );
    expect(readProjectConfig(dir)).toMatchObject({
      verify: ['pnpm test', 'pnpm lint'],
      verify_timeout_seconds: 120,
    });

    writeFileSync(configPath, 'verify: pnpm test\n');
    expect(() => readProjectConfig(dir)).toThrow('verify must be a list');

    writeFileSync(configPath, 'verify: []\nverify_timeout_seconds: 0\n');
    expect(() => readProjectConfig(dir)).toThrow('verify_timeout_seconds');
  });

  it('reads and validates project CI config', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'crew-config-'));
    tempDirs.push(dir);
    mkdirSync(path.join(dir, '.crew'), { recursive: true });
    const configPath = path.join(dir, '.crew', 'config.yaml');

    writeFileSync(
      configPath,
      [
        'ci:',
        '  provider: github_actions',
        '  timeout_seconds: 120',
        '  interval_seconds: 2',
        '',
      ].join('\n'),
    );
    expect(readProjectConfig(dir)?.ci).toEqual({
      provider: 'github_actions',
      timeout_seconds: 120,
      interval_seconds: 2,
    });

    writeFileSync(configPath, 'ci:\n  provider: gitlab\n');
    expect(() => readProjectConfig(dir)).toThrow('ci.provider');

    writeFileSync(
      configPath,
      'ci:\n  provider: github_actions\n  timeout_seconds: 0\n',
    );
    expect(() => readProjectConfig(dir)).toThrow('ci.timeout_seconds');
  });

  it('reads and validates project auto-merge policy', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'crew-config-'));
    tempDirs.push(dir);
    mkdirSync(path.join(dir, '.crew'), { recursive: true });
    const configPath = path.join(dir, '.crew', 'config.yaml');

    writeFileSync(
      configPath,
      [
        'delivery: auto_merge',
        'auto_merge:',
        '  method: squash',
        '  delete_branch: true',
        '',
      ].join('\n'),
    );
    expect(readProjectConfig(dir)?.auto_merge).toEqual({
      method: 'squash',
      delete_branch: true,
    });

    writeFileSync(configPath, 'auto_merge:\n  method: fast-forward\n');
    expect(() => readProjectConfig(dir)).toThrow('auto_merge.method');

    writeFileSync(
      configPath,
      'auto_merge:\n  method: merge\n  delete_branch: yes\n',
    );
    expect(() => readProjectConfig(dir)).toThrow('auto_merge.delete_branch');
  });

  it('reads agents, review, and delivery from the global config', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'crew-config-'));
    tempDirs.push(dir);
    process.env.CREW_CONFIG_DIR = dir;
    process.env.CREW_DATA_DIR = path.join(dir, 'data');
    process.env.CREW_STATE_DIR = path.join(dir, 'state');
    writeFileSync(
      path.join(dir, 'config.yaml'),
      [
        'harness: opencode',
        'timeout_seconds: 60',
        'agents:',
        '  developer:',
        '    harness: opencode',
        '    agent: build',
        '    model: provider/model',
        '  tester:',
        '    harness: fake',
        'review:',
        '  max_iterations: 5',
        'delivery: pr',
        '',
      ].join('\n'),
    );

    const context = loadContext();
    expect(context.config.agents.developer).toEqual({
      harness: 'opencode',
      agent: 'build',
      model: 'provider/model',
    });
    expect(context.config.agents.tester.harness).toBe('fake');
    expect(context.config.review.maxIterations).toBe(5);
    expect(context.config.delivery).toBe('pr');
  });
});
