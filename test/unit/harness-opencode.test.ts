import { describe, expect, it } from 'vitest';
import { OpencodeHarness } from '../../src/adapters/harness/opencode';
import type { LaunchSpec } from '../../src/adapters/harness/types';

const spec = {
  task: {
    id: 'tsk_1',
    projectId: 'prj_1',
    title: 'Add a feature',
    briefText: 'do the thing',
    worktreePath: '/worktrees/tsk_1',
  },
  project: { id: 'prj_1', name: 'demo', rootPath: '/repo' },
  run: { id: 'run_1' },
  worktreePath: '/worktrees/tsk_1',
  briefPath: '/worktrees/tsk_1/.crew/brief.md',
  brief: '---\nschema: "crew.brief/v1"\n\n# Task\n\ndo the thing\n',
  reportPath: '/worktrees/tsk_1/.crew/reports/run_1.json',
  dbPath: '/state/crew.db',
  role: 'developer',
  agent: undefined,
  model: undefined,
  env: {},
} as unknown as LaunchSpec;

describe('opencode harness', () => {
  const harness = new OpencodeHarness();

  it('delivers the brief on stdin, not as an argument', () => {
    const launch = harness.buildLaunch(spec);
    expect(launch.command).toBe('opencode');
    expect(launch.args.join(' ')).not.toContain('crew.brief/v1');
    expect(launch.args.some((arg) => arg.startsWith('---'))).toBe(false);
    expect(harness.manifest.spec.execution.prompt.mode).toBe('stdin');
  });

  it('keeps the session title and the optional agent and model', () => {
    const launch = harness.buildLaunch({
      ...spec,
      agent: 'build',
      model: 'anthropic/claude',
    } as LaunchSpec);
    expect(launch.args).toContain('--title');
    expect(launch.args).toContain('Add a feature');
    expect(launch.args).toContain('--agent');
    expect(launch.args).toContain('build');
    expect(launch.args).toContain('--model');
    expect(launch.args).toContain('anthropic/claude');
  });

  it('passes the crew context through the environment', () => {
    const launch = harness.buildLaunch(spec);
    expect(launch.env.CREW_TASK_ID).toBe('tsk_1');
    expect(launch.env.CREW_RUN_ID).toBe('run_1');
    expect(launch.env.CREW_REPORT_PATH).toBe(
      '/worktrees/tsk_1/.crew/reports/run_1.json',
    );
    expect(launch.env.CREW_WORKTREE).toBe('/worktrees/tsk_1');
  });
});
