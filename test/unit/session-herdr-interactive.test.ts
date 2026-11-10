import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HerdrBackend } from '../../src/app/session/herdr';
import { createFakeHerdr } from './fake-herdr';
import { cleanupDirs, report, startInteractive, tempDir } from './session-herdr-fixture';

afterEach(cleanupDirs);

describe('HerdrBackend interactive mode', () => {
  it('creates a tab with the worktree cwd and starts the agent kind of the harness', () => {
    const dir = tempDir();
    const worktree = path.join(dir, 'worktree');
    const reportPath = path.join(worktree, '.crew', 'reports', 'run_1.json');
    const fake = createFakeHerdr({ promptBehavior: 'report', reportPath, report: report() });
    const backend = new HerdrBackend(path.join(dir, 'state'), fake.run);

    const started = startInteractive(backend, {
      name: 'crew-tsk_01M6VCD1QSK57YAKYTPG9M55G6-developer',
      worktree,
      reportPath,
      kind: 'opencode',
    });

    expect(started.ok).toBe(true);
    const tab = fake.calls.find((call) => call[0] === 'tab' && call[1] === 'create');
    expect(tab).toBeDefined();
    expect(tab).toContain('--cwd');
    expect(tab?.[tab.indexOf('--cwd') + 1]).toBe(worktree);
    const agent = fake.calls.find((call) => call[0] === 'agent' && call[1] === 'start');
    expect(agent).toContain('--kind');
    expect(agent?.[agent.indexOf('--kind') + 1]).toBe('opencode');
    const runTab = fake.tabs.find((item) => item.label === 'crew-tsk_01M6VCD1QSK57YAKYTPG9M55G6-developer');
    expect(runTab?.cwd).toBe(worktree);
    expect(fake.agents[0]?.name).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
  });

  it('lists the real agent kind and tab of an interactive run', () => {
    const dir = tempDir();
    const worktree = path.join(dir, 'worktree');
    const reportPath = path.join(worktree, '.crew', 'reports', 'run_1.json');
    const fake = createFakeHerdr();
    const backend = new HerdrBackend(path.join(dir, 'state'), fake.run);
    const name = 'crew-tsk_01M6VCD1QSK57YAKYTPG9M55G6-developer';

    expect(
      startInteractive(backend, { name, worktree, reportPath, kind: 'opencode' }).ok,
    ).toBe(true);
    const session = backend.list().find((item) => item.name === name);

    expect(session?.agentKind).toBe('opencode');
    expect(session?.attach).toContain('tab');
    expect(session?.command).toContain('opencode');
    expect(session?.command).not.toContain('pi');
  });

  it('sends the orchestrated prompt and exits 0 only with a valid report and a settled agent', async () => {
    const dir = tempDir();
    const worktree = path.join(dir, 'worktree');
    const reportPath = path.join(worktree, '.crew', 'reports', 'run_1.json');
    const fake = createFakeHerdr({
      promptBehavior: 'report',
      reportPath,
      report: report(),
      readOutput: 'pi finished the task',
    });
    const backend = new HerdrBackend(path.join(dir, 'state'), fake.run);
    const name = 'crew-tsk_01M6VCD1QSK57YAKYTPG9M55G6-developer';

    expect(startInteractive(backend, { name, worktree, reportPath }).ok).toBe(true);
    const result = await backend.wait(name, { timeoutMs: 2000, pollMs: 100 });

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(fake.prompts[0]).toContain(path.join(worktree, '.crew', 'brief.md'));
    expect(fake.prompts[0]).toContain(reportPath);
    expect(result.output).toContain('pi finished the task');
    expect(fake.tabs.some((tab) => tab.label === name)).toBe(false);
    expect(fake.workspaces.length).toBe(1);
    expect(fake.workspaceCloses).toEqual([]);
  });

  it('resolves a name collision and closes only its tab on kill', () => {
    const dir = tempDir();
    const worktree = path.join(dir, 'worktree');
    const reportPath = path.join(worktree, '.crew', 'reports', 'run_1.json');
    const fake = createFakeHerdr({ existingAgents: ['crew-5pteeddt48-dev'] });
    const backend = new HerdrBackend(path.join(dir, 'state'), fake.run);
    const name = 'crew-tsk_01M6VCD1QSK57YAKYTPG9M55G6-developer';

    expect(startInteractive(backend, { name, worktree, reportPath }).ok).toBe(true);
    expect(fake.agents.some((agent) => agent.name === 'crew-5pteeddt48-dev-2')).toBe(true);

    expect(backend.kill(name)).toBe(true);
    expect(fake.tabs.some((tab) => tab.label === name)).toBe(false);
    expect(fake.workspaceCloses).toEqual([]);
    expect(fake.workspaces.length).toBe(1);
  });

  it('fails a blocked agent with the agent read extract and cleans the tab', async () => {
    const dir = tempDir();
    const worktree = path.join(dir, 'worktree');
    const reportPath = path.join(worktree, '.crew', 'reports', 'run_1.json');
    const fake = createFakeHerdr({
      promptBehavior: 'blocked',
      readOutput: 'approval needed to continue',
    });
    const backend = new HerdrBackend(path.join(dir, 'state'), fake.run);
    const name = 'crew-tsk_01M6VCD1QSK57YAKYTPG9M55G6-developer';

    expect(startInteractive(backend, { name, worktree, reportPath }).ok).toBe(true);
    const result = await backend.wait(name, { timeoutMs: 2000, pollMs: 100 });

    expect(result.exitCode).toBe(1);
    expect(result.timedOut).toBe(false);
    expect(result.output).toContain('approval needed to continue');
    expect(fake.tabs.some((tab) => tab.label === name)).toBe(false);
    expect(fake.workspaceCloses).toEqual([]);
  });

  it('fails a timeout with the agent read extract and cleans the tab', async () => {
    const dir = tempDir();
    const worktree = path.join(dir, 'worktree');
    const reportPath = path.join(worktree, '.crew', 'reports', 'run_1.json');
    const fake = createFakeHerdr({
      promptBehavior: 'never',
      readOutput: 'still working after the timeout',
    });
    const backend = new HerdrBackend(path.join(dir, 'state'), fake.run);
    const name = 'crew-tsk_01M6VCD1QSK57YAKYTPG9M55G6-developer';

    expect(startInteractive(backend, { name, worktree, reportPath }).ok).toBe(true);
    const result = await backend.wait(name, { timeoutMs: 50, pollMs: 100 });

    expect(result.exitCode).toBeNull();
    expect(result.timedOut).toBe(true);
    expect(result.output).toContain('still working after the timeout');
    expect(fake.tabs.some((tab) => tab.label === name)).toBe(false);
    expect(fake.workspaceCloses).toEqual([]);
  });

  it('keeps the batch workspace topology when interactive mode is off', () => {
    const dir = tempDir();
    const worktree = path.join(dir, 'worktree');
    const fake = createFakeHerdr();
    const backend = new HerdrBackend(path.join(dir, 'state'), fake.run);

    const started = backend.start({
      name: 'crew-tsk_01M6VCD1QSK57YAKYTPG9M55G6-developer',
      command: 'echo',
      args: ['hi'],
      cwd: worktree,
      env: {},
      exitFile: path.join(dir, 'exit'),
    });

    expect(started.ok).toBe(true);
    expect(fake.calls.some((call) => call[0] === 'workspace' && call[1] === 'create')).toBe(true);
    expect(fake.calls.some((call) => call[0] === 'pane' && call[1] === 'run')).toBe(true);
    expect(fake.calls.some((call) => call[0] === 'tab' && call[1] === 'create')).toBe(false);
    expect(fake.calls.some((call) => call[0] === 'agent' && call[1] === 'start')).toBe(false);
  });
});
