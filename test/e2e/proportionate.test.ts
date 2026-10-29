import { execFileSync, spawnSync } from 'node:child_process';
import {
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

// ADR 0040: the proportionate policy skips the independent tester for
// low-risk changes with green verification, keeps it for anything unknown
// or riskier, and records every decision as durable evidence.

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const TSX = path.join(ROOT, 'node_modules', '.bin', 'tsx');
const CLI = path.join(ROOT, 'src', 'cli', 'main.ts');

interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
  json: any;
}

describe('proportionate review policy', () => {
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

  function queuedTask(title: string, brief: string): string {
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
      brief,
      '--methodology',
      'free',
    ]);
    expect(created.status, created.stderr).toBe(0);
    const taskId = created.json.task.id as string;
    expect(cli(['--json', 'task', 'queue', taskId]).json.task.state).toBe('queued');
    return taskId;
  }

  beforeAll(() => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'crew-proportionate-'));
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
      configText.replace('verify: []', 'verify:\n  - test -f FAKE_AGENT_OUTPUT.txt') +
        '\nreview:\n  mode: proportionate\ndelivery:\n  yolo: true\n',
    );
    expect(cli(['--json', 'project', 'add', '.', '--name', 'demo']).status).toBe(0);
  });

  afterAll(() => {
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('skips the tester for a low-risk change and records the route', () => {
    const taskId = queuedTask('Small change', 'Make the small change');
    const run = cli([
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
    expect(run.status, run.stderr).toBe(0);

    const shown = cli(['--json', 'task', 'show', taskId]);
    expect(shown.status, shown.stderr).toBe(0);
    expect(shown.json.task.state).toBe('review');
    expect(shown.json.summary.reviewRoute.route).toBe('skipped');
    expect(shown.json.summary.reviewRoute.reason).toContain('pre-commit risk is low');
    expect(shown.json.summary.tester).toBeNull();
    expect(shown.json.summary.verification.state).toBe('passed');
    expect(shown.json.summary.risk.level).toBe('low');
  });

  it('keeps the tester for anything riskier than low', () => {
    const taskId = queuedTask('Wide change', 'Make the wide change');
    const run = cli([
      '--json',
      'daemon',
      'run',
      '--max-tasks',
      '1',
      '--harness',
      'fake',
      '--env',
      'CREW_FAKE_DEVELOPER_SCENARIO=success_wide',
      '--env',
      'CREW_FAKE_TESTER_SCENARIO=success',
      '--quiet',
    ]);
    expect(run.status, run.stderr).toBe(0);

    const shown = cli(['--json', 'task', 'show', taskId]);
    expect(shown.json.task.state).toBe('review');
    expect(shown.json.summary.reviewRoute.route).toBe('tester');
    expect(shown.json.summary.reviewRoute.reason).toContain('medium');
    expect(shown.json.summary.tester).not.toBeNull();
    expect(shown.json.summary.tester.verdict).toBe('approve');
  });

  it('merges a skipped-route task: the recorded route waives the tester gate', () => {
    const shown = cli(['--json', 'task', 'list']);
    const tasks = shown.json.tasks as Array<{ id: string; title: string }>;
    const small = tasks.find((task) => task.title === 'Small change');
    expect(small).toBeDefined();
    const merged = cli(['--json', 'task', 'merge', small!.id, '--accept-only', '--by', 'user']);
    expect(merged.status, merged.stderr).toBe(0);
    expect(merged.json.decision.allowed).toBe(true);
    const gate = merged.json.decision.gates.find(
      (gate: { name: string }) => gate.name === 'tester approved',
    ) as { ok: boolean; detail: string };
    expect(gate.ok).toBe(true);
    expect(gate.detail).toContain('skipped under the proportionate policy');
    expect(merged.json.taskState).toBe('done');
  });

  it('reports the route metrics over the engine', () => {
    const skip = cli(['--json', 'metrics']);
    expect(skip.status, skip.stderr).toBe(0);
    expect(skip.json.routes).toEqual({ tester: 1, skipped: 1 });
    expect(skip.json.testerRunsSaved).toBe(1);
  });
});
