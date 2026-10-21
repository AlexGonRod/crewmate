import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
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

function runCli(
  args: string[],
  options: { cwd: string; env: Record<string, string> },
): CliResult {
  const result = spawnSync(TSX, [CLI, ...args], {
    cwd: options.cwd,
    env: {
      ...process.env,
      ...options.env,
      NO_COLOR: '1',
      FORCE_COLOR: '0',
    },
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
  return {
    status: result.status ?? 1,
    stdout,
    stderr: result.stderr ?? '',
    json,
  };
}

describe('phase 0 walking skeleton', () => {
  let tempRoot: string;
  let repo: string;
  let env: Record<string, string>;
  let toolBin: string;

  function cli(args: string[]): CliResult {
    return runCli(args, { cwd: repo, env });
  }

  function createTask(
    title: string,
    brief = 'Create a marker file',
    extra: string[] = ['--methodology', 'free'],
  ): string {
    const result = cli([
      '--json',
      'task',
      'create',
      '--project',
      'demo',
      '--title',
      title,
      '--brief',
      brief,
      ...extra,
    ]);
    expect(result.status, result.stderr).toBe(0);
    return result.json.task.id as string;
  }

  function createSpecTask(
    title: string,
    methodology: 'spec' | 'tdd',
    criteria: string[],
  ): string {
    return createTask(title, 'Implement the requested behaviour', [
      '--methodology',
      methodology,
      ...criteria.flatMap((criterion) => ['--acceptance', criterion]),
    ]);
  }

  function runTask(
    id: string,
    scenario: string,
    extra: string[] = [],
    timeout = '10',
  ): CliResult {
    return cli([
      '--json',
      'task',
      'run',
      id,
      '--harness',
      'fake',
      '--env',
      `CREW_FAKE_SCENARIO=${scenario}`,
      '--timeout',
      timeout,
      ...extra,
    ]);
  }

  beforeAll(() => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'crew-e2e-'));
    repo = path.join(tempRoot, 'repo');
    env = {
      CREW_CONFIG_DIR: path.join(tempRoot, 'config'),
      CREW_DATA_DIR: path.join(tempRoot, 'data'),
      CREW_STATE_DIR: path.join(tempRoot, 'state'),
    };

    toolBin = path.join(tempRoot, 'tool-bin');
    mkdirSync(toolBin, { recursive: true });
    symlinkSync(
      process.execPath,
      path.join(toolBin, process.platform === 'win32' ? 'node.exe' : 'node'),
    );

    mkdirSync(repo, { recursive: true });
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
    expect(configText).toContain('verify: []');
    writeFileSync(
      configPath,
      configText.replace(
        'verify: []',
        'verify:\n  - test -f FAKE_AGENT_OUTPUT.txt',
      ),
    );
    const added = cli(['--json', 'project', 'add', '.', '--name', 'demo']);
    expect(added.status, added.stderr).toBe(0);
    expect(added.json.project.defaultBranch).toBe('main');
  });

  afterAll(() => {
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('runs a fake agent to done and cleans a dirty worktree only with --force', () => {
    const id = createTask('Fake success');
    const result = runTask(id, 'success');
    expect(result.status, result.stderr).toBe(0);
    expect(result.json.task.state).toBe('review');
    expect(result.json.developerReport.status).toBe('done');
    expect(result.json.testerReport.payload.verdict).toBe('approve');
    expect(result.json.runs.at(-1).state).toBe('exited');
    expect(result.json.runs.at(-1).exitCode).toBe(0);
    expect(result.json.commitSha).toBeTruthy();
    expect(result.json.verifications).toHaveLength(1);
    expect(result.json.verifications[0]).toMatchObject({
      command: 'test -f FAKE_AGENT_OUTPUT.txt',
      state: 'passed',
      exitCode: 0,
    });

    const accepted = cli(['--json', 'task', 'accept', id]);
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(accepted.json.task.state).toBe('done');

    const worktree = result.json.task.worktreePath as string;
    expect(existsSync(path.join(worktree, 'FAKE_AGENT_OUTPUT.txt'))).toBe(true);
    expect(existsSync(path.join(worktree, '.crew', 'brief.md'))).toBe(true);
    writeFileSync(path.join(worktree, 'dirty.txt'), 'dirty\n');

    const refused = cli(['task', 'clean', id]);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('WORKTREE_DIRTY');

    const cleaned = cli(['--json', 'task', 'clean', id, '--force']);
    expect(cleaned.status, cleaned.stderr).toBe(0);
    expect(existsSync(worktree)).toBe(false);
    expect(cleaned.json.task.worktreePath).toBeNull();

    const shown = cli(['--json', 'task', 'show', id]);
    expect(shown.status, shown.stderr).toBe(0);
    expect(shown.json.task.state).toBe('done');
    expect(shown.json.verifications[0].state).toBe('passed');
    expect(shown.json.events.length).toBeGreaterThan(0);
  });

  it('summarizes risk, verification and tester state for a task', () => {
    const id = createTask('Risk summary');
    const result = runTask(id, 'success');
    expect(result.status, result.stderr).toBe(0);

    const shown = cli(['--json', 'task', 'show', id]);
    expect(shown.status, shown.stderr).toBe(0);
    const summary = shown.json.summary;
    expect(summary.taskId).toBe(id);
    expect(summary.state).toBe('review');
    expect(summary.risk.level).toBe('low');
    expect(summary.risk.score).toBe(0);
    expect(summary.risk.change.files).toBeGreaterThan(0);
    expect(summary.verification.state).toBe('passed');
    expect(summary.verification.total).toBe(1);
    expect(summary.tester.verdict).toBe('approve');
    expect(summary.ci).toBeNull();
    expect(summary.pr).toBeNull();

    const text = cli(['task', 'show', id]);
    expect(text.status, text.stderr).toBe(0);
    expect(text.stdout).toContain('Risk:');
    expect(text.stdout).toContain('low');
    expect(text.stdout).toContain('Verify:');
  });

  it('shows a crew status overview with risk and CI summaries', () => {
    const id = createTask('Status overview');
    const result = runTask(id, 'success');
    expect(result.status, result.stderr).toBe(0);

    const status = cli(['--json', 'status', '--limit', '5']);
    expect(status.status, status.stderr).toBe(0);
    expect(status.json.total_tasks).toBeGreaterThan(0);
    expect(status.json.counts.review).toBeGreaterThan(0);
    expect(status.json.active_runs).toBe(0);
    const entry = status.json.tasks.find((task: any) => task.taskId === id);
    expect(entry).toBeTruthy();
    expect(entry.risk.level).toBe('low');
    expect(entry.verification.state).toBe('passed');
    expect(entry.ci).toBeNull();

    const text = cli(['status', '--limit', '3']);
    expect(text.status, text.stderr).toBe(0);
    expect(text.stdout).toContain('Lease:');
    expect(text.stdout).toContain('Recent tasks:');
    expect(text.stdout).toContain('RISK');
  });

  it('marks a crash without a report as failed', () => {
    const id = createTask('Fake crash');
    const result = runTask(id, 'crash');
    expect(result.status).toBe(1);
    expect(result.json.task.state).toBe('failed');
    expect(result.json.report).toBeNull();
  });

  it('rejects a malformed report and marks the task failed', () => {
    const id = createTask('Fake malformed');
    const result = runTask(id, 'malformed');
    expect(result.status).toBe(1);
    expect(result.json.task.state).toBe('failed');

    const shown = cli(['--json', 'task', 'show', id]);
    const failed = shown.json.events.find(
      (event: { type: string }) => event.type === 'task.failed',
    );
    expect(failed.payload.reason).toContain('Invalid agent report');
  });

  it('supports needs_input followed by answer and a second attempt', () => {
    const id = createTask('Fake needs input');
    const first = runTask(id, 'needs_input');
    expect(first.status).toBe(2);
    expect(first.json.task.state).toBe('waiting_input');
    expect(first.json.report.status).toBe('needs_input');

    const answered = cli([
      '--json',
      'task',
      'answer',
      id,
      '--text',
      'Use the existing design system',
    ]);
    expect(answered.status, answered.stderr).toBe(0);
    expect(answered.json.task.state).toBe('queued');

    const second = runTask(id, 'success');
    expect(second.status, second.stderr).toBe(0);
    expect(second.json.task.state).toBe('review');
    const developerRuns = (second.json.runs as Array<{ role: string; attempt: number }>).filter(
      (run) => run.role === 'developer',
    );
    expect(developerRuns.at(-1)?.attempt).toBe(2);
    expect(cli(['--json', 'task', 'accept', id]).json.task.state).toBe('done');

    const shown = cli(['--json', 'task', 'show', id]);
    expect(shown.json.messages.some((message: { body: string }) =>
      message.body.includes('existing design system'),
    )).toBe(true);
  });

  it('times out a stuck agent', () => {
    const id = createTask('Fake timeout');
    const started = Date.now();
    const result = runTask(id, 'timeout', [], '1');
    const elapsed = Date.now() - started;
    expect(result.status).toBe(1);
    expect(result.json.task.state).toBe('failed');
    expect(result.json.runs.at(-1).state).toBe('failed');
    expect(elapsed).toBeLessThan(20_000);
  });

  it('reports doctor and event JSON', () => {
    const doctor = cli(['--json', 'doctor']);
    expect(doctor.status, doctor.stderr).toBe(0);
    expect(doctor.json.ok).toBe(true);
    expect(Array.isArray(doctor.json.checks)).toBe(true);

    const tasks = cli(['--json', 'task', 'list']);
    expect(tasks.status, tasks.stderr).toBe(0);
    const id = tasks.json.tasks[0].id as string;
    const events = cli(['--json', 'events', '--task', id]);
    expect(events.status, events.stderr).toBe(0);
    expect(Array.isArray(events.json.events)).toBe(true);
  });

  it('lists harness availability and rejects unavailable harnesses before creating a worktree', () => {
    const list = cli(['--json', 'harness', 'list']);
    expect(list.status, list.stderr).toBe(0);
    const byId = new Map(
      (list.json.harnesses as Array<{ id: string; available: boolean }>).map((entry) => [
        entry.id,
        entry,
      ]),
    );
    expect(byId.get('fake')?.available).toBe(true);
    expect(typeof byId.get('opencode')?.available).toBe('boolean');

    const id = createTask('OpenCode unavailable');
    const restrictedPath = {
      ...env,
      PATH: [toolBin, '/usr/bin', '/bin'].join(path.delimiter),
    };

    const missing = runCli(
      ['--json', 'task', 'run', id, '--harness', 'opencode'],
      { cwd: repo, env: restrictedPath },
    );
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('HARNESS_UNAVAILABLE');

    const auto = runCli(['--json', 'task', 'run', id, '--harness', 'auto'], {
      cwd: repo,
      env: restrictedPath,
    });
    expect(auto.status).toBe(1);
    expect(auto.stderr).toContain('No real harness detected');

    const shown = cli(['--json', 'task', 'show', id]);
    expect(shown.json.task.state).toBe('draft');
    expect(shown.json.task.worktreePath).toBeNull();
    expect(shown.json.runs).toHaveLength(0);
  });

  it('defaults new projects to the spec methodology', () => {
    const rejected = cli([
      '--json',
      'task',
      'create',
      '--project',
      'demo',
      '--title',
      'Spec without criteria',
      '--brief',
      'Do the thing',
    ]);
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain('SPEC_REQUIRED');

    const created = cli([
      '--json',
      'task',
      'create',
      '--project',
      'demo',
      '--title',
      'Default spec task',
      '--brief',
      'Do the thing',
      '--acceptance',
      'The thing exists',
    ]);
    expect(created.status, created.stderr).toBe(0);
    expect(created.json.task.methodology).toBe('spec');
    expect(created.json.task.spec.acceptance_criteria[0].id).toBe('AC1');
  });

  it('creates a spec task from a spec file', () => {
    const specPath = path.join(tempRoot, 'health.yaml');
    writeFileSync(
      specPath,
      [
        'goal: Implement the health endpoint',
        'acceptance_criteria:',
        '  - text: It returns 200',
        '  - id: AC2',
        '    text: It has an integration test',
        'non_goals:',
        '  - Authentication',
        '',
      ].join('\n'),
    );
    const created = cli([
      '--json',
      'task',
      'create',
      '--project',
      'demo',
      '--title',
      'Spec file task',
      '--spec-file',
      specPath,
    ]);
    expect(created.status, created.stderr).toBe(0);
    expect(created.json.task.spec.goal).toBe('Implement the health endpoint');
    expect(created.json.task.spec.acceptance_criteria).toEqual([
      { id: 'AC1', text: 'It returns 200' },
      { id: 'AC2', text: 'It has an integration test' },
    ]);
    expect(created.json.task.spec.non_goals).toEqual(['Authentication']);

    const result = runTask(created.json.task.id as string, 'spec_success');
    expect(result.status, result.stderr).toBe(0);
    expect(result.json.task.state).toBe('review');
  });

  it('runs a spec task and records acceptance evidence', () => {
    const id = createSpecTask('Spec success', 'spec', [
      'The marker file exists',
      'The report covers both criteria',
    ]);
    const result = runTask(id, 'spec_success');
    expect(result.status, result.stderr).toBe(0);
    expect(result.json.task.state).toBe('review');
    expect(result.json.developerReport.schema).toBe('crew.report/v2');
    expect(result.json.developerReport.payload.acceptance).toHaveLength(2);

    const shown = cli(['--json', 'task', 'show', id]);
    expect(shown.status, shown.stderr).toBe(0);
    expect(shown.json.task.methodology).toBe('spec');
    expect(shown.json.verifications[0].state).toBe('passed');
  });

  it('fails a spec task when acceptance evidence is missing', () => {
    const id = createSpecTask('Spec missing evidence', 'spec', [
      'The marker file exists',
      'The report covers both criteria',
    ]);
    const result = runTask(id, 'spec_missing_evidence');
    expect(result.status).toBe(1);
    expect(result.json.task.state).toBe('failed');
    expect(result.json.report).toBeNull();

    const shown = cli(['--json', 'task', 'show', id]);
    const failed = shown.json.events.find(
      (event: { type: string }) => event.type === 'task.failed',
    );
    expect(failed.payload.reason).toContain('Missing acceptance evidence');
    expect(failed.payload.reason).toContain('AC2');
  });

  it('runs a tdd task with red and green evidence', () => {
    const id = createSpecTask('TDD success', 'tdd', ['The marker file exists']);
    const result = runTask(id, 'tdd_success');
    expect(result.status, result.stderr).toBe(0);
    expect(result.json.task.state).toBe('review');
    expect(
      result.json.developerReport.payload.tests.map((test: { phase: string }) => test.phase),
    ).toEqual(['red', 'green']);
  });

  it('fails a tdd task without a red phase', () => {
    const id = createSpecTask('TDD missing red', 'tdd', ['The marker file exists']);
    const result = runTask(id, 'tdd_missing_red');
    expect(result.status).toBe(1);
    expect(result.json.task.state).toBe('failed');

    const shown = cli(['--json', 'task', 'show', id]);
    const failed = shown.json.events.find(
      (event: { type: string }) => event.type === 'task.failed',
    );
    expect(failed.payload.reason).toContain('phases: red');
  });

  it('queues a task and runs it through the daemon', () => {
    const id = createTask('Daemon success');
    expect(cli(['--json', 'task', 'queue', id]).json.task.state).toBe('queued');

    const statusBefore = cli(['--json', 'daemon', 'status']);
    expect(statusBefore.status, statusBefore.stderr).toBe(0);
    expect(statusBefore.json.queued_tasks).toBe(1);
    expect(statusBefore.json.lease).toBeNull();

    const result = cli([
      '--json',
      'daemon',
      'run',
      '--once',
      '--harness',
      'fake',
      '--env',
      'CREW_FAKE_SCENARIO=success',
      '--quiet',
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.json.stopped).toBe('once');
    expect(result.json.processed).toHaveLength(1);
    expect(result.json.processed[0].taskState).toBe('review');
    expect(result.json.processed[0].reportStatus).toBe('done');

    const statusAfter = cli(['--json', 'daemon', 'status']);
    expect(statusAfter.json.queued_tasks).toBe(0);
    expect(statusAfter.json.lease).toBeNull();
    expect(cli(['--json', 'task', 'accept', id]).json.task.state).toBe('done');
  });

  it('runs queued tasks concurrently without worktree or state collisions', () => {
    const first = createTask('Concurrent first');
    const second = createTask('Concurrent second');
    expect(cli(['--json', 'task', 'queue', first]).json.task.state).toBe('queued');
    expect(cli(['--json', 'task', 'queue', second]).json.task.state).toBe('queued');

    const result = cli([
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
      'CREW_FAKE_SCENARIO=success',
      '--quiet',
    ]);
    expect(result.status, result.stderr).toBe(0);
    const lines = result.stdout
      .trim()
      .split(/\r?\n/)
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line));
    const stopped = lines.find((line) => line.event === 'daemon.stopped');
    expect(stopped.stopped).toBe('max_tasks');
    expect(stopped.processed).toHaveLength(2);

    const startedAt = (id: string): number => {
      const detail = cli(['--json', 'task', 'show', id]).json;
      const event = detail.events.find(
        (item: { type: string }) => item.type === 'task.started',
      );
      return Date.parse(event.createdAt);
    };
    const reviewedAt = (id: string): number => {
      const detail = cli(['--json', 'task', 'show', id]).json;
      const event = detail.events.find(
        (item: { type: string }) => item.type === 'task.review.requested',
      );
      return Date.parse(event.createdAt);
    };

    expect(startedAt(second)).toBeLessThan(reviewedAt(first));
    expect(startedAt(first)).toBeLessThan(reviewedAt(second));
    expect(cli(['--json', 'task', 'show', first]).json.task.state).toBe('review');
    expect(cli(['--json', 'task', 'show', second]).json.task.state).toBe('review');
    expect(cli(['--json', 'task', 'accept', first]).json.task.state).toBe('done');
    expect(cli(['--json', 'task', 'accept', second]).json.task.state).toBe('done');
  });

  it('reclaims stale runs and retries the failed task', () => {
    const id = createTask('Daemon retry');
    cli(['--json', 'task', 'queue', id]);

    const crashed = cli([
      '--json',
      'daemon',
      'run',
      '--once',
      '--harness',
      'fake',
      '--env',
      'CREW_FAKE_SCENARIO=crash',
      '--quiet',
    ]);
    expect(crashed.status).toBe(1);
    expect(crashed.json.processed[0].taskState).toBe('failed');

    const reconciled = cli(['--json', 'daemon', 'reconcile']);
    expect(reconciled.status, reconciled.stderr).toBe(0);
    expect(reconciled.json.lost).toEqual([]);

    const retried = cli(['--json', 'task', 'retry', id]);
    expect(retried.status, retried.stderr).toBe(0);
    expect(retried.json.task.state).toBe('queued');

    const result = cli([
      '--json',
      'daemon',
      'run',
      '--once',
      '--harness',
      'fake',
      '--env',
      'CREW_FAKE_SCENARIO=success',
      '--quiet',
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.json.processed[0].taskState).toBe('review');
    expect(cli(['--json', 'task', 'accept', id]).json.task.state).toBe('done');
  });

  it('rejects review when independent verification fails', () => {
    const specPath = path.join(tempRoot, 'verify-failure.yaml');
    writeFileSync(
      specPath,
      [
        'goal: Exercise deterministic verification',
        'acceptance_criteria:',
        '  - id: AC1',
        '    text: The developer marker exists',
        '  - id: AC2',
        '    text: A required file is missing on purpose',
        '    verify: test -f NEVER_CREATED.txt',
        '',
      ].join('\n'),
    );
    const created = cli([
      '--json',
      'task',
      'create',
      '--project',
      'demo',
      '--title',
      'Verification failure',
      '--spec-file',
      specPath,
    ]);
    expect(created.status, created.stderr).toBe(0);
    const id = created.json.task.id as string;

    const first = runTask(id, 'spec_success', ['--max-iterations', '1']);
    expect(first.status).toBe(1);
    expect(first.json.task.state).toBe('queued');
    expect(first.json.task.reviewIterations).toBe(1);
    expect(first.json.testerReport).toBeNull();
    expect(first.json.runs.every((run: { role: string }) => run.role === 'developer')).toBe(
      true,
    );
    expect(
      first.json.verifications.some(
        (verification: { state: string; command: string }) =>
          verification.state === 'failed' &&
          verification.command === 'test -f NEVER_CREATED.txt',
      ),
    ).toBe(true);

    const shown = cli(['--json', 'task', 'show', id]);
    expect(
      shown.json.messages.some((message: { body: string }) =>
        message.body.includes('Independent verification failed'),
      ),
    ).toBe(true);
    expect(
      shown.json.messages.some((message: { body: string }) =>
        message.body.includes('test -f NEVER_CREATED.txt'),
      ),
    ).toBe(true);

    const second = runTask(id, 'spec_success', ['--max-iterations', '1']);
    expect(second.status).toBe(1);
    expect(second.json.task.state).toBe('failed');
    expect(second.json.task.reviewIterations).toBe(2);
    const failedShow = cli(['--json', 'task', 'show', id]);
    const failed = failedShow.json.events.find(
      (event: { type: string }) => event.type === 'task.failed',
    );
    expect(failed.payload.reason).toContain('Independent verification failed');
  });

  it('rejects unsupported delivery modes before starting an agent', () => {
    const id = createTask('Unsupported delivery', 'Do the thing', [
      '--methodology',
      'free',
      '--delivery',
      'scout',
    ]);
    const result = runTask(id, 'success');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('DELIVERY_UNSUPPORTED');

    const shown = cli(['--json', 'task', 'show', id]);
    expect(shown.json.task.state).toBe('draft');
    expect(shown.json.runs).toHaveLength(0);
  });

  it('requeues after tester rejection and fails at the iteration limit', () => {
    const id = createTask('Tester rejection');
    const rejected = runTask(id, 'success', [
      '--env',
      'CREW_FAKE_TESTER_SCENARIO=tester_reject',
    ]);
    expect(rejected.status).toBe(1);
    expect(rejected.json.task.state).toBe('queued');
    expect(rejected.json.task.reviewIterations).toBe(1);

    for (let iteration = 2; iteration <= 3; iteration += 1) {
      const next = runTask(id, 'success', [
        '--env',
        'CREW_FAKE_TESTER_SCENARIO=tester_reject',
      ]);
      expect(next.status).toBe(1);
      expect(next.json.task.state).toBe('queued');
      expect(next.json.task.reviewIterations).toBe(iteration);
    }

    const exhausted = runTask(id, 'success', [
      '--env',
      'CREW_FAKE_TESTER_SCENARIO=tester_reject',
    ]);
    expect(exhausted.status).toBe(1);
    expect(exhausted.json.task.state).toBe('failed');
    expect(exhausted.json.task.reviewIterations).toBe(4);

    const shown = cli(['--json', 'task', 'show', id]);
    expect(
      shown.json.messages.filter(
        (message: { kind: string }) => message.kind === 'review_feedback',
      ),
    ).toHaveLength(4);
    const failed = shown.json.events.find(
      (event: { type: string }) => event.type === 'task.failed',
    );
    expect(failed.payload.reason).toContain('Review rejected 4 times');
  });

  it('keeps the main checkout free of tracked changes', () => {
    const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
      cwd: repo,
      encoding: 'utf8',
    });
    expect(status.trim()).toBe('');
    expect(readFileSync(path.join(repo, 'README.md'), 'utf8')).toBe('# demo\n');
  });
});
