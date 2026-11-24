/**
 * Fake Herdr workspace and tab handlers, split out of fake-herdr.ts to keep it
 * under the linter's line budget; `fake` is mutated in place.
 */
import type { HerdrResponse } from '../../src/app/session/herdr';
import { option, response, type FakeHerdr } from './fake-herdr-types';

/** Counters shared by the workspace and tab handlers of one fake. */
export interface WorkspaceCounters {
  nextWorkspace: number;
  nextTab: number;
}

/** The workspace and tab commands, or null when the call is another command. */
export function workspaceAndTabHandler(
  fake: FakeHerdr,
  counters: WorkspaceCounters,
  args: string[],
): HerdrResponse | null {
  if (args[0] === 'workspace' && args[1] === 'list') {
    return response({ type: 'workspace_list', workspaces: fake.workspaces });
  }
  if (args[0] === 'workspace' && args[1] === 'create') {
    const id = `w${counters.nextWorkspace++}`;
    const label = option(args, '--label') ?? id;
    const paneId = `${id}:p1`;
    const tabId = `${id}:t1`;
    fake.workspaces.push({ workspace_id: id, label });
    fake.tabs.push({
      tab_id: tabId,
      workspace_id: id,
      label: '1',
      cwd: option(args, '--cwd') ?? process.cwd(),
      pane_id: paneId,
    });
    return response({
      type: 'workspace_created',
      workspace: { workspace_id: id, label },
      tab: { tab_id: tabId, workspace_id: id, label: '1' },
      root_pane: { pane_id: paneId, tab_id: tabId, workspace_id: id },
    });
  }
  if (args[0] === 'workspace' && args[1] === 'close') {
    fake.workspaceCloses.push(args[2] ?? '');
    fake.workspaces = fake.workspaces.filter((item) => item.workspace_id !== args[2]);
    return response({ type: 'workspace_closed' });
  }
  if (args[0] === 'tab' && args[1] === 'create') {
    const workspaceId = option(args, '--workspace') ?? '';
    const id = `${workspaceId}:t${++counters.nextTab}`;
    const paneId = `${workspaceId}:p${counters.nextTab}`;
    fake.tabs.push({
      tab_id: id,
      workspace_id: workspaceId,
      label: option(args, '--label') ?? 'new',
      cwd: option(args, '--cwd') ?? process.cwd(),
      pane_id: paneId,
    });
    return response({
      type: 'tab_created',
      tab: { tab_id: id, workspace_id: workspaceId },
      root_pane: { pane_id: paneId, workspace_id: workspaceId },
    });
  }
  if (args[0] === 'tab' && args[1] === 'rename') {
    const tabId = args[2] ?? '';
    const label = args.slice(3).join(' ');
    for (const tab of fake.tabs) {
      if (tab.tab_id === tabId) {
        tab.label = label;
      }
    }
    return response({ type: 'tab_renamed', tab: { tab_id: tabId, label } });
  }
  if (args[0] === 'tab' && args[1] === 'close') {
    fake.tabs = fake.tabs.filter((tab) => tab.tab_id !== args[2]);
    fake.agents = fake.agents.filter((agent) => agent.tab_id !== args[2]);
    return response({ type: 'tab_closed' });
  }
  return null;
}
