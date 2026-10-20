import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { CrewError } from '../core/errors';
import type { Methodology } from '../core/types';
import { parseMethodology } from '../spec/spec';
import { ensurePaths, resolvePaths, type CrewPaths } from './paths';

export interface CrewConfig {
  harness: string;
  timeoutSeconds: number;
}

export interface ResolvedContext {
  paths: CrewPaths;
  config: CrewConfig;
}

const DEFAULT_CONFIG: CrewConfig = {
  harness: 'fake',
  timeoutSeconds: 300,
};

function readGlobalConfig(configDir: string): Partial<CrewConfig> {
  const configPath = path.join(configDir, 'config.yaml');
  if (!existsSync(configPath)) {
    return {};
  }

  try {
    const parsed = parse(readFileSync(configPath, 'utf8')) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== 'object') {
      return {};
    }
    const result: Partial<CrewConfig> = {};
    if (typeof parsed.harness === 'string') {
      result.harness = parsed.harness;
    }
    if (typeof parsed.timeout_seconds === 'number') {
      result.timeoutSeconds = parsed.timeout_seconds;
    }
    return result;
  } catch (error) {
    throw new CrewError(
      'CONFIG_INVALID',
      `Could not read ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function loadContext(options: { dbPath?: string } = {}): ResolvedContext {
  const paths = resolvePaths(options.dbPath);
  ensurePaths(paths);
  const config = { ...DEFAULT_CONFIG, ...readGlobalConfig(paths.configDir) };
  return { paths, config };
}

export interface ProjectConfig {
  schema?: string;
  name?: string;
  default_branch?: string;
  methodology?: Methodology;
  verify?: string[];
}

export function projectConfigPath(rootPath: string): string {
  return path.join(rootPath, '.crew', 'config.yaml');
}

export function readProjectConfig(rootPath: string): ProjectConfig | null {
  const configPath = projectConfigPath(rootPath);
  if (!existsSync(configPath)) {
    return null;
  }
  try {
    const parsed = parse(readFileSync(configPath, 'utf8')) as ProjectConfig | null;
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    if (typeof parsed.methodology === 'string') {
      parsed.methodology = parseMethodology(parsed.methodology);
    }
    return parsed;
  } catch (error) {
    throw new CrewError(
      'PROJECT_CONFIG_INVALID',
      `Could not read ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
