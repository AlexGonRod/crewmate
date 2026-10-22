import { describe, expect, it } from 'vitest';
import { composeCaptainPrompt } from '../../src/app/captain-prompt';
import { parseCaptainOutput } from '../../src/app/captain-run';
import { newId } from '../../src/core/ids';
import type { Project } from '../../src/core/types';
import type { CaptainBrief } from '../../src/app/captain';

const project: Project = {
  id: newId('prj'),
  name: 'demo',
  rootPath: '/tmp/demo',
  defaultBranch: 'main',
  remoteUrl: null,
  forge: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const brief: CaptainBrief = {
  generatedAt: '2026-01-01T00:00:00.000Z',
  memory: [],
  lease: null,
  projects: [],
  counts: { review: 0 },
  totalTasks: 0,
  activeRuns: [],
  attention: [],
  tasks: [],
};

function prompt(overrides: Partial<Parameters<typeof composeCaptainPrompt>[0]> = {}) {
  return composeCaptainPrompt({
    project,
    brief,
    request: 'arregla el bug del login',
    memory: [],
    skills: [],
    crewCommand: 'crew',
    workerHarness: 'opencode',
    ...overrides,
  });
}

describe('the captain prompt', () => {
  it('carries the request as the person wrote it', () => {
    const text = prompt({ request: 'arregla el bug\ndel login' });
    expect(text).toContain('> arregla el bug\n> del login');
  });

  it('tells the captain which harness the workers use', () => {
    expect(prompt({ workerHarness: 'opencode' })).toContain(
      'Harness de los workers: opencode',
    );
  });

  it('requires --request when creating a task', () => {
    const text = prompt();
    expect(text).toContain('--request "<las palabras de la persona, sin tocar>"');
    expect(text).toContain('REQUEST_REQUIRED');
  });

  it('renders the conversation history', () => {
    const text = prompt({
      history: [
        { role: 'person', text: 'hola' },
        { role: 'captain', text: 'dime' },
      ],
    });
    expect(text).toContain('**Persona**: hola');
    expect(text).toContain('**Capitán**: dime');
  });
});

describe('reading the captain output', () => {
  const line = (text: string, sessionID = 'ses_1') =>
    JSON.stringify({ type: 'text', sessionID, part: { type: 'text', text } });

  it('takes the last message as the answer', () => {
    const output = [
      JSON.stringify({ type: 'step_start', sessionID: 'ses_1' }),
      line('voy a mirar el estado'),
      JSON.stringify({ type: 'tool_use', sessionID: 'ses_1' }),
      line('hecho: tarea creada'),
    ].join('\n');
    const parsed = parseCaptainOutput(output);
    expect(parsed.text).toBe('hecho: tarea creada');
    expect(parsed.transcript).toContain('voy a mirar el estado');
    expect(parsed.transcript).toContain('hecho: tarea creada');
    expect(parsed.sessionId).toBe('ses_1');
  });

  it('falls back to plain text when the output is not JSON', () => {
    const parsed = parseCaptainOutput('todo listo');
    expect(parsed.text).toBe('todo listo');
    expect(parsed.sessionId).toBeNull();
  });
});
