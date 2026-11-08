import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HerdrBackend } from '../../src/app/session/herdr';
import { createFakeHerdr } from './fake-herdr';
import { cleanupDirs, report, startInteractive, tempDir } from './session-herdr-fixture';

afterEach(cleanupDirs);

describe('HerdrBackend interactive prompt and log', () => {
  it('submits the prompt with --wait so a stale settled state is not trusted', async () => {
    const dir = tempDir();
    const worktree = path.join(dir, 'worktree');
    const reportPath = path.join(worktree, '.crew', 'reports', 'run_1.json');
    const fake = createFakeHerdr({ promptBehavior: 'report', reportPath, report: report() });
    const backend = new HerdrBackend(path.join(dir, 'state'), fake.run);
    const name = 'crew-tsk_01M6VCD1QSK57YAKYTPG9M55G6-developer';

    expect(startInteractive(backend, { name, worktree, reportPath }).ok).toBe(true);
    await backend.wait(name, { timeoutMs: 2000, pollMs: 100 });

    const prompt = fake.calls.find((call) => call[0] === 'agent' && call[1] === 'prompt');
    expect(prompt).toContain('--wait');
    expect(prompt?.[prompt.indexOf('--timeout') + 1]).toBeDefined();
  });

  it('logs the tab, agent, prompt and report events of the run', async () => {
    const dir = tempDir();
    const worktree = path.join(dir, 'worktree');
    const reportPath = path.join(worktree, '.crew', 'reports', 'run_1.json');
    const fake = createFakeHerdr({ promptBehavior: 'report', reportPath, report: report() });
    const backend = new HerdrBackend(path.join(dir, 'state'), fake.run);
    const name = 'crew-tsk_01M6VCD1QSK57YAKYTPG9M55G6-developer';
    const events: string[] = [];

    const started = startInteractive(backend, {
      name,
      worktree,
      reportPath,
      onEvent: (message) => events.push(message),
    });
    expect(started.ok).toBe(true);
    await backend.wait(name, {
      timeoutMs: 2000,
      pollMs: 100,
      onEvent: (message) => events.push(message),
    });

    expect(events.some((event) => event.includes('herdr tab created'))).toBe(true);
    expect(events.some((event) => event.includes('pi agent started'))).toBe(true);
    expect(events.some((event) => event.includes('prompt sent'))).toBe(true);
    expect(events.some((event) => event.includes('report detected'))).toBe(true);
  });
});
