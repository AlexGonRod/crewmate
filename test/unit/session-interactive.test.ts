import { describe, expect, it } from 'vitest';
import {
  CREW_SESSION_WORKSPACE,
  buildInteractivePrompt,
  decideInteractiveRun,
  interactiveAgentBaseName,
  isValidAgentName,
  resolveInteractiveMode,
  uniqueAgentName,
} from '../../src/app/session/interactive';

describe('interactive agent names', () => {
  it('builds a valid, deterministic base name from the run and the role', () => {
    const runId = 'run_01M6VCY2CJTPGS2W5PTEEDDT48';
    const base = interactiveAgentBaseName(runId, 'developer');
    expect(base).toBe('crew-5pteeddt48-dev');
    expect(isValidAgentName(base)).toBe(true);
    expect(interactiveAgentBaseName(runId, 'tester')).toContain('test');
  });

  it('keeps names inside the Herdr constraint even with long run ids', () => {
    const base = interactiveAgentBaseName(`run_${'A'.repeat(26)}`, 'developer');
    expect(base.length).toBeLessThanOrEqual(32);
    expect(isValidAgentName(base)).toBe(true);
  });

  it('resolves collisions with a numeric suffix without breaking the pattern', () => {
    const base = 'crew-cjtpgs2w5p-dev';
    const taken = new Set([base]);
    const second = uniqueAgentName(base, taken);
    expect(second).toBe(`${base}-2`);
    expect(isValidAgentName(second)).toBe(true);
    expect(second).not.toBe(base);

    taken.add(second);
    const third = uniqueAgentName(base, taken);
    expect(third).toBe(`${base}-3`);
    expect(isValidAgentName(third)).toBe(true);
  });

  it('truncates the base when the suffix would overflow the limit', () => {
    const base = 'a'.repeat(32);
    const name = uniqueAgentName(base, new Set([base]));
    expect(name.length).toBeLessThanOrEqual(32);
    expect(name.endsWith('-2')).toBe(true);
    expect(isValidAgentName(name)).toBe(true);
  });

  it('rejects names Herdr would reject', () => {
    expect(isValidAgentName('crew-ok')).toBe(true);
    expect(isValidAgentName('1crew')).toBe(false);
    expect(isValidAgentName('Crew')).toBe(false);
    expect(isValidAgentName('crew name')).toBe(false);
    expect(isValidAgentName(`crew-${'a'.repeat(40)}`)).toBe(false);
  });
});

describe('interactive prompt', () => {
  it('points the agent at the absolute brief and report paths', () => {
    const prompt = buildInteractivePrompt({
      briefPath: '/work/task/.crew/brief.md',
      reportPath: '/work/task/.crew/reports/run_1.json',
      worktreePath: '/work/task',
    });
    expect(prompt).toContain('/work/task/.crew/brief.md');
    expect(prompt).toContain('/work/task/.crew/reports/run_1.json');
    expect(prompt).toContain('/work/task');
    expect(prompt.length).toBeLessThan(500);
  });
});

describe('interactive mode resolution', () => {
  it('is off by default', () => {
    expect(resolveInteractiveMode(undefined, undefined)).toBe(false);
    expect(resolveInteractiveMode(false, undefined)).toBe(false);
  });

  it('turns on with the project config', () => {
    expect(resolveInteractiveMode(true, undefined)).toBe(true);
  });

  it('lets the environment override the config in both directions', () => {
    expect(resolveInteractiveMode(false, '1')).toBe(true);
    expect(resolveInteractiveMode(false, 'true')).toBe(true);
    expect(resolveInteractiveMode(true, '0')).toBe(false);
    expect(resolveInteractiveMode(true, 'false')).toBe(false);
    expect(resolveInteractiveMode(true, 'maybe')).toBe(true);
  });

  it('names the shared crew workspace', () => {
    expect(CREW_SESSION_WORKSPACE).toBe('crew-sessions');
  });
});

describe('interactive run decision', () => {
  it('finishes with exit 0 only when the report parses and the agent settled', () => {
    expect(
      decideInteractiveRun({ report: 'valid', agentState: 'idle', timedOut: false }),
    ).toEqual({ done: true, exitCode: 0, reason: null });
    expect(
      decideInteractiveRun({ report: 'valid', agentState: 'done', timedOut: false }),
    ).toEqual({ done: true, exitCode: 0, reason: null });
  });

  it('keeps waiting while the agent works or the report is missing', () => {
    expect(
      decideInteractiveRun({ report: 'valid', agentState: 'working', timedOut: false }),
    ).toEqual({ done: false, exitCode: null, reason: null });
    expect(
      decideInteractiveRun({ report: 'missing', agentState: 'idle', timedOut: false }),
    ).toEqual({ done: false, exitCode: null, reason: null });
    expect(
      decideInteractiveRun({ report: 'invalid', agentState: 'idle', timedOut: false }),
    ).toEqual({ done: false, exitCode: null, reason: null });
  });

  it('fails on a blocked agent and on a timeout', () => {
    expect(
      decideInteractiveRun({ report: 'missing', agentState: 'blocked', timedOut: false }),
    ).toEqual({ done: true, exitCode: 1, reason: 'blocked' });
    expect(
      decideInteractiveRun({ report: 'valid', agentState: 'working', timedOut: true }),
    ).toEqual({ done: true, exitCode: null, reason: 'timeout' });
  });
});
