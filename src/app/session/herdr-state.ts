import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {
  isLayoutFileName,
  layoutPath,
  readTaskLayout,
  type TaskLayout,
} from './layout';
import type { HerdrSessionState, HerdrRunner } from './herdr-types';

/** Where the state of a session is recorded: `stateDir/<name>.json`. */
export function statePath(stateDir: string, name: string): string {
  return path.join(stateDir, `${name}.json`);
}

export function readState(stateDir: string, name: string): HerdrSessionState | null {
  const file = statePath(stateDir, name);
  if (!existsSync(file)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as HerdrSessionState;
  } catch {
    return null;
  }
}

export function writeState(stateDir: string, state: HerdrSessionState): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(statePath(stateDir, state.name), JSON.stringify(state, null, 2), 'utf8');
}

export function removeState(stateDir: string, name: string): void {
  rmSync(statePath(stateDir, name), { force: true });
}

export function listStates(stateDir: string): HerdrSessionState[] {
  try {
    return readdirSync(stateDir)
      .filter((entry) => entry.endsWith('.json') && !isLayoutFileName(entry))
      .map((entry) => readState(stateDir, entry.replace(/\.json$/, '')))
      .filter((state): state is HerdrSessionState => state !== null);
  } catch {
    return [];
  }
}

export function saveLayout(stateDir: string, layout: TaskLayout): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(layoutPath(stateDir, layout.taskId), JSON.stringify(layout, null, 2), 'utf8');
}

export function removeLayout(stateDir: string, taskId: string): void {
  rmSync(layoutPath(stateDir, taskId), { force: true });
}

/** The task layout, as long as its tab is still alive in Herdr. */
export function reusableLayout(
  stateDir: string,
  taskId: string,
  run: HerdrRunner,
): TaskLayout | null {
  const layout = readTaskLayout(stateDir, taskId);
  if (!layout) {
    return null;
  }
  return run(['tab', 'get', layout.tabId]).ok ? layout : null;
}
