import { parse } from 'yaml';
import { CrewError } from '../core/errors';
import type { DeliveryMode, Methodology, Task } from '../core/types';
import type { Store } from '../store/store';

export const PLAN_SCHEMA = 'crew.plan/v1';

export interface PlanTaskSpec {
  key: string;
  title: string;
  brief: string;
  methodology: Methodology;
  acceptance: string[];
  nonGoals: string[];
  dependsOn: string[];
  delivery: DeliveryMode | null;
}

export interface PlanFile {
  schema: string;
  tasks: PlanTaskSpec[];
}

export interface PlanValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
  groups: string[][];
  tasks: PlanTaskSpec[];
}

const METHODOLOGIES: Methodology[] = ['free', 'spec', 'tdd'];
const DELIVERY_MODES: DeliveryMode[] = ['local', 'pr', 'auto_merge', 'scout'];

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string');
}

export function parsePlan(text: string): PlanFile {
  let parsed: unknown;
  try {
    parsed = parse(text);
  } catch (error) {
    throw new CrewError(
      'PLAN_INVALID',
      `Cannot parse the plan: ${error instanceof Error ? error.message : 'invalid yaml'}`,
    );
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new CrewError('PLAN_INVALID', 'The plan must be a mapping');
  }
  const raw = parsed as Record<string, unknown>;
  const schema = typeof raw.schema === 'string' ? raw.schema : '';
  const rawTasks = Array.isArray(raw.tasks) ? raw.tasks : [];
  const tasks: PlanTaskSpec[] = rawTasks.map((entry, index) => {
    const item = (entry ?? {}) as Record<string, unknown>;
    const acceptance = asStringArray(item.acceptance);
    const methodology = (item.methodology ??
      (acceptance.length > 0 ? 'spec' : 'free')) as Methodology;
    return {
      key: typeof item.key === 'string' && item.key.trim() !== '' ? item.key.trim() : `task-${index + 1}`,
      title: typeof item.title === 'string' ? item.title.trim() : '',
      brief: typeof item.brief === 'string' ? item.brief.trim() : '',
      methodology,
      acceptance,
      nonGoals: asStringArray(item.non_goals ?? item.nonGoals),
      dependsOn: asStringArray(item.depends_on ?? item.dependsOn),
      delivery: typeof item.delivery === 'string' ? (item.delivery as DeliveryMode) : null,
    };
  });
  return { schema, tasks };
}

export function validatePlan(plan: PlanFile): PlanValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (plan.schema !== PLAN_SCHEMA) {
    errors.push(`schema must be "${PLAN_SCHEMA}", found "${plan.schema || 'none'}"`);
  }
  if (plan.tasks.length === 0) {
    errors.push('the plan has no tasks');
  }

  const keys = new Set<string>();
  for (const task of plan.tasks) {
    if (keys.has(task.key)) {
      errors.push(`duplicate task key: ${task.key}`);
    }
    keys.add(task.key);
  }

  for (const task of plan.tasks) {
    if (!task.title) {
      errors.push(`${task.key}: missing title`);
    }
    if (!task.brief) {
      errors.push(`${task.key}: missing brief`);
    }
    if (!METHODOLOGIES.includes(task.methodology)) {
      errors.push(`${task.key}: unknown methodology "${task.methodology}"`);
    }
    if (
      (task.methodology === 'spec' || task.methodology === 'tdd') &&
      task.acceptance.length === 0
    ) {
      errors.push(`${task.key}: methodology "${task.methodology}" requires acceptance criteria`);
    }
    if (task.delivery !== null && !DELIVERY_MODES.includes(task.delivery)) {
      errors.push(`${task.key}: unknown delivery mode "${task.delivery}"`);
    }
    for (const dependency of task.dependsOn) {
      if (dependency === task.key) {
        errors.push(`${task.key}: cannot depend on itself`);
      } else if (!keys.has(dependency)) {
        errors.push(`${task.key}: unknown dependency "${dependency}"`);
      }
    }
  }

  const groups = computeGroups(plan.tasks);
  if (groups.length === 0 && errors.length === 0) {
    errors.push('the plan has a dependency cycle');
  }

  for (const group of groups) {
    if (group.length > 2) {
      warnings.push(
        `${group.length} tasks would start in parallel (${group.join(', ')}): confirm the cost before launching workers`,
      );
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    groups,
    tasks: plan.tasks,
  };
}

export function computeGroups(tasks: PlanTaskSpec[]): string[][] {
  const byKey = new Map(tasks.map((task) => [task.key, task]));
  const resolved = new Set<string>();
  const groups: string[][] = [];

  let pending = tasks.map((task) => task.key);
  while (pending.length > 0) {
    const ready = pending.filter((key) =>
      (byKey.get(key)?.dependsOn ?? []).every((dependency) => resolved.has(dependency)),
    );
    if (ready.length === 0) {
      return [];
    }
    groups.push(ready);
    for (const key of ready) {
      resolved.add(key);
    }
    pending = pending.filter((key) => !resolved.has(key));
  }
  return groups;
}

export interface AppliedPlan {
  tasks: Array<{
    key: string;
    id: string;
    title: string;
    state: Task['state'];
    dependsOn: string[];
  }>;
  groups: string[][];
  queued: boolean;
}

export function applyPlan(
  store: Store,
  plan: PlanFile,
  options: { projectId: string; queue?: boolean; delivery?: DeliveryMode },
): AppliedPlan {
  const validation = validatePlan(plan);
  if (!validation.ok) {
    throw new CrewError('PLAN_INVALID', validation.errors.join('; '));
  }

  const created = new Map<string, Task>();
  for (const spec of plan.tasks) {
    const task = store.createTask({
      projectId: options.projectId,
      title: spec.title,
      briefText: spec.brief,
      origin: 'plan',
      methodology: spec.methodology,
      spec:
        spec.methodology === 'free'
          ? null
          : {
              schema: 'crew.spec/v1',
              goal: spec.brief,
              acceptance_criteria: spec.acceptance.map((text, index) => ({
                id: `AC${index + 1}`,
                text,
              })),
              non_goals: spec.nonGoals,
            },
      deliveryMode: spec.delivery ?? options.delivery ?? 'local',
    });
    created.set(spec.key, task);
  }

  for (const spec of plan.tasks) {
    const task = created.get(spec.key);
    if (!task) {
      continue;
    }
    for (const dependency of spec.dependsOn) {
      const dependsOn = created.get(dependency);
      if (dependsOn) {
        store.addDependency(task.id, dependsOn.id);
      }
    }
  }

  if (options.queue) {
    for (const task of created.values()) {
      store.queueTask(task.id);
    }
  }

  return {
    tasks: plan.tasks.map((spec) => {
      const task = created.get(spec.key) as Task;
      const current = options.queue ? store.getTaskOrThrow(task.id) : task;
      return {
        key: spec.key,
        id: task.id,
        title: task.title,
        state: current.state,
        dependsOn: spec.dependsOn,
      };
    }),
    groups: validation.groups,
    queued: Boolean(options.queue),
  };
}
