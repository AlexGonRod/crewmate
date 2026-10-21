import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Project, Task } from '../../src/core/types';
import {
  checkRemoteRunner,
  commitWorkspace,
  describeTaskLocation,
  diffStatsWorkspace,
  ensureWorkspace,
  LocalWorkspace,
  pushWorkspace,
  RemoteWorkspace,
  removeWorkspace,
  resolveWorkspace,
} from '../../src/app/workspace';

const tempDirs: string[] = [];
const originalPath = process.env.PATH;

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'crew-workspace-'));
  tempDirs.push(dir);
  return dir;
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function makeRepo(dir: string): string {
  const repo = path.join(dir, 'repo');
  mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
  git(['config', 'user.email', 'crew@example.com'], repo);
  git(['config', 'user.name', 'Crew Test'], repo);
  writeFileSync(path.join(repo, 'README.md'), '# demo\n');
  git(['add', '.'], repo);
  git(['commit', '-m', 'initial'], repo);
  return repo;
}

const project = (rootPath: string): Project =>
  ({
    id: 'prj_1',
    name: 'demo',
    rootPath,
    forge: null,
    defaultBranch: 'main',
    createdAt: '2026-01-01T00:00:00.000Z',
  }) as unknown as Project;

const task = (): Task =>
  ({
    id: 'tsk_1',
    projectId: 'prj_1',
    title: 'Remote task',
    branch: 'crew/tsk_1-remote-task',
    worktreePath: null,
  }) as unknown as Task;

describe('workspace resolution', () => {
  it('keeps everything local without a runner', () => {
    const resolution = resolveWorkspace({
      project: project('/repo'),
      projectConfig: null,
      task: task(),
      worktreesDir: '/worktrees',
    });
    expect(resolution.runner).toBeNull();
    expect(resolution.workspace.kind).toBe('local');
    expect(resolution.remoteCode).toBe(false);
    expect(resolution.workspace.worktreePath).toBe('/worktrees/demo/tsk_1');
  });

  it('keeps the git operations local when the runner has no repo_path', () => {
    const resolution = resolveWorkspace({
      project: project('/repo'),
      projectConfig: {
        runner: { host: 'builder@server' },
      },
      task: task(),
      worktreesDir: '/worktrees',
    });
    expect(resolution.runner?.host).toBe('builder@server');
    expect(resolution.workspace.kind).toBe('local');
    expect(resolution.remoteCode).toBe(false);
  });

  it('moves the worktree to the remote host when repo_path is configured', () => {
    const resolution = resolveWorkspace({
      project: project('/repo'),
      projectConfig: {
        runner: { host: 'builder@server', repo_path: '/srv/repos/demo' },
      },
      task: task(),
      worktreesDir: '/worktrees',
    });
    expect(resolution.workspace.kind).toBe('remote');
    expect(resolution.remoteCode).toBe(true);
    expect(resolution.workspace.repoPath).toBe('/srv/repos/demo');
    expect(resolution.workspace.worktreePath).toBe(
      '/srv/repos/crew-worktrees/demo/tsk_1',
    );
  });

  it('uses the configured worktree root', () => {
    const resolution = resolveWorkspace({
      project: project('/repo'),
      projectConfig: {
        runner: {
          host: 'builder@server',
          repo_path: '/srv/repos/demo',
          worktree_root: '/mnt/worktrees',
        },
      },
      task: task(),
      worktreesDir: '/worktrees',
    });
    expect(resolution.workspace.worktreePath).toBe('/mnt/worktrees/demo/tsk_1');
  });

  it('honours the command line host override', () => {
    const resolution = resolveWorkspace({
      project: project('/repo'),
      projectConfig: {
        runner: { host: 'builder@server', repo_path: '/srv/repos/demo' },
      },
      task: task(),
      worktreesDir: '/worktrees',
      remoteHost: 'other@server',
    });
    expect(resolution.runner?.host).toBe('other@server');
    expect(resolution.workspace.kind).toBe('remote');
  });
});

describe('local workspace', () => {
  it('creates, commits and removes a worktree', () => {
    const dir = tempDir();
    const repo = makeRepo(dir);
    const workspace = new LocalWorkspace(repo, path.join(dir, 'worktrees', 'tsk_1'));

    const created = ensureWorkspace(workspace, {
      branch: 'crew/tsk_1',
      baseBranch: 'main',
    });
    expect(created.created).toBe(true);
    expect(existsSync(path.join(workspace.worktreePath, 'README.md'))).toBe(true);

    writeFileSync(path.join(workspace.worktreePath, 'new.txt'), 'hello\n');
    const commit = commitWorkspace(workspace, 'crew: test');
    expect(commit.committed).toBe(true);
    expect(commit.sha).toHaveLength(40);

    const stats = diffStatsWorkspace(workspace, 'main');
    expect(stats?.files).toBe(1);
    expect(stats?.additions).toBe(1);

    removeWorkspace(workspace, { force: true });
    expect(existsSync(workspace.worktreePath)).toBe(false);
  });

  it('pushes a branch to the origin', () => {
    const dir = tempDir();
    const origin = path.join(dir, 'origin.git');
    execFileSync('git', ['init', '--bare', '-b', 'main', origin]);
    const repo = makeRepo(dir);
    git(['remote', 'add', 'origin', origin], repo);
    git(['push', '-u', 'origin', 'main'], repo);

    const workspace = new LocalWorkspace(repo, path.join(dir, 'worktrees', 'tsk_1'));
    ensureWorkspace(workspace, { branch: 'crew/tsk_1', baseBranch: 'main' });
    writeFileSync(path.join(workspace.worktreePath, 'new.txt'), 'hello\n');
    commitWorkspace(workspace, 'crew: test');
    pushWorkspace(workspace, 'crew/tsk_1');

    const branches = git(['branch', '--list', 'crew/tsk_1'], origin);
    expect(branches).toContain('crew/tsk_1');
  });

  it('refuses to remove a dirty worktree without force', () => {
    const dir = tempDir();
    const repo = makeRepo(dir);
    const workspace = new LocalWorkspace(repo, path.join(dir, 'worktrees', 'tsk_1'));
    ensureWorkspace(workspace, { branch: 'crew/tsk_1', baseBranch: 'main' });
    writeFileSync(path.join(workspace.worktreePath, 'new.txt'), 'hello\n');
    expect(() => removeWorkspace(workspace)).toThrow(/uncommitted changes/);
  });
});

describe('remote workspace', () => {
  let dir: string;
  let repo: string;
  let bin: string;

  beforeAll(() => {
    dir = tempDir();
    repo = makeRepo(dir);
    bin = path.join(dir, 'bin');
    mkdirSync(bin, { recursive: true });
    const shim = path.join(bin, 'ssh');
    writeFileSync(
      shim,
      `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const script = args[args.length - 1];
const result = spawnSync('/bin/sh', ['-c', script], { encoding: 'utf8' });
process.stdout.write(result.stdout || '');
process.stderr.write(result.stderr || '');
process.exit(result.status === null ? 1 : result.status);
`,
    );
    chmodSync(shim, 0o755);
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`;
  });

  afterAll(() => {
    process.env.PATH = originalPath;
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop() as string, { recursive: true, force: true });
    }
  });

  it('runs git, reads and writes files on the remote host', () => {
    const workspace = new RemoteWorkspace(
      repo,
      path.join(dir, 'remote-worktrees', 'tsk_1'),
      { host: 'builder@server', options: [] },
    );

    const created = ensureWorkspace(workspace, {
      branch: 'crew/tsk_1',
      baseBranch: 'main',
    });
    expect(created.created).toBe(true);
    expect(existsSync(path.join(workspace.worktreePath, 'README.md'))).toBe(true);

    workspace.writeFile(path.join(workspace.worktreePath, 'note.md'), 'hello\n');
    expect(readFileSync(path.join(workspace.worktreePath, 'note.md'), 'utf8')).toBe(
      'hello\n',
    );
    workspace.appendFile(path.join(workspace.worktreePath, 'note.md'), 'again\n');
    expect(readFileSync(path.join(workspace.worktreePath, 'note.md'), 'utf8')).toBe(
      'hello\nagain\n',
    );
    expect(workspace.readFile(path.join(workspace.worktreePath, 'note.md'))).toBe(
      'hello\nagain\n',
    );
    expect(workspace.exists(path.join(workspace.worktreePath, 'note.md'))).toBe(true);
    expect(workspace.exists(path.join(workspace.worktreePath, 'missing.md'))).toBe(
      false,
    );
    expect(workspace.readFile(path.join(workspace.worktreePath, 'missing.md'))).toBeNull();
  });

  it('writes content with quotes and special characters intact', () => {
    const workspace = new RemoteWorkspace(
      repo,
      path.join(dir, 'remote-worktrees', 'tsk_1'),
      { host: 'builder@server', options: [] },
    );
    const content = "line with 'quotes' and $vars and `backticks`\nCREW_EOF\n";
    workspace.writeFile(path.join(workspace.worktreePath, 'tricky.md'), content);
    expect(readFileSync(path.join(workspace.worktreePath, 'tricky.md'), 'utf8')).toBe(
      content,
    );
  });

  it('commits on the remote host', () => {
    const workspace = new RemoteWorkspace(
      repo,
      path.join(dir, 'remote-worktrees', 'tsk_2'),
      { host: 'builder@server', options: [] },
    );
    ensureWorkspace(workspace, { branch: 'crew/tsk_2', baseBranch: 'main' });
    writeFileSync(path.join(workspace.worktreePath, 'new.txt'), 'hello\n');
    const commit = commitWorkspace(workspace, 'crew: remote');
    expect(commit.committed).toBe(true);
    const stats = diffStatsWorkspace(workspace, 'main');
    expect(stats?.files).toBe(1);
  });
});

describe('task location', () => {
  function projectWithRunner(runner: string): Project {
    const dir = tempDir();
    mkdirSync(path.join(dir, '.crew'), { recursive: true });
    writeFileSync(
      path.join(dir, '.crew', 'config.yaml'),
      ['runner:', runner].join('\n'),
      'utf8',
    );
    return { ...project(dir) };
  }

  it('is local without a runner', () => {
    const location = describeTaskLocation(project('/repo'), task());
    expect(location).toEqual({ where: 'local', host: null, path: null });
  });

  it('is shared when the runner has no repo_path', () => {
    const location = describeTaskLocation(
      projectWithRunner('  host: builder@server'),
      task(),
    );
    expect(location.where).toBe('shared');
    expect(location.host).toBe('builder@server');
  });

  it('is remote when the runner declares a repo_path', () => {
    const location = describeTaskLocation(
      projectWithRunner('  host: builder@server\n  repo_path: /srv/repos/demo'),
      task(),
    );
    expect(location.where).toBe('remote');
    expect(location.host).toBe('builder@server');
  });
});

describe('remote runner checks', () => {
  it('checks the host, the repository and the worktree root', () => {
    const dir = tempDir();
    const repo = makeRepo(dir);
    const bin = path.join(dir, 'bin');
    mkdirSync(bin, { recursive: true });
    const shim = path.join(bin, 'ssh');
    writeFileSync(
      shim,
      `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const script = args[args.length - 1];
const result = spawnSync('/bin/sh', ['-c', script], { encoding: 'utf8' });
process.stdout.write(result.stdout || '');
process.stderr.write(result.stderr || '');
process.exit(result.status === null ? 1 : result.status);
`,
    );
    chmodSync(shim, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ''}`;
    try {
      const checks = checkRemoteRunner(project(repo), {
        runner: { host: 'builder@server', repo_path: repo },
      });
      const names = checks.map((check) => check.name);
      expect(names).toContain('runner.demo.host');
      expect(names).toContain('runner.demo.repo');
      expect(names).toContain('runner.demo.worktrees');
      expect(checks.every((check) => check.status === 'ok')).toBe(true);
    } finally {
      process.env.PATH = previousPath;
    }
  });

  it('reports a repository that is missing on the host', () => {
    const dir = tempDir();
    const bin = path.join(dir, 'bin');
    mkdirSync(bin, { recursive: true });
    const shim = path.join(bin, 'ssh');
    writeFileSync(
      shim,
      `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const script = args[args.length - 1];
const result = spawnSync('/bin/sh', ['-c', script], { encoding: 'utf8' });
process.stdout.write(result.stdout || '');
process.stderr.write(result.stderr || '');
process.exit(result.status === null ? 1 : result.status);
`,
    );
    chmodSync(shim, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ''}`;
    try {
      const checks = checkRemoteRunner(project(dir), {
        runner: { host: 'builder@server', repo_path: path.join(dir, 'missing') },
      });
      const repo = checks.find((check) => check.name.endsWith('.repo'));
      expect(repo?.status).toBe('error');
      expect(repo?.detail).toContain('no git repository');
    } finally {
      process.env.PATH = previousPath;
    }
  });
});
