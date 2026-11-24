import { decideInteractiveRun } from './interactive';
import { captureSession } from './herdr-capture';
import { reportState } from './herdr-cli';
import { readState } from './herdr-state';
import type { HerdrContext, HerdrSessionState } from './herdr-types';
import { agentState } from './herdr-workspaces';
import { killSession, sessionStatus } from './herdr-session';
import type { SessionRunResult, WaitSessionOptions } from './types';

export async function waitSession(
  ctx: HerdrContext,
  name: string,
  options: WaitSessionOptions,
): Promise<SessionRunResult> {
  const state = readState(ctx.stateDir, name);
  if (state?.mode === 'interactive') {
    return waitInteractive(ctx, name, state, options);
  }
  const pollMs = Math.max(100, options.pollMs ?? 400);
  const deadline = Date.now() + Math.max(0, options.timeoutMs);
  return new Promise((resolve) => {
    let timedOut = false;
    const finish = (exitCode: number | null): void => {
      clearInterval(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve({
        exitCode,
        output: captureSession(ctx, name),
        timedOut,
      });
    };
    const onAbort = (): void => {
      timedOut = true;
      killSession(ctx, name);
      finish(null);
    };
    const timer = setInterval(() => {
      const status = sessionStatus(ctx, name);
      if (status.dead) {
        finish(status.exitCode);
        return;
      }
      if (Date.now() >= deadline) {
        timedOut = true;
        killSession(ctx, name);
        finish(null);
      }
    }, pollMs);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) {
      onAbort();
    }
  });
}

function waitInteractive(
  ctx: HerdrContext,
  name: string,
  state: HerdrSessionState,
  options: WaitSessionOptions,
): Promise<SessionRunResult> {
  const pollMs = Math.max(100, options.pollMs ?? 500);
  const deadline = Date.now() + Math.max(0, options.timeoutMs);
  const agentName = state.agentName ?? '';
  let prompted = false;
  let timedOut = false;
  let lastSignature = '';

  return new Promise((resolve) => {
    const finish = (exitCode: number | null): void => {
      clearInterval(timer);
      options.signal?.removeEventListener('abort', onAbort);
      const output = captureSession(ctx, name);
      killSession(ctx, name, { graceful: exitCode === 0 });
      resolve({ exitCode, output, timedOut });
    };
    const onAbort = (): void => {
      timedOut = true;
      options.onEvent?.('interactive run aborted');
      finish(null);
    };
    const timer = setInterval(() => {
      if (!prompted) {
        prompted = true;
        // `--wait` makes Herdr confirm the agent picked the prompt up (it
        // must show `working` or `blocked`), so a settled state that is
        // still the one before the prompt cannot be mistaken for the end.
        // The timeout is short: the run loop keeps polling afterwards.
        const sent = ctx.run([
          'agent',
          'prompt',
          agentName,
          state.prompt ?? '',
          '--wait',
          '--until',
          'working',
          '--until',
          'blocked',
          '--timeout',
          '5000',
        ]);
        if (!sent.ok) {
          // A stalled prompt may still have been delivered (Herdr does not
          // guarantee it was not); the report and the agent state decide.
          options.onEvent?.(
            `prompt to ${agentName} not confirmed: ${sent.stderr.trim() || 'unknown error'}`,
          );
        } else {
          options.onEvent?.(`prompt sent to ${agentName}`);
        }
      }
      const agent = agentState(ctx.run, agentName);
      const report = reportState(state.reportPath);
      const signature = `${agent ?? 'unknown'}:${report}`;
      if (signature !== lastSignature) {
        lastSignature = signature;
        options.onEvent?.(`agent ${agentName}: state=${agent ?? 'unknown'} report=${report}`);
      }
      const decision = decideInteractiveRun({
        report,
        agentState: agent,
        timedOut: false,
      });
      if (decision.done) {
        if (decision.reason === 'blocked') {
          options.onEvent?.(`agent ${agentName} is blocked`);
        }
        if (decision.exitCode === 0) {
          options.onEvent?.(`report detected: ${state.reportPath ?? ''}`);
        }
        finish(decision.exitCode);
        return;
      }
      if (Date.now() >= deadline) {
        timedOut = true;
        options.onEvent?.(`interactive run timed out after ${options.timeoutMs}ms`);
        finish(null);
      }
    }, pollMs);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) {
      onAbort();
    }
  });
}
