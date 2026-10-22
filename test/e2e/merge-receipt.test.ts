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

describe('the reviewed commit receipt', () => {
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

  function git(...args: string[]): string {
    return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  }

  function runTaskToReview(title: string): { id: string; branch: string; commitSha: string } {
    const created = cli([
      '--json',
      'task',
      'create',
      '--no-request',
      '--project',
      'demo',
      '--title',
      title,
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
    return {
      id,
      branch: run.json.task.branch as string,
      commitSha: run.json.commitSha as string,
    };
  }

  beforeAll(() => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'crew-receipt-'));
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
      // tempdir cleanup is best effort
    }
  });

  it('merges while the head is still the reviewed commit', () => {
    const task = runTaskToReview('Receipt healthy');
    expect(task.commitSha).toBe(git('rev-parse', `refs/heads/${task.branch}`));

    const merged = cli(['--json', 'task', 'merge', task.id, '--method', 'squash', '--by', 'user']);
    expect(merged.status, merged.stderr).toBe(0);
    expect(merged.json.decision.receipt).toEqual({
      headSha: task.commitSha,
      source: 'local',
    });
    expect(merged.json.decision.gates.some((gate: any) => gate.name === 'head matches the reviewed commit' && gate.ok)).toBe(true);
    expect(merged.json.taskState).toBe('done');
  });

  it('blocks the merge when the branch moved after the review', () => {
    const task = runTaskToReview('Receipt drift');
    expect(task.commitSha).toBe(git('rev-parse', `refs/heads/${task.branch}`));

    const tree = git('write-tree');
    const extra = git('commit-tree', tree, '-p', task.commitSha, '-m', 'human fix after the review');
    git('update-ref', `refs/heads/${task.branch}`, extra);
    expect(git('rev-parse', `refs/heads/${task.branch}`)).not.toBe(task.commitSha);

    const blocked = cli(['--json', 'task', 'merge', task.id, '--method', 'squash', '--by', 'user']);
    expect(blocked.status).toBe(1);
    expect(blocked.stderr).toContain('MERGE_BLOCKED');
    expect(blocked.stderr).toContain('head matches the reviewed commit');
    expect(blocked.stderr).toContain('the branch moved after the review');

    const stayed = cli(['--json', 'task', 'show', task.id]);
    expect(stayed.status, stayed.stderr).toBe(0);
    expect(stayed.json.task.state).toBe('review');

    const forced = cli([
      '--json',
      'task',
      'merge',
      task.id,
      '--method',
      'squash',
      '--by',
      'user',
      '--force',
    ]);
    expect(forced.status, forced.stderr).toBe(0);
    expect(forced.json.decision.receipt).toBeNull();
    expect(
      forced.json.decision.gates.some(
        (gate: any) => gate.name === 'head matches the reviewed commit',
      ),
    ).toBe(false);
    expect(forced.json.taskState).toBe('done');
  });
});
