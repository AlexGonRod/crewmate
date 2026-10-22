import { spawnSync } from 'node:child_process';
import { CrewError } from '../core/errors';

export interface GitResult {
  status: number;
  stdout: string;
  stderr: string;
}

export function git(args: string[], cwd: string): GitResult {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });

  if (result.error) {
    throw new CrewError('GIT_ERROR', `Could not run git: ${result.error.message}`);
  }

  return {
    status: result.status ?? 1,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
  };
}

export function gitOrThrow(args: string[], cwd: string): string {
  const result = git(args, cwd);
  if (result.status !== 0) {
    throw new CrewError(
      'GIT_ERROR',
      `git ${args.join(' ')} failed in ${cwd}: ${result.stderr || result.stdout || `exit ${result.status}`}`,
    );
  }
  return result.stdout;
}

export function resolveRepoRoot(inputPath: string): string {
  const result = git(['rev-parse', '--show-toplevel'], inputPath);
  if (result.status !== 0) {
    throw new CrewError('NOT_A_GIT_REPO', `${inputPath} is not a git repository`);
  }
  return result.stdout;
}

export function branchExists(rootPath: string, branch: string): boolean {
  return git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], rootPath).status === 0;
}

export function detectDefaultBranch(rootPath: string): string {
  const remoteHead = git(
    ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
    rootPath,
  );
  if (remoteHead.status === 0 && remoteHead.stdout) {
    return remoteHead.stdout.replace(/^origin\//, '');
  }

  const current = git(['rev-parse', '--abbrev-ref', 'HEAD'], rootPath);
  if (current.status === 0 && current.stdout && current.stdout !== 'HEAD') {
    return current.stdout;
  }

  for (const candidate of ['main', 'master']) {
    if (branchExists(rootPath, candidate)) {
      return candidate;
    }
  }

  throw new CrewError(
    'DEFAULT_BRANCH_UNKNOWN',
    `Could not determine the default branch for ${rootPath}`,
  );
}

export function detectRemoteUrl(rootPath: string): string | null {
  const result = git(['remote', 'get-url', 'origin'], rootPath);
  return result.status === 0 && result.stdout ? result.stdout : null;
}

export function detectForge(remoteUrl: string | null): string | null {
  if (!remoteUrl) {
    return null;
  }
  if (/github\.com[:/]/i.test(remoteUrl)) {
    return 'github';
  }
  if (/gitlab\.com[:/]/i.test(remoteUrl)) {
    return 'gitlab';
  }
  if (/(forgejo|gitea)/i.test(remoteUrl)) {
    return 'forgejo';
  }
  return 'external';
}

export function currentBranch(worktreePath: string): string {
  return gitOrThrow(['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath);
}

export interface BranchHeadProbe {
  sha: string | null;
  error: string | null;
}

export function remoteBranchHead(rootPath: string, branch: string): BranchHeadProbe {
  const ref = `refs/heads/${branch}`;
  const pushUrl = git(['remote', 'get-url', '--push', 'origin'], rootPath);
  const target = pushUrl.status === 0 && pushUrl.stdout ? pushUrl.stdout : 'origin';
  const result = git(['ls-remote', target, ref], rootPath);
  if (result.status !== 0) {
    return { sha: null, error: `git ls-remote failed: ${result.stderr || 'exit code != 0'}` };
  }
  const line = result.stdout
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.endsWith(ref));
  const sha = line?.split('\t')[0]?.trim() ?? null;
  if (!sha) {
    return { sha: null, error: `branch ${branch} not found on origin` };
  }
  return { sha, error: null };
}

export function localBranchHead(rootPath: string, branch: string): BranchHeadProbe {
  const result = git(
    ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`],
    rootPath,
  );
  if (result.status !== 0) {
    return { sha: null, error: `branch ${branch} not found in ${rootPath}` };
  }
  return { sha: result.stdout || null, error: null };
}
