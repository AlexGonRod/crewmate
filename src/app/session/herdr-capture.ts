import { readState } from './herdr-state';
import type { HerdrContext } from './herdr-types';

/** The PID of the process running in a session's pane, when Herdr knows it. */
export function sessionPid(ctx: HerdrContext, name: string): number | null {
  const state = readState(ctx.stateDir, name);
  if (!state) {
    return null;
  }
  const info = ctx.run(['pane', 'process-info', '--pane', state.paneId]);
  const processes = info.json?.result?.process_info?.foreground_processes;
  const pid = processes?.[0]?.pid ?? info.json?.result?.process_info?.shell_pid;
  return typeof pid === 'number' && pid > 0 ? pid : null;
}

/** The recent output of a session: the agent transcript or the pane's text. */
export function captureSession(ctx: HerdrContext, name: string): string {
  const state = readState(ctx.stateDir, name);
  if (!state) {
    return '';
  }
  if (state.mode === 'interactive' && state.agentName) {
    const result = ctx.run([
      'agent',
      'read',
      state.agentName,
      '--source',
      'recent-unwrapped',
      '--lines',
      '200',
    ]);
    if (result.ok) {
      return result.stdout;
    }
  }
  const result = ctx.run([
    'pane',
    'read',
    state.paneId,
    '--source',
    'recent-unwrapped',
    '--lines',
    '200',
  ]);
  return result.ok ? result.stdout : '';
}
