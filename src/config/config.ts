import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import { CrewError } from '../core/errors';
import type {
  CiProvider,
  DeliveryMode,
  MergeMethod,
  Methodology,
} from '../core/types';
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

export type SchedulingMode = 'serial' | 'parallel';

export interface SchedulingConfig {
  concurrency: number;
  mode: SchedulingMode;
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
  scheduling: SchedulingConfig;
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
  scheduling: {
    concurrency: 1,
    mode: 'serial',
  },
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
    if (parsed.scheduling && typeof parsed.scheduling === 'object') {
      const scheduling = parsed.scheduling as Record<string, unknown>;
      const concurrency =
        typeof scheduling.concurrency === 'number' && scheduling.concurrency >= 1
          ? Math.floor(scheduling.concurrency)
          : DEFAULT_CONFIG.scheduling.concurrency;
      const mode: SchedulingMode =
        scheduling.mode === 'parallel' ? 'parallel' : 'serial';
      result.scheduling = { concurrency, mode };
    }
    return result;
  } catch (error) {
    throw new CrewError(
      'CONFIG_INVALID',
      `Could not read ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function globalConfigPath(configDir: string): string {
  return path.join(configDir, 'config.yaml');
}

export function readGlobalConfigFile(configDir: string): Record<string, unknown> {
  const configPath = globalConfigPath(configDir);
  if (!existsSync(configPath)) {
    return {};
  }
  try {
    const parsed = parse(readFileSync(configPath, 'utf8')) as Record<string, unknown> | null;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

const SETTABLE_KEYS = [
  'harness',
  'timeout_seconds',
  'delivery',
  'review.max_iterations',
  'scheduling.concurrency',
  'scheduling.mode',
  'agents.developer.harness',
  'agents.developer.agent',
  'agents.developer.model',
  'agents.tester.harness',
  'agents.tester.agent',
  'agents.tester.model',
] as const;

export type SettableKey = (typeof SETTABLE_KEYS)[number];

/**
 * Writes a value in the global configuration, keeping the rest of the file.
 */
export function writeGlobalConfigValue(
  configDir: string,
  key: SettableKey,
  value: string | number | boolean,
): { path: string; key: string; value: string | number | boolean } {
  if (!SETTABLE_KEYS.includes(key)) {
    throw new CrewError(
      'CONFIG_KEY_UNKNOWN',
      `Unknown config key: ${key}. Known keys: ${SETTABLE_KEYS.join(', ')}`,
    );
  }
  const current = readGlobalConfigFile(configDir);
  const parts = key.split('.');
  let cursor = current;
  for (const part of parts.slice(0, -1)) {
    const next = cursor[part];
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      cursor[part] = {};
    }
    cursor = cursor[part] as Record<string, unknown>;
  }
  const last = parts[parts.length - 1] as string;
  cursor[last] = value;
  const configPath = globalConfigPath(configDir);
  writeFileSync(configPath, stringify(current, { indent: 2 }), 'utf8');
  return { path: configPath, key, value };
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
    scheduling: {
      ...DEFAULT_CONFIG.scheduling,
      ...stored.scheduling,
    },
  };
  return { paths, config };
}

export interface ProjectCiConfig {
  provider: CiProvider;
  timeout_seconds?: number;
  interval_seconds?: number;
}

export interface ProjectAutoMergeConfig {
  method: MergeMethod;
  delete_branch?: boolean;
}

/**
 * The delivery policy of a project, in the shape firstmate uses: a mode that
 * owns the technical rigour of the path, and a `yolo` posture that says who
 * may sign a merge.
 */
export type DeliveryPath = 'no-mistakes' | 'direct-PR' | 'local-only';

export interface ProjectDeliveryConfig {
  mode?: DeliveryPath;
  yolo?: boolean;
  method?: MergeMethod;
  delete_branch?: boolean;
}

export interface ProjectRunnerConfig {
  host: string;
  ssh_options?: string[];
  /** Repository root on the remote host. Enables the fully remote workspace. */
  repo_path?: string;
  /** Root directory for the remote worktrees. */
  worktree_root?: string;
}

export interface ProjectConfig {
  schema?: string;
  name?: string;
  default_branch?: string;
  methodology?: Methodology;
  verify?: string[];
  verify_timeout_seconds?: number;
  ci?: ProjectCiConfig;
  auto_merge?: ProjectAutoMergeConfig;
  delivery?: DeliveryMode | ProjectDeliveryConfig;
  review?: {
    max_iterations?: number;
  };
  runner?: ProjectRunnerConfig;
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
    if (parsed.verify !== undefined) {
      if (
        !Array.isArray(parsed.verify) ||
        !parsed.verify.every(
          (command) => typeof command === 'string' && command.trim().length > 0,
        )
      ) {
        throw new CrewError(
          'PROJECT_CONFIG_INVALID',
          `verify must be a list of non-empty commands in ${configPath}`,
        );
      }
      parsed.verify = parsed.verify.map((command) => command.trim());
    }
    if (parsed.verify_timeout_seconds !== undefined) {
      if (
        typeof parsed.verify_timeout_seconds !== 'number' ||
        !Number.isFinite(parsed.verify_timeout_seconds) ||
        parsed.verify_timeout_seconds <= 0
      ) {
        throw new CrewError(
          'PROJECT_CONFIG_INVALID',
          `verify_timeout_seconds must be a positive number in ${configPath}`,
        );
      }
    }
    if (parsed.ci !== undefined) {
      if (
        !parsed.ci ||
        typeof parsed.ci !== 'object' ||
        Array.isArray(parsed.ci)
      ) {
        throw new CrewError(
          'PROJECT_CONFIG_INVALID',
          `ci must be an object in ${configPath}`,
        );
      }
      if (parsed.ci.provider !== 'github_actions') {
        throw new CrewError(
          'PROJECT_CONFIG_INVALID',
          `ci.provider must be "github_actions" in ${configPath}`,
        );
      }
      for (const key of ['timeout_seconds', 'interval_seconds'] as const) {
        const value = parsed.ci[key];
        if (
          value !== undefined &&
          (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
        ) {
          throw new CrewError(
            'PROJECT_CONFIG_INVALID',
            `ci.${key} must be a positive number in ${configPath}`,
          );
        }
      }
    }
    if (parsed.auto_merge !== undefined) {
      if (
        !parsed.auto_merge ||
        typeof parsed.auto_merge !== 'object' ||
        Array.isArray(parsed.auto_merge)
      ) {
        throw new CrewError(
          'PROJECT_CONFIG_INVALID',
          `auto_merge must be an object in ${configPath}`,
        );
      }
      if (
        parsed.auto_merge.method !== 'merge' &&
        parsed.auto_merge.method !== 'squash' &&
        parsed.auto_merge.method !== 'rebase'
      ) {
        throw new CrewError(
          'PROJECT_CONFIG_INVALID',
          `auto_merge.method must be "merge", "squash", or "rebase" in ${configPath}`,
        );
      }
      if (
        parsed.auto_merge.delete_branch !== undefined &&
        typeof parsed.auto_merge.delete_branch !== 'boolean'
      ) {
        throw new CrewError(
          'PROJECT_CONFIG_INVALID',
          `auto_merge.delete_branch must be a boolean in ${configPath}`,
        );
      }
    }
    if (parsed.runner !== undefined) {
      const runner = parsed.runner;
      if (
        !runner ||
        typeof runner !== 'object' ||
        Array.isArray(runner) ||
        typeof runner.host !== 'string' ||
        runner.host.trim() === ''
      ) {
        throw new CrewError(
          'PROJECT_CONFIG_INVALID',
          `runner.host must be a non-empty string in ${configPath}`,
        );
      }
      for (const key of ['repo_path', 'worktree_root'] as const) {
        const value = runner[key];
        if (value !== undefined && (typeof value !== 'string' || value.trim() === '')) {
          throw new CrewError(
            'PROJECT_CONFIG_INVALID',
            `runner.${key} must be a non-empty string in ${configPath}`,
          );
        }
      }
      if (
        runner.ssh_options !== undefined &&
        (!Array.isArray(runner.ssh_options) ||
          !runner.ssh_options.every((item) => typeof item === 'string'))
      ) {
        throw new CrewError(
          'PROJECT_CONFIG_INVALID',
          `runner.ssh_options must be a list of strings in ${configPath}`,
        );
      }
    }
    if (parsed.delivery !== undefined) {
      if (typeof parsed.delivery === 'string') {
        const delivery = parseDeliveryMode(parsed.delivery);
        if (!delivery) {
          throw new CrewError(
            'PROJECT_CONFIG_INVALID',
            `Invalid delivery mode in ${configPath}: ${String(parsed.delivery)}`,
          );
        }
        parsed.delivery = delivery;
      } else {
        const delivery = parsed.delivery;
        if (
          !delivery ||
          typeof delivery !== 'object' ||
          Array.isArray(delivery)
        ) {
          throw new CrewError(
            'PROJECT_CONFIG_INVALID',
            `delivery must be a mode or an object in ${configPath}`,
          );
        }
        if (
          delivery.mode !== undefined &&
          !['no-mistakes', 'direct-PR', 'local-only'].includes(delivery.mode)
        ) {
          throw new CrewError(
            'PROJECT_CONFIG_INVALID',
            `delivery.mode must be "no-mistakes", "direct-PR" or "local-only" in ${configPath}`,
          );
        }
        if (delivery.yolo !== undefined && typeof delivery.yolo !== 'boolean') {
          throw new CrewError(
            'PROJECT_CONFIG_INVALID',
            `delivery.yolo must be a boolean in ${configPath}`,
          );
        }
        if (
          delivery.method !== undefined &&
          !['merge', 'squash', 'rebase'].includes(delivery.method)
        ) {
          throw new CrewError(
            'PROJECT_CONFIG_INVALID',
            `delivery.method must be "merge", "squash" or "rebase" in ${configPath}`,
          );
        }
        if (
          delivery.delete_branch !== undefined &&
          typeof delivery.delete_branch !== 'boolean'
        ) {
          throw new CrewError(
            'PROJECT_CONFIG_INVALID',
            `delivery.delete_branch must be a boolean in ${configPath}`,
          );
        }
      }
    }
    return parsed;
  } catch (error) {
    throw new CrewError(
      'PROJECT_CONFIG_INVALID',
      `Could not read ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
