import { afterEach, describe, expect, it } from 'vitest';
import { openReviewSurface, DEFAULT_REVIEW_PLUGIN } from '../../src/app/review-surface';
import type { HerdrResponse, HerdrRunner } from '../../src/app/session/herdr';

const calls: string[][] = [];

function response(partial: Partial<HerdrResponse>): HerdrResponse {
  return { ok: true, stdout: '', stderr: '', json: null, ...partial };
}

function runner(overrides: Record<string, HerdrResponse> = {}): HerdrRunner {
  return (args) => {
    calls.push(args);
    const key = args.join(' ');
    if (key === 'status server') return response({});
    if (key === 'plugin list --json') {
      return response({
        json: {
          result: {
            plugins: [
              { plugin_id: DEFAULT_REVIEW_PLUGIN, name: 'reviewr', enabled: true, panes: [{ id: 'pane', title: 'reviewr' }] },
            ],
          },
        },
      });
    }
    if (key === 'pane list') return response({ json: { result: { panes: [] } } });
    return overrides[key] ?? response({ json: { result: { pane: { pane_id: 'w1:p9' } } } });
  };
}

afterEach(() => {
  calls.length = 0;
});

describe('review Herdr surface in the task layout', () => {
  it('opens the review pane as the right column of the task layout', () => {
    const result = openReviewSurface(DEFAULT_REVIEW_PLUGIN, '/worktrees/tsk_1', runner(), 'w1:s1');
    expect(result).toMatchObject({ opened: true, reused: false, paneId: 'w1:p9' });
    expect(calls.find((args) => args[0] === 'plugin' && args[2] === 'open')).toEqual([
      'plugin',
      'pane',
      'open',
      '--plugin',
      DEFAULT_REVIEW_PLUGIN,
      '--entrypoint',
      'pane',
      '--placement',
      'split',
      '--direction',
      'right',
      '--target-pane',
      'w1:s1',
      '--cwd',
      '/worktrees/tsk_1',
      '--no-focus',
    ]);
    // The placeholder half is closed so the plugin pane takes the column.
    expect(calls).toContainEqual(['pane', 'close', 'w1:s1']);
  });

  it('falls back to the tab placement when the layout column is gone', () => {
    const openKey =
      'plugin pane open --plugin persiyanov.reviewr --entrypoint pane --placement split ' +
      '--direction right --target-pane w1:s1 --cwd /worktrees/tsk_1 --no-focus';
    const result = openReviewSurface(
      DEFAULT_REVIEW_PLUGIN,
      '/worktrees/tsk_1',
      runner({ [openKey]: response({ ok: false, stderr: 'pane not found' }) }),
      'w1:s1',
    );
    expect(result.opened).toBe(true);
    const placements = calls
      .filter((args) => args[0] === 'plugin' && args[2] === 'open')
      .map((args) => args[args.indexOf('--placement') + 1]);
    expect(placements).toEqual(['split', 'tab']);
    expect(calls.some((args) => args[0] === 'pane' && args[1] === 'close')).toBe(false);
  });
});
