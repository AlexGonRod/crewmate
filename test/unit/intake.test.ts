import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  detectConsentItems,
  detectVerifyCommands,
  intakeProject,
  parseRepoRef,
} from '../../src/app/intake';
import { CrewError } from '../../src/core/errors';
import { Store } from '../../src/store/store';

const tempDirs: string[] = [];
const stores: Store[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'crew-intake-'));
  tempDirs.push(dir);
  return dir;
}

function createStore(): Store {
  const store = new Store(':memory:');
  stores.push(store);
  return store;
}

afterEach(() => {
  while (stores.length > 0) {
    stores.pop()?.close();
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('parseRepoRef', () => {
  it('parses https, ssh and short GitHub references', () => {
    expect(parseRepoRef('https://github.com/acme/widgets')).toMatchObject({
      owner: 'acme',
      name: 'widgets',
      slug: 'acme-widgets',
      cloneUrl: 'https://github.com/acme/widgets.git',
    });
    expect(parseRepoRef('https://github.com/acme/widgets.git')).toMatchObject({
      owner: 'acme',
      name: 'widgets',
    });
    expect(parseRepoRef('git@github.com:acme/widgets.git')).toMatchObject({
      owner: 'acme',
      name: 'widgets',
    });
    expect(parseRepoRef('acme/widgets')).toMatchObject({
      owner: 'acme',
      name: 'widgets',
    });
  });

  it('rejects references that are not GitHub repositories', () => {
    for (const input of ['https://gitlab.com/acme/widgets', 'not a repo']) {
      let code = '';
      try {
        parseRepoRef(input);
      } catch (error) {
        code = error instanceof CrewError ? error.code : 'unknown';
      }
      expect(code).toBe('REPO_URL_INVALID');
    }
  });
});

describe('detectVerifyCommands', () => {
  it('detects node projects with the right package manager', () => {
    const root = tempDir();
    writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ scripts: { test: 'vitest run', typecheck: 'tsc' } }),
    );
    writeFileSync(path.join(root, 'pnpm-lock.yaml'), '');
    expect(detectVerifyCommands(root)).toEqual({
      commands: ['pnpm test', 'pnpm run typecheck'],
      packageManager: 'pnpm',
      language: 'node',
    });
  });

  it('detects rust, go and python projects', () => {
    const rust = tempDir();
    writeFileSync(path.join(rust, 'Cargo.toml'), '[package]\nname = "x"\n');
    expect(detectVerifyCommands(rust).commands).toEqual(['cargo test']);

    const go = tempDir();
    writeFileSync(path.join(go, 'go.mod'), 'module x\n');
    expect(detectVerifyCommands(go).commands).toEqual(['go test ./...']);

    const python = tempDir();
    writeFileSync(path.join(python, 'pyproject.toml'), '[project]\nname = "x"\n');
    expect(detectVerifyCommands(python).commands).toEqual(['python -m pytest']);
  });

  it('detects a make test target', () => {
    const root = tempDir();
    writeFileSync(path.join(root, 'Makefile'), 'test:\n\tgo test ./...\n');
    expect(detectVerifyCommands(root).commands).toEqual(['make test']);
  });
});

describe('detectConsentItems', () => {
  it('asks for consent before installing dependencies', () => {
    const root = tempDir();
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }));
    writeFileSync(path.join(root, 'package-lock.json'), '{}');
    const items = detectConsentItems(root);
    const install = items.find((item) => item.action === 'install_dependencies');
    expect(install?.command).toBe('npm install');
    expect(install?.reason).toContain('node_modules');
  });

  it('does not ask twice when the dependencies are installed', () => {
    const root = tempDir();
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }));
    writeFileSync(path.join(root, 'package-lock.json'), '{}');
    mkdirSync(path.join(root, 'node_modules'));
    const items = detectConsentItems(root);
    expect(items.some((item) => item.action === 'install_dependencies')).toBe(false);
  });
});

describe('intakeProject', () => {
  function fakeClone(files: Record<string, string>) {
    return (_cloneUrl: string, destination: string): string => {
      mkdirSync(destination, { recursive: true });
      for (const [name, content] of Object.entries(files)) {
        writeFileSync(path.join(destination, name), content);
      }
      execFileSync('git', ['init', '-b', 'main'], { cwd: destination });
      execFileSync('git', ['config', 'user.email', 'crew@example.com'], {
        cwd: destination,
      });
      execFileSync('git', ['config', 'user.name', 'Crew Test'], {
        cwd: destination,
      });
      execFileSync('git', ['add', '.'], { cwd: destination });
      execFileSync('git', ['commit', '-m', 'initial'], { cwd: destination });
      return destination;
    };
  }

  it('clones, configures and registers the project', () => {
    const store = createStore();
    const projectsDir = tempDir();
    const result = intakeProject(store, {
      url: 'https://github.com/acme/widgets',
      projectsDir,
      clone: fakeClone({
        'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }),
        'package-lock.json': '{}',
      }),
      checkAccess: () => ({ accessible: true }),
    });

    expect(result.project.name).toBe('widgets');
    expect(result.project.rootPath).toBe(path.join(projectsDir, 'acme-widgets'));
    expect(result.clone.defaultBranch).toBe('main');
    expect(result.config.verify).toEqual(['npm test']);
    const config = readFileSync(result.config.path, 'utf8');
    expect(config).toContain('verify:');
    expect(store.listProjects()).toHaveLength(1);
    expect(result.consent.some((item) => item.action === 'install_dependencies')).toBe(true);
  });

  it('fails when the repository is not reachable', () => {
    const store = createStore();
    let code = '';
    try {
      intakeProject(store, {
        url: 'https://github.com/acme/widgets',
        projectsDir: tempDir(),
        checkAccess: () => ({ accessible: false, error: 'network down' }),
      });
    } catch (error) {
      code = error instanceof CrewError ? error.code : 'unknown';
    }
    expect(code).toBe('REPO_NOT_ACCESSIBLE');
  });
});
