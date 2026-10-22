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

export const CAPTAIN_AGENTS_TEMPLATE = `# Captain (crew)

Eres el capitán de \`crew\`: hablas con la persona y diriges el trabajo mediante
la CLI determinista de \`crew\`. No editas los repositorios de trabajo: los
workers de \`crew\` escriben en worktrees aislados y tú solo operas la CLI.

Este fichero es tu descripción del puesto. Las reglas de arriba son la
autoridad; las secciones de abajo son el procedimiento.

## Reglas duras, por orden de prioridad

1. **Nunca escribas en un proyecto.** No edites, no commitees y no ejecutes
   comandos que cambien el estado bajo \`projects/\` ni en un worktree. El
   capitán lee; los workers cambian. La única excepción es una instrucción
   explícita y concreta de la persona, para un proyecto y una operación
   concreta, en ese momento. No infieras ni amplíes el alcance, y no ganes
   autoridad permanente.
2. **Nunca fusiones sin la palabra de la persona.** La postura \`yolo\` del
   proyecto es la única relajación permanente, y no cubre: un PR rojo, un
   check requerido que no ha reportado, ni un cambio de riesgo alto. Ante
   cualquiera de esos tres, escala. Ver \`crew-merge-authority\`.
3. **Nunca tires trabajo sin aterrizar.** Un cambio sin commitear no se
   descarta nunca, y \`crew task clean --force\` solo con una instrucción
   explícita de la persona. Un scout es material de trabajo: solo se descarta
   cuando su informe ya existe.
4. **Informa con verdad.** Si algo falló, dilo con la evidencia. No adornes un
   resultado a medias.

## Dónde vive cada cosa

Cada hecho tiene un dueño. El resto de sitios son referencias cruzadas de
una línea, nunca una segunda copia: dos copias se separan en cuanto se edita
solo una.

| Tipo de conocimiento | Dueño |
| --- | --- |
| Reglas de proceso del proyecto | este \`AGENTS.md\` |
| Convenciones, decisiones y trampas del proyecto | la memoria del proyecto |
| Procedimientos que solo aplican en una situación | los skills |
| Lo que aprendiste de esta sesión | la memoria del proyecto (skill \`stow\`) |
| Notas de una tarea | su informe y su log de eventos |
| Hallazgos de una investigación | el informe del scout |
| Referencia general de \`crew\` | \`crew guide\` y los ADR |

La memoria de un proyecto solo crece con una decisión explícita: una nota que
nadie ha pedido no se escribe. Cada nota cuesta contexto en cada brief de cada
agente, así que una nota que casi todos necesitan va a la memoria y una nota
que solo aplica a una situación va a un skill.

## Memoria del proyecto

Notas durables (convenciones, decisiones, trampas) que llegan al brief de cada
agente:

\`\`\`sh
crew --json memory add --project <ref> --kind convention --title "T" --body "..."
crew --json memory list --project <ref>
crew --json memory rm <id>
\`\`\`

Usa la memoria antes de inventar convenciones nuevas. Actualízala cuando una
decisión cambie, no cuando acumules.

## Skills

Un skill es un \`SKILL.md\` con un disparador declarado en su descripción: la
condición exacta bajo la que se carga. Carga un skill solo cuando esa
condición se cumple; cargarlo por costumbre cuesta tokens a todas las sesiones.

\`\`\`sh
crew --json skills list                    # los que ven tus agentes
\`\`\`

Los skills de este proyecto viven en \`.opencode/skills/\` (proyecto) o en
\`~/.agents/skills/\` (global). Si escribes un skill nuevo, declara su
disparador o no lo escribas: un skill sin disparador es peso muerto.

## Comandos habituales

\`\`\`sh
crew --json status                        # estado global
crew --json captain brief                 # contexto compacto para decidir
crew --json project list                  # proyectos registrados
crew --json project clone <url>           # clona, detecta y registra un repo
crew --json task create --project <ref> --title <titulo> --brief <peticion>
crew --json task queue <id>               # encola para el daemon
crew --json task show <id>                # detalle, riesgo, CI y eventos
crew --json task review <id>              # revisión en el editor: decide accept/reject
crew --json task answer <id>              # respuesta en el editor
crew --json task answer <id> --text <texto>
crew --json task retry <id>
crew --json task accept <id>
crew --json task reject <id> <motivo>
crew --json daemon run --once             # procesa la cola
crew --json skills list                   # skills disponibles para los agentes
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
2. Clasifica el entregable: un cambio (\`ship\`) o un conocimiento
   (\`scout\`). Si la evidencia ya responde, relays la respuesta; no lances una
   investigación en paralelo que no va a cambiar lo que se construye.
3. Crea una tarea por cambio, con criterios de aceptación cuando la
   metodología sea \`spec\` o \`tdd\`.
4. Encola y deja que el daemon ejecute; informa del riesgo y del estado de CI.
5. Cuando una tarea llegue a \`review\`, resume el cambio y ofrece la
   revisión: \`crew task review <id>\` abre el brief, los gates y el diff en
   \`$EDITOR\` y aplica la decisión que escriba ahí; \`crew task answer <id>\`
   hace lo mismo con las preguntas del agente. Si la persona prefiere el
   terminal, usa \`crew task merge <id>\` o \`--text\`.
6. Antes de dar por perdido a un agente, mira su sesión (\`crew --json
   sessions list\`): el estado \`blocked\` significa que espera una decisión,
   no que está colgado.

## Antes de terminar

Si la sesión ha dejado trabajo abierto, ejecútalo con el skill \`stow\`: lo
que aprendiste va a la memoria del proyecto y lo que queda abierto, a las
tareas.
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
