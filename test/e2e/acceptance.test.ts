import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
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

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('fase 3 acceptance demo', () => {
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
    tempRoot = mkdtempSync(path.join(tmpdir(), 'crew-acceptance-'));
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
    writeFileSync(
      path.join(repo, 'package.json'),
      JSON.stringify({ name: 'demo', scripts: { test: 'node -e "process.exit(0)"' } }),
    );
    writeFileSync(path.join(repo, 'README.md'), '# demo\n');
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repo });

    expect(cli(['init']).status).toBe(0);
    const configPath = path.join(repo, '.crew', 'config.yaml');
    const configText = readFileSync(configPath, 'utf8');
    writeFileSync(
      configPath,
      `${configText.replace('verify: []', 'verify:\n  - test -f FAKE_AGENT_OUTPUT.txt')}\ndelivery:\n  yolo: true\n`,
    );
    expect(cli(['--json', 'project', 'add', '.', '--name', 'demo']).status).toBe(0);
  });

  afterAll(() => {
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('walks the whole flow: plan, workers, report and merge', () => {
    const planPath = path.join(tempRoot, 'plan.yaml');
    writeFileSync(
      planPath,
      [
        'schema: crew.plan/v1',
        'tasks:',
        '  - key: api',
        '    title: Acceptance API change',
        '    brief: Implement the health endpoint',
        '    acceptance:',
        '      - Returns 200',
        '  - key: docs',
        '    title: Acceptance docs change',
        '    brief: Document the health endpoint',
        '    acceptance:',
        '      - Mentions the endpoint',
        '',
      ].join('\n'),
    );

    const validation = cli(['--json', 'plan', 'validate', planPath]);
    expect(validation.status, validation.stderr).toBe(0);
    expect(validation.json.ok).toBe(true);
    expect(validation.json.groups).toEqual([['api', 'docs']]);

    const applied = cli(['--json', 'plan', 'apply', planPath, '--queue']);
    expect(applied.status, applied.stderr).toBe(0);
    const ids = applied.json.tasks.map((task: any) => task.id as string);
    expect(ids).toHaveLength(2);

    const run = cli([
      '--json',
      'daemon',
      'run',
      '--max-tasks',
      '2',
      '--concurrency',
      '2',
      '--harness',
      'fake',
      '--env',
      'CREW_FAKE_SCENARIO=spec_success',
      '--quiet',
    ]);
    expect(run.status, run.stderr).toBe(0);

    const worktrees = new Set<string>();
    for (const id of ids) {
      const shown = cli(['--json', 'task', 'show', id]);
      expect(shown.status, shown.stderr).toBe(0);
      expect(shown.json.task.state).toBe('review');
      expect(shown.json.summary.risk.level).toBe('low');
      expect(shown.json.summary.verification.state).toBe('passed');
      expect(shown.json.summary.ci).toBeNull();
      worktrees.add(shown.json.task.worktreePath as string);
    }
    expect(worktrees.size).toBe(2);
    expect(existsSync(path.join(repo, 'FAKE_AGENT_OUTPUT.txt'))).toBe(false);

    const status = cli(['--json', 'status', '--limit', '5']);
    expect(status.status, status.stderr).toBe(0);
    expect(status.json.tasks.every((task: any) => task.risk?.level === 'low')).toBe(true);
    expect(status.json.counts.review).toBe(2);

    for (const id of ids) {
      const merged = cli(['--json', 'task', 'merge', id, '--accept-only', '--by', 'user']);
      expect(merged.status, merged.stderr).toBe(0);
      expect(merged.json.decision.allowed).toBe(true);
      expect(merged.json.taskState).toBe('done');
    }

    const shown = cli(['--json', 'task', 'show', ids[0]]);
    const authorization = shown.json.events.find(
      (event: { type: string }) => event.type === 'task.authorized',
    );
    expect(authorization.actor).toBe('user');
    expect(authorization.payload.action).toBe('merge');
  });

  it('does not lose tasks when the daemon dies mid flight', async () => {
    const created = cli([
      '--json',
      'task',
      'create',
      '--no-request',
      '--project',
      'demo',
      '--title',
      'Interrupted task',
      '--brief',
      'Do the thing',
      '--methodology',
      'free',
    ]);
    const taskId = created.json.task.id as string;
    expect(cli(['--json', 'task', 'queue', taskId]).json.task.state).toBe('queued');

    const daemon = spawn(TSX, [CLI, 'daemon', 'run', '--harness', 'fake', '--env', 'CREW_FAKE_SCENARIO=timeout', '--quiet'], {
      cwd: repo,
      env: { ...process.env, ...env, NO_COLOR: '1' },
      detached: true,
      stdio: 'ignore',
    });

    try {
      await waitFor(() => {
        const shown = cli(['--json', 'task', 'show', taskId]);
        return shown.json.task.state === 'running';
      });
    } finally {
      const shown = cli(['--json', 'task', 'show', taskId]);
      for (const run of shown.json.runs) {
        if (run.pid) {
          try {
            process.kill(run.pid, 'SIGKILL');
          } catch {
            // the agent is already gone
          }
        }
      }
      if (daemon.pid) {
        try {
          process.kill(-daemon.pid, 'SIGKILL');
        } catch {
          daemon.kill('SIGKILL');
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    const reconciled = cli([
      '--json',
      'daemon',
      'reconcile',
      '--requeue',
      '--max-attempts',
      '2',
      '--backoff',
      '0',
      '--stale-after',
      '0',
    ]);
    expect(reconciled.status, reconciled.stderr).toBe(0);
    expect(reconciled.json.lost.length).toBeGreaterThan(0);

    const requeued = cli(['--json', 'task', 'show', taskId]);
    expect(requeued.json.task.state).toBe('queued');
    expect(requeued.json.task.attempts).toBe(1);

    const finished = cli([
      '--json',
      'daemon',
      'run',
      '--max-tasks',
      '1',
      '--harness',
      'fake',
      '--env',
      'CREW_FAKE_SCENARIO=success',
      '--quiet',
    ]);
    expect(finished.status, finished.stderr).toBe(0);

    const done = cli(['--json', 'task', 'show', taskId]);
    expect(done.json.task.state).toBe('review');
    const types = done.json.events.map((event: { type: string }) => event.type);
    expect(types).toContain('run.lost');
    expect(types).toContain('task.requeued');
  });
});
