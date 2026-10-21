import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

describe('captain layer', () => {
  let tempRoot: string;
  let repo: string;
  let env: Record<string, string>;

  function cli(args: string[]): CliResult {
    const result = spawnSync(TSX, [CLI, ...args], {
      cwd: repo,
      env: { ...process.env, ...env, NO_COLOR: '1', FORCE_COLOR: '0' },
      encoding: 'utf8',
      timeout: 60_000,
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
    tempRoot = mkdtempSync(path.join(tmpdir(), 'crew-captain-'));
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
    const configPath = path.join(repo, '.crew', 'config.yaml');
    const configText = readFileSync(configPath, 'utf8');
    writeFileSync(
      configPath,
      configText.replace('verify: []', 'verify:\n  - test -f FAKE_AGENT_OUTPUT.txt'),
    );
    expect(cli(['--json', 'project', 'add', '.', '--name', 'demo']).status).toBe(0);
  });

  afterAll(() => {
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('writes the captain instructions and refuses to overwrite them', () => {
    const first = cli(['--json', 'captain', 'init']);
    expect(first.status, first.stderr).toBe(0);
    expect(first.json.created).toBe(true);
    const instructions = readFileSync(path.join(repo, 'AGENTS.md'), 'utf8');
    expect(instructions).toContain('# Captain (crew)');
    expect(instructions).toContain('crew --json captain brief');

    const second = cli(['captain', 'init']);
    expect(second.status).toBe(1);
    expect(second.stderr).toContain('CAPTAIN_AGENTS_EXISTS');

    const forced = cli(['--json', 'captain', 'init', '--force']);
    expect(forced.status, forced.stderr).toBe(0);
    expect(forced.json.overwritten).toBe(false);
  });

  it('briefs the captain with projects, counts and what needs attention', () => {
    const created = cli([
      '--json',
      'task',
      'create',
      '--project',
      'demo',
      '--title',
      'Captain task',
      '--brief',
      'Do the thing',
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
      '20',
    ]);
    expect(run.status, run.stderr).toBe(0);

    const brief = cli(['--json', 'captain', 'brief']);
    expect(brief.status, brief.stderr).toBe(0);
    expect(brief.json.projects[0].name).toBe('demo');
    expect(brief.json.totalTasks).toBe(1);
    expect(brief.json.counts.review).toBe(1);
    expect(brief.json.attention[0]).toMatchObject({
      taskId,
      state: 'review',
    });
    expect(brief.json.tasks[0].risk.level).toBe('low');
    expect(brief.json.tasks[0].verification.state).toBe('passed');

    const text = cli(['captain', 'brief']);
    expect(text.status, text.stderr).toBe(0);
    expect(text.stdout).toContain('Needs attention:');
    expect(text.stdout).toContain(taskId);
  });

  it('limits the briefing to a single project', () => {
    const brief = cli(['--json', 'captain', 'brief', '--project', 'demo']);
    expect(brief.status, brief.stderr).toBe(0);
    expect(brief.json.totalTasks).toBe(1);

    const unknown = cli(['--json', 'captain', 'brief', '--project', 'nope']);
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain('PROJECT_NOT_FOUND');
  });
});
