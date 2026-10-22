import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  let crewBin: string;

  function cli(
    args: string[],
    input?: string,
    extraEnv: Record<string, string> = {},
  ): CliResult {
    const result = spawnSync(TSX, [CLI, ...args], {
      cwd: repo,
      env: { ...process.env, ...env, ...extraEnv, NO_COLOR: '1', FORCE_COLOR: '0' },
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

    const binDir = path.join(tempRoot, 'bin');
    mkdirSync(binDir, { recursive: true });
    crewBin = path.join(binDir, 'crew');
    writeFileSync(crewBin, `#!/bin/sh\nexec "${TSX}" "${CLI}" "$@"\n`);
    chmodSync(crewBin, 0o755);
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

  it('follows the work it created until review', () => {
    const result = cli(
      [
        '--json',
        'ask',
        'cambia el saludo por hola',
        '--project',
        'demo',
        '--harness',
        'fake',
        '--timeout',
        '30',
        '--follow',
      ],
      undefined,
      {
        CREW_BIN: crewBin,
        CREW_FAKE_CAPTAIN_CREATE: '1',
        CREW_FAKE_CAPTAIN_PROJECT: 'demo',
        CREW_FAKE_SCENARIO: 'commit',
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.json.answer).toContain('tsk_');
    expect(result.json.daemon).toBe('ran');
    expect(result.json.tasks).toHaveLength(1);
    expect(result.json.tasks[0].state).toBe('review');
    expect(result.json.followUp).toHaveLength(1);
    expect(result.json.followUp[0].answer).toContain('Seguimiento');

    const prompt = readFileSync(result.json.followUp[0].promptPath as string, 'utf8');
    expect(prompt).toContain('## Seguimiento del motor');
    expect(prompt).toContain(result.json.tasks[0].taskId);
    expect(prompt).not.toContain('## Petición de la persona');
  });

  it('answers the question of a worker and follows the new attempt', () => {
    const result = cli(
      [
        '--json',
        'ask',
        'cambia el saludo por hola',
        '--project',
        'demo',
        '--harness',
        'fake',
        '--timeout',
        '30',
        '--follow',
      ],
      undefined,
      {
        CREW_BIN: crewBin,
        CREW_FAKE_CAPTAIN_CREATE: '1',
        CREW_FAKE_CAPTAIN_PROJECT: 'demo',
        CREW_FAKE_CAPTAIN_ANSWER: '1',
        CREW_FAKE_DEVELOPER_SCENARIO: 'needs_input_once',
        CREW_FAKE_TESTER_SCENARIO: 'commit',
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.json.tasks).toHaveLength(1);
    expect(result.json.tasks[0].state).toBe('review');
    expect(result.json.followUp).toHaveLength(2);
    expect(result.json.followUp[0].answer.toLowerCase()).toContain('respondida');
    expect(result.json.followUp[1].answer).toContain('Seguimiento');

    const first = readFileSync(result.json.followUp[0].promptPath as string, 'utf8');
    expect(first).toContain(result.json.tasks[0].taskId);
    expect(first).toContain('Pregunta sin responder');

    const shown = cli(['--json', 'task', 'show', result.json.tasks[0].taskId as string]);
    expect(shown.status, shown.stderr).toBe(0);
    const answers = (shown.json.messages as Array<Record<string, string>>).filter(
      (message) => message.direction === 'in' && message.kind === 'answer',
    );
    expect(answers).toHaveLength(1);
    expect(answers[0]?.body).toBe('usa el diseno existente');
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
