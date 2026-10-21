import type { ChangeStats } from '../core/types';
import { git } from './git';

export function diffStats(worktreePath: string, baseBranch: string): ChangeStats | null {
  const result = git(['diff', '--numstat', `${baseBranch}...HEAD`], worktreePath);
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

  return {
    files: paths.length,
    additions,
    deletions,
    paths,
  };
}
