import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initProject } from '../../src/app/projects';

let root: string | null = null;

function tempRepo(): string {
  root = mkdtempSync(path.join(tmpdir(), 'crew-init-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'crew@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Crew Test'], { cwd: root });
  writeFileSync(path.join(root, 'README.md'), '# demo\n');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: root });
  return root;
}

afterEach(() => {
  if (root) {
    rmSync(root, { recursive: true, force: true });
    root = null;
  }
});

describe('initProject', () => {
  it('generates the config with detected verify commands', () => {
    const repo = tempRepo();
    writeFileSync(
      path.join(repo, 'package.json'),
      JSON.stringify({ scripts: { test: 'vitest run', typecheck: 'tsc' } }),
    );
    writeFileSync(path.join(repo, 'pnpm-lock.yaml'), '');

    const result = initProject(repo);

    expect(result.verify).toEqual(['pnpm test', 'pnpm run typecheck']);
    const configText = readFileSync(path.join(repo, '.crew', 'config.yaml'), 'utf8');
    expect(configText).toContain('verify:');
    expect(configText).toContain('pnpm test');
    expect(configText).not.toContain('verify: []');
  });

  it('generates verify: [] when the toolchain has nothing to confirm', () => {
    const repo = tempRepo();

    const result = initProject(repo);

    expect(result.verify).toEqual([]);
    const configText = readFileSync(path.join(repo, '.crew', 'config.yaml'), 'utf8');
    expect(configText).toContain('verify: []');
  });

  it('keeps the rest of the generated shape', () => {
    const repo = tempRepo();

    const result = initProject(repo);

    expect(result.name).toBe(path.basename(repo));
    expect(result.defaultBranch).toBe('main');
    expect(existsSync(result.configPath)).toBe(true);
    const configText = readFileSync(result.configPath, 'utf8');
    expect(configText).toContain("schema: crew.project/v1");
    expect(configText).toContain("methodology: spec");
  });
});
