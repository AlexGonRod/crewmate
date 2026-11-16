/**
 * Fake Herdr handlers for pane splits and plugin panes, used by the task
 * layout tests. Split out of fake-herdr.ts to keep it under the linter's
 * line budget; `fake` is mutated in place (its arrays are shared).
 */
import { failure, option, response, type FakeHerdr } from './fake-herdr-types';
import type { HerdrResponse } from '../../src/app/session/herdr';

export function splitAndPluginPaneHandler(
  fake: FakeHerdr,
  nextPane: { value: number },
  args: string[],
): HerdrResponse | null {
  if (args[0] === 'tab' && args[1] === 'get') {
    const tab = fake.tabs.find((item) => item.tab_id === args[2]);
    return tab ? response({ type: 'tab_info', tab }) : failure(`tab ${args[2]} not found`);
  }
  if (args[0] === 'pane' && args[1] === 'split') {
    const source = fake.tabs.find((item) => item.pane_id === (option(args, '--pane') ?? ''));
    if (!source) {
      return failure('pane not found');
    }
    const paneId = `${source.workspace_id}:s${++nextPane.value}`;
    fake.tabs.push({ ...source, pane_id: paneId, cwd: option(args, '--cwd') ?? source.cwd });
    return response({ type: 'pane_split', pane: { pane_id: paneId } });
  }
  if (args[0] === 'plugin' && args[1] === 'list') {
    return response({
      type: 'plugin_list',
      plugins: [
        {
          plugin_id: 'persiyanov.reviewr',
          name: 'reviewr',
          enabled: true,
          panes: [{ id: 'pane', title: 'reviewr' }],
        },
      ],
    });
  }
  if (args[0] === 'plugin' && args[1] === 'pane' && args[2] === 'open') {
    const workspaceId = option(args, '--workspace') ?? 'w0';
    const paneId = `${workspaceId}:pl${++nextPane.value}`;
    fake.tabs.push({
      tab_id: option(args, '--target-pane')?.split(':')[0] ?? `${workspaceId}:t0`,
      workspace_id: workspaceId,
      label: 'reviewr',
      cwd: option(args, '--cwd') ?? process.cwd(),
      pane_id: paneId,
    });
    fake.pluginPanes.push(paneId);
    return response({
      type: 'plugin_pane_opened',
      plugin_pane: { entrypoint: 'pane', pane: { pane_id: paneId, label: 'reviewr' } },
    });
  }
  if (args[0] === 'plugin' && args[1] === 'pane' && args[2] === 'focus') {
    return response({ type: 'ok' });
  }
  return null;
}
