import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runVerificationCommands } from '../../src/verify/verify';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('independent verification', () => {
  it('runs commands and captures results and logs', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'crew-verify-'));
    tempDirs.push(dir);
    const results = await runVerificationCommands({
      taskId: 'tsk_test',
      runId: 'run_test',
      worktreePath: dir,
      commands: ['printf "verified"', 'exit 3'],
      timeoutSeconds: 5,
      tasksDir: path.join(dir, 'tasks'),
      env: {},
    });

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      command: 'printf "verified"',
      state: 'passed',
      exitCode: 0,
    });
    expect(results[0]?.output).toContain('verified');
    expect(results[1]).toMatchObject({
      command: 'exit 3',
      state: 'failed',
      exitCode: 3,
    });
    expect(readFileSync(results[1]!.logPath, 'utf8')).toContain('exit 3');
  });

  it('marks timed out commands as failed', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'crew-verify-'));
    tempDirs.push(dir);
    const results = await runVerificationCommands({
      taskId: 'tsk_test',
      runId: 'run_timeout',
      worktreePath: dir,
      commands: ['sleep 5'],
      timeoutSeconds: 0.2,
      tasksDir: path.join(dir, 'tasks'),
      env: {},
    });

    expect(results[0]?.state).toBe('failed');
    expect(results[0]?.timedOut).toBe(true);
  });

  it('exposes crew context to verification commands', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'crew-verify-'));
    tempDirs.push(dir);
    const results = await runVerificationCommands({
      taskId: 'tsk_test',
      runId: 'run_test',
      worktreePath: dir,
      commands: ['printf "$CREW_VERIFY:$CREW_TASK_ID"'],
      timeoutSeconds: 5,
      tasksDir: path.join(dir, 'tasks'),
      env: {},
    });

    expect(results[0]?.output).toContain('1:tsk_test');
  });
});
