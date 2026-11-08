import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { HerdrResponse } from '../../src/app/session/herdr';
import {
  failure,
  option,
  response,
  type FakeAgent,
  type FakeHerdr,
  type FakeHerdrOptions,
} from './fake-herdr-types';

export type { FakeAgent, FakeHerdr, FakeHerdrOptions, FakeTab } from './fake-herdr-types';

export function createFakeHerdr(options: FakeHerdrOptions = {}): FakeHerdr {
  const fake: FakeHerdr = {
    run: () => failure('not ready'),
    calls: [],
    workspaces: [],
    tabs: [],
    agents: (options.existingAgents ?? []).map((name, index) => ({
      name,
      agent: 'pi',
      agent_status: 'idle',
      pane_id: `w0:p${index + 1}`,
      tab_id: `w0:t${index + 1}`,
      workspace_id: 'w0',
    })),
    prompts: [],
    workspaceCloses: [],
  };
  let nextWorkspace = 1;
  let nextTab = 1;

  const findAgent = (target: string): FakeAgent | undefined =>
    fake.agents.find((agent) => agent.name === target || agent.pane_id === target);

  fake.run = (args: string[]): HerdrResponse => {
    fake.calls.push(args);
    if (args[0] === '--version') {
      return { ok: true, stdout: 'herdr 0.9.5\n', stderr: '', json: null };
    }
    if (args[0] === 'status' && args[1] === 'server') {
      return response({ type: 'server_status', status: 'running' });
    }
    if (args[0] === 'workspace' && args[1] === 'list') {
      return response({ type: 'workspace_list', workspaces: fake.workspaces });
    }
    if (args[0] === 'workspace' && args[1] === 'create') {
      const id = `w${nextWorkspace++}`;
      const label = option(args, '--label') ?? id;
      const paneId = `${id}:p1`;
      fake.workspaces.push({ workspace_id: id, label });
      fake.tabs.push({
        tab_id: `${id}:t1`,
        workspace_id: id,
        label: '1',
        cwd: option(args, '--cwd') ?? process.cwd(),
        pane_id: paneId,
      });
      return response({
        type: 'workspace_created',
        workspace: { workspace_id: id, label },
        root_pane: { pane_id: paneId, workspace_id: id },
      });
    }
    if (args[0] === 'workspace' && args[1] === 'close') {
      fake.workspaceCloses.push(args[2] ?? '');
      fake.workspaces = fake.workspaces.filter((item) => item.workspace_id !== args[2]);
      return response({ type: 'workspace_closed' });
    }
    if (args[0] === 'tab' && args[1] === 'create') {
      const workspaceId = option(args, '--workspace') ?? '';
      const id = `${workspaceId}:t${++nextTab}`;
      const paneId = `${workspaceId}:p${nextTab}`;
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
    if (args[0] === 'tab' && args[1] === 'close') {
      fake.tabs = fake.tabs.filter((tab) => tab.tab_id !== args[2]);
      fake.agents = fake.agents.filter((agent) => agent.tab_id !== args[2]);
      return response({ type: 'tab_closed' });
    }
    if (args[0] === 'agent' && args[1] === 'list') {
      return response({ type: 'agent_list', agents: fake.agents });
    }
    if (args[0] === 'agent' && args[1] === 'start') {
      const paneId = option(args, '--pane') ?? '';
      const tab = fake.tabs.find((item) => item.pane_id === paneId);
      const agent: FakeAgent = {
        name: args[2] ?? null,
        agent: option(args, '--kind') ?? 'pi',
        agent_status: 'idle',
        pane_id: paneId,
        tab_id: tab?.tab_id ?? '',
        workspace_id: tab?.workspace_id ?? '',
      };
      fake.agents.push(agent);
      return response({ type: 'agent_started', agent });
    }
    if (args[0] === 'agent' && args[1] === 'wait') {
      return response({ type: 'wait_matched', state: 'idle' });
    }
    if (args[0] === 'agent' && args[1] === 'prompt') {
      const agent = findAgent(args[2] ?? '');
      if (!agent) {
        return failure(`agent target ${args[2]} not found`);
      }
      fake.prompts.push(args[3] ?? '');
      if (options.promptBehavior === 'blocked') {
        agent.agent_status = 'blocked';
      } else if (options.promptBehavior === 'report') {
        agent.agent_status = 'idle';
        if (options.reportPath) {
          mkdirSync(path.dirname(options.reportPath), { recursive: true });
          writeFileSync(
            options.reportPath,
            JSON.stringify(options.report ?? {}, null, 2),
            'utf8',
          );
        }
      } else {
        agent.agent_status = 'working';
      }
      return response({ type: 'agent_prompted', agent });
    }
    if (args[0] === 'agent' && args[1] === 'get') {
      const agent = findAgent(args[2] ?? '');
      return agent ? response({ type: 'agent_info', agent }) : failure('agent not found');
    }
    if (args[0] === 'agent' && args[1] === 'read') {
      return {
        ok: true,
        stdout: options.readOutput ?? 'agent output',
        stderr: '',
        json: null,
      };
    }
    if (args[0] === 'pane' && args[1] === 'process-info') {
      return response({
        type: 'pane_process_info',
        process_info: { shell_pid: 4242, foreground_processes: [{ pid: 4242 }] },
      });
    }
    if (args[0] === 'pane' && args[1] === 'run') {
      return response({ type: 'pane_run', pane_id: args[2] });
    }
    if (args[0] === 'pane' && args[1] === 'read') {
      return {
        ok: true,
        stdout: options.readOutput ?? 'pane output',
        stderr: '',
        json: null,
      };
    }
    if (args[0] === 'pane' && args[1] === 'list') {
      const workspace = option(args, '--workspace');
      const panes = fake.tabs
        .filter((tab) => !workspace || tab.workspace_id === workspace)
        .map((tab) => ({ pane_id: tab.pane_id, workspace_id: tab.workspace_id }));
      return response({ type: 'pane_list', panes });
    }
    if (args[0] === 'pane' && args[1] === 'get') {
      const tab = fake.tabs.find((item) => item.pane_id === args[2]);
      return tab
        ? response({ type: 'pane_info', pane: { pane_id: tab.pane_id, agent_status: 'idle' } })
        : failure('pane not found');
    }
    if (args[0] === 'pane' && args[1] === 'close') {
      fake.tabs = fake.tabs.filter((tab) => tab.pane_id !== args[2]);
      return response({ type: 'pane_closed' });
    }
    return failure(`fake herdr: unsupported ${args.join(' ')}`);
  };

  return fake;
}
