import type { Project, TaskState } from '../core/types';
import type { ResolvedContext } from '../config/config';
import type { Store } from '../store/store';
import { runCaptainTurn, type CaptainTurnResult } from './captain-run';
import type { CaptainTurn } from './captain-prompt';
import { runDaemon } from './daemon';
import { summarizeDetail } from './summary';

/**
 * Follows the work the captain created in a turn.
 *
 * The engine, not the person, writes the follow-up: it drains the queue and
 * tells the captain what happened, so the captain can answer the questions the
 * workers left and report the result. The captain still decides nothing on
 * its own: it only talks to the person and answers the agent.
 */

export interface FollowedTask {
  taskId: string;
  title: string;
  state: TaskState;
  risk: string | null;
  question: string | null;
}

export interface FollowResult {
  tasks: FollowedTask[];
  turns: CaptainTurnResult[];
  /** Why the engine could not run the work, if it could not. */
  skipped: 'lease' | null;
}

export interface FollowInput {
  store: Store;
  context: ResolvedContext;
  project: Project;
  /** The ids that already existed before the turn of the captain. */
  before: Set<string>;
  rounds?: number;
  harnessId?: string;
  timeoutSeconds?: number;
  maxTasks?: number;
  history?: CaptainTurn[];
  sessionId?: string | null;
}

const RUNNABLE: TaskState[] = ['draft', 'queued'];

function clampRounds(rounds: number | undefined): number {
  return Math.max(1, Math.min(rounds ?? 2, 5));
}

function readTasks(store: Store, before: Set<string>): FollowedTask[] {
  return store
    .listTasks()
    .filter((task) => !before.has(task.id))
    .map((task) => {
      const detail = store.getTaskDetail(task.id);
      const summary = summarizeDetail(detail);
      const question =
        task.state === 'waiting_input' || task.state === 'blocked'
          ? (detail.messages
              .filter(
                (message) =>
                  message.direction === 'out' &&
                  message.kind === 'question' &&
                  message.consumedAt === null,
              )
              .at(-1)?.body ?? null)
          : null;
      return {
        taskId: task.id,
        title: task.title,
        state: task.state,
        risk: summary.risk?.level ?? null,
        question,
      };
    });
}

function describe(task: FollowedTask): string {
  const risk = task.risk ? `, riesgo ${task.risk}` : '';
  const head = `- ${task.taskId} [${task.state}] "${task.title}"${risk}.`;
  if (task.state === 'review') {
    return `${head} Lista para que la persona la firme; no la fusiones tú.`;
  }
  if (task.state === 'waiting_input' || task.state === 'blocked') {
    const question = task.question
      ? ` El agente pregunta: "${task.question}"`
      : ' El agente espera una respuesta.';
    return `${head}${question} Respóndela con \`task answer\` si es una decisión técnica; si es de producto, trasladasela a la persona.`;
  }
  if (task.state === 'failed' || task.state === 'cancelled') {
    return `${head} Explica el fallo y pregunta si se reintenta.`;
  }
  if (task.state === 'done') {
    return `${head} Ya está terminada.`;
  }
  return `${head} Sigue en marcha.`;
}

function continuation(tasks: FollowedTask[]): string {
  return [
    'El motor ha procesado el trabajo que creaste en este turno. Estado ahora:',
    '',
    ...tasks.map(describe),
    '',
    'Explícale a la persona qué ha pasado. No fusiones nada: la firma es suya.',
  ].join('\n');
}

export async function followCaptainWork(input: FollowInput): Promise<FollowResult> {
  const rounds = clampRounds(input.rounds);
  const turns: CaptainTurnResult[] = [];
  const history: CaptainTurn[] = [...(input.history ?? [])];
  let sessionId = input.sessionId ?? null;

  for (let round = 0; round < rounds; round += 1) {
    const touched = readTasks(input.store, input.before);
    if (touched.length === 0) {
      break;
    }

    const runnable = touched.some((task) => RUNNABLE.includes(task.state));
    const waiting = touched.some(
      (task) => task.state === 'waiting_input' || task.state === 'blocked',
    );
    // If the turn already left everything settled and nothing asks a question,
    // the captain already knows the outcome: a follow-up would only repeat it.
    if (!runnable && !waiting) {
      break;
    }

    const lease = input.store.getLease('daemon');
    if (lease && Date.parse(lease.expiresAt) > Date.now()) {
      return { tasks: touched, turns, skipped: 'lease' };
    }

    if (runnable) {
      await runDaemon(input.store, input.context, {
        once: true,
        quiet: true,
        maxTasks: input.maxTasks ?? 10,
        harnessId: input.harnessId,
        timeoutSeconds: input.timeoutSeconds,
      });
    }

    const after = readTasks(input.store, input.before);
    const followUp = await runCaptainTurn({
      store: input.store,
      context: input.context,
      project: input.project,
      continuation: continuation(after),
      harnessId: input.harnessId,
      timeoutSeconds: input.timeoutSeconds,
      sessionId,
      history,
    });
    turns.push(followUp);
    sessionId = followUp.sessionId;

    history.push({ role: 'engine', text: continuation(after) });
    history.push({ role: 'captain', text: followUp.text });

    const requeued = readTasks(input.store, input.before).some((task) =>
      RUNNABLE.includes(task.state),
    );
    if (!requeued) {
      break;
    }
  }

  return { tasks: readTasks(input.store, input.before), turns, skipped: null };
}
