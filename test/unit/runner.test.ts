import { afterEach, describe, expect, it } from 'vitest';
import { buildRemoteCommand, parseRunnerConfig } from '../../src/app/runner';

afterEach(() => {
  // nothing to clean
});

describe('remote runner', () => {
  it('builds an ssh command that runs in the remote working directory', () => {
    const { command, args } = buildRemoteCommand(
      { host: 'user@server', options: ['-o', 'BatchMode=yes'] },
      'node',
      ['agent.mjs', '--flag'],
      '/srv/worktrees/task',
      { CREW_TASK_ID: 'tsk_1' },
    );

    expect(command).toBe('ssh');
    expect(args[0]).toBe('-o');
    expect(args[1]).toBe('BatchMode=yes');
    expect(args).toContain('-o');
    expect(args).toContain('ConnectTimeout=10');
    expect(args[args.length - 2]).toBe('user@server');
    const script = args[args.length - 1] as string;
    expect(script).toContain("cd '/srv/worktrees/task'");
    expect(script).toContain("CREW_TASK_ID='tsk_1'");
    expect(script).toContain("'node'");
    expect(script).toContain("'agent.mjs'");
    expect(script).toContain("'--flag'");
  });

  it('escapes quotes in the environment values', () => {
    const { args } = buildRemoteCommand(
      { host: 'user@server', options: [] },
      'node',
      [],
      '/tmp',
      { CREW_TITLE: "it's here" },
    );
    expect(args[args.length - 1]).toContain("CREW_TITLE='it'\\''s here'");
  });

  it('parses the runner configuration', () => {
    expect(parseRunnerConfig({ host: ' user@server ' })).toEqual({
      host: 'user@server',
      options: [],
    });
    expect(
      parseRunnerConfig({ host: 'user@server', ssh_options: ['-o', 'BatchMode=yes'] }),
    ).toEqual({ host: 'user@server', options: ['-o', 'BatchMode=yes'] });
    expect(parseRunnerConfig(undefined)).toBeNull();
    expect(parseRunnerConfig({})).toBeNull();
  });
});
