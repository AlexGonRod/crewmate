import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
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

interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
  json: any;
}

describe('reviewing a task in the editor', () => {
  let tempRoot: string;
  let repo: string;
  let remote: string;
  let bin: string;
  let env: Record<string, string>;
  let ghState: string;

  function cli(args: string[], extraEnv: Record<string, string> = {}): CliResult {
    const result = spawnSync(TSX, [CLI, ...args], {
      cwd: repo,
      env: { ...process.env, ...env, ...extraEnv, NO_COLOR: '1', FORCE_COLOR: '0' },
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

  function createTask(title: string, extra: string[] = []): string {
    const created = cli([
      '--json',
      'task',
      'create',
      '--project',
      'demo',
      '--title',
      title,
      '--brief',
      'Create a marker file',
      '--methodology',
      'free',
      ...extra,
    ]);
    expect(created.status, created.stderr).toBe(0);
    return created.json.task.id as string;
  }

  function runTask(id: string, scenario = 'success'): CliResult {
    const run = cli([
      '--json',
      'task',
      'run',
      id,
      '--harness',
      'fake',
      '--env',
      `CREW_FAKE_SCENARIO=${scenario}`,
      '--timeout',
      '30',
    ]);
    // A task that needs input ends with the exit code 2 by design.
    const expected = scenario === 'needs_input' ? 2 : 0;
    expect(run.status, run.stderr).toBe(expected);
    return run;
  }

  beforeAll(() => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'crew-review-'));
    repo = path.join(tempRoot, 'repo');
    remote = path.join(tempRoot, 'remote.git');
    ghState = path.join(tempRoot, 'gh-state.json');
    bin = path.join(tempRoot, 'bin');
    mkdirSync(repo, { recursive: true });
    mkdirSync(bin, { recursive: true });
    env = {
      CREW_CONFIG_DIR: path.join(tempRoot, 'config'),
      CREW_DATA_DIR: path.join(tempRoot, 'data'),
      CREW_STATE_DIR: path.join(tempRoot, 'state'),
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
      GH_STATE: ghState,
      CREW_EDITOR: path.join(bin, 'editor'),
    };

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
    execFileSync('git', ['config', 'remote.origin.pushurl', remote], { cwd: repo });

    writeFileSync(
      path.join(bin, 'editor'),
      `#!/bin/sh
if [ -n "$CREW_FAKE_DECISION" ]; then
  sed -i.bak "s|^crew-decision:.*|crew-decision: $CREW_FAKE_DECISION|" "$1"
fi
if [ -n "$CREW_FAKE_REASON" ]; then
  sed -i.bak "s|^crew-reason:.*|crew-reason: $CREW_FAKE_REASON|" "$1"
fi
if [ -n "$CREW_FAKE_ANSWER" ]; then
  sed -i.bak "s|^crew-answer:.*|crew-answer: $CREW_FAKE_ANSWER|" "$1"
fi
`,
    );
    chmodSync(path.join(bin, 'editor'), 0o755);

    writeFileSync(
      path.join(bin, 'gh'),
      `#!/usr/bin/env node
const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
const statePath = process.env.GH_STATE;
function state() {
  if (!statePath || !existsSync(statePath)) return null;
  return JSON.parse(readFileSync(statePath, 'utf8'));
}
if (args[0] === 'auth' && args[1] === 'status') process.exit(0);
if (args[0] === 'pr' && args[1] === 'list') {
  const item = state();
  const head = args[args.indexOf('--head') + 1];
  const list = item && item.head === head ? [item] : [];
  process.stdout.write(JSON.stringify(list));
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'create') {
  const item = {
    url: 'https://github.com/acme/demo/pull/1',
    state: 'OPEN',
    mergedAt: null,
    mergeable: 'MERGEABLE',
    isDraft: false,
    number: 1,
    head: args[args.indexOf('--head') + 1],
    base: args[args.indexOf('--base') + 1],
  };
  writeFileSync(statePath, JSON.stringify(item));
  process.stdout.write(item.url + '\\n');
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'view') {
  const item = state();
  if (!item) process.exit(1);
  process.stdout.write(JSON.stringify(item));
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'merge') {
  const item = state();
  if (!item) process.exit(1);
  item.state = 'MERGED';
  item.mergedAt = '2026-01-01T00:00:00Z';
  writeFileSync(statePath, JSON.stringify(item));
  process.stdout.write(item.url + '\\n');
  process.exit(0);
}
if (args[0] === 'api' && args[1].includes('/check-runs')) {
  process.stdout.write(JSON.stringify({
    total_count: 1,
    check_runs: [{ name: 'test', status: 'completed', conclusion: 'success', html_url: 'https://ci/1' }],
  }));
  process.exit(0);
}
process.stderr.write('gh shim: unsupported ' + args.join(' ') + '\\n');
process.exit(1);
`,
    );
    chmodSync(path.join(bin, 'gh'), 0o755);

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
          'ci:',
          '  provider: github_actions',
          '  timeout_seconds: 10',
          '  interval_seconds: 1',
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

  it('writes a review buffer with the brief, the gates and the diff', () => {
    const id = createTask('Review buffer');
    runTask(id);
    const review = cli(['--json', 'task', 'review', id, '--no-open']);
    expect(review.status, review.stderr).toBe(0);
    expect(review.json.decision.decision).toBe('none');

    const buffer = readFileSync(review.json.bufferPath, 'utf8');
    expect(buffer).toContain('crew review');
    expect(buffer).toContain('crew-decision:');
    expect(buffer).toContain('Review buffer');
    expect(buffer).toContain('Diff (base...head)');
    expect(buffer).toContain('FAKE_AGENT_OUTPUT.txt');
    expect(buffer).toContain('verification passed');
  });

  it('accepts the task from the editor and merges the pull request', () => {
    const id = createTask('Accept from the editor', ['--delivery', 'pr']);
    runTask(id);
    expect(cli(['--json', 'task', 'show', id]).json.task.state).toBe('review');

    const review = cli(['--json', 'task', 'review', id], {
      CREW_FAKE_DECISION: 'accept',
      CREW_FAKE_REASON: 'looks good to me',
    });
    expect(review.status, review.stderr).toBe(0);
    expect(review.json.decision.decision).toBe('accept');
    expect(review.json.merged).toBe(true);
    expect(review.json.merge.state).toBe('merged');

    const detail = cli(['--json', 'task', 'show', id]);
    expect(detail.json.task.state).toBe('done');
    const artifact = detail.json.artifacts.find(
      (item: { kind: string }) => item.kind === 'review',
    );
    expect(artifact.metadata.decision).toBe('accept');
    expect(artifact.metadata.reason).toBe('looks good to me');
  });

  it('rejects the task from the editor and sends the feedback back', () => {
    const id = createTask('Reject from the editor');
    runTask(id);

    const review = cli(['--json', 'task', 'review', id], {
      CREW_FAKE_DECISION: 'reject',
      CREW_FAKE_REASON: 'the change does not match the brief',
    });
    expect(review.status, review.stderr).toBe(0);
    expect(review.json.decision.decision).toBe('reject');
    expect(review.json.reason).toBe('the change does not match the brief');

    const detail = cli(['--json', 'task', 'show', id]);
    expect(detail.json.task.state).toBe('queued');
    const artifact = detail.json.artifacts.find(
      (item: { kind: string }) => item.kind === 'review',
    );
    expect(artifact.metadata.decision).toBe('reject');
  });

  it('changes nothing when the editor closes without a decision', () => {
    const id = createTask('No decision');
    runTask(id);

    const review = cli(['--json', 'task', 'review', id]);
    expect(review.status, review.stderr).toBe(0);
    expect(review.json.decision.decision).toBe('none');
    expect(review.json.merged).toBe(false);

    const detail = cli(['--json', 'task', 'show', id]);
    expect(detail.json.task.state).toBe('review');
    const artifact = detail.json.artifacts.find(
      (item: { kind: string }) => item.kind === 'review',
    );
    expect(artifact.metadata.decision).toBe('none');
  });

  it('answers a waiting task from the editor', () => {
    const id = createTask('Needs an answer');
    runTask(id, 'needs_input');
    expect(cli(['--json', 'task', 'show', id]).json.task.state).toBe('waiting_input');

    const answer = cli(['--json', 'task', 'answer', id], {
      CREW_FAKE_ANSWER: 'use the existing adapter',
    });
    expect(answer.status, answer.stderr).toBe(0);
    expect(answer.json.answered).toBe(true);
    expect(answer.json.answer).toBe('use the existing adapter');
    expect(answer.json.taskState).toBe('queued');

    const buffer = readFileSync(answer.json.bufferPath, 'utf8');
    expect(buffer).toContain('crew answer');
    expect(buffer).toContain('crew-answer:');

    const detail = cli(['--json', 'task', 'show', id]);
    const messages = detail.json.messages as Array<{ kind: string; body: string }>;
    expect(messages.some((message) => message.body === 'use the existing adapter')).toBe(
      true,
    );
  });

  it('keeps the text answer working without the editor', () => {
    const id = createTask('Answer with text');
    runTask(id, 'needs_input');
    const answer = cli(['--json', 'task', 'answer', id, '--text', 'use the text path']);
    expect(answer.status, answer.stderr).toBe(0);
    expect(answer.json.task.state).toBe('queued');
  });
});
