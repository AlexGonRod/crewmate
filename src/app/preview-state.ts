import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { isPidAlive } from '../core/process';

export interface PreviewState {
  taskId: string;
  port: number;
  pid: number;
  url: string;
  command: string;
  startedAt: string;
}

export interface PreviewStatus {
  taskId: string;
  url: string | null;
  port: number | null;
  pid: number | null;
  running: boolean;
}

export function previewStatePath(previewsDir: string, taskId: string): string {
  return path.join(previewsDir, `${taskId}.json`);
}

export function previewLogPath(previewsDir: string, taskId: string): string {
  return path.join(previewsDir, `${taskId}.log`);
}

function parseState(text: string): PreviewState | null {
  try {
    const value = JSON.parse(text) as Partial<PreviewState> | null;
    if (
      !value ||
      typeof value.taskId !== 'string' ||
      typeof value.port !== 'number' ||
      typeof value.pid !== 'number' ||
      typeof value.url !== 'string' ||
      typeof value.command !== 'string' ||
      typeof value.startedAt !== 'string'
    ) {
      return null;
    }
    return value as PreviewState;
  } catch {
    return null;
  }
}

export function readStateFile(
  previewsDir: string,
  taskId: string,
): PreviewState | null {
  const file = previewStatePath(previewsDir, taskId);
  if (!existsSync(file)) {
    return null;
  }
  try {
    return parseState(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function removeStateFile(previewsDir: string, taskId: string): void {
  rmSync(previewStatePath(previewsDir, taskId), { force: true });
}

/**
 * The live preview of a task, or null. A registry whose process died is stale:
 * it is removed so a later start knows the task is not being served.
 */
export function readPreview(
  previewsDir: string,
  taskId: string,
): PreviewState | null {
  const state = readStateFile(previewsDir, taskId);
  if (!state) {
    return null;
  }
  if (!isPidAlive(state.pid)) {
    removeStateFile(previewsDir, taskId);
    return null;
  }
  return state;
}

export function listLivePreviews(previewsDir: string): PreviewState[] {
  if (!existsSync(previewsDir)) {
    return [];
  }
  return readdirSync(previewsDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => readPreview(previewsDir, name.slice(0, -'.json'.length)))
    .filter((state): state is PreviewState => state !== null);
}

export function toStatus(state: PreviewState | null): PreviewStatus {
  return state
    ? {
        taskId: state.taskId,
        url: state.url,
        port: state.port,
        pid: state.pid,
        running: true,
      }
    : { taskId: '', url: null, port: null, pid: null, running: false };
}
