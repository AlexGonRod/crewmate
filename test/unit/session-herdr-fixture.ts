import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { HerdrBackend } from '../../src/app/session/herdr';
import { buildInteractivePrompt } from '../../src/app/session/interactive';

const dirs: string[] = [];

export function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'crew-herdr-interactive-'));
  dirs.push(dir);
  return dir;
}

export function cleanupDirs(): void {
  while (dirs.length > 0) {
    rmSync(dirs.pop() as string, { recursive: true, force: true });
  }
}

export function report(): unknown {
  return {
    schema: 'crew.report/v2',
    task_id: 'tsk_01M6VCD1QSK57YAKYTPG9M55G6',
    run_id: 'run_01M6VCY2CJTPGS2W5PTEEDDT48',
    methodology: 'tdd',
    status: 'done',
    summary: 'Interactive agent finished',
  };
}

export function startInteractive(
  backend: HerdrBackend,
  options: {
    name: string;
    worktree: string;
    reportPath: string;
    baseName?: string;
    onEvent?: (message: string) => void;
  },
): ReturnType<HerdrBackend['start']> {
  const prompt = buildInteractivePrompt({
    briefPath: path.join(options.worktree, '.crew', 'brief.md'),
    reportPath: options.reportPath,
    worktreePath: options.worktree,
  });
  return backend.start({
    name: options.name,
    command: 'ignored',
    args: [],
    cwd: options.worktree,
    env: {},
    onEvent: options.onEvent,
    interactive: {
      kind: 'pi',
      baseName: options.baseName ?? 'crew-5pteeddt48-dev',
      prompt,
      reportPath: options.reportPath,
      workspaceLabel: 'crew-sessions',
    },
  });
}
