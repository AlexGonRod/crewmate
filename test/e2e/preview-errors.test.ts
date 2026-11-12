import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const TSX = path.join(ROOT, 'node_modules', '.bin', 'tsx');
const CLI = path.join(ROOT, 'src', 'cli', 'main.ts');

interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
  json: any;
}

describe('task preview errors', () => {
  let tempRoot: string;
  let repo: string;
  let env: Record<string, string>;
  let configPath: string;

  function cli(args: string[]): CliResult {
    const result = spawnSync(TSX, [CLI, ...args], {
      cwd: repo,
      env: { ...process.env, ...env, NO_COLOR: '1', FORCE_COLOR: '0' },
      encoding: 'utf8',
      timeout: 90_000,
    });
    if (result.error) {
      throw result.error;
    }
    const stdout = result.stdout ?? '';
    let json: any = null;
    try {
      json = JSON.parse(stdout);
    } catch {
      json = null;
    }
    return { status: result.status ?? 1, stdout, stderr: result.stderr ?? '', json };
  }

  beforeAll(() => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'crew-preview-errors-'));
    repo = path.join(tempRoot, 'repo');
    env = {
      CREW_CONFIG_DIR: path.join(tempRoot, 'config'),
      CREW_DATA_DIR: path.join(tempRoot, 'data'),
      CREW_STATE_DIR: path.join(tempRoot, 'state'),
    };
    mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'crew@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Crew Test'], { cwd: repo });
    writeFileSync(path.join(repo, 'README.md'), '# demo\n');
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repo });
    expect(cli(['init']).status).toBe(0);
    configPath = path.join(repo, '.crew', 'config.yaml');
    writeFileSync(
      configPath,
      ['verify:', '  - node -e "process.exit(0)"', ''].join('\n'),
    );
    expect(cli(['--json', 'project', 'add', '.', '--name', 'demo']).status).toBe(0);
  });

  afterAll(() => {
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  function reviewedTask(): string {
    const created = cli([
      '--json',
      'task',
      'create',
      '--no-request',
      '--project',
      'demo',
      '--title',
      'Preview errors',
      '--brief',
      'Make it previewable',
      '--methodology',
      'free',
    ]);
    expect(created.status, created.stderr).toBe(0);
    const taskId = created.json.task.id as string;
    const run = cli([
      '--json',
      'task',
      'run',
      taskId,
      '--harness',
      'fake',
      '--env',
      'CREW_FAKE_SCENARIO=success',
      '--timeout',
      '30',
    ]);
    expect(run.status, run.stderr).toBe(0);
    return taskId;
  }

  it('asks for a preview command with an example when the project has none', () => {
    const id = reviewedTask();
    const preview = cli(['--json', 'task', 'preview', id]);
    expect(preview.status).not.toBe(0);
    expect(preview.stderr).toContain('[PREVIEW_NOT_CONFIGURED]');
    expect(preview.stderr).toContain('preview:');
    expect(preview.stderr).toContain('command: npm run dev -- --port {port}');
  });

  it('refuses a remote workspace with PREVIEW_UNSUPPORTED_REMOTE', () => {
    const id = reviewedTask();
    const current = readFileSync(configPath, 'utf8');
    writeFileSync(
      configPath,
      [
        current.trimEnd(),
        'preview:',
        '  command: node -e "process.exit(0)"',
        'runner:',
        '  host: example.invalid',
        '  repo_path: /srv/demo',
        '',
      ].join('\n'),
    );
    const preview = cli(['--json', 'task', 'preview', id]);
    expect(preview.status).not.toBe(0);
    expect(preview.stderr).toContain('[PREVIEW_UNSUPPORTED_REMOTE]');
  });
});
