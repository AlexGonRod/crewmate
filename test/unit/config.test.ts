import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadContext } from '../../src/config/config';

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
