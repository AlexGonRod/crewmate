import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export interface CrewPaths {
  configDir: string;
  dataDir: string;
  stateDir: string;
  dbPath: string;
  worktreesDir: string;
  tasksDir: string;
  logsDir: string;
}

function envPath(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== '' ? path.resolve(value) : fallback;
}

export function resolvePaths(dbPathOverride?: string): CrewPaths {
  const home = homedir();
  const configHome = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  const dataHome = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  const stateHome = process.env.XDG_STATE_HOME || path.join(home, '.local', 'state');

  const configDir = envPath('CREW_CONFIG_DIR', path.join(configHome, 'crew'));
  const dataDir = envPath('CREW_DATA_DIR', path.join(dataHome, 'crew'));
  const stateDir = envPath('CREW_STATE_DIR', path.join(stateHome, 'crew'));
  const dbPath = dbPathOverride
    ? path.resolve(dbPathOverride)
    : envPath('CREW_DB_PATH', path.join(stateDir, 'crew.db'));

  return {
    configDir,
    dataDir,
    stateDir,
    dbPath,
    worktreesDir: path.join(dataDir, 'worktrees'),
    tasksDir: path.join(dataDir, 'tasks'),
    logsDir: path.join(dataDir, 'logs'),
  };
}

export function ensurePaths(paths: CrewPaths): void {
  for (const dir of [
    paths.configDir,
    paths.dataDir,
    paths.stateDir,
    path.dirname(paths.dbPath),
    paths.worktreesDir,
    paths.tasksDir,
    paths.logsDir,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
}
