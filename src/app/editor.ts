import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { CrewError } from '../core/errors';

/**
 * Editors that run in their own window: they need `--wait` so the crew knows
 * when the human is done reading.
 */
const GUI_EDITORS = new Set([
  'atom',
  'code',
  'code-insiders',
  'cursor',
  'idea',
  'pycharm',
  'subl',
  'sublime_text',
  'webstorm',
  'zed',
]);

export interface EditorEnvironment {
  CREW_EDITOR?: string;
  VISUAL?: string;
  EDITOR?: string;
}

export function resolveEditor(env: EditorEnvironment = process.env): string {
  const candidate = env.CREW_EDITOR ?? env.VISUAL ?? env.EDITOR ?? 'nvim';
  const trimmed = candidate.trim();
  if (!trimmed) {
    throw new CrewError(
      'EDITOR_UNAVAILABLE',
      'No editor configured. Set CREW_EDITOR, VISUAL or EDITOR.',
    );
  }
  return trimmed;
}

export interface EditorCommand {
  binary: string;
  args: string[];
}

export function editorCommand(env: EditorEnvironment = process.env): EditorCommand {
  const parts = resolveEditor(env).split(/\s+/).filter(Boolean);
  const binary = parts[0];
  if (!binary) {
    throw new CrewError('EDITOR_UNAVAILABLE', 'The configured editor is empty');
  }
  const args = parts.slice(1);
  if (GUI_EDITORS.has(path.basename(binary))) {
    args.push('--wait');
  }
  return { binary, args };
}

/**
 * Opens a file in the editor and waits until the human closes it.
 */
export function openInEditor(
  filePath: string,
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): void {
  const env = options.env ?? process.env;
  const { binary, args } = editorCommand(env);
  const result = spawnSync(binary, [...args, filePath], {
    cwd: options.cwd,
    env,
    stdio: 'inherit',
  });
  if (result.error) {
    throw new CrewError(
      'EDITOR_FAILED',
      `Could not run the editor (${binary}): ${result.error.message}`,
    );
  }
}
