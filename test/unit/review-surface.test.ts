import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../../src/store/store';
import {
  openReviewSurface,
  openTaskReviewSurface,
  resolveReviewPluginId,
  DEFAULT_REVIEW_PLUGIN,
} from '../../src/app/review-surface';
import type { HerdrResponse, HerdrRunner } from '../../src/app/session/herdr';

const calls: string[][] = [];
const stores: Store[] = [];

function response(partial: Partial<HerdrResponse>): HerdrResponse {
  return { ok: true, stdout: '', stderr: '', json: null, ...partial };
}

function pluginList(plugin: Record<string, unknown> = {}): HerdrResponse {
  return response({
    json: {
      result: {
        plugins: [
          {
            plugin_id: DEFAULT_REVIEW_PLUGIN,
            name: 'reviewr',
            enabled: true,
            panes: [{ id: 'pane', title: 'reviewr', placement: 'split' }],
            ...plugin,
          },
        ],
      },
    },
  });
}

function runner(overrides: Record<string, HerdrResponse> = {}): HerdrRunner {
  return (args) => {
    calls.push(args);
    const key = args.join(' ');
    const match = overrides[key];
    if (match) {
      return match;
    }
    if (key === 'status server') return response({});
    if (key === 'plugin list --json') return pluginList();
    if (key === 'pane list') return response({ json: { result: { panes: [] } } });
    if (key.startsWith('plugin pane open')) {
      return response({ json: { result: { pane: { pane_id: 'w1:p9' } } } });
    }
    return response({ json: {} });
  };
}

function store(): Store {
  const created = new Store(':memory:');
  stores.push(created);
  return created;
}

afterEach(() => {
  calls.length = 0;
  while (stores.length > 0) {
    stores.pop()?.close();
  }
});

describe('review Herdr surface', () => {
  it('resolves the opt-in config value', () => {
    expect(resolveReviewPluginId(undefined)).toBeNull();
    expect(resolveReviewPluginId(null)).toBeNull();
    expect(resolveReviewPluginId('off')).toBeNull();
    expect(resolveReviewPluginId('  ')).toBeNull();
    expect(resolveReviewPluginId('reviewr')).toBe(DEFAULT_REVIEW_PLUGIN);
    expect(resolveReviewPluginId('acme.reviewer')).toBe('acme.reviewer');
  });

  it('opens the plugin pane as a tab on the task worktree without focus', () => {
    const result = openReviewSurface(
      DEFAULT_REVIEW_PLUGIN,
      '/worktrees/tsk_1',
      runner(),
    );
    expect(result).toMatchObject({
      opened: true,
      reused: false,
      paneId: 'w1:p9',
      reason: null,
    });
    const open = calls.find((args) => args[0] === 'plugin' && args[2] === 'open');
    expect(open).toEqual([
      'plugin',
      'pane',
      'open',
      '--plugin',
      DEFAULT_REVIEW_PLUGIN,
      '--entrypoint',
      'pane',
      '--placement',
      'tab',
      '--cwd',
      '/worktrees/tsk_1',
      '--no-focus',
    ]);
  });

  it('focuses an existing review pane instead of opening a second one', () => {
    const result = openReviewSurface(
      DEFAULT_REVIEW_PLUGIN,
      '/worktrees/tsk_1',
      runner({
        'pane list': response({
          json: {
            result: {
              panes: [
                { pane_id: 'w1:p5', label: 'reviewr', cwd: '/worktrees/tsk_1' },
                { pane_id: 'w1:p6', label: 'reviewr', cwd: '/other' },
              ],
            },
          },
        }),
      }),
    );
    expect(result).toMatchObject({ opened: true, reused: true, paneId: 'w1:p5' });
    expect(calls.some((args) => args[0] === 'plugin' && args[2] === 'open')).toBe(false);
    expect(calls).toContainEqual(['plugin', 'pane', 'focus', 'w1:p5']);
  });

  it('fails soft when Herdr is not available', () => {
    const result = openReviewSurface(
      DEFAULT_REVIEW_PLUGIN,
      '/worktrees/tsk_1',
      runner({ 'status server': response({ ok: false, stderr: 'no server' }) }),
    );
    expect(result.opened).toBe(false);
    expect(result.reason).toContain('herdr is not available');
  });

  it('fails soft when the plugin is not installed', () => {
    const result = openReviewSurface(
      DEFAULT_REVIEW_PLUGIN,
      '/worktrees/tsk_1',
      runner({
        'plugin list --json': response({ json: { result: { plugins: [] } } }),
      }),
    );
    expect(result.opened).toBe(false);
    expect(result.reason).toContain('is not installed');
  });

  it('records review.surface_failed without throwing', () => {
    const db = store();
    const project = db.createProject({
      name: 'demo',
      rootPath: '/tmp/demo',
      defaultBranch: 'main',
      remoteUrl: null,
      forge: null,
    });
    const task = db.createTask({
      projectId: project.id,
      title: 'Review surface',
      briefText: 'Do the thing',
      deliveryMode: 'local',
      methodology: 'free',
      spec: null,
    });
    const outcome = openTaskReviewSurface(db, {
      taskId: task.id,
      pluginId: DEFAULT_REVIEW_PLUGIN,
      worktreePath: '/worktrees/tsk_1',
      run: runner({
        'status server': response({ ok: false, stderr: 'no server' }),
      }),
    });
    expect(outcome.opened).toBe(false);
    const event = db
      .listEvents({ taskId: task.id })
      .find((item) => item.type === 'review.surface_failed');
    expect(event?.payload).toMatchObject({
      plugin: DEFAULT_REVIEW_PLUGIN,
      worktree: '/worktrees/tsk_1',
    });
  });
});
