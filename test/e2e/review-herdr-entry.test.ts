import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createReviewHerdrFixture } from './review-herdr-fixture';

describe('review tab in Herdr: entering review', () => {
  const fixture = createReviewHerdrFixture();

  beforeAll(() => fixture.setup());
  beforeEach(() => fixture.resetHerdr());
  afterAll(() => fixture.cleanup());

  it('opens a tab on the task worktree when the task enters review', () => {
    fixture.configure('reviewr');
    const id = fixture.createTask('Open review tab');
    fixture.runTask(id);

    const detail = fixture.cli(['--json', 'task', 'show', id]);
    expect(detail.json.task.state).toBe('review');
    const worktree = detail.json.task.worktreePath as string;
    const opens = fixture.opensFor(worktree);
    expect(opens).toHaveLength(1);
    expect(opens[0]?.args).toEqual([
      'plugin',
      'pane',
      'open',
      '--plugin',
      'persiyanov.reviewr',
      '--entrypoint',
      'pane',
      '--placement',
      'tab',
      '--cwd',
      worktree,
      '--no-focus',
    ]);
  });

  it('does nothing when review.herdr_tab is off', () => {
    fixture.configure('off');
    const id = fixture.createTask('Off review tab');
    fixture.runTask(id);
    const worktree = fixture.cli(['--json', 'task', 'show', id]).json.task.worktreePath;
    expect(fixture.opensFor(worktree)).toHaveLength(0);
  });

  it('keeps the task in review and records review.surface_failed', () => {
    fixture.configure('missing.plugin');
    const id = fixture.createTask('Failed review surface');
    fixture.runTask(id);

    const detail = fixture.cli(['--json', 'task', 'show', id]);
    expect(detail.json.task.state).toBe('review');
    const failed = detail.json.events.find(
      (event: { type: string }) => event.type === 'review.surface_failed',
    );
    expect(failed?.payload).toMatchObject({ plugin: 'missing.plugin' });
  });
});
