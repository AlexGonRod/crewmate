import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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

describe('fully remote workspace', () => {
  let tempRoot: string;
  let localRepo: string;
  let remoteRepo: string;
  let origin: string;
  let worktreeRoot: string;
  let bin: string;
  let sshLog: string;
  let env: Record<string, string>;

  function cli(args: string[], cwd: string = localRepo): CliResult {
    const result = spawnSync(TSX, [CLI, ...args], {
      cwd,
      env: { ...process.env, ...env, NO_COLOR: '1', FORCE_COLOR: '0' },
      encoding: 'utf8',
      timeout: 120_000,
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

  function git(args: string[], cwd: string): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8' });
  }

  beforeAll(() => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'crew-remote-ws-'));
    origin = path.join(tempRoot, 'origin.git');
    localRepo = path.join(tempRoot, 'local-repo');
    remoteRepo = path.join(tempRoot, 'remote-repo');
    worktreeRoot = path.join(tempRoot, 'remote-worktrees');
    bin = path.join(tempRoot, 'bin');
    sshLog = path.join(tempRoot, 'ssh.log');
    mkdirSync(bin, { recursive: true });
    mkdirSync(worktreeRoot, { recursive: true });
    env = {
      CREW_CONFIG_DIR: path.join(tempRoot, 'config'),
      CREW_DATA_DIR: path.join(tempRoot, 'data'),
      CREW_STATE_DIR: path.join(tempRoot, 'state'),
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
      SSH_LOG: sshLog,
    };

    execFileSync('git', ['init', '--bare', '-b', 'main', origin]);
    execFileSync('git', ['clone', origin, localRepo]);
    git(['config', 'user.email', 'crew@example.com'], localRepo);
    git(['config', 'user.name', 'Crew Test'], localRepo);
    writeFileSync(path.join(localRepo, 'README.md'), '# demo\n');
    git(['add', '.'], localRepo);
    git(['commit', '-m', 'initial'], localRepo);
    git(['push', 'origin', 'main'], localRepo);

    execFileSync('git', ['clone', origin, remoteRepo]);
    git(['config', 'user.email', 'remote@example.com'], remoteRepo);
    git(['config', 'user.name', 'Remote Crew'], remoteRepo);

    const ssh = path.join(bin, 'ssh');
    writeFileSync(
      ssh,
      `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const script = args[args.length - 1];
if (process.env.SSH_LOG) {
  appendFileSync(process.env.SSH_LOG, args.slice(0, -1).join(' ') + ' ' + script + '\\n');
}
const result = spawnSync('/bin/sh', ['-c', script], { encoding: 'utf8' });
process.stdout.write(result.stdout || '');
process.stderr.write(result.stderr || '');
process.exit(result.status === null ? 1 : result.status);
`,
    );
    chmodSync(ssh, 0o755);

    expect(cli(['init']).status).toBe(0);
    const configPath = path.join(localRepo, '.crew', 'config.yaml');
    const configText = readFileSync(configPath, 'utf8');
    writeFileSync(
      configPath,
      configText.replace(
        'verify: []',
        [
          'verify:',
          '  - test -f FAKE_AGENT_OUTPUT.txt',
          'runner:',
          '  host: builder@remote',
          `  repo_path: ${remoteRepo}`,
          `  worktree_root: ${worktreeRoot}`,
        ].join('\n'),
      ),
    );
    expect(cli(['--json', 'project', 'add', '.', '--name', 'demo']).status).toBe(0);
  });

  afterAll(() => {
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('creates the worktree, runs the agent and commits on the remote host', () => {
    const created = cli([
      '--json',
      'task',
      'create',
      '--no-request',
      '--project',
      'demo',
      '--title',
      'Remote workspace',
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
    expect(run.json.verifications[0].state).toBe('passed');

    const worktreePath = path.join(worktreeRoot, 'demo', id);
    expect(existsSync(worktreePath)).toBe(true);
    expect(existsSync(path.join(worktreePath, 'FAKE_AGENT_OUTPUT.txt'))).toBe(true);
    expect(existsSync(path.join(worktreePath, '.crew', 'brief.md'))).toBe(true);

    const log = readFileSync(sshLog, 'utf8');
    expect(log).toContain('builder@remote');
    expect(log).toContain('worktree');
    expect(log).toContain('add');
    expect(log).toContain('commit');

    const branch = run.json.task.branch as string;
    expect(git(['rev-parse', branch], remoteRepo).trim()).toBe(
      git(['rev-parse', 'HEAD'], worktreePath).trim(),
    );
  });

  it('never creates the worktree on the local machine', () => {
    const localWorktrees = path.join(tempRoot, 'data', 'worktrees');
    const entries = existsSync(localWorktrees) ? readdirSync(localWorktrees) : [];
    expect(entries).toEqual([]);
  });

  it('shows where the task runs and checks the remote host in the doctor', () => {
    const created = cli([
      '--json',
      'task',
      'create',
      '--no-request',
      '--project',
      'demo',
      '--title',
      'Remote observability',
      '--brief',
      'Create a marker file',
      '--methodology',
      'free',
    ]);
    expect(created.status, created.stderr).toBe(0);
    const id = created.json.task.id as string;

    const shown = cli(['--json', 'task', 'show', id]);
    expect(shown.status, shown.stderr).toBe(0);
    expect(shown.json.summary.location.where).toBe('remote');
    expect(shown.json.summary.location.host).toBe('builder@remote');

    const listed = cli(['--json', 'task', 'list']);
    expect(listed.status, listed.stderr).toBe(0);
    const summary = (listed.json.tasks as Array<{ id: string; location: { where: string } }>).find(
      (entry) => entry.id === id,
    );
    expect(summary?.location.where).toBe('remote');

    const doctor = cli(['--json', 'doctor']);
    const checks = (doctor.json.checks as Array<{ name: string; status: string }>).filter(
      (check) => check.name.startsWith('runner.demo'),
    );
    expect(checks.map((check) => check.name)).toContain('runner.demo.host');
    expect(checks.every((check) => check.status === 'ok')).toBe(true);
  });

  it('removes the remote worktree on clean', () => {
    const created = cli([
      '--json',
      'task',
      'create',
      '--no-request',
      '--project',
      'demo',
      '--title',
      'Remote cleanup',
      '--brief',
      'Create a marker file',
      '--methodology',
      'free',
    ]);
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

    const worktreePath = path.join(worktreeRoot, 'demo', id);
    expect(existsSync(worktreePath)).toBe(true);

    const cleaned = cli(['--json', 'task', 'clean', id, '--force']);
    expect(cleaned.status, cleaned.stderr).toBe(0);
    expect(existsSync(worktreePath)).toBe(false);
  });
});
