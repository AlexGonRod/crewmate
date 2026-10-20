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

describe('pipeline pull requests', () => {
  let tempRoot: string;
  let repo: string;
  let remote: string;
  let env: Record<string, string>;
  let ghState: string;

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
    tempRoot = mkdtempSync(path.join(tmpdir(), 'crew-pr-'));
    repo = path.join(tempRoot, 'repo');
    remote = path.join(tempRoot, 'remote.git');
    ghState = path.join(tempRoot, 'gh-state.json');
    const bin = path.join(tempRoot, 'bin');
    mkdirSync(repo, { recursive: true });
    mkdirSync(bin, { recursive: true });
    env = {
      CREW_CONFIG_DIR: path.join(tempRoot, 'config'),
      CREW_DATA_DIR: path.join(tempRoot, 'data'),
      CREW_STATE_DIR: path.join(tempRoot, 'state'),
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
      GH_STATE: ghState,
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
      'https://github.com/acme/demo.git',
    ], { cwd: repo });
    execFileSync('git', ['config', 'remote.origin.pushurl', remote], {
      cwd: repo,
    });

    const gh = path.join(bin, 'gh');
    writeFileSync(
      gh,
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
    mergeable: process.env.GH_MERGEABLE || 'MERGEABLE',
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
  if (process.env.GH_MERGE_STATE === 'fail') {
    process.stderr.write('merge conflict\\n');
    process.exit(1);
  }
  item.state = 'MERGED';
  item.mergedAt = '2026-01-01T00:00:00Z';
  writeFileSync(statePath, JSON.stringify(item));
  process.stdout.write(item.url + '\\n');
  process.exit(0);
}
if (args[0] === 'api' && args[1].includes('/check-runs')) {
  const mode = process.env.GH_CI_STATE || 'pass';
  const checkRuns = mode === 'none'
    ? []
    : mode === 'fail'
      ? [{
          name: 'test',
          status: 'completed',
          conclusion: 'failure',
          html_url: 'https://ci/1',
        }]
      : [{
          name: 'test',
          status: 'completed',
          conclusion: 'success',
          html_url: 'https://ci/1',
        }];
  process.stdout.write(JSON.stringify({ total_count: checkRuns.length, check_runs: checkRuns }));
  process.exit(0);
}
process.stderr.write('gh shim: unsupported ' + args.join(' ') + '\\n');
process.exit(1);
`,
    );
    chmodSync(gh, 0o755);

    expect(cli(['init']).status).toBe(0);
    const configPath = path.join(repo, '.crew', 'config.yaml');
    const configText = readFileSync(configPath, 'utf8');
    expect(configText).toContain('verify: []');
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
          'auto_merge:',
          '  method: squash',
        ].join('\n'),
      ),
    );
    const added = cli(['--json', 'project', 'add', '.', '--name', 'demo']);
    expect(added.status, added.stderr).toBe(0);
    expect(added.json.project.forge).toBe('github');
  });

  afterAll(() => {
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('pushes a branch, opens a PR, and accepts only after it is merged', () => {
    const created = cli([
      '--json',
      'task',
      'create',
      '--project',
      'demo',
      '--title',
      'Pull request task',
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
    expect(run.json.prUrl).toBe('https://github.com/acme/demo/pull/1');
    expect(run.json.commitSha).toBeTruthy();
    expect(run.json.verifications[0].state).toBe('passed');
    expect(run.json.ci.state).toBe('passed');

    const branch = run.json.task.branch as string;
    const refs = execFileSync('git', ['--git-dir', remote, 'show-ref'], {
      encoding: 'utf8',
    });
    expect(refs).toContain(branch);
    expect(existsSync(ghState)).toBe(true);

    const premature = cli(['--json', 'task', 'accept', id]);
    expect(premature.status).toBe(1);
    expect(premature.stderr).toContain('PR_NOT_MERGED');

    const pullRequest = JSON.parse(readFileSync(ghState, 'utf8')) as Record<string, unknown>;
    writeFileSync(
      ghState,
      JSON.stringify({ ...pullRequest, state: 'MERGED', mergedAt: '2026-01-01T00:00:00Z' }),
    );

    const accepted = cli(['--json', 'task', 'accept', id]);
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(accepted.json.task.state).toBe('done');
  });

  it('fails the task when CI does not pass', () => {
    env.GH_CI_STATE = 'fail';
    try {
      const created = cli([
        '--json',
        'task',
        'create',
        '--project',
        'demo',
        '--title',
        'Failing CI task',
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
      expect(run.status).toBe(1);
      expect(run.json.task.state).toBe('failed');
      expect(run.json.ci.state).toBe('failed');
      expect(run.json.ci.summary).toContain('test');

      const shown = cli(['--json', 'task', 'show', id]);
      expect(
        shown.json.artifacts.some(
          (artifact: { kind: string }) => artifact.kind === 'ci',
        ),
      ).toBe(true);
      expect(
        shown.json.events.some(
          (event: { type: string }) => event.type === 'ci.completed',
        ),
      ).toBe(true);
    } finally {
      delete env.GH_CI_STATE;
    }
  });

  it('auto-merges when the policy, verification, tester, and CI all pass', () => {
    const created = cli([
      '--json',
      'task',
      'create',
      '--project',
      'demo',
      '--title',
      'Auto-merge task',
      '--brief',
      'Create an auto-merged marker file',
      '--methodology',
      'free',
      '--delivery',
      'auto_merge',
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
    expect(run.json.task.state).toBe('done');
    expect(run.json.ci.state).toBe('passed');
    expect(run.json.merge.state).toBe('merged');
    expect(run.json.merge.method).toBe('squash');
    expect(run.json.merge.actor).toBe('crew');

    const pullRequest = JSON.parse(readFileSync(ghState, 'utf8')) as Record<string, unknown>;
    expect(pullRequest.state).toBe('MERGED');

    const shown = cli(['--json', 'task', 'show', id]);
    expect(
      shown.json.artifacts.some(
        (artifact: { kind: string }) => artifact.kind === 'merge',
      ),
    ).toBe(true);
    expect(
      shown.json.events.some(
        (event: { type: string }) => event.type === 'merge.completed',
      ),
    ).toBe(true);
    expect(
      shown.json.events.some(
        (event: { type: string }) => event.type === 'task.accepted',
      ),
    ).toBe(true);
  });

  it('leaves the task in review when the automatic merge fails', () => {
    env.GH_MERGE_STATE = 'fail';
    try {
      const created = cli([
        '--json',
        'task',
        'create',
        '--project',
        'demo',
        '--title',
        'Auto-merge fallback task',
        '--brief',
        'Create a fallback marker file',
        '--methodology',
        'free',
        '--delivery',
        'auto_merge',
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
      expect(run.json.merge.state).toBe('failed');
      expect(run.json.merge.reason).toContain('merge conflict');
      expect(run.json.merge.reason).toContain('PR OPEN');

      const premature = cli(['--json', 'task', 'accept', id]);
      expect(premature.status).toBe(1);
      expect(premature.stderr).toContain('PR_NOT_MERGED');

      const pullRequest = JSON.parse(readFileSync(ghState, 'utf8')) as Record<string, unknown>;
      writeFileSync(
        ghState,
        JSON.stringify({ ...pullRequest, state: 'MERGED', mergedAt: '2026-01-01T00:00:00Z' }),
      );
      const accepted = cli(['--json', 'task', 'accept', id]);
      expect(accepted.status, accepted.stderr).toBe(0);
      expect(accepted.json.task.state).toBe('done');
    } finally {
      delete env.GH_MERGE_STATE;
    }
  });

  it('does not merge when the pull request is not mergeable', () => {
    env.GH_MERGEABLE = 'DIRTY';
    try {
      const created = cli([
        '--json',
        'task',
        'create',
        '--project',
        'demo',
        '--title',
        'Conflicting auto-merge task',
        '--brief',
        'Create a conflicting marker file',
        '--methodology',
        'free',
        '--delivery',
        'auto_merge',
      ]);
      expect(created.status, created.stderr).toBe(0);
      const run = cli([
        '--json',
        'task',
        'run',
        created.json.task.id as string,
        '--harness',
        'fake',
        '--env',
        'CREW_FAKE_SCENARIO=success',
        '--timeout',
        '10',
      ]);
      expect(run.status, run.stderr).toBe(0);
      expect(run.json.task.state).toBe('review');
      expect(run.json.merge.state).toBe('failed');
      expect(run.json.merge.reason).toContain('not mergeable (DIRTY)');
      expect(
        (JSON.parse(readFileSync(ghState, 'utf8')) as Record<string, unknown>).state,
      ).toBe('OPEN');
    } finally {
      delete env.GH_MERGEABLE;
    }
  });

  it('requires an explicit merge policy and CI config for auto-merge', () => {
    const configPath = path.join(repo, '.crew', 'config.yaml');
    const originalConfig = readFileSync(configPath, 'utf8');
    try {
      writeFileSync(
        configPath,
        originalConfig.replace('auto_merge:\n  method: squash\n', ''),
      );
      const created = cli([
        '--json',
        'task',
        'create',
        '--project',
        'demo',
        '--title',
        'Missing merge policy',
        '--brief',
        'Should not start',
        '--methodology',
        'free',
        '--delivery',
        'auto_merge',
      ]);
      expect(created.status, created.stderr).toBe(0);
      const run = cli([
        '--json',
        'task',
        'run',
        created.json.task.id as string,
        '--harness',
        'fake',
      ]);
      expect(run.status).toBe(1);
      expect(run.stderr).toContain('MERGE_POLICY_REQUIRED');
      expect(cli(['--json', 'task', 'show', created.json.task.id]).json.task.state).toBe(
        'draft',
      );

      writeFileSync(
        configPath,
        originalConfig.replace(
          'ci:\n  provider: github_actions\n  timeout_seconds: 10\n  interval_seconds: 1\n',
          '',
        ),
      );
      const noCi = cli([
        '--json',
        'task',
        'create',
        '--project',
        'demo',
        '--title',
        'Missing CI',
        '--brief',
        'Should not start either',
        '--methodology',
        'free',
        '--delivery',
        'auto_merge',
      ]);
      expect(noCi.status, noCi.stderr).toBe(0);
      const noCiRun = cli([
        '--json',
        'task',
        'run',
        noCi.json.task.id as string,
        '--harness',
        'fake',
      ]);
      expect(noCiRun.status).toBe(1);
      expect(noCiRun.stderr).toContain('CI_REQUIRED_FOR_AUTO_MERGE');
    } finally {
      writeFileSync(configPath, originalConfig);
    }
  });

  it('fails the task when no CI checks are reported before the timeout', () => {
    env.GH_CI_STATE = 'none';
    const configPath = path.join(repo, '.crew', 'config.yaml');
    const originalConfig = readFileSync(configPath, 'utf8');
    writeFileSync(
      configPath,
      originalConfig
        .replace('timeout_seconds: 10', 'timeout_seconds: 1')
        .replace('interval_seconds: 1', 'interval_seconds: 0.1'),
    );
    try {
      const created = cli([
        '--json',
        'task',
        'create',
        '--project',
        'demo',
        '--title',
        'Missing CI task',
        '--brief',
        'Create a third marker file',
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
      expect(run.status).toBe(1);
      expect(run.json.task.state).toBe('failed');
      expect(run.json.ci.state).toBe('error');
      expect(run.json.ci.summary).toContain('did not finish within 1s');
    } finally {
      writeFileSync(configPath, originalConfig);
      delete env.GH_CI_STATE;
    }
  });
});
