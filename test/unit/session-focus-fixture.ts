import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach } from 'vitest';
import type { TaskState } from '../../src/core/types';
import type {
  FocusBackend,
  SessionFocusState,
} from '../../src/app/session/focus';
import { layoutFileName } from '../../src/app/session/layout';

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

export function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'crew-focus-'));
  dirs.push(dir);
  return dir;
}

export function task(
  id: string,
  state: TaskState,
  updatedAt: string,
): { id: string; state: TaskState; updatedAt: string } {
  return { id, state, updatedAt };
}

export interface StubOptions {
  states?: Record<string, SessionFocusState>;
  session?: string | null;
  focusOk?: boolean;
}

export function stubBackend(options: StubOptions = {}): {
  backend: FocusBackend;
  calls: string[];
} {
  const calls: string[] = [];
  const focusOk = options.focusOk ?? true;
  const backend: FocusBackend = {
    sessionState: (name) => options.states?.[name] ?? null,
    sessionForTask: () => options.session ?? null,
    focusTab: (tabId) => {
      calls.push(`tab:${tabId}`);
      return focusOk;
    },
    focusWorkspace: (workspaceId) => {
      calls.push(`workspace:${workspaceId}`);
      return focusOk;
    },
  };
  return { backend, calls };
}

export function writeState(
  stateDir: string,
  name: string,
  state: Record<string, unknown>,
): void {
  writeFileSync(
    path.join(stateDir, `${name}.json`),
    JSON.stringify({ name, ...state }),
    'utf8',
  );
}

export function writeLayout(stateDir: string, taskId: string, tabId: string): void {
  writeFileSync(
    path.join(stateDir, layoutFileName(taskId)),
    JSON.stringify({
      schema: 'crew.herdr-layout/v1',
      taskId,
      workspaceId: 'w1',
      tabId,
      developerPaneId: 'p1',
      testerPaneId: 'p2',
      reviewerPaneId: 'p3',
      createdAt: '2026-01-01T00:00:00.000Z',
    }),
    'utf8',
  );
}
