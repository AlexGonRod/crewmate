import type { RunProcessOptions } from '../adapters/backend/process';

export interface RemoteRunner {
  host: string;
  options: string[];
  /** Repository root on the remote host; when set the worktree lives there. */
  repoPath?: string;
  /** Root directory for the remote worktrees. */
  worktreeRoot?: string;
}

/**
 * Safety options for every ssh call: never prompt for a password and never
 * wait forever for a host that does not answer. The user options come first
 * so they can override them.
 */
export function safeSshOptions(options: string[]): string[] {
  return [...options, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'];
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function buildRemoteCommand(
  remote: RemoteRunner,
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string | undefined>,
): { command: string; args: string[] } {
  const parts: string[] = ['cd', shellQuote(cwd), '&&'];
  const entries = Object.entries(env).filter(([, value]) => value !== undefined);
  if (entries.length > 0) {
    parts.push('env');
    for (const [key, value] of entries) {
      parts.push(`${key}=${shellQuote(value as string)}`);
    }
  }
  parts.push(shellQuote(command));
  for (const arg of args) {
    parts.push(shellQuote(arg));
  }
  const script = parts.join(' ');
  return {
    command: 'ssh',
    args: [...safeSshOptions(remote.options), remote.host, script],
  };
}

export function forwardedEnv(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && (key.startsWith('CREW_') || key === 'PATH')) {
      result[key] = value;
    }
  }
  return result;
}

export function remoteProcessOptions(
  options: RunProcessOptions,
  remote: RemoteRunner,
): RunProcessOptions {
  const { command, args } = buildRemoteCommand(
    remote,
    options.command,
    options.args,
    options.cwd,
    forwardedEnv(options.env),
  );
  const rest = { ...options };
  delete rest.remote;
  return { ...rest, command, args };
}

export function parseRunnerConfig(
  value: unknown,
): RemoteRunner | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const config = value as Record<string, unknown>;
  const host = typeof config.host === 'string' ? config.host.trim() : '';
  if (!host) {
    return null;
  }
  const options = Array.isArray(config.ssh_options)
    ? config.ssh_options.filter((item): item is string => typeof item === 'string')
    : [];
  const repoPath =
    typeof config.repo_path === 'string' ? config.repo_path.trim() : '';
  const worktreeRoot =
    typeof config.worktree_root === 'string' ? config.worktree_root.trim() : '';
  return {
    host,
    options,
    repoPath: repoPath || undefined,
    worktreeRoot: worktreeRoot || undefined,
  };
}
