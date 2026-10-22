import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

describe('the commit hygiene gate', () => {
  let tempRoot: string;
  let repo: string;
  let env: Record<string, string>;

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
    tempRoot = mkdtempSync(path.join(tmpdir(), 'crew-hygiene-'));
    repo = path.join(tempRoot, 'repo');
    const bin = path.join(tempRoot, 'bin');
    mkdirSync(repo, { recursive: true });
    env = {
      CREW_CONFIG_DIR: path.join(tempRoot, 'config'),
      CREW_DATA_DIR: path.join(tempRoot, 'data'),
      CREW_STATE_DIR: path.join(tempRoot, 'state'),
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
    };

    execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'crew@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Crew Test'], { cwd: repo });
    writeFileSync(path.join(repo, 'README.md'), '# demo\n');
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repo });

    const init = cli(['init']);
    expect(init.status, init.stderr).toBe(0);
    const configPath = path.join(repo, '.crew', 'config.yaml');
    const configText = readFileSync(configPath, 'utf8');
    writeFileSync(
      configPath,
      `${configText.replace('verify: []', 'verify:\n  - test -f FAKE_AGENT_OUTPUT.txt')}\ndelivery:\n  yolo: true\n`,
    );

    const project = cli(['--json', 'project', 'add', '.', '--name', 'demo']);
    expect(project.status, project.stderr).toBe(0);
  });

  afterAll(() => {
    try {
      execFileSync('rm', ['-rf', tempRoot]);
    } catch {
      // best effort
    }
  });

  it('blocks the delivery when the change carries forbidden files', () => {
    const created = cli([
      '--json',
      'task',
      'create',
      '--no-request',
      '--project',
      'demo',
      '--title',
      'Hygiene blocked',
      '--brief',
      'Create a marker file',
      '--methodology',
      'free',
    ]);
    expect(created.status, created.stderr).toBe(0);
    const id = created.json.task.id as string;

    const run = cli([
      '--json',
      'task',
      'run',
      id,
      '--harness',
      'fake',
      '--env',
      'CREW_FAKE_DEVELOPER_SCENARIO=success_with_secrets',
      '--env',
      'CREW_FAKE_TESTER_SCENARIO=success',
      '--max-iterations',
      '0',
      '--timeout',
      '30',
    ]);
    expect(run.json.task.state).toBe('failed');
    expect(run.json.task.lastError ?? '').toContain('hygiene gate');
    expect(run.json.task.lastError ?? '').toContain('.env');
    expect(run.json.task.lastError ?? '').not.toContain('do-not-commit-me');

    const show = cli(['--json', 'task', 'show', id]);
    expect(show.status, show.stderr).toBe(0);
    const commitArtifacts = (show.json.artifacts as Array<{ kind: string }>).filter(
      (artifact) => artifact.kind === 'commit',
    );
    expect(commitArtifacts).toHaveLength(0);
    const feedback = (show.json.messages as Array<{ kind: string; body: string }>).some(
      (message) => message.kind === 'review_feedback' && message.body.includes('.env'),
    );
    expect(feedback).toBe(true);
  });

  it('does not commit generated artifacts', () => {
    const created = cli([
      '--json',
      'task',
      'create',
      '--no-request',
      '--project',
      'demo',
      '--title',
      'Pycache blocked',
      '--brief',
      'Create a marker file',
      '--methodology',
      'free',
    ]);
    expect(created.status, created.stderr).toBe(0);
    const id = created.json.task.id as string;

    const run = cli([
      '--json',
      'task',
      'run',
      id,
      '--harness',
      'fake',
      '--env',
      'CREW_FAKE_DEVELOPER_SCENARIO=success_with_pycache',
      '--env',
      'CREW_FAKE_TESTER_SCENARIO=success',
      '--max-iterations',
      '0',
      '--timeout',
      '30',
    ]);
    expect(run.json.task.state).toBe('failed');
    expect(run.json.task.lastError ?? '').toContain('__pycache__/');
  });

  it('commits a clean change and exits in review', () => {
    const created = cli([
      '--json',
      'task',
      'create',
      '--no-request',
      '--project',
      'demo',
      '--title',
      'Hygiene clean',
      '--brief',
      'Create a marker file',
      '--methodology',
      'free',
    ]);
    expect(created.status, created.stderr).toBe(0);
    const id = created.json.task.id as string;

    const run = cli([
      '--json',
      'task',
      'run',
      id,
      '--harness',
      'fake',
      '--env',
      'CREW_FAKE_SCENARIO=success',
      '--timeout',
      '30',
    ]);
    expect(run.status, run.stderr).toBe(0);
    expect(run.json.task.state).toBe('review');
  });
});
