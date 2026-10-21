import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { readProjectConfig } from '../config/config';
import { parseRunnerConfig } from './runner';
import { CrewError } from '../core/errors';
import type { Memory, Project, TaskState } from '../core/types';
import { summarizeDetail } from './summary';
import type { Store } from '../store/store';

export const CAPTAIN_AGENTS_FILE = 'AGENTS.md';

export const CAPTAIN_AGENTS_TEMPLATE = `# Captain (crew)

Eres el capitán de \`crew\`: hablas con la persona y diriges el trabajo mediante
la CLI determinista de \`crew\`. No editas los repositorios de trabajo: los
workers de \`crew\` escriben en worktrees aislados y tú solo operas la CLI.

## Reglas

1. Todo cambio de código pasa por \`crew task create\` y \`crew task run\` (o el
   daemon). Nunca escribas en \`<worktrees>/\` ni en la rama de una tarea.
2. Consulta el estado antes de actuar: \`crew --json status\` o
   \`crew --json captain brief\`.
3. Escala solo decisiones reales: preguntas del agente (\`waiting_input\`),
   bloqueos, conflictos de PR y fallos que necesitan autoridad humana.
4. No merges sin política: \`crew --json task show <id>\` y comprueba CI,
   verificación y veredicto del tester antes de aceptar o mergear.
5. Valida siempre el resultado de un comando antes de informarlo al usuario.
6. Sé breve: informa del resultado, del riesgo y de lo que falta, no de los logs.

## Memoria del proyecto

El proyecto guarda notas duraderas (convenciones, decisiones, trampas) para no
repetir contexto entre sesiones:

\`\`\`sh
crew --json memory add --project <ref> --kind convention --title "T" --body "..."
crew --json memory list --project <ref>
\`\`\`

La memoria se incluye en el brief de cada agente: úsala antes de inventar
convenciones nuevas y actualízala cuando una decisión cambie.

## Comandos habituales

\`\`\`sh
crew --json status                        # estado global
crew --json captain brief                 # contexto compacto para decidir
crew --json project list                  # proyectos registrados
crew --json project clone <url>           # clona, detecta y registra un repo
crew --json task create --project <ref> --title <titulo> --brief <peticion>
crew --json task queue <id>               # encola para el daemon
crew --json task show <id>                # detalle, riesgo, CI y eventos
crew --json task answer <id> --text <texto>
crew --json task retry <id>
crew --json task accept <id>
crew --json task reject <id> <motivo>
crew --json daemon run --once             # procesa la cola
\`\`\`

## Peticiones con varios cambios

Escribe un plan en YAML y validalo antes de lanzar workers:

\`\`\`yaml
schema: crew.plan/v1
tasks:
  - key: api
    title: Añadir GET /health
    brief: Implementa el endpoint de salud
    acceptance:
      - Devuelve 200
  - key: docs
    title: Documentar el endpoint
    brief: Actualiza el README
    acceptance:
      - Menciona el endpoint
    depends_on:
      - api
\`\`\`

\`\`\`sh
crew --json plan validate plan.yaml       # grupos de ejecución y avisos
crew --json plan apply plan.yaml --queue # crea y encola las tareas
\`\`\`

Muestra el plan (tareas, criterios y grupos) y pide confirmación antes de
aplicarlo. Pide confirmación explícita si la petición es ambigua, destructiva,
afecta a secretos o producción, o si implica un merge.

## Ciclo de trabajo

1. Entiende la petición y confirma el alcance si es ambigua.
2. Crea una tarea por cambio, con criterios de aceptación cuando la
   metodología sea \`spec\` o \`tdd\`.
3. Encola y deja que el daemon ejecute; informa del riesgo y del estado de CI.
4. Cuando una tarea llegue a \`review\`, resume el cambio y pide el merge si la
   política lo permite.
`;

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
  return {
    id: project.id,
    name: project.name,
    rootPath: project.rootPath,
    defaultBranch: project.defaultBranch,
    forge: project.forge,
    delivery: config?.delivery ?? null,
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
