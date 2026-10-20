import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { CrewError } from '../core/errors';
import type { DeliveryMode, Methodology } from '../core/types';
import { parseMethodology } from '../spec/spec';
import { ensurePaths, resolvePaths, type CrewPaths } from './paths';

export interface AgentConfig {
  harness?: string;
  agent?: string;
  model?: string;
}

export interface ReviewConfig {
  maxIterations: number;
}

export interface CrewConfig {
  harness: string;
  timeoutSeconds: number;
  agents: {
    developer: AgentConfig;
    tester: AgentConfig;
  };
  review: ReviewConfig;
  delivery: DeliveryMode;
}

export interface ResolvedContext {
  paths: CrewPaths;
  config: CrewConfig;
}

const DEFAULT_CONFIG: CrewConfig = {
  harness: 'fake',
  timeoutSeconds: 300,
  agents: {
    developer: {},
    tester: {},
  },
  review: {
    maxIterations: 3,
  },
  delivery: 'local',
};

const DELIVERY_MODES: DeliveryMode[] = ['local', 'pr', 'auto_merge', 'scout'];

function parseAgentConfig(value: unknown): AgentConfig {
  if (!value || typeof value !== 'object') {
    return {};
  }
  const input = value as Record<string, unknown>;
  const result: AgentConfig = {};
  if (typeof input.harness === 'string') result.harness = input.harness;
  if (typeof input.agent === 'string') result.agent = input.agent;
  if (typeof input.model === 'string') result.model = input.model;
  return result;
}

function parseDeliveryMode(value: unknown): DeliveryMode | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  return DELIVERY_MODES.includes(value as DeliveryMode)
    ? (value as DeliveryMode)
    : undefined;
}

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
    if (parsed.agents && typeof parsed.agents === 'object') {
      const agents = parsed.agents as Record<string, unknown>;
      result.agents = {
        developer: parseAgentConfig(agents.developer),
        tester: parseAgentConfig(agents.tester),
      };
    }
    if (parsed.review && typeof parsed.review === 'object') {
      const review = parsed.review as Record<string, unknown>;
      if (typeof review.max_iterations === 'number') {
        result.review = {
          maxIterations: review.max_iterations,
        };
      }
    }
    const delivery = parseDeliveryMode(parsed.delivery);
    if (delivery) {
      result.delivery = delivery;
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
  const stored = readGlobalConfig(paths.configDir);
  const config: CrewConfig = {
    ...DEFAULT_CONFIG,
    ...stored,
    agents: {
      developer: {
        ...DEFAULT_CONFIG.agents.developer,
        ...stored.agents?.developer,
      },
      tester: {
        ...DEFAULT_CONFIG.agents.tester,
        ...stored.agents?.tester,
      },
    },
    review: {
      ...DEFAULT_CONFIG.review,
      ...stored.review,
    },
  };
  return { paths, config };
}

export interface ProjectConfig {
  schema?: string;
  name?: string;
  default_branch?: string;
  methodology?: Methodology;
  verify?: string[];
  delivery?: DeliveryMode;
  review?: {
    max_iterations?: number;
  };
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
    if (parsed.delivery !== undefined) {
      const delivery = parseDeliveryMode(parsed.delivery);
      if (!delivery) {
        throw new CrewError(
          'PROJECT_CONFIG_INVALID',
          `Invalid delivery mode in ${configPath}: ${String(parsed.delivery)}`,
        );
      }
      parsed.delivery = delivery;
    }
    return parsed;
  } catch (error) {
    throw new CrewError(
      'PROJECT_CONFIG_INVALID',
      `Could not read ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
