import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
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

function runCli(
  args: string[],
  options: { cwd: string; env: Record<string, string> },
): CliResult {
  const result = spawnSync(TSX, [CLI, ...args], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env, NO_COLOR: '1', FORCE_COLOR: '0' },
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

describe('role contracts', () => {
  let tempRoot: string;
  let repo: string;
  let env: Record<string, string>;

  function cli(args: string[]): CliResult {
    return runCli(args, { cwd: repo, env });
  }

  beforeAll(() => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'crew-roles-e2e-'));
    repo = path.join(tempRoot, 'repo');
    mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'crew@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Crew Test'], { cwd: repo });
    writeFileSync(path.join(repo, 'README.md'), '# demo\n');
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repo });
    env = {
      CREW_CONFIG_DIR: path.join(tempRoot, 'config'),
      CREW_DATA_DIR: path.join(tempRoot, 'data'),
      CREW_STATE_DIR: path.join(tempRoot, 'state'),
    };
    const init = cli(['init']);
    expect(init.status, init.stderr).toBe(0);
    const added = cli(['--json', 'project', 'add', '.', '--name', 'demo']);
    expect(added.status, added.stderr).toBe(0);
  });

  afterAll(() => {
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('lists the contracts and says where they come from', () => {
    const listed = cli(['--json', 'role', 'list', '--project', 'demo']);
    expect(listed.status, listed.stderr).toBe(0);
    expect(listed.json.contracts).toHaveLength(3);
    for (const contract of listed.json.contracts) {
      expect(contract.source).toBe('default');
    }
  });

  it('writes a contract in the project so it can be edited', () => {
    const written = cli(['--json', 'role', 'init', 'tester']);
    expect(written.status, written.stderr).toBe(0);
    const target = path.join(repo, '.crew', 'roles', 'tester.md');
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, 'utf8')).toContain('# Tester (crew)');

    const again = cli(['role', 'init', 'tester']);
    expect(again.status).toBe(1);
    expect(again.stderr).toContain('ROLE_AGENTS_EXISTS');

    const forced = cli(['--json', 'role', 'init', 'tester', '--force']);
    expect(forced.status, forced.stderr).toBe(0);
  });

  it('uses the contract of the project instead of the default one', () => {
    const target = path.join(repo, '.crew', 'roles', 'developer.md');
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, '# Developer (del proyecto)\n', 'utf8');

    const listed = cli(['--json', 'role', 'list', '--project', 'demo']);
    const developer = listed.json.contracts.find(
      (contract: any) => contract.role === 'developer',
    );
    expect(developer.source).toBe('project');

    const shown = cli(['--json', 'role', 'show', 'developer', '--project', 'demo']);
    expect(shown.status, shown.stderr).toBe(0);
    expect(shown.json.source).toBe('project');
    expect(shown.json.contract).toContain('# Developer (del proyecto)');
  });
});
