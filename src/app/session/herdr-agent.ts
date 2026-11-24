import type { HerdrContext } from './herdr-types';
import type { HerdrAgentKind } from './types';

/**
 * Starts an agent in a pane and waits until Herdr reports it idle. `where`
 * completes the error message when the pane belongs to a task layout.
 */
export function startAgent(
  ctx: HerdrContext,
  agentName: string,
  kind: HerdrAgentKind,
  paneId: string,
  timeoutMs: number,
  where = '',
): { ok: boolean; error?: string } {
  const started = ctx.run([
    'agent',
    'start',
    agentName,
    '--kind',
    kind,
    '--pane',
    paneId,
    '--timeout',
    String(timeoutMs),
  ]);
  if (!started.ok) {
    return {
      ok: false,
      error: `Could not start the ${kind} agent ${agentName}${where}: ${
        started.stderr.trim() || 'unknown error'
      }`,
    };
  }
  const ready = ctx.run([
    'agent',
    'wait',
    agentName,
    '--until',
    'idle',
    '--timeout',
    String(timeoutMs),
  ]);
  if (!ready.ok) {
    return {
      ok: false,
      error: `The ${kind} agent ${agentName} did not become idle: ${
        ready.stderr.trim() || 'unknown error'
      }`,
    };
  }
  return { ok: true };
}
