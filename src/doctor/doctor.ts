import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isPidAlive } from '../core/process';
import { isTerminalTaskState } from '../core/state';
import { readProjectConfig, type ResolvedContext } from '../config/config';
import { resolveWorkspace } from '../app/workspace';
import { detectHarness } from '../adapters/harness/detect';
import { fakeAgentPath } from '../adapters/harness/fake';
import { getHarness, listHarnessAdapters } from '../adapters/harness/registry';
import type { Store } from '../store/store';

export type DoctorStatus = 'ok' | 'warn' | 'error';

export interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  detail: string;
}

export interface DoctorResult {
  ok: boolean;
  checks: DoctorCheck[];
}

export function runDoctor(store: Store, context: ResolvedContext): DoctorResult {
  const checks: DoctorCheck[] = [];

  const integrity = store.integrityCheck();
  checks.push({
    name: 'database.integrity',
    status: integrity === 'ok' ? 'ok' : 'error',
    detail: integrity,
  });

  const version = store.schemaVersion();
  checks.push({
    name: 'database.schema',
    status: version >= 4 ? 'ok' : 'warn',
    detail: `schema version ${version}`,
  });

  checks.push({
    name: 'fake-agent',
    status: existsSync(fakeAgentPath()) ? 'ok' : 'error',
    detail: fakeAgentPath(),
  });

  try {
    getHarness(context.config.harness);
  } catch (error) {
    checks.push({
      name: 'harness.configured',
      status: 'error',
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  for (const adapter of listHarnessAdapters()) {
    if (adapter.manifest.spec.detect.binaries.length === 0) {
      continue;
    }
    const id = adapter.manifest.metadata.id;
    const availability = detectHarness(adapter.manifest);
    const configured =
      context.config.harness === id ||
      context.config.agents.developer.harness === id ||
      context.config.agents.tester.harness === id;
    checks.push({
      name: `harness.${id}`,
      status: availability.available ? 'ok' : configured ? 'error' : 'warn',
      detail:
        availability.binary ??
        `not found on PATH: ${adapter.manifest.spec.detect.binaries.join(', ')}`,
    });
  }

  for (const role of ['developer', 'tester'] as const) {
    const configured = context.config.agents[role].harness;
    if (!configured) {
      continue;
    }
    try {
      getHarness(configured);
    } catch (error) {
      checks.push({
        name: `agents.${role}.harness`,
        status: 'error',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  checks.push({
    name: 'paths.data',
    status: existsSync(context.paths.dataDir) ? 'ok' : 'warn',
    detail: context.paths.dataDir,
  });

  const needsGithubDelivery = (mode: string): boolean =>
    mode === 'pr' || mode === 'auto_merge';
  const projects = store.listProjects();
  let needsGitHub =
    needsGithubDelivery(context.config.delivery) ||
    store.listTasks().some((task) => needsGithubDelivery(task.deliveryMode));
  for (const project of projects) {
    try {
      const config = readProjectConfig(project.rootPath);
      if (
        (config?.delivery && needsGithubDelivery(config.delivery)) ||
        config?.ci
      ) {
        needsGitHub = true;
      }
      if (
        config?.methodology &&
        config.methodology !== 'free' &&
        (!config.verify || config.verify.length === 0)
      ) {
        checks.push({
          name: `project.${project.name}.verify`,
          status: 'warn',
          detail: `${config.methodology} methodology has no verify commands`,
        });
      }
    } catch (error) {
      checks.push({
        name: `project.${project.name}.config`,
        status: 'error',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (needsGitHub) {
    const result = spawnSync('gh', ['auth', 'status'], {
      encoding: 'utf8',
      env: { ...process.env, GH_PROMPT_DISABLED: '1' },
    });
    const available = !result.error && result.status === 0;
    checks.push({
      name: 'github.cli',
      status: available ? 'ok' : 'error',
      detail: available
        ? 'gh is installed and authenticated'
        : result.error?.message ??
          (result.stderr || result.stdout || 'gh auth status failed').trim(),
    });
  }

  const lease = store.getLease('daemon');
  if (!lease) {
    checks.push({
      name: 'daemon.lease',
      status: 'ok',
      detail: 'no daemon lease',
    });
  } else {
    const active = Date.parse(lease.expiresAt) > Date.now();
    checks.push({
      name: 'daemon.lease',
      status: active ? 'ok' : 'warn',
      detail: `${lease.owner} expires ${lease.expiresAt}`,
    });
  }

  const activeRuns = store.listActiveRuns();
  if (activeRuns.length === 0) {
    checks.push({
      name: 'runs.active',
      status: 'ok',
      detail: 'no active runs',
    });
  } else {
    for (const run of activeRuns) {
      if (run.pid && isPidAlive(run.pid)) {
        checks.push({
          name: `run.${run.id}`,
          status: 'ok',
          detail: `pid ${run.pid} is alive`,
        });
      } else {
        checks.push({
          name: `run.${run.id}`,
          status: 'warn',
          detail: `stale run: state=${run.state} pid=${run.pid ?? 'none'}`,
        });
      }
    }
  }

  for (const task of store.listTasks()) {
    if (!task.worktreePath) {
      continue;
    }
    const project = store.getProject(task.projectId);
    if (!project) {
      continue;
    }
    const resolution = resolveWorkspace({
      project,
      projectConfig: readProjectConfig(project.rootPath),
      task,
      worktreesDir: context.paths.worktreesDir,
    });
    if (!resolution.workspace.exists(resolution.workspace.worktreePath)) {
      checks.push({
        name: `worktree.${task.id}`,
        status: isTerminalTaskState(task.state) ? 'warn' : 'error',
        detail: `missing worktree for ${task.state} task: ${task.worktreePath}`,
      });
    } else if (isTerminalTaskState(task.state)) {
      checks.push({
        name: `worktree.${task.id}`,
        status: 'warn',
        detail: `terminal task still has a worktree: ${task.worktreePath}`,
      });
    }
  }

  return {
    ok: checks.every((check) => check.status !== 'error'),
    checks,
  };
}
