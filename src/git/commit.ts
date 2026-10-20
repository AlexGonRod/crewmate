import { gitOrThrow, isWorktreeDirty } from './git';

export interface CommitResult {
  sha: string;
  committed: boolean;
}

export function currentCommit(worktreePath: string): string {
  return gitOrThrow(['rev-parse', 'HEAD'], worktreePath);
}

export function commitWorktree(
  worktreePath: string,
  message: string,
): CommitResult {
  if (!isWorktreeDirty(worktreePath)) {
    return { sha: currentCommit(worktreePath), committed: false };
  }

  gitOrThrow(['add', '-A'], worktreePath);
  const staged = gitOrThrow(['diff', '--cached', '--name-only'], worktreePath);
  if (!staged) {
    return { sha: currentCommit(worktreePath), committed: false };
  }
  gitOrThrow(['commit', '-m', message], worktreePath);
  return { sha: currentCommit(worktreePath), committed: true };
}

export function pushBranch(worktreePath: string, branch: string): void {
  gitOrThrow(['push', '--set-upstream', 'origin', branch], worktreePath);
}
