import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createReviewHerdrFixture } from './review-herdr-fixture';

describe('review tab in Herdr: manual and idempotent', () => {
  const fixture = createReviewHerdrFixture();

  beforeAll(() => fixture.setup());
  beforeEach(() => fixture.resetHerdr());
  afterAll(() => fixture.cleanup());

  it('reuses the review tab instead of opening a second pane', () => {
    fixture.configure('reviewr');
    const id = fixture.createTask('Reuse review tab');
    fixture.runTask(id);
    const worktree = fixture.cli(['--json', 'task', 'show', id]).json.task.worktreePath;
    expect(fixture.opensFor(worktree)).toHaveLength(1);

    const manual = fixture.cli(['--json', 'task', 'review', id, '--herdr']);
    expect(manual.status, manual.stderr).toBe(0);
    expect(manual.json).toMatchObject({ opened: true, reused: true });
    expect(fixture.opensFor(worktree)).toHaveLength(1);
    expect(fixture.calls()).toContainEqual(['plugin', 'pane', 'focus', 'w1:p9']);
  });

  it('opens the tab on demand when the review tab was closed', () => {
    fixture.configure('off');
    const id = fixture.createTask('Manual review tab');
    fixture.runTask(id);
    const worktree = fixture.cli(['--json', 'task', 'show', id]).json.task.worktreePath;
    expect(fixture.opensFor(worktree)).toHaveLength(0);

    const manual = fixture.cli(['--json', 'task', 'review', id, '--herdr']);
    expect(manual.status, manual.stderr).toBe(0);
    expect(manual.json).toMatchObject({ opened: true, reused: false });
    expect(fixture.opensFor(worktree)).toHaveLength(1);
  });
});
