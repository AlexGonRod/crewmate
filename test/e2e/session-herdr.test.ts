import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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

/**
 * A fake herdr that speaks the same JSON protocol: it creates workspaces and
 * panes, runs the command in the background and records its output.
 */
const FAKE_HERDR = `#!/usr/bin/env node
const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const { spawn } = require('node:child_process');
const args = process.argv.slice(2);
const statePath = process.env.HERDR_STATE;

function load() {
  if (!statePath || !existsSync(statePath)) return { workspaces: [], panes: [] };
  return JSON.parse(readFileSync(statePath, 'utf8'));
}
function save(state) {
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}
function ok(result) {
  process.stdout.write(JSON.stringify({ id: 'cli:fake', result }));
  process.exit(0);
}
function fail(message) {
  process.stdout.write(JSON.stringify({ error: { code: 'fake_error', message } }));
  process.exit(1);
}
function option(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

if (args[0] === '--version') {
  process.stdout.write('herdr 0.9.3\\n');
  process.exit(0);
}
if (args[0] === 'status' && args[1] === 'server') {
  ok({ type: 'server_status', status: 'running', version: '0.9.3' });
}

const state = load();
if (args[0] === 'workspace' && args[1] === 'create') {
  const id = 'w' + (state.workspaces.length + 1);
  const label = option('--label') || id;
  const cwd = option('--cwd') || process.cwd();
  const paneId = id + ':p1';
  state.workspaces.push({ workspace_id: id, label, agent_status: 'unknown', pane_count: 1 });
  state.panes.push({ pane_id: paneId, workspace_id: id, label, cwd, agent_status: 'unknown', output: '' });
  save(state);
  ok({
    type: 'workspace_created',
    workspace: { workspace_id: id, label },
    root_pane: { pane_id: paneId, workspace_id: id },
  });
}
if (args[0] === 'workspace' && args[1] === 'list') {
  ok({ type: 'workspace_list', workspaces: state.workspaces });
}
if (args[0] === 'workspace' && args[1] === 'close') {
  const id = args[2];
  state.workspaces = state.workspaces.filter((item) => item.workspace_id !== id);
  state.panes = state.panes.filter((item) => item.workspace_id !== id);
  save(state);
  ok({ type: 'workspace_closed' });
}
if (args[0] === 'pane' && args[1] === 'list') {
  const workspace = option('--workspace');
  const panes = workspace
    ? state.panes.filter((item) => item.workspace_id === workspace)
    : state.panes;
  ok({ type: 'pane_list', panes });
}
if (args[0] === 'pane' && args[1] === 'get') {
  const pane = state.panes.find((item) => item.pane_id === args[2]);
  if (!pane) fail('pane not found');
  ok({ type: 'pane_info', pane });
}
if (args[0] === 'pane' && args[1] === 'run') {
  const pane = state.panes.find((item) => item.pane_id === args[2]);
  if (!pane) fail('pane not found');
  const command = args[3];
  pane.agent_status = 'working';
  save(state);
  const child = spawn('/bin/sh', ['-c', command], { detached: true, stdio: 'ignore' });
  child.unref();
  ok({ type: 'pane_run', pane_id: pane.pane_id });
}
if (args[0] === 'pane' && args[1] === 'read') {
  const pane = state.panes.find((item) => item.pane_id === args[2]);
  if (!pane) fail('pane not found');
  process.stdout.write(pane.output || '');
  process.exit(0);
}
if (args[0] === 'pane' && args[1] === 'close') {
  state.panes = state.panes.filter((item) => item.pane_id !== args[2]);
  save(state);
  ok({ type: 'pane_closed' });
}
if (args[0] === 'pane' && args[1] === 'process-info') {
  const pane = option('--pane');
  ok({ type: 'pane_process_info', process_info: { pane_id: pane, shell_pid: 4242, foreground_processes: [{ pid: 4242 }] } });
}
fail('fake herdr: unsupported ' + args.join(' '));
`;

describe('sessions in herdr', () => {
  let tempRoot: string;
  let repo: string;
  let bin: string;
  let env: Record<string, string>;

  function cli(args: string[]): { status: number; stdout: string; stderr: string; json: any } {
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

  beforeAll(() => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'crew-herdr-'));
    repo = path.join(tempRoot, 'repo');
    bin = path.join(tempRoot, 'bin');
    mkdirSync(repo, { recursive: true });
    mkdirSync(bin, { recursive: true });
    env = {
      CREW_CONFIG_DIR: path.join(tempRoot, 'config'),
      CREW_DATA_DIR: path.join(tempRoot, 'data'),
      CREW_STATE_DIR: path.join(tempRoot, 'state'),
      HERDR_STATE: path.join(tempRoot, 'herdr-state.json'),
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
    };

    execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'crew@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Crew Test'], { cwd: repo });
    writeFileSync(path.join(repo, 'README.md'), '# demo\n');
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repo });

    writeFileSync(path.join(bin, 'herdr'), FAKE_HERDR);
    chmodSync(path.join(bin, 'herdr'), 0o755);

    expect(cli(['init']).status).toBe(0);
    expect(cli(['--json', 'project', 'add', '.', '--name', 'demo']).status).toBe(0);
  });

  afterAll(() => {
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('runs the agent in a herdr workspace and records the exit code', () => {
    const created = cli([
      '--json',
      'task',
      'create',
      '--project',
      'demo',
      '--title',
      'Herdr session',
      '--brief',
      'Create a marker file',
      '--methodology',
      'free',
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
      '60',
      '--session',
      'herdr',
    ]);
    expect(run.status, run.stderr).toBe(0);
    expect(run.json.task.state).toBe('review');

    const state = JSON.parse(
      readFileSync(path.join(tempRoot, 'herdr-state.json'), 'utf8'),
    ) as { workspaces: Array<{ label: string }>; panes: Array<{ output: string }> };
    expect(state.workspaces.some((item) => item.label.startsWith('crew-'))).toBe(true);

    const exitFiles = globExitFiles(path.join(tempRoot, 'data', 'tasks'));
    expect(exitFiles.length).toBeGreaterThan(0);
    expect(exitFiles.every((file) => file.trim() === '0')).toBe(true);
  });

  it('lists the herdr sessions with their backend', () => {
    const listed = cli(['--json', 'sessions', 'list']);
    expect(listed.status, listed.stderr).toBe(0);
    const backends = listed.json.backends as Array<{ id: string; available: boolean }>;
    expect(backends.find((backend) => backend.id === 'herdr')?.available).toBe(true);
    const sessions = listed.json.sessions as Array<{ backend: string; name: string }>;
    expect(sessions.some((session) => session.backend === 'herdr')).toBe(true);
  });

  it('kills a herdr session', () => {
    const listed = cli(['--json', 'sessions', 'list']);
    const session = (listed.json.sessions as Array<{ backend: string; name: string }>).find(
      (item) => item.backend === 'herdr',
    );
    expect(session).toBeDefined();
    const killed = cli(['--json', 'sessions', 'kill', session!.name]);
    expect(killed.status, killed.stderr).toBe(0);
    expect(killed.json.backend).toBe('herdr');
  });
});

function globExitFiles(dir: string): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) {
    return results;
  }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...globExitFiles(full));
    } else if (entry.name === 'exit') {
      results.push(readFileSync(full, 'utf8'));
    }
  }
  return results;
}
