import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

describe('captain layer', () => {
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
    tempRoot = mkdtempSync(path.join(tmpdir(), 'crew-captain-'));
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
    const configPath = path.join(repo, '.crew', 'config.yaml');
    const configText = readFileSync(configPath, 'utf8');
    writeFileSync(
      configPath,
      configText.replace('verify: []', 'verify:\n  - test -f FAKE_AGENT_OUTPUT.txt'),
    );
    expect(cli(['--json', 'project', 'add', '.', '--name', 'demo']).status).toBe(0);
  });

  afterAll(() => {
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('writes the captain instructions and refuses to overwrite them', () => {
    const first = cli(['--json', 'captain', 'init']);
    expect(first.status, first.stderr).toBe(0);
    expect(first.json.created).toBe(true);
    const instructions = readFileSync(path.join(repo, 'AGENTS.md'), 'utf8');
    expect(instructions).toContain('# Captain (crew)');
    expect(instructions).toContain('crew --json captain brief');

    const second = cli(['captain', 'init']);
    expect(second.status).toBe(1);
    expect(second.stderr).toContain('CAPTAIN_AGENTS_EXISTS');

    const forced = cli(['--json', 'captain', 'init', '--force']);
    expect(forced.status, forced.stderr).toBe(0);
    expect(forced.json.overwritten).toBe(false);
  });

  it('briefs the captain with projects, counts and what needs attention', () => {
    const created = cli([
      '--json',
      'task',
      'create',
      '--project',
      'demo',
      '--title',
      'Captain task',
      '--brief',
      'Do the thing',
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
      '20',
    ]);
    expect(run.status, run.stderr).toBe(0);

    const brief = cli(['--json', 'captain', 'brief']);
    expect(brief.status, brief.stderr).toBe(0);
    expect(brief.json.projects[0].name).toBe('demo');
    expect(brief.json.totalTasks).toBe(1);
    expect(brief.json.counts.review).toBe(1);
    expect(brief.json.attention[0]).toMatchObject({
      taskId,
      state: 'review',
    });
    expect(brief.json.tasks[0].risk.level).toBe('low');
    expect(brief.json.tasks[0].verification.state).toBe('passed');

    const text = cli(['captain', 'brief']);
    expect(text.status, text.stderr).toBe(0);
    expect(text.stdout).toContain('Needs attention:');
    expect(text.stdout).toContain(taskId);
  });

  it('applies a plan and runs the tasks respecting their dependencies', () => {
    const planPath = path.join(tempRoot, 'plan.yaml');
    writeFileSync(
      planPath,
      [
        'schema: crew.plan/v1',
        'tasks:',
        '  - key: api',
        '    title: Plan API task',
        '    brief: Implement the health endpoint',
        '    acceptance:',
        '      - Returns 200',
        '  - key: docs',
        '    title: Plan docs task',
        '    brief: Document the health endpoint',
        '    acceptance:',
        '      - Mentions the endpoint',
        '    depends_on:',
        '      - api',
        '',
      ].join('\n'),
    );

    const validation = cli(['--json', 'plan', 'validate', planPath]);
    expect(validation.status, validation.stderr).toBe(0);
    expect(validation.json.ok).toBe(true);
    expect(validation.json.groups).toEqual([['api'], ['docs']]);

    const applied = cli(['--json', 'plan', 'apply', planPath, '--queue']);
    expect(applied.status, applied.stderr).toBe(0);
    expect(applied.json.tasks).toHaveLength(2);
    const api = applied.json.tasks.find((task: any) => task.key === 'api');
    const docs = applied.json.tasks.find((task: any) => task.key === 'docs');
    expect(api.state).toBe('queued');
    expect(docs.state).toBe('queued');

    const shown = cli(['--json', 'task', 'show', docs.id]);
    expect(shown.json.dependencies).toEqual([api.id]);

    const run = cli([
      '--json',
      'daemon',
      'run',
      '--max-tasks',
      '2',
      '--harness',
      'fake',
      '--env',
      'CREW_FAKE_SCENARIO=spec_success',
      '--quiet',
    ]);
    expect(run.status, run.stderr).toBe(0);

    const apiShown = cli(['--json', 'task', 'show', api.id]);
    const docsShown = cli(['--json', 'task', 'show', docs.id]);
    expect(apiShown.json.task.state).toBe('review');
    expect(docsShown.json.task.state).toBe('review');
    const apiEnded = apiShown.json.runs.at(-1).endedAt as string;
    const docsStarted = docsShown.json.runs.at(0).startedAt as string;
    expect(Date.parse(docsStarted)).toBeGreaterThanOrEqual(Date.parse(apiEnded));
  });

  it('reports the progress of a task in plain language', () => {
    const created = cli([
      '--json',
      'task',
      'create',
      '--project',
      'demo',
      '--title',
      'Progress task',
      '--brief',
      'Do the thing',
      '--methodology',
      'free',
    ]);
    const taskId = created.json.task.id as string;

    const queued = cli(['--json', 'task', 'queue', taskId]);
    expect(queued.status, queued.stderr).toBe(0);

    const progress = cli(['--json', 'progress', taskId]);
    expect(progress.status, progress.stderr).toBe(0);
    expect(progress.json.state).toBe('queued');
    expect(progress.json.next).toContain('waiting in the queue');
    expect(progress.json.summary.state).toBe('queued');

    const text = cli(['progress', taskId]);
    expect(text.status, text.stderr).toBe(0);
    expect(text.stdout).toContain(`Task ${taskId} [queued]`);
    expect(text.stdout).toContain('Next:');
    expect(text.stdout).toContain('Risk:');
  });

  it('runs the tasks of one project one at a time in serial mode', () => {
    const configDir = env.CREW_CONFIG_DIR as string;
    const configPath = path.join(configDir, 'config.yaml');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      configPath,
      ['scheduling:', '  concurrency: 2', '  mode: serial', ''].join('\n'),
    );

    try {
      const ids: string[] = [];
      for (const title of ['Serial first', 'Serial second']) {
        const created = cli([
          '--json',
          'task',
          'create',
          '--project',
          'demo',
          '--title',
          title,
          '--brief',
          'Do the thing',
          '--methodology',
          'free',
        ]);
        ids.push(created.json.task.id as string);
        cli(['--json', 'task', 'queue', created.json.task.id as string]);
      }

      const queued = cli(['--json', 'task', 'list', '--state', 'queued']);
      const maxTasks = queued.json.tasks.length;

      const run = cli([
        '--json',
        'daemon',
        'run',
        '--max-tasks',
        String(maxTasks),
        '--harness',
        'fake',
        '--env',
        'CREW_FAKE_SCENARIO=success',
        '--quiet',
      ]);
      expect(run.status, run.stderr).toBe(0);

      const first = cli(['--json', 'task', 'show', ids[0] as string]).json;
      const second = cli(['--json', 'task', 'show', ids[1] as string]).json;
      const firstEnded = first.runs.at(-1).endedAt as string;
      const secondStarted = second.runs.at(0).startedAt as string;
      expect(Date.parse(secondStarted)).toBeGreaterThanOrEqual(Date.parse(firstEnded));
    } finally {
      rmSync(configPath, { force: true });
    }
  });

  it('limits the briefing to a single project', () => {
    const brief = cli(['--json', 'captain', 'brief', '--project', 'demo']);
    expect(brief.status, brief.stderr).toBe(0);
    expect(brief.json.totalTasks).toBeGreaterThan(0);
    expect(brief.json.tasks.every((task: any) => task.taskId)).toBe(true);

    const unknown = cli(['--json', 'captain', 'brief', '--project', 'nope']);
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain('PROJECT_NOT_FOUND');
  });
});
