import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The `task decision` intake (ADR 0043): a review decided outside the editor
// (for example the herdr-reviewr plugin's paste) records the same decision
// artifacts, applies the same merge gates, and turns reject comments into
// review feedback the next developer attempt receives.

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const TSX = path.join(ROOT, 'node_modules', '.bin', 'tsx');
const CLI = path.join(ROOT, 'src', 'cli', 'main.ts');

interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
  json: any;
}

describe('task decision intake', () => {
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

  function queuedTask(title: string): string {
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
    expect(cli(['--json', 'task', 'queue', taskId]).json.task.state).toBe('queued');
    return taskId;
  }

  function runToOneReview(scenario: string): void {
    expect(
      cli([
        '--json',
        'daemon',
        'run',
        '--max-tasks',
        '1',
        '--harness',
        'fake',
        '--env',
        `CREW_FAKE_SCENARIO=${scenario}`,
        '--quiet',
      ]).status,
    ).toBe(0);
  }

  beforeAll(() => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'crew-decision-'));
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
    expect(cli(['--json', 'project', 'add', '.', '--name', 'demo']).status).toBe(0);
  });

  afterAll(() => {
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('turns the reviewr paste into a rejection the next attempt receives', () => {
    const taskId = queuedTask('Paste reject');
    runToOneReview('success');

    const paste = [
      'crew-decision: reject',
      'Fix each comment, then run the tests.',
      '- the change drops the second line of the marker',
    ].join('\n');

    // The agent that receives the reviewr paste calls the CLI with the paste
    // verbatim (after stripping nothing): the whole text is evidence.
    const comments = paste.split('\n').slice(1).join('\n');
    const decided = cli([
      '--json',
      'task',
      'decision',
      taskId,
      comments,
      '--reject',
      '--by',
      'alex',
      '--origin',
      'herdr-reviewr',
    ]);
    expect(decided.status, decided.stderr).toBe(0);
    expect(decided.json.decision).toBe('reject');
    expect(decided.json.taskState).toBe('queued');
    expect(decided.json.reason).toContain('the change drops the second line');

    // The next attempt receives the verbatim feedback, like any editor reject.
    runToOneReview('success');
    const shown = cli(['--json', 'task', 'show', taskId]);
    expect(shown.json.task.state).toBe('review');
    expect(shown.json.task.reviewIterations).toBe(1);
  });

  it('accepts through the merge gates when the paste says accept', () => {
    const taskId = queuedTask('Paste accept');
    runToOneReview('success');

    const decided = cli([
      '--json',
      'task',
      'decision',
      taskId,
      'looks good to me',
      '--accept',
      '--by',
      'alex',
      '--origin',
      'herdr-reviewr',
    ]);
    expect(decided.status, decided.stderr).toBe(0);
    expect(decided.json.decision).toBe('accept');
    expect(decided.json.taskState).toBe('done');
    expect(decided.json.accepted).toBe(true);

    const shown = cli(['--json', 'task', 'show', taskId]);
    expect(shown.json.task.state).toBe('done');
    const review = shown.json.artifacts
      .filter((artifact: { kind: string }) => artifact.kind === 'review')
      .at(-1) as { metadata: Record<string, unknown> };
    expect(review).toBeDefined();
    expect(review.metadata).toMatchObject({
      decision: 'accept',
      origin: 'herdr-reviewr',
      authorizedBy: 'alex',
    });
  });

  it('does not record anything without an explicit decision', () => {
    const taskId = queuedTask('Silence stays put');
    runToOneReview('success');

    const decided = cli(['--json', 'task', 'decision', taskId]);
    expect(decided.status).not.toBe(0);
    expect(decided.json).toBeNull();

    const shown = cli(['--json', 'task', 'show', taskId]);
    expect(shown.json.task.state).toBe('review');
  });
});
