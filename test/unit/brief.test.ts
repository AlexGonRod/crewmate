import { describe, expect, it } from 'vitest';
import { generateBrief } from '../../src/brief/brief';
import { newId } from '../../src/core/ids';
import type { Methodology, Project, Run, Task, TaskSpec } from '../../src/core/types';

const project: Project = {
  id: newId('prj'),
  name: 'demo',
  rootPath: '/tmp/demo',
  defaultBranch: 'main',
  remoteUrl: null,
  forge: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const run: Run = {
  id: newId('run'),
  taskId: newId('tsk'),
  attempt: 1,
  harnessId: 'fake',
  backend: 'process',
  state: 'running',
  pid: null,
  exitCode: null,
  logPath: '/tmp/run.jsonl',
  startedAt: '2026-01-01T00:00:00.000Z',
  endedAt: null,
};

function makeTask(
  methodology: Methodology,
  spec: TaskSpec | null,
): Task {
  return {
    id: run.taskId,
    projectId: project.id,
    title: 'Task',
    slug: 'task',
    briefText: 'Do the thing',
    methodology,
    spec,
    state: 'running',
    deliveryMode: 'local',
    baseBranch: 'main',
    branch: 'crew/task',
    worktreePath: '/tmp/worktree',
    harnessId: 'fake',
    priority: 0,
    lastSeq: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: null,
  };
}

function makeBrief(task: Task): string {
  return generateBrief({
    task,
    project,
    run,
    attempt: 1,
    reportPath: '/tmp/worktree/.crew/report.json',
    briefPath: '/tmp/worktree/.crew/brief.md',
    specPath: '/tmp/worktree/.crew/spec.json',
    cliCommand: 'crew',
    methodology: task.methodology,
    spec: task.spec,
    verifyCommands: ['pnpm test'],
    messages: [],
  });
}

const spec: TaskSpec = {
  schema: 'crew.spec/v1',
  goal: 'Add the endpoint',
  acceptance_criteria: [
    { id: 'AC1', text: 'It returns 200' },
    { id: 'AC2', text: 'It has a test' },
  ],
  non_goals: ['Authentication'],
};

describe('brief generation', () => {
  it('keeps the free methodology on report v1', () => {
    const brief = makeBrief(makeTask('free', null));
    expect(brief).toContain('methodology: "free"');
    expect(brief).toContain('crew.report/v1');
    expect(brief).not.toContain('## Methodology:');
  });

  it('renders acceptance criteria and v2 reporting for spec', () => {
    const brief = makeBrief(makeTask('spec', spec));
    expect(brief).toContain('## Acceptance criteria');
    expect(brief).toContain('**AC1**: It returns 200');
    expect(brief).toContain('### Non-goals');
    expect(brief).toContain('## Methodology: spec');
    expect(brief).toContain('crew.report/v2');
    expect(brief).toContain('CREW_SPEC_PATH');
  });

  it('adds red-green-refactor instructions for tdd', () => {
    const brief = makeBrief(makeTask('tdd', spec));
    expect(brief).toContain('## Methodology: TDD');
    expect(brief).toContain('**Red**');
    expect(brief).toContain('**Green**');
    expect(brief).toContain('phase');
    expect(brief).toContain('crew.report/v2');
  });
});
