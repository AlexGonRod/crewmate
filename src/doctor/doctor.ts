import { existsSync } from 'node:fs';
import { isTerminalTaskState } from '../core/state';
import { readProjectConfig, type ResolvedContext } from '../config/config';
import { fakeAgentPath } from '../adapters/harness/fake';
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

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
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
    status: version >= 2 ? 'ok' : 'warn',
    detail: `schema version ${version}`,
  });

  checks.push({
    name: 'fake-agent',
    status: existsSync(fakeAgentPath()) ? 'ok' : 'error',
    detail: fakeAgentPath(),
  });

  checks.push({
    name: 'paths.data',
    status: existsSync(context.paths.dataDir) ? 'ok' : 'warn',
    detail: context.paths.dataDir,
  });

  for (const project of store.listProjects()) {
    try {
      const config = readProjectConfig(project.rootPath);
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
    if (!existsSync(task.worktreePath)) {
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
