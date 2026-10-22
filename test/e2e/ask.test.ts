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

describe('the request enters through the captain', () => {
  let tempRoot: string;
  let repo: string;
  let env: Record<string, string>;

  function cli(args: string[], input?: string): CliResult {
    const result = spawnSync(TSX, [CLI, ...args], {
      cwd: repo,
      env: { ...process.env, ...env, NO_COLOR: '1', FORCE_COLOR: '0' },
      encoding: 'utf8',
      timeout: 60_000,
      input,
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
    tempRoot = mkdtempSync(path.join(tmpdir(), 'crew-ask-'));
    repo = path.join(tempRoot, 'repo');
    env = {
      CREW_CONFIG_DIR: path.join(tempRoot, 'config'),
      CREW_DATA_DIR: path.join(tempRoot, 'data'),
      CREW_STATE_DIR: path.join(tempRoot, 'state'),
      CREW_FAKE_SESSION_ID: 'ses_fake_captain',
    };
    mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'crew@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Crew Test'], { cwd: repo });
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

  it('asks the captain and hands it the request verbatim', () => {
    const result = cli([
      '--json',
      'ask',
      'arregla el bug de login',
      '--project',
      'demo',
      '--harness',
      'fake',
      '--timeout',
      '20',
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.json.answer).toContain('arregla el bug de login');
    expect(result.json.sessionId).toBe('ses_fake_captain');

    const prompt = readFileSync(result.json.promptPath as string, 'utf8');
    expect(prompt).toContain('> arregla el bug de login');
    expect(prompt).toContain('## Petición de la persona');
    expect(prompt).toContain('--request');
    expect(prompt).toContain('# Captain (crew)');
  });

  it('keeps the conversation across turns with crew chat', () => {
    const result = cli(
      ['--json', 'chat', '--project', 'demo', '--harness', 'fake', '--timeout', '20'],
      'primera peticion\nsegunda peticion\n/exit\n',
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('primera peticion');
    expect(result.stdout).toContain('segunda peticion');
  });

  it('refuses a task without the request of the person', () => {
    const refused = cli([
      '--json',
      'task',
      'create',
      '--project',
      'demo',
      '--title',
      'sin peticion',
      '--brief',
      'haz algo',
      '--methodology',
      'free',
    ]);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('REQUEST_REQUIRED');
  });

  it('stores the request verbatim and who asked for it', () => {
    const created = cli([
      '--json',
      'task',
      'create',
      '--project',
      'demo',
      '--title',
      'con peticion',
      '--request',
      'arregla el login sin tocar la sesion',
      '--brief',
      'Arregla el login',
      '--methodology',
      'free',
    ]);
    expect(created.status, created.stderr).toBe(0);
    expect(created.json.task.requestText).toBe('arregla el login sin tocar la sesion');
    expect(created.json.task.origin).toBe('person');

    const shown = cli(['--json', 'task', 'show', created.json.task.id as string]);
    expect(shown.status, shown.stderr).toBe(0);
    expect(shown.json.task.requestText).toBe('arregla el login sin tocar la sesion');
    expect(shown.json.task.origin).toBe('person');
  });

  it('lets tooling opt out explicitly', () => {
    const created = cli([
      '--json',
      'task',
      'create',
      '--project',
      'demo',
      '--title',
      'sin persona',
      '--brief',
      'haz algo',
      '--methodology',
      'free',
      '--no-request',
    ]);
    expect(created.status, created.stderr).toBe(0);
    expect(created.json.task.requestText).toBeNull();
    expect(created.json.task.origin).toBe('cli');

    const both = cli([
      '--json',
      'task',
      'create',
      '--project',
      'demo',
      '--title',
      'mezcla',
      '--brief',
      'haz algo',
      '--methodology',
      'free',
      '--request',
      'una cosa',
      '--no-request',
    ]);
    expect(both.status, both.stderr).toBe(0);
    expect(both.json.task.requestText).toBeNull();
  });
});
