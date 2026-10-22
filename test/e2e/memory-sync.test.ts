import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

function cli(cwd: string, env: Record<string, string>, args: string[]): CliResult {
  const result = spawnSync(TSX, [CLI, ...args], {
    cwd,
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

function createProject(tempRoot: string, name: string): { repo: string; env: Record<string, string> } {
  const repo = path.join(tempRoot, name);
  mkdirSync(repo, { recursive: true });
  const env = {
    CREW_CONFIG_DIR: path.join(tempRoot, 'config'),
    CREW_DATA_DIR: path.join(tempRoot, 'data'),
    CREW_STATE_DIR: path.join(tempRoot, 'state'),
  };
  execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'crew@example.com'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'Crew Test'], { cwd: repo });
  writeFileSync(path.join(repo, 'README.md'), '# demo\n');
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: repo });
  const added = cli(repo, env, ['--json', 'project', 'add', '.', '--name', name]);
  expect(added.status, added.stderr).toBe(0);
  expect(added.json.project.name).toBe(name);
  return { repo, env };
}

describe('memory sync roundtrip', () => {
  let tempRoot: string;
  let repo: string;
  let env: Record<string, string>;
  let other: string;

  beforeAll(() => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'crew-memory-sync-'));
    ({ repo, env } = createProject(tempRoot, 'demo'));
    other = createProject(tempRoot, 'other').repo;
  });

  afterAll(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('exports the project memory into the repo file', () => {
    cli(repo, env, ['--json', 'memory', 'add', '--project', 'demo', '--kind', 'convention', '--title', 'Use pnpm', '--body', 'pnpm, never npm.']);
    const sync = cli(repo, env, ['--json', 'memory', 'sync', '--project', 'demo']);
    expect(sync.status, sync.stderr).toBe(0);
    expect(sync.json.imported).toBe(0);
    expect(sync.json.total).toBe(1);
    expect(sync.json.file).toBe(path.join(repo, '.crew', 'memory.json'));

    const file = JSON.parse(readFileSync(sync.json.file, 'utf8'));
    expect(file.schema).toBe('crew.memory/v1');
    expect(file.project).toBe('demo');
    expect(file.memories).toHaveLength(1);
    expect(file.memories[0]).toMatchObject({ kind: 'convention', title: 'Use pnpm', body: 'pnpm, never npm.' });
  });

  it('imports a handwritten file and stays idempotent on the next sync', () => {
    const file = path.join(repo, '.crew', 'memory.json');
    const current = JSON.parse(readFileSync(file, 'utf8'));
    current.memories.push(
      { kind: 'convention', title: 'Use pnpm', body: 'pnpm, never npm.' },
      { kind: 'pitfall', title: 'Wrangler only', body: 'Deploy via wrangler.' },
      { kind: 'bogus-kind', title: 'Fallback kind', body: 'kind falls through to context.' },
      { title: '', body: 'dropped' },
      { title: 'Dropped', body: '  ' },
    );
    writeFileSync(file, JSON.stringify(current, null, 2));

    const sync = cli(repo, env, ['--json', 'memory', 'sync', '--project', 'demo']);
    expect(sync.status, sync.stderr).toBe(0);
    expect(sync.json.imported).toBe(2);
    expect(sync.json.total).toBe(3);

    const listed = cli(repo, env, ['--json', 'memory', 'list', '--project', 'demo']);
    const kinds = listed.json.memories.map((memory: any) => memory.kind);
    expect(kinds).toContain('context');
    expect(kinds).not.toContain('bogus-kind');

    const again = cli(repo, env, ['--json', 'memory', 'sync', '--project', 'demo']);
    expect(again.status, again.stderr).toBe(0);
    expect(again.json.imported).toBe(0);
    expect(again.json.total).toBe(3);
  });

  it('rejects a malformed memory file', () => {
    const file = path.join(repo, '.crew', 'memory.json');
    const backup = readFileSync(file, 'utf8');
    writeFileSync(file, 'not json');
    const bad = cli(repo, env, ['--json', 'memory', 'sync', '--project', 'demo']);
    expect(bad.status).toBeGreaterThan(0);
    expect(bad.stderr).toContain('INVALID_MEMORY_FILE');
    // restore a valid file so later projects stay unaffected
    writeFileSync(file, backup);
  });

  it('does not leak one project memory into another', () => {
    const sync = cli(other, env, ['--json', 'memory', 'sync', '--project', 'other']);
    expect(sync.status, sync.stderr).toBe(0);
    expect(sync.json.imported).toBe(0);
    expect(sync.json.total).toBe(0);
    const file = JSON.parse(readFileSync(sync.json.file, 'utf8'));
    expect(file.project).toBe('other');
    expect(file.memories).toHaveLength(0);
  });
});
