import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { runProcess } from '../adapters/backend/process';
import { assertHarnessAvailable } from '../adapters/harness/detect';
import { getHarness, resolveHarnessId } from '../adapters/harness/registry';
import { CrewError } from '../core/errors';
import { newId } from '../core/ids';
import { redactText } from '../core/redact';
import type { Project } from '../core/types';
import type { ResolvedContext } from '../config/config';
import { buildCaptainBrief, type CaptainBrief } from './captain';
import { composeCaptainPrompt, type CaptainTurn } from './captain-prompt';
import { discoverSkills } from './skills';
import type { Store } from '../store/store';

/**
 * A turn of the conversation with the captain.
 *
 * The captain is the main agent: the person talks to it, and it turns that
 * into tasks. There is no worktree and no report here; the contract of the
 * captain says it drives the CLI and nothing else.
 */

export interface CaptainTurnInput {
  store: Store;
  context: ResolvedContext;
  project: Project;
  request: string;
  harnessId?: string;
  timeoutSeconds?: number;
  sessionId?: string | null;
  history?: CaptainTurn[];
  quiet?: boolean;
}

export interface CaptainTurnResult {
  /** The last thing the captain said: its answer. */
  text: string;
  /** Everything the captain said during the turn. */
  transcript: string;
  sessionId: string | null;
  exitCode: number | null;
  timedOut: boolean;
  prompt: string;
  promptPath: string;
  logPath: string;
}

/**
 * Extracts the answer and the session id from the output of the agent.
 *
 * Harnesses that speak JSON lines (opencode with `--format json`) give both
 * directly; anything else is taken as the answer itself.
 */
export function parseCaptainOutput(output: string): {
  text: string;
  transcript: string;
  sessionId: string | null;
} {
  const texts: string[] = [];
  let sessionId: string | null = null;
  let sawJson = false;

  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) {
      continue;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    sawJson = true;
    if (!sessionId && typeof parsed.sessionID === 'string') {
      sessionId = parsed.sessionID;
    }
    if (parsed.type === 'text') {
      const part = parsed.part as Record<string, unknown> | undefined;
      if (part && typeof part.text === 'string' && part.text.trim()) {
        texts.push(part.text.trim());
      }
    }
  }

  if (sawJson) {
    // The agent speaks in several messages; the last one is its answer.
    return {
      text: texts.at(-1) ?? '',
      transcript: texts.join('\n\n'),
      sessionId,
    };
  }
  return { text: output.trim(), transcript: output.trim(), sessionId };
}

function captainDirectory(context: ResolvedContext, sessionKey: string): string {
  return path.join(context.paths.dataDir, 'captain', sessionKey);
}

export async function runCaptainTurn(
  input: CaptainTurnInput,
): Promise<CaptainTurnResult> {
  const harnessId = resolveHarnessId(
    input.harnessId ??
      input.context.config.agents.captain.harness ??
      input.context.config.harness,
  );
  const harness = getHarness(harnessId);
  if (!harness.buildChatLaunch) {
    throw new CrewError(
      'HARNESS_NO_CHAT',
      `The harness ${harnessId} cannot hold a conversation with the captain`,
    );
  }
  const availability = assertHarnessAvailable(harness);

  const brief: CaptainBrief = buildCaptainBrief(input.store, {
    limit: 20,
    projectId: input.project.id,
  });

  const crewCommand = process.env.CREW_BIN ?? 'crew';
  const prompt = composeCaptainPrompt({
    project: input.project,
    brief,
    request: input.request,
    memory: input.store.listMemories(input.project.id),
    skills: discoverSkills({ projectRoot: input.project.rootPath }),
    crewCommand,
    workerHarness:
      input.context.config.agents.developer.harness ?? input.context.config.harness,
    history: input.history,
  });

  const sessionKey = input.sessionId ?? `turn-${newId('cap').slice(-8)}`;
  const dir = captainDirectory(input.context, sessionKey);
  mkdirSync(dir, { recursive: true });
  const promptPath = path.join(dir, 'prompt.md');
  const logPath = path.join(dir, 'run.jsonl');
  writeFileSync(promptPath, prompt, 'utf8');

  const launch = harness.buildChatLaunch({
    prompt,
    cwd: input.project.rootPath,
    sessionId: input.sessionId ?? null,
    agent: input.context.config.agents.captain.agent,
    model: input.context.config.agents.captain.model,
    env: {
      CREW_ROLE: 'captain',
      CREW_PROJECT_ID: input.project.id,
      CREW_BIN: crewCommand,
      CREW_CAPTAIN_REQUEST: input.request,
    },
  });

  const timeoutSeconds =
    input.timeoutSeconds && input.timeoutSeconds > 0
      ? input.timeoutSeconds
      : input.context.config.timeoutSeconds;

  input.store.recordEvent({
    aggregateType: 'captain',
    aggregateId: sessionKey,
    type: 'captain.requested',
    actor: 'person',
    payload: {
      project: input.project.name,
      request: redactText(input.request, process.env),
      session_id: input.sessionId ?? null,
    },
  });

  const result = await runProcess({
    command: availability.binary ?? launch.command,
    args: launch.args,
    cwd: input.project.rootPath,
    env: launch.env,
    logPath,
    timeoutMs: timeoutSeconds * 1000,
    stdin: prompt,
    quiet: input.quiet ?? true,
  });

  const parsed = parseCaptainOutput(result.outputTail);

  input.store.recordEvent({
    aggregateType: 'captain',
    aggregateId: sessionKey,
    type: 'captain.answered',
    actor: 'captain',
    payload: {
      project: input.project.name,
      exit_code: result.exitCode,
      timed_out: result.timedOut,
      session_id: parsed.sessionId,
      answer: redactText(parsed.text, process.env),
    },
  });

  return {
    text: parsed.text,
    transcript: parsed.transcript,
    sessionId: parsed.sessionId ?? input.sessionId ?? null,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    prompt,
    promptPath,
    logPath,
  };
}
