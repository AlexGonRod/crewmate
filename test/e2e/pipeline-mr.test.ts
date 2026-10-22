import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
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

describe('gitlab merge requests', () => {
  let tempRoot: string;
  let repo: string;
  let remote: string;
  let env: Record<string, string>;
  let glabState: string;

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
    tempRoot = mkdtempSync(path.join(tmpdir(), 'crew-mr-'));
    repo = path.join(tempRoot, 'repo');
    remote = path.join(tempRoot, 'remote.git');
    glabState = path.join(tempRoot, 'glab-state.json');
    const bin = path.join(tempRoot, 'bin');
    mkdirSync(repo, { recursive: true });
    mkdirSync(bin, { recursive: true });
    env = {
      CREW_CONFIG_DIR: path.join(tempRoot, 'config'),
      CREW_DATA_DIR: path.join(tempRoot, 'data'),
      CREW_STATE_DIR: path.join(tempRoot, 'state'),
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
      GLAB_STATE: glabState,
    };

    execFileSync('git', ['init', '--bare', '-b', 'main', remote]);
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'crew@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Crew Test'], { cwd: repo });
    writeFileSync(path.join(repo, 'README.md'), '# demo\n');
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repo });
    execFileSync('git', [
      'remote',
      'add',
      'origin',
      'https://gitlab.com/acme/demo.git',
    ], { cwd: repo });
    execFileSync('git', ['config', 'remote.origin.pushurl', remote], {
      cwd: repo,
    });

    const glab = path.join(bin, 'glab');
    writeFileSync(
      glab,
      `#!/usr/bin/env node
const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
const statePath = process.env.GLAB_STATE;
function state() {
  if (!statePath || !existsSync(statePath)) return null;
  return JSON.parse(readFileSync(statePath, 'utf8'));
}
if (args[0] === 'auth' && args[1] === 'status') process.exit(0);
if (args[0] === 'mr' && args[1] === 'create') {
  const item = {
    web_url: 'https://gitlab.com/acme/demo/-/merge_requests/1',
    iid: 1,
    state: 'opened',
    draft: false,
    merge_status: process.env.GLAB_MERGEABLE === 'conflict' ? 'cannot_be_merged' : 'can_be_merged',
    source_branch: args[args.indexOf('--source-branch') + 1],
    target_branch: args[args.indexOf('--target-branch') + 1],
  };
  writeFileSync(statePath, JSON.stringify(item));
  process.stdout.write('Created merge request! ' + item.web_url + '\\n');
  process.exit(0);
}
if (args[0] === 'mr' && args[1] === 'view') {
  const item = state();
  if (!item) process.exit(1);
  process.stdout.write(JSON.stringify(item));
  process.exit(0);
}
if (args[0] === 'mr' && args[1] === 'merge') {
  const item = state();
  if (!item) process.exit(1);
  if (process.env.GLAB_MERGE_STATE === 'fail') {
    process.stderr.write('merge conflict\\n');
    process.exit(1);
  }
  item.state = 'merged';
  item.merge_status = 'can_be_merged';
  writeFileSync(statePath, JSON.stringify(item));
  process.exit(0);
}
process.stderr.write('glab shim: unsupported ' + args.join(' ') + '\\n');
process.exit(1);
`,
    );
    chmodSync(glab, 0o755);

    expect(cli(['init']).status).toBe(0);
    const configPath = path.join(repo, '.crew', 'config.yaml');
    const configText = readFileSync(configPath, 'utf8');
    writeFileSync(
      configPath,
      `${configText.replace('verify: []', 'verify:\n  - test -f FAKE_AGENT_OUTPUT.txt')}\ndelivery:\n  yolo: true\n`,
    );
    const added = cli(['--json', 'project', 'add', '.', '--name', 'demo']);
    expect(added.status, added.stderr).toBe(0);
    expect(added.json.project.forge).toBe('gitlab');
  });

  afterAll(() => {
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('opens a merge request and accepts the task once it is merged', () => {
    const created = cli([
      '--json',
      'task',
      'create',
      '--project',
      'demo',
      '--title',
      'Merge request task',
      '--brief',
      'Create a marker file',
      '--methodology',
      'free',
      '--delivery',
      'pr',
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
      '10',
    ]);
    expect(run.status, run.stderr).toBe(0);
    expect(run.json.task.state).toBe('review');
    expect(run.json.prUrl).toBe('https://gitlab.com/acme/demo/-/merge_requests/1');
    expect(run.json.commitSha).toBeTruthy();
    expect(existsSync(glabState)).toBe(true);

    const branch = run.json.task.branch as string;
    const refs = execFileSync('git', ['--git-dir', remote, 'show-ref'], {
      encoding: 'utf8',
    });
    expect(refs).toContain(branch);

    const premature = cli(['--json', 'task', 'accept', id]);
    expect(premature.status).toBe(1);
    expect(premature.stderr).toContain('PR_NOT_MERGED');

    const mergeRequest = JSON.parse(readFileSync(glabState, 'utf8')) as Record<string, unknown>;
    writeFileSync(
      glabState,
      JSON.stringify({ ...mergeRequest, state: 'merged', merged_at: '2026-01-01T00:00:00Z' }),
    );

    const accepted = cli(['--json', 'task', 'accept', id]);
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(accepted.json.task.state).toBe('done');
  });

  it('merges a merge request from the conversational merge command', () => {
    const created = cli([
      '--json',
      'task',
      'create',
      '--project',
      'demo',
      '--title',
      'Merge request merge',
      '--brief',
      'Create another marker file',
      '--methodology',
      'free',
      '--delivery',
      'pr',
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
      '10',
    ]);
    expect(run.status, run.stderr).toBe(0);
    expect(run.json.task.state).toBe('review');

    const merged = cli(['--json', 'task', 'merge', id, '--method', 'squash', '--by', 'user']);
    expect(merged.status, merged.stderr).toBe(0);
    expect(merged.json.decision.allowed).toBe(true);
    expect(merged.json.merge.state).toBe('merged');
    expect(merged.json.taskState).toBe('done');

    const mergeRequest = JSON.parse(readFileSync(glabState, 'utf8')) as Record<string, unknown>;
    expect(mergeRequest.state).toBe('merged');
  });
});
