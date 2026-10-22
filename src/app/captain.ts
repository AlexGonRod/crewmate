import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { readProjectConfig } from '../config/config';
import { parseRunnerConfig } from './runner';
import { resolveDeliveryPolicy } from './delivery';
import { CrewError } from '../core/errors';
import type { Memory, Project, TaskState } from '../core/types';
import { summarizeDetail } from './summary';
import type { Store } from '../store/store';

export const CAPTAIN_AGENTS_FILE = 'AGENTS.md';

import { CAPTAIN_AGENTS_TEMPLATE } from './role-agents';

export { CAPTAIN_AGENTS_TEMPLATE };
export interface CaptainInitResult {
  path: string;
  created: boolean;
  overwritten: boolean;
}

export function captainInstructionsPath(rootPath: string): string {
  return path.join(rootPath, CAPTAIN_AGENTS_FILE);
}

export function writeCaptainInstructions(
  rootPath: string,
  options: { force?: boolean } = {},
): CaptainInitResult {
  const target = captainInstructionsPath(rootPath);
  const exists = existsSync(target);
  if (exists && !options.force) {
    throw new CrewError(
      'CAPTAIN_AGENTS_EXISTS',
      `${target} already exists; use --force to overwrite it`,
    );
  }
  mkdirSync(path.dirname(target), { recursive: true });
  const current = exists ? readFileSync(target, 'utf8') : null;
  writeFileSync(target, CAPTAIN_AGENTS_TEMPLATE, 'utf8');
  return {
    path: target,
    created: !exists,
    overwritten: exists && current !== CAPTAIN_AGENTS_TEMPLATE,
  };
}

export interface CaptainProjectBrief {
  id: string;
  name: string;
  rootPath: string;
  defaultBranch: string;
  forge: string | null;
  delivery: string | null;
  /** Whether the captain may merge green work on its own. */
  yolo: boolean;
  autoMerge: string | null;
  ci: string | null;
  verify: string[];
  runner: {
    host: string;
    mode: 'shared' | 'remote';
    repoPath: string | null;
  } | null;
}

export interface CaptainBrief {
  generatedAt: string;
  memory: Memory[];
  lease: {
    owner: string;
    active: boolean;
    expiresAt: string;
  } | null;
  projects: CaptainProjectBrief[];
  counts: Record<string, number>;
  totalTasks: number;
  activeRuns: Array<{
    id: string;
    taskId: string;
    role: string;
    pid: number | null;
    startedAt: string;
  }>;
  attention: Array<{
    taskId: string;
    title: string;
    state: TaskState;
    reason: string;
  }>;
  tasks: ReturnType<typeof summarizeDetail>[];
}

const ATTENTION_STATES: TaskState[] = ['waiting_input', 'blocked', 'review', 'failed'];

const ATTENTION_REASONS: Record<string, string> = {
  waiting_input: 'the agent is waiting for an answer',
  blocked: 'the agent reported a blocker',
  review: 'ready for review and acceptance',
  failed: 'the task failed and may need a retry',
};

function projectBrief(project: Project): CaptainProjectBrief {
  const config = readProjectConfig(project.rootPath);
  const runner = parseRunnerConfig(config?.runner);
  const deliveryPolicy = resolveDeliveryPolicy({
    taskMode: 'pr',
    projectConfig: config,
  });
  return {
    id: project.id,
    name: project.name,
    rootPath: project.rootPath,
    defaultBranch: project.defaultBranch,
    forge: project.forge,
    delivery: deliveryPolicy.path,
    yolo: deliveryPolicy.yolo,
    autoMerge: config?.auto_merge?.method ?? null,
    ci: config?.ci?.provider ?? null,
    verify: config?.verify ?? [],
    runner: runner
      ? {
          host: runner.host,
          mode: runner.repoPath ? 'remote' : 'shared',
          repoPath: runner.repoPath ?? null,
        }
      : null,
  };
}

export function buildCaptainBrief(
  store: Store,
  options: { limit?: number; projectId?: string } = {},
): CaptainBrief {
  const limit = Math.max(1, Math.min(options.limit ?? 20, 100));
  const allTasks = store.listTasks();
  const tasks = options.projectId
    ? allTasks.filter((task) => task.projectId === options.projectId)
    : allTasks;

  const counts: Record<string, number> = {};
  for (const task of tasks) {
    counts[task.state] = (counts[task.state] ?? 0) + 1;
  }

  const lease = store.getLease('daemon');
  const attention = tasks
    .filter((task) => ATTENTION_STATES.includes(task.state))
    .map((task) => ({
      taskId: task.id,
      title: task.title,
      state: task.state,
      reason: ATTENTION_REASONS[task.state] ?? task.state,
    }));

  const projects = store.listProjects();
  const memory = (
    options.projectId
      ? projects.filter((project) => project.id === options.projectId)
      : projects
  ).flatMap((project) => store.listMemories(project.id));

  return {
    generatedAt: new Date().toISOString(),
    memory,
    lease: lease
      ? {
          owner: lease.owner,
          active: Date.parse(lease.expiresAt) > Date.now(),
          expiresAt: lease.expiresAt,
        }
      : null,
    projects: store.listProjects().map(projectBrief),
    counts,
    totalTasks: tasks.length,
    activeRuns: store.listActiveRuns().map((run) => ({
      id: run.id,
      taskId: run.taskId,
      role: run.role,
      pid: run.pid,
      startedAt: run.startedAt,
    })),
    attention,
    tasks: tasks.slice(0, limit).map((task) => summarizeDetail(store.getTaskDetail(task.id))),
  };
}
