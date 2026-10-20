import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import { afterAll, describe, expect, it } from 'vitest';
import {
  assertHarnessAvailable,
  detectHarness,
  findBinary,
} from '../../src/adapters/harness/detect';
import { FakeHarness } from '../../src/adapters/harness/fake';
import { OpencodeHarness } from '../../src/adapters/harness/opencode';
import {
  getHarness,
  listHarnessManifests,
  resolveHarnessId,
} from '../../src/adapters/harness/registry';
import type { Project, Run, Task } from '../../src/core/types';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

function makeTask(): Task {
  return {
    id: 'tsk_test',
    projectId: 'prj_test',
    title: 'Add health endpoint',
    slug: 'add-health-endpoint',
    briefText: 'Do it',
    methodology: 'free',
    spec: null,
    state: 'queued',
    deliveryMode: 'local',
    baseBranch: 'main',
    branch: null,
    worktreePath: null,
    harnessId: null,
    priority: 0,
    lastSeq: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: null,
  };
}

function makeProject(): Project {
  return {
    id: 'prj_test',
    name: 'demo',
    rootPath: '/tmp/demo',
    defaultBranch: 'main',
    remoteUrl: null,
    forge: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function makeRun(): Run {
  return {
    id: 'run_test',
    taskId: 'tsk_test',
    attempt: 1,
    harnessId: 'opencode',
    backend: 'process',
    state: 'starting',
    pid: null,
    exitCode: null,
    logPath: '/tmp/run.jsonl',
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: null,
  };
}

describe('harness manifests', () => {
  it('validates every bundled manifest against the harness contract', () => {
    const ajv = new Ajv({ allErrors: true, strict: false });
    const schema = JSON.parse(
      readFileSync(path.join(ROOT, 'contracts', 'harness.v1.schema.json'), 'utf8'),
    ) as object;
    const validate = ajv.compile(schema);
    for (const manifest of listHarnessManifests()) {
      expect(validate(manifest), ajv.errorsText(validate.errors)).toBe(true);
    }
  });

  it('rejects unknown harness ids', () => {
    expect(() => getHarness('nope')).toThrow('Unknown harness');
  });
});

describe('harness detection', () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'crew-harness-'));

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it.skipIf(process.platform === 'win32')(
    'finds an executable binary on the provided PATH',
    () => {
      const binary = path.join(tempDir, 'opencode');
      writeFileSync(binary, '#!/bin/sh\nexit 0\n');
      chmodSync(binary, 0o755);

      expect(findBinary('opencode', tempDir)).toBe(binary);
      expect(findBinary('opencode', path.join(tempDir, 'missing'))).toBeNull();
    },
  );

  it('reports availability per manifest and resolves auto', () => {
    const opencode = new OpencodeHarness();
    const fake = new FakeHarness();

    const unavailable = detectHarness(opencode.manifest, '');
    expect(unavailable.available).toBe(false);
    expect(detectHarness(fake.manifest, '').available).toBe(true);

    expect(() => resolveHarnessId('auto', { envPath: '' })).toThrow(
      'No real harness detected',
    );
    expect(() => assertHarnessAvailable(opencode, '')).toThrow(
      'not installed',
    );
    expect(() => assertHarnessAvailable(fake, '')).not.toThrow();
  });

  it.skipIf(process.platform === 'win32')(
    'resolves auto to the first available real harness',
    () => {
      const binary = path.join(tempDir, 'opencode');
      writeFileSync(binary, '#!/bin/sh\nexit 0\n');
      chmodSync(binary, 0o755);

      expect(resolveHarnessId('auto', { envPath: tempDir })).toBe('opencode');
      expect(resolveHarnessId('fake', { envPath: tempDir })).toBe('fake');
    },
  );
});

describe('opencode adapter', () => {
  it('launches a one-shot run with the brief as the prompt', () => {
    const launch = new OpencodeHarness().buildLaunch({
      task: makeTask(),
      project: makeProject(),
      run: makeRun(),
      worktreePath: '/tmp/worktree',
      briefPath: '/tmp/worktree/.crew/brief.md',
      brief: 'Implement the health endpoint',
      reportPath: '/tmp/worktree/.crew/report.json',
      dbPath: '/tmp/crew.db',
      env: { CREW_EXTRA: '1' },
    });

    expect(launch.command).toBe('opencode');
    expect(launch.args).toEqual([
      'run',
      '--format',
      'json',
      '--auto',
      '--title',
      'Add health endpoint',
      'Implement the health endpoint',
    ]);
    expect(launch.env.CREW_TASK_ID).toBe('tsk_test');
    expect(launch.env.CREW_REPORT_PATH).toBe('/tmp/worktree/.crew/report.json');
    expect(launch.env.CREW_EXTRA).toBe('1');
  });
});
