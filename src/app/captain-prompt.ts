import type { Memory, Project } from '../core/types';
import type { CaptainBrief } from './captain';
import { resolveRoleAgents } from './role-agents';
import type { DiscoveredSkill } from './skills';

/**
 * The prompt of the captain: the main agent that talks to the person.
 *
 * It is composed of four parts, in this order: the contract of the captain
 * (the same text `crew captain init` writes in `AGENTS.md`), the context of
 * the project right now, the request of the person, and how to turn that
 * request into a task.
 */

export interface CaptainTurn {
  role: 'person' | 'captain';
  text: string;
}

export interface CaptainPromptInput {
  project: Project;
  brief: CaptainBrief;
  request: string;
  memory: Memory[];
  skills: DiscoveredSkill[];
  crewCommand: string;
  history?: CaptainTurn[];
}

function renderContext(input: CaptainPromptInput): string {
  const { brief, project } = input;
  const current = brief.projects.find((entry) => entry.id === project.id);
  const lines: string[] = [];

  lines.push(`- Proyecto: ${project.name} (${project.rootPath})`);
  if (current) {
    lines.push(`- Rama base: ${current.defaultBranch}`);
    lines.push(`- Forja: ${current.forge ?? 'ninguna'}`);
    lines.push(`- Entrega: ${current.delivery ?? 'la del proyecto'}`);
    lines.push(`- Postura yolo: ${current.yolo ? 'sí' : 'no'}`);
    if (current.verify.length > 0) {
      lines.push(`- Verificación: ${current.verify.join(' | ')}`);
    }
    if (current.runner) {
      lines.push(
        `- Runner: ${current.runner.mode}${current.runner.host ? ` (${current.runner.host})` : ''}`,
      );
    }
  }
  lines.push(
    `- Tareas: ${brief.totalTasks} (${Object.entries(brief.counts)
      .map(([state, count]) => `${state} ${count}`)
      .join(', ')})`,
  );
  lines.push(`- Daemon: ${brief.lease ? (brief.lease.active ? 'activo' : 'expirado') : 'sin daemon'}`);
  if (brief.activeRuns.length > 0) {
    lines.push(
      `- Runs activos: ${brief.activeRuns
        .map((run) => `${run.id} (${run.role})`)
        .join(', ')}`,
    );
  }
  return lines.join('\n');
}

function renderAttention(brief: CaptainBrief): string {
  if (brief.attention.length === 0) {
    return '- Nada necesita atención.';
  }
  return brief.attention
    .map((item) => `- ${item.taskId} [${item.state}] ${item.title} — ${item.reason}`)
    .join('\n');
}

function renderMemory(memory: Memory[]): string {
  if (memory.length === 0) {
    return '- Sin notas en la memoria del proyecto.';
  }
  return memory.map((note) => `- [${note.kind}] ${note.title}: ${note.body}`).join('\n');
}

function renderSkills(skills: DiscoveredSkill[]): string {
  if (skills.length === 0) {
    return '- Sin skills disponibles.';
  }
  return skills
    .map((skill) => `- \`${skill.name}\`: ${skill.description}`)
    .join('\n');
}

function renderHistory(history: CaptainTurn[] | undefined): string {
  if (!history || history.length === 0) {
    return '';
  }
  const rendered = history
    .map((turn) =>
      turn.role === 'person'
        ? `**Persona**: ${turn.text}`
        : `**Capitán**: ${turn.text}`,
    )
    .join('\n\n');
  return `\n## Conversación hasta ahora\n\n${rendered}\n`;
}

/**
 * Composes the prompt of the captain for one request.
 *
 * The request of the person goes in verbatim: it is the only channel through
 * which work enters the system, and the worker will read the same words.
 */
export function composeCaptainPrompt(input: CaptainPromptInput): string {
  const contract = resolveRoleAgents('captain', {
    projectRoot: input.project.rootPath,
  }).content;

  return `${contract}
---

## Contexto de ahora

${renderContext(input)}

### Necesita atención

${renderAttention(input.brief)}

### Memoria del proyecto

${renderMemory(input.memory)}

### Skills disponibles

${renderSkills(input.skills)}
${renderHistory(input.history)}
## Petición de la persona

La persona ha pedido lo siguiente. Son sus palabras literales: no las
reinterpretes ni las resumas, y pásalas tal cual al crear la tarea.

> ${input.request.replace(/\n/g, '\n> ')}

## Cómo convertir la petición en trabajo

Usa la CLI determinista de \`crew\` (${input.crewCommand}). No edites ficheros
del proyecto: los workers escriben en worktrees aislados.

\`\`\`sh
${input.crewCommand} --json task create --project ${input.project.name} \\
  --title "<título corto>" \\
  --brief "<tu brief: qué hay que hacer y con qué criterio se da por hecho>" \\
  --methodology spec \\
  --acceptance "<criterio de aceptación>" \\
  --acceptance "<otro criterio>"
${input.crewCommand} --json task queue <id>            # encola la tarea para el daemon
${input.crewCommand} --json status                     # estado global
${input.crewCommand} --json captain brief              # contexto actualizado
\`\`\`

Si la petición es ambigua, dile a la persona qué necesitas antes de crear
nada. Si pide varios cambios, escribe un plan (\`crew plan apply\`) en vez de
una tarea sola. Cuando termines, explica qué creaste y qué falta.
`;
}
