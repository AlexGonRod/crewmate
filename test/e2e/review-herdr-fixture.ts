import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import { herdrShim } from './review-herdr-shim';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const TSX = path.join(ROOT, 'node_modules', '.bin', 'tsx');
const CLI = path.join(ROOT, 'src', 'cli', 'main.ts');

export interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
  json: any;
}

export interface ReviewHerdrFixture {
  setup(): void;
  cleanup(): void;
  configure(tab: string): void;
  resetHerdr(): void;
  cli(args: string[]): CliResult;
  createTask(title: string): string;
  runTask(id: string): CliResult;
  calls(): string[][];
  opensFor(worktree: string): Array<{ args: string[]; cwd: string }>;
}

export function createReviewHerdrFixture(): ReviewHerdrFixture {
  let tempRoot = '';
  let repo = '';
  let bin = '';
  let env: Record<string, string> = {};
  let herdrLog = '';
  let herdrState = '';

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

  function configure(tab: string): void {
    writeFileSync(
      path.join(repo, '.crew', 'config.yaml'),
      [
        'verify:',
        '  - test -f FAKE_AGENT_OUTPUT.txt',
        'review:',
        `  herdr_tab: ${tab}`,
        '',
      ].join('\n'),
    );
  }

  function calls(): string[][] {
    const text = readFileSync(herdrLog, 'utf8').trim();
    return text === '' ? [] : text.split('\n').map((line) => JSON.parse(line) as string[]);
  }

  function resetHerdr(): void {
    writeFileSync(herdrLog, '');
    writeFileSync(herdrState, JSON.stringify({ panes: [] }));
  }

  function createTask(title: string): string {
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
    return created.json.task.id as string;
  }

  function runTask(id: string): CliResult {
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
    return run;
  }

  function opensFor(worktree: string): Array<{ args: string[]; cwd: string }> {
    return calls()
      .filter((args) => args[0] === 'plugin' && args[2] === 'open')
      .filter((args) => args[args.indexOf('--cwd') + 1] === worktree)
      .map((args) => ({
        args,
        cwd: args[args.indexOf('--cwd') + 1] as string,
      }));
  }

  function setup(): void {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'crew-review-herdr-'));
    repo = path.join(tempRoot, 'repo');
    bin = path.join(tempRoot, 'bin');
    herdrLog = path.join(tempRoot, 'herdr.log');
    herdrState = path.join(tempRoot, 'herdr-state.json');
    mkdirSync(repo, { recursive: true });
    mkdirSync(bin, { recursive: true });
    env = {
      CREW_CONFIG_DIR: path.join(tempRoot, 'config'),
      CREW_DATA_DIR: path.join(tempRoot, 'data'),
      CREW_STATE_DIR: path.join(tempRoot, 'state'),
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
      HERDR_LOG: herdrLog,
      HERDR_STATE: herdrState,
    };
    resetHerdr();

    const remote = path.join(tempRoot, 'remote.git');
    execFileSync('git', ['init', '--bare', '-b', 'main', remote]);
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'crew@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Crew Test'], { cwd: repo });
    writeFileSync(path.join(repo, 'README.md'), '# demo\n');
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repo });
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/demo.git'], {
      cwd: repo,
    });

    writeFileSync(path.join(bin, 'herdr'), herdrShim());
    chmodSync(path.join(bin, 'herdr'), 0o755);
    expect(cli(['init']).status).toBe(0);
    configure('reviewr');
    expect(cli(['--json', 'project', 'add', '.', '--name', 'demo']).status).toBe(0);
  }

  function cleanup(): void {
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }

  return {
    setup,
    cleanup,
    configure,
    resetHerdr,
    cli,
    createTask,
    runTask,
    calls,
    opensFor,
  };
}
