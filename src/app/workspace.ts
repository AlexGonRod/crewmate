import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { CrewError } from '../core/errors';
import { slugify } from '../core/slug';
import type { ChangeStats, Project, Task } from '../core/types';
import { git, gitOrThrow, type GitResult } from '../git/git';
import { parseRunnerConfig, shellQuote, type RemoteRunner } from './runner';
import type { ProjectConfig } from '../config/config';

/**
 * Where the code of a task lives.
 *
 * A workspace is either local (the worktree is on this machine) or remote (the
 * worktree is on the host configured in the project runner). Every git and
 * file operation of the pipeline goes through it, so the engine can drive a
 * task whose code never touches the local disk.
 */
export interface Workspace {
  readonly kind: 'local' | 'remote';
  readonly repoPath: string;
  readonly worktreePath: string;
  git(args: string[], cwd?: string): GitResult;
  gitOrThrow(args: string[], cwd?: string): string;
  writeFile(filePath: string, content: string): void;
  appendFile(filePath: string, content: string): void;
  readFile(filePath: string): string | null;
  exists(filePath: string): boolean;
  ensureDir(dirPath: string): void;
}

export class LocalWorkspace implements Workspace {
  readonly kind = 'local' as const;

  constructor(
    readonly repoPath: string,
    readonly worktreePath: string,
  ) {}

  git(args: string[], cwd: string = this.worktreePath): GitResult {
    return git(args, cwd);
  }

  gitOrThrow(args: string[], cwd: string = this.worktreePath): string {
    return gitOrThrow(args, cwd);
  }

  writeFile(filePath: string, content: string): void {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, content, 'utf8');
  }

  appendFile(filePath: string, content: string): void {
    mkdirSync(path.dirname(filePath), { recursive: true });
    appendFileSync(filePath, content, 'utf8');
  }

  readFile(filePath: string): string | null {
    try {
      return readFileSync(filePath, 'utf8');
    } catch {
      return null;
    }
  }

  exists(filePath: string): boolean {
    return existsSync(filePath);
  }

  ensureDir(dirPath: string): void {
    mkdirSync(dirPath, { recursive: true });
  }
}

export class RemoteWorkspace implements Workspace {
  readonly kind = 'remote' as const;

  constructor(
    readonly repoPath: string,
    readonly worktreePath: string,
    private readonly runner: RemoteRunner,
  ) {}

  exec(script: string): GitResult {
    const result = spawnSync(
      'ssh',
      [...this.runner.options, this.runner.host, script],
      {
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    if (result.error) {
      throw new CrewError(
        'REMOTE_EXEC_FAILED',
        `Could not run ssh on ${this.runner.host}: ${result.error.message}`,
      );
    }
    return {
      status: result.status ?? 1,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  }

  private inDir(cwd: string, command: string): string {
    return `cd ${shellQuote(cwd)} && ${command}`;
  }

  git(args: string[], cwd: string = this.worktreePath): GitResult {
    const command = ['git', ...args].map(shellQuote).join(' ');
    return this.exec(this.inDir(cwd, command));
  }

  gitOrThrow(args: string[], cwd: string = this.worktreePath): string {
    const result = this.git(args, cwd);
    if (result.status !== 0) {
      throw new CrewError(
        'GIT_ERROR',
        `git ${args.join(' ')} failed on ${this.runner.host} (${cwd}): ${
          result.stderr || result.stdout || `exit ${result.status}`
        }`,
      );
    }
    return result.stdout.trim();
  }

  writeFile(filePath: string, content: string): void {
    const script = [
      `mkdir -p ${shellQuote(path.dirname(filePath))}`,
      this.heredoc(content, `> ${shellQuote(filePath)}`),
    ].join(' && ');
    this.expectSuccess(this.exec(script), `write ${filePath}`);
  }

  appendFile(filePath: string, content: string): void {
    const script = [
      `mkdir -p ${shellQuote(path.dirname(filePath))}`,
      this.heredoc(content, `>> ${shellQuote(filePath)}`),
    ].join(' && ');
    this.expectSuccess(this.exec(script), `append ${filePath}`);
  }

  readFile(filePath: string): string | null {
    const result = this.exec(`cat ${shellQuote(filePath)}`);
    if (result.status !== 0) {
      return null;
    }
    return result.stdout;
  }

  exists(filePath: string): boolean {
    return this.exec(`test -e ${shellQuote(filePath)}`).status === 0;
  }

  ensureDir(dirPath: string): void {
    this.expectSuccess(
      this.exec(`mkdir -p ${shellQuote(dirPath)}`),
      `create ${dirPath}`,
    );
  }

  private heredoc(content: string, redirection: string): string {
    let delimiter = 'CREW_EOF';
    while (content.includes(delimiter)) {
      delimiter = `CREW_EOF_${Math.random().toString(36).slice(2, 10)}`;
    }
    const body = content.endsWith('\n') ? content : `${content}\n`;
    return `cat ${redirection} <<'${delimiter}'\n${body}${delimiter}`;
  }

  private expectSuccess(result: GitResult, action: string): void {
    if (result.status !== 0) {
      throw new CrewError(
        'REMOTE_EXEC_FAILED',
        `Could not ${action} on ${this.runner.host}: ${
          result.stderr || result.stdout || `exit ${result.status}`
        }`,
      );
    }
  }
}

export interface EnsureWorkspaceResult {
  worktreePath: string;
  branch: string;
  created: boolean;
}

function excludeCrewDirectory(workspace: Workspace): void {
  const excludePath = path.resolve(
    workspace.repoPath,
    workspace.gitOrThrow(['rev-parse', '--git-path', 'info/exclude'], workspace.repoPath),
  );
  const current = workspace.readFile(excludePath) ?? '';
  if (!current.split(/\r?\n/).includes('.crew/')) {
    workspace.appendFile(
      excludePath,
      `${current.endsWith('\n') || current === '' ? '' : '\n'}.crew/\n`,
    );
  }
}

export function ensureWorkspace(
  workspace: Workspace,
  options: { branch: string; baseBranch: string },
): EnsureWorkspaceResult {
  const { branch, baseBranch } = options;
  workspace.ensureDir(path.dirname(workspace.worktreePath));
  workspace.gitOrThrow(['worktree', 'prune'], workspace.repoPath);

  if (workspace.exists(workspace.worktreePath)) {
    const result = workspace.git(
      ['rev-parse', '--is-inside-work-tree'],
      workspace.worktreePath,
    );
    if (result.status !== 0) {
      throw new CrewError(
        'WORKTREE_INVALID',
        `${workspace.worktreePath} exists but is not a git worktree`,
      );
    }
    const actualBranch = workspace.gitOrThrow(
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      workspace.worktreePath,
    );
    if (actualBranch !== branch) {
      throw new CrewError(
        'WORKTREE_BRANCH_MISMATCH',
        `Worktree ${workspace.worktreePath} is on ${actualBranch}, expected ${branch}`,
      );
    }
    excludeCrewDirectory(workspace);
    return { worktreePath: workspace.worktreePath, branch, created: false };
  }

  const exists = workspace.git(
    ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`],
    workspace.repoPath,
  );
  if (exists.status === 0) {
    workspace.gitOrThrow(
      ['worktree', 'add', workspace.worktreePath, branch],
      workspace.repoPath,
    );
  } else {
    workspace.gitOrThrow(
      ['worktree', 'add', '-b', branch, workspace.worktreePath, baseBranch],
      workspace.repoPath,
    );
  }

  excludeCrewDirectory(workspace);
  return { worktreePath: workspace.worktreePath, branch, created: true };
}

export function removeWorkspace(
  workspace: Workspace,
  options: { force?: boolean } = {},
): void {
  const force = options.force ?? false;
  if (!workspace.exists(workspace.worktreePath)) {
    return;
  }
  if (!force) {
    const dirty = workspace.gitOrThrow(
      ['status', '--porcelain'],
      workspace.worktreePath,
    );
    if (dirty.length > 0) {
      throw new CrewError(
        'WORKTREE_DIRTY',
        `Refusing to remove ${workspace.worktreePath}: it has uncommitted changes. Use --force to discard the worktree only.`,
      );
    }
  }
  workspace.gitOrThrow(
    ['worktree', 'remove', ...(force ? ['--force'] : []), workspace.worktreePath],
    workspace.repoPath,
  );
  workspace.git(['worktree', 'prune'], workspace.repoPath);
}

export interface CommitResult {
  sha: string;
  committed: boolean;
}

export function commitWorkspace(
  workspace: Workspace,
  message: string,
): CommitResult {
  const current = (): string =>
    workspace.gitOrThrow(['rev-parse', 'HEAD'], workspace.worktreePath);
  if (workspace.gitOrThrow(['status', '--porcelain'], workspace.worktreePath).length === 0) {
    return { sha: current(), committed: false };
  }
  workspace.gitOrThrow(['add', '-A'], workspace.worktreePath);
  const staged = workspace.gitOrThrow(
    ['diff', '--cached', '--name-only'],
    workspace.worktreePath,
  );
  if (!staged) {
    return { sha: current(), committed: false };
  }
  workspace.gitOrThrow(['commit', '-m', message], workspace.worktreePath);
  return { sha: current(), committed: true };
}

export function diffStatsWorkspace(
  workspace: Workspace,
  baseBranch: string,
): ChangeStats | null {
  const result = workspace.git(
    ['diff', '--numstat', `${baseBranch}...HEAD`],
    workspace.worktreePath,
  );
  if (result.status !== 0) {
    return null;
  }
  const paths: string[] = [];
  let additions = 0;
  let deletions = 0;
  for (const line of result.stdout.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    const parts = line.split('\t');
    if (parts.length < 3) {
      continue;
    }
    const added = Number(parts[0]);
    const removed = Number(parts[1]);
    if (Number.isFinite(added)) {
      additions += added;
    }
    if (Number.isFinite(removed)) {
      deletions += removed;
    }
    paths.push(parts.slice(2).join('\t'));
  }
  return { files: paths.length, additions, deletions, paths };
}

export function pushWorkspace(workspace: Workspace, branch: string): void {
  workspace.gitOrThrow(
    ['push', '--set-upstream', 'origin', branch],
    workspace.repoPath,
  );
}

export interface WorkspaceResolution {
  workspace: Workspace;
  runner: RemoteRunner | null;
  /** True when the worktree and the commits live on the remote host. */
  remoteCode: boolean;
}

export interface ResolveWorkspaceOptions {
  project: Project;
  projectConfig: ProjectConfig | null;
  task: Task;
  worktreesDir: string;
  remoteHost?: string;
}

/**
 * Resolves where the code of a task lives.
 *
 * - No runner: everything stays local.
 * - Runner without `repo_path`: the agent runs on the remote host, which must
 *   see the same worktree (shared filesystem). The git operations stay local.
 * - Runner with `repo_path`: the worktree, the commits and the push happen on
 *   the remote host; the local machine only keeps the engine state.
 */
export function resolveWorkspace(
  options: ResolveWorkspaceOptions,
): WorkspaceResolution {
  const { project, projectConfig, task, worktreesDir } = options;
  const localWorktreePath =
    task.worktreePath ??
    path.join(worktreesDir, slugify(project.name), task.id);

  const configured = parseRunnerConfig(projectConfig?.runner);
  const runner = options.remoteHost
    ? {
        ...(configured ?? { host: options.remoteHost, options: [] }),
        host: options.remoteHost,
      }
    : configured;

  if (!runner) {
    return {
      workspace: new LocalWorkspace(project.rootPath, localWorktreePath),
      runner: null,
      remoteCode: false,
    };
  }

  if (!runner.repoPath) {
    return {
      workspace: new LocalWorkspace(project.rootPath, localWorktreePath),
      runner,
      remoteCode: false,
    };
  }

  const worktreeRoot =
    runner.worktreeRoot ?? path.join(path.dirname(runner.repoPath), 'crew-worktrees');
  const worktreePath = path.join(worktreeRoot, slugify(project.name), task.id);
  return {
    workspace: new RemoteWorkspace(runner.repoPath, worktreePath, runner),
    runner,
    remoteCode: true,
  };
}

