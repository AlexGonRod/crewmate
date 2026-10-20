import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CrewError } from '../core/errors';
import { branchExists, currentBranch, git, gitOrThrow, isWorktreeDirty } from './git';

export interface EnsureWorktreeOptions {
  repoPath: string;
  worktreePath: string;
  branch: string;
  baseBranch: string;
}

export interface EnsureWorktreeResult {
  worktreePath: string;
  branch: string;
  created: boolean;
}

function excludeCrewDirectory(worktreePath: string): void {
  const excludePath = path.resolve(
    worktreePath,
    gitOrThrow(['rev-parse', '--git-path', 'info/exclude'], worktreePath),
  );
  mkdirSync(path.dirname(excludePath), { recursive: true });
  const current = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : '';
  if (!current.split(/\r?\n/).includes('.crew/')) {
    appendFileSync(excludePath, `${current.endsWith('\n') || current === '' ? '' : '\n'}.crew/\n`);
  }
}

export function ensureWorktree(options: EnsureWorktreeOptions): EnsureWorktreeResult {
  const { repoPath, worktreePath, branch, baseBranch } = options;
  mkdirSync(path.dirname(worktreePath), { recursive: true });

  git(['worktree', 'prune'], repoPath);

  if (existsSync(worktreePath)) {
    const result = git(['rev-parse', '--is-inside-work-tree'], worktreePath);
    if (result.status !== 0) {
      throw new CrewError(
        'WORKTREE_INVALID',
        `${worktreePath} exists but is not a git worktree`,
      );
    }
    const actualBranch = currentBranch(worktreePath);
    if (actualBranch !== branch) {
      throw new CrewError(
        'WORKTREE_BRANCH_MISMATCH',
        `Worktree ${worktreePath} is on ${actualBranch}, expected ${branch}`,
      );
    }
    excludeCrewDirectory(worktreePath);
    return { worktreePath, branch, created: false };
  }

  if (branchExists(repoPath, branch)) {
    gitOrThrow(['worktree', 'add', worktreePath, branch], repoPath);
  } else {
    gitOrThrow(['worktree', 'add', '-b', branch, worktreePath, baseBranch], repoPath);
  }

  excludeCrewDirectory(worktreePath);
  return { worktreePath, branch, created: true };
}

export function removeWorktree(options: {
  repoPath: string;
  worktreePath: string;
  force?: boolean;
}): void {
  const { repoPath, worktreePath, force = false } = options;
  if (!existsSync(worktreePath)) {
    return;
  }

  if (!force && isWorktreeDirty(worktreePath)) {
    throw new CrewError(
      'WORKTREE_DIRTY',
      `Refusing to remove ${worktreePath}: it has uncommitted changes. Use --force to discard the worktree only.`,
    );
  }

  gitOrThrow(['worktree', 'remove', ...(force ? ['--force'] : []), worktreePath], repoPath);
  git(['worktree', 'prune'], repoPath);
}

export function writeWorktreeFile(worktreePath: string, relativePath: string, content: string): string {
  const target = path.join(worktreePath, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
  return target;
}
