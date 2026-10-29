import { describe, expect, it } from 'vitest';
import type {
  Artifact,
  ChangeStats,
  Project,
  Task,
  TaskDetail,
} from '../../src/core/types';
import { summarizeDetail } from '../../src/app/summary';

const project: Project = {
  id: 'prj_1',
  name: 'demo',
  rootPath: '/tmp/demo',
  defaultBranch: 'main',
  remoteUrl: null,
  forge: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const task: Task = {
  id: 'tsk_1',
  projectId: project.id,
  title: 'Task',
  slug: 'task',
  requestText: null,
  origin: 'cli',
  briefText: 'Do the thing',
  methodology: 'free',
  spec: null,
  stage: 'review',
  reviewIterations: 0,
  commitSha: 'abc123',
  prUrl: null,
  state: 'review',
  deliveryMode: 'local',
  baseBranch: 'main',
  branch: 'crew/task',
  worktreePath: '/tmp/worktree',
  harnessId: 'fake',
  priority: 0,
  attempts: 1,
  nextAttemptAt: null,
  lastError: null,
  retryable: false,
  lastSeq: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T01:00:00.000Z',
  finishedAt: null,
};

function detail(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    task,
    project,
    runs: [],
    report: null,
    reports: [],
    messages: [],
    artifacts: [],
    verifications: [],
    dependencies: [],
    events: [],
    ...overrides,
  };
}

function changeArtifact(stats: Partial<ChangeStats>): Artifact {
  return {
    id: 'art_change',
    taskId: task.id,
    runId: null,
    kind: 'change',
    ref: `${stats.files ?? 0} file(s)`,
    metadata: {
      files: 2,
      additions: 100,
      deletions: 100,
      paths: ['src/a.ts', 'src/b.ts'],
      ...stats,
    },
    createdAt: task.createdAt,
  };
}

function routeArtifact(metadata: Record<string, unknown>): Artifact {
  return {
    id: 'art_route',
    taskId: task.id,
    runId: null,
    kind: 'review_route',
    ref: 'review route',
    metadata,
    createdAt: task.createdAt,
  };
}

describe('summarizeDetail', () => {
  it('reports the recorded tester route and its reason', () => {
    const summary = summarizeDetail(
      detail({
        artifacts: [
          routeArtifact({
            route: 'skipped',
            reason: 'tester skipped: pre-commit risk is low (small change: 1 file(s), +5/-1)',
          }),
        ],
      }),
    );
    expect(summary.reviewRoute).toEqual({
      route: 'skipped',
      reason: 'tester skipped: pre-commit risk is low (small change: 1 file(s), +5/-1)',
    });
  });

  it('ignores a review route artifact with an unknown or missing route', () => {
    const summary = summarizeDetail(
      detail({ artifacts: [routeArtifact({ route: 'nonsense' })] }),
    );
    expect(summary.reviewRoute).toBe(null);
    expect(summarizeDetail(detail()).reviewRoute).toBe(null);
  });

  it('always holds the advisories list', () => {
    expect(summarizeDetail(detail()).advisories).toEqual([]);
  });

  it('advises when the change is bigger than a reviewable work unit', () => {
    const summary = summarizeDetail(
      detail({
        artifacts: [
          changeArtifact({ additions: 700, deletions: 90, files: 4 }),
        ],
      }),
    );
    const advisory = summary.advisories[0] ?? '';
    expect(advisory).toContain('oversized change: +700/-90 over 4 file(s)');
    expect(advisory).toContain('400 authored lines');
  });

  it('stays quiet for a change at or under the advisory threshold', () => {
    const summary = summarizeDetail(
      detail({
        artifacts: [changeArtifact({ additions: 350, deletions: 45, files: 2 })],
      }),
    );
    expect(summary.advisories).toEqual([]);
  });
});
