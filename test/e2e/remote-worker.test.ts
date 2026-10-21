import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
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

describe('remote workers over ssh', () => {
  let tempRoot: string;
  let repo: string;
  let env: Record<string, string>;
  let sshLog: string;

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
    tempRoot = mkdtempSync(path.join(tmpdir(), 'crew-remote-'));
    repo = path.join(tempRoot, 'repo');
    const bin = path.join(tempRoot, 'bin');
    sshLog = path.join(tempRoot, 'ssh.log');
    mkdirSync(repo, { recursive: true });
    mkdirSync(bin, { recursive: true });
    env = {
      CREW_CONFIG_DIR: path.join(tempRoot, 'config'),
      CREW_DATA_DIR: path.join(tempRoot, 'data'),
      CREW_STATE_DIR: path.join(tempRoot, 'state'),
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
      SSH_LOG: sshLog,
    };

    execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'crew@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Crew Test'], { cwd: repo });
    writeFileSync(path.join(repo, 'README.md'), '# demo\n');
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repo });

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
    const configPath = path.join(repo, '.crew', 'config.yaml');
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

  it('runs the agent and the verification on the remote host', () => {
    const created = cli([
      '--json',
      'task',
      'create',
      '--project',
      'demo',
      '--title',
      'Remote task',
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
      '20',
    ]);
    expect(run.status, run.stderr).toBe(0);
    expect(run.json.task.state).toBe('review');
    expect(run.json.verifications[0].state).toBe('passed');

    const log = readFileSync(sshLog, 'utf8');
    expect(log).toContain('builder@remote');
    expect(log).toContain('CREW_TASK_ID');
    expect(log).toContain('FAKE_AGENT_OUTPUT.txt');
  });

  it('overrides the remote host from the command line', () => {
    const created = cli([
      '--json',
      'task',
      'create',
      '--project',
      'demo',
      '--title',
      'Remote override',
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
      '--host',
      'other@remote',
      '--env',
      'CREW_FAKE_SCENARIO=success',
      '--timeout',
      '20',
    ]);
    expect(run.status, run.stderr).toBe(0);
    expect(readFileSync(sshLog, 'utf8')).toContain('other@remote');
  });
});
