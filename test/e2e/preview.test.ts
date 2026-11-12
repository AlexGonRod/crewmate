import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
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
const BASE_PORT = 4381;

interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
  json: any;
}

describe('task preview', () => {
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

  function stateFile(taskId: string): string {
    return path.join(env.CREW_DATA_DIR ?? '', 'previews', `${taskId}.json`);
  }

  function reviewedTask(title: string): string {
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
      `Make ${title}`,
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
    expect(run.json.task.state).toBe('review');
    return taskId;
  }

  beforeAll(() => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'crew-preview-e2e-'));
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
    writeFileSync(
      path.join(repo, '.crew', 'config.yaml'),
      [
        'schema: crew.project/v1',
        'name: demo',
        'default_branch: main',
        'methodology: free',
        'verify:',
        '  - node -e "process.exit(0)"',
        'preview:',
        '  command: >-',
        '    node -e "const http=require(\'node:http\');http.createServer((req,res)=>res.end(\'ok\')).listen(Number(process.argv[1]),\'127.0.0.1\')" {port}',
        `  port: ${BASE_PORT}`,
        '',
      ].join('\n'),
    );
    expect(cli(['--json', 'project', 'add', '.', '--name', 'demo']).status).toBe(0);
  });

  afterAll(() => {
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('starts the worktree, waits for readiness and is idempotent', () => {
    const id = reviewedTask('Preview one');
    const first = cli(['--json', 'task', 'preview', id]);
    expect(first.status, first.stderr).toBe(0);
    expect(first.json).toMatchObject({ taskId: id, running: true });
    expect(first.json.url).toBe(`http://localhost:${first.json.port}`);
    expect(first.json.port).toBeGreaterThanOrEqual(BASE_PORT);
    expect(first.json.pid).toBeGreaterThan(0);

    const again = cli(['--json', 'task', 'preview', id]);
    expect(again.status, again.stderr).toBe(0);
    expect(again.json).toMatchObject({
      pid: first.json.pid,
      port: first.json.port,
      url: first.json.url,
      running: true,
    });

    const shown = cli(['--json', 'task', 'show', id]);
    expect(shown.json.preview).toMatchObject({ url: first.json.url, running: true });
    expect(
      shown.json.events.some((event: { type: string }) => event.type === 'preview.started'),
    ).toBe(true);
    expect(cli(['task', 'show', id]).stdout).toContain(`Preview:   ${first.json.url}`);

    const review = cli(['--json', 'task', 'review', id, '--no-open']);
    expect(review.status, review.stderr).toBe(0);
    expect(readFileSync(review.json.bufferPath, 'utf8')).toContain(
      `#  Preview   ${first.json.url}`,
    );

    const stopped = cli(['--json', 'task', 'preview', id, '--stop']);
    expect(stopped.status, stopped.stderr).toBe(0);
    expect(stopped.json.running).toBe(false);
    expect(existsSync(stateFile(id))).toBe(false);
    const afterStop = cli(['--json', 'task', 'show', id]);
    expect(
      afterStop.json.events.some(
        (event: { type: string }) => event.type === 'preview.stopped',
      ),
    ).toBe(true);

    const twice = cli(['--json', 'task', 'preview', id, '--stop']);
    expect(twice.status, twice.stderr).toBe(0);
    expect(twice.json.running).toBe(false);
  });

  it('serves two tasks at the same time on different ports', () => {
    const one = reviewedTask('Preview parallel one');
    const two = reviewedTask('Preview parallel two');
    const first = cli(['--json', 'task', 'preview', one]);
    const second = cli(['--json', 'task', 'preview', two]);
    expect(first.status, first.stderr).toBe(0);
    expect(second.status, second.stderr).toBe(0);
    expect(first.json.port).not.toBe(second.json.port);
    expect(second.json.port).toBeGreaterThan(first.json.port);
    cli(['task', 'preview', one, '--stop']);
    cli(['task', 'preview', two, '--stop']);
  });

  it('stops the preview before cleaning the worktree', () => {
    const id = reviewedTask('Preview clean');
    const started = cli(['--json', 'task', 'preview', id]);
    expect(started.status, started.stderr).toBe(0);
    const pid = started.json.pid as number;

    const cleaned = cli(['--json', 'task', 'clean', id]);
    expect(cleaned.status, cleaned.stderr).toBe(0);
    expect(existsSync(stateFile(id))).toBe(false);
    expect(() => process.kill(pid, 0)).toThrow();
  });
});
