/**
 * Interactive agent mode for the Herdr backend.
 *
 * The engine normally runs an agent as a batch process. In interactive mode
 * the agent is a long-lived agent of the run harness in its own Herdr tab:
 * the run finishes only when the report exists, parses and the agent is
 * settled.
 *
 * Everything here is pure so it can be tested without Herdr.
 */

import { CrewError } from '../../core/errors';
import type {
  HerdrAgentKind,
  InteractiveStartOptions,
  SessionMode,
} from './types';

export type { HerdrAgentKind } from './types';

export const CREW_SESSION_WORKSPACE = 'crew-sessions';
export const MAX_AGENT_NAME_LENGTH = 32;
export const AGENT_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

const SHORT_ROLES: Record<string, string> = {
  developer: 'dev',
  tester: 'test',
  captain: 'capt',
  scout: 'scout',
};

const HERDR_KINDS: Record<string, HerdrAgentKind> = {
  opencode: 'opencode',
  pi: 'pi',
};

export type InteractiveReportState = 'missing' | 'invalid' | 'valid';

export interface InteractiveDecision {
  done: boolean;
  exitCode: number | null;
  reason: 'blocked' | 'timeout' | null;
}

export interface InteractivePromptPaths {
  briefPath: string;
  reportPath: string;
  worktreePath: string;
}

export function isValidAgentName(name: string): boolean {
  return AGENT_NAME_PATTERN.test(name);
}

/**
 * A short, valid base name. The run id is a ULID: its random tail is unique
 * enough to distinguish parallel runs, and the role keeps the tab readable.
 */
export function interactiveAgentBaseName(runId: string, role: string): string {
  const compactRun = runId.replace(/^run_/, '').slice(-10).toLowerCase();
  const compactRole =
    (SHORT_ROLES[role] ?? role.slice(0, 4)).toLowerCase().replace(/[^a-z0-9]/g, '') ||
    'agent';
  return `crew-${compactRun}-${compactRole}`.slice(0, MAX_AGENT_NAME_LENGTH);
}

/**
 * Herdr requires names matching [a-z][a-z0-9_-]{0,31} and unique among live
 * agents. A collision appends a numeric suffix, truncating the base if needed.
 */
export function uniqueAgentName(base: string, taken: Set<string>): string {
  const sanitized =
    base
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '')
      .replace(/^[^a-z]+/, '') || 'crew-agent';
  const root = sanitized.slice(0, MAX_AGENT_NAME_LENGTH);
  if (!taken.has(root)) {
    return root;
  }
  for (let attempt = 2; ; attempt += 1) {
    const suffix = `-${attempt}`;
    const candidate = `${root.slice(0, MAX_AGENT_NAME_LENGTH - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
}

/**
 * The prompt is deliberately short: the brief is the source of truth and the
 * interactive agent reads it by absolute path. The environment variables of
 * the batch process are not inherited by the Herdr pane.
 */
export function buildInteractivePrompt(paths: InteractivePromptPaths): string {
  return [
    `Lee ${paths.briefPath} y ejecuta lo que pide.`,
    `Trabaja en ${paths.worktreePath}.`,
    `Escribe tu informe en ${paths.reportPath}.`,
  ].join(' ');
}

/**
 * The Herdr agent kind for a run harness, or null when the harness has no
 * Herdr counterpart (for example `fake`). The interactive tab must run the
 * agent of the harness that owns the run, never a hard-coded one.
 */
export function herdrKindForHarness(harnessId: string): HerdrAgentKind | null {
  return HERDR_KINDS[harnessId] ?? null;
}

export function assertHerdrKindForHarness(harnessId: string): HerdrAgentKind {
  const kind = herdrKindForHarness(harnessId);
  if (!kind) {
    throw new CrewError(
      'SESSION_INTERACTIVE_UNSUPPORTED_HARNESS',
      `Interactive session mode needs a harness with a Herdr agent kind (opencode or pi); harness "${harnessId}" has none`,
    );
  }
  return kind;
}

export interface InteractiveStartInput {
  harnessId: string;
  baseName: string;
  prompt: string;
  reportPath: string;
  workspaceLabel?: string;
}

export function interactiveStartOptions(
  input: InteractiveStartInput,
): InteractiveStartOptions {
  return {
    kind: assertHerdrKindForHarness(input.harnessId),
    baseName: input.baseName,
    prompt: input.prompt,
    reportPath: input.reportPath,
    workspaceLabel: input.workspaceLabel ?? CREW_SESSION_WORKSPACE,
  };
}

/**
 * Interactive mode needs a session backend; without an explicit `--session`
 * it uses Herdr, the only backend that supports it. Off by default.
 */
export function interactiveSessionMode(
  interactive: boolean,
  explicit: SessionMode | undefined,
): SessionMode | undefined {
  return explicit ?? (interactive ? 'herdr' : undefined);
}

/** Project config with the env override; interactive mode is off by default. */
export function resolveInteractiveMode(
  configValue: unknown,
  envValue: string | undefined,
): boolean {
  const env = envValue?.trim().toLowerCase();
  if (env === '1' || env === 'true') {
    return true;
  }
  if (env === '0' || env === 'false') {
    return false;
  }
  return configValue === true;
}

/**
 * A run is finished when the report parses and the agent is settled, when the
 * agent is blocked, or when the timeout expires. Anything else keeps polling.
 */
export function decideInteractiveRun(input: {
  report: InteractiveReportState;
  agentState: string | null;
  timedOut: boolean;
}): InteractiveDecision {
  if (input.timedOut) {
    return { done: true, exitCode: null, reason: 'timeout' };
  }
  if (input.agentState === 'blocked') {
    return { done: true, exitCode: 1, reason: 'blocked' };
  }
  if (
    input.report === 'valid' &&
    (input.agentState === 'idle' || input.agentState === 'done')
  ) {
    return { done: true, exitCode: 0, reason: null };
  }
  return { done: false, exitCode: null, reason: null };
}
