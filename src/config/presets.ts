import type { AgentConfig } from './config';

/**
 * Declarative agent presets: named sets of per-role agent overrides that are
 * selected at resolution time and applied on top of the configured
 * `agents.<role>.*` values. Selection precedence: CREW_PRESET (env) >
 * project `preset` > global `preset`. When nothing is selected the agents
 * pass through untouched.
 */

export type AgentRole = 'developer' | 'tester' | 'captain';

export type AgentsByRole = Record<AgentRole, AgentConfig>;

export interface PresetLayerRaw {
  /** Selected preset name (`preset: <name>`), if any. */
  preset?: unknown;
  /** Named preset definitions (`presets: { <name>: {...} }`). */
  presets?: unknown;
}

export interface PresetSource {
  where: string;
  layer: PresetLayerRaw;
}

export interface ResolveAgentPresetInput {
  /** CREW_PRESET env value. Takes precedence over project and global. */
  envPreset?: string;
  /** Global config layer (~/.config/crew/config.yaml). */
  global?: PresetSource;
  /** Project config layer (<root>/.crew/config.yaml). */
  project?: PresetSource;
  /** Currently configured agents; the preset overrides fields on top. */
  agents: AgentsByRole;
}

export interface PresetResolution {
  /** Effective agents (preset applied, or pass-through when unselected). */
  agents: AgentsByRole;
  /** Human-readable warnings for omitted presets; the run never fails. */
  warnings: string[];
}

interface PresetDefinition {
  extends?: string;
  agents: { [role in AgentRole]?: AgentConfig };
}

const ROLES: AgentRole[] = ['developer', 'tester', 'captain'];
const MAX_CHAIN_DEPTH = 10;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Field-by-field merge for plain objects; the child wins field by field. */
export function deepMergePresets(
  base: Record<string, unknown>,
  child: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(child)) {
    const current = result[key];
    result[key] =
      isPlainObject(current) && isPlainObject(value)
        ? deepMergePresets(current, value)
        : value;
  }
  return result;
}

function parsePresetAgentConfig(value: unknown): AgentConfig {
  const result: AgentConfig = {};
  if (!isPlainObject(value)) {
    return result;
  }
  if (typeof value.harness === 'string') result.harness = value.harness;
  if (typeof value.agent === 'string') result.agent = value.agent;
  if (typeof value.model === 'string') result.model = value.model;
  return result;
}

function parsePresetDefinition(
  name: string,
  value: unknown,
  where: string,
  warnings: string[],
): PresetDefinition | null {
  if (!isPlainObject(value)) {
    warnings.push(`preset "${name}" in ${where} is not an object; ignoring`);
    return null;
  }
  const definition: PresetDefinition = { agents: {} };
  if (value.extends !== undefined) {
    if (typeof value.extends !== 'string' || value.extends.trim() === '') {
      warnings.push(`preset "${name}" in ${where} has an invalid "extends"; ignoring`);
      return null;
    }
    definition.extends = value.extends;
  }
  const agents: PresetDefinition['agents'] = {};
  if (value.agents !== undefined) {
    if (!isPlainObject(value.agents)) {
      warnings.push(`preset "${name}" in ${where} has an invalid "agents" block; ignoring`);
      return null;
    }
    for (const role of ROLES) {
      if (value.agents[role] !== undefined) {
        agents[role] = parsePresetAgentConfig(value.agents[role]);
      }
    }
  }
  definition.agents = agents;
  return definition;
}

function normalizeDefinitions(
  layer: PresetSource,
  warnings: string[],
): Map<string, PresetDefinition> {
  const definitions = new Map<string, PresetDefinition>();
  if (!isPlainObject(layer.layer.presets)) {
    if (layer.layer.presets !== undefined) {
      warnings.push(`presets in ${layer.where} is not a map; ignoring`);
    }
    return definitions;
  }
  for (const [name, value] of Object.entries(layer.layer.presets)) {
    const definition = parsePresetDefinition(name, value, layer.where, warnings);
    if (definition) {
      definitions.set(name, definition);
    }
  }
  return definitions;
}

/**
 * Picks the preset name following the precedence env > project > global,
 * and returns which layer it was selected from.
 */
function selectLayer(
  input: ResolveAgentPresetInput,
): { name: string; source: PresetSource } | null {
  if (input.envPreset && input.envPreset.trim() !== '') {
    return { name: input.envPreset.trim(), source: { where: 'CREW_PRESET', layer: {} } };
  }
  if (typeof input.project?.layer.preset === 'string' && input.project.layer.preset.trim() !== '') {
    return { name: input.project.layer.preset.trim(), source: input.project };
  }
  if (typeof input.global?.layer.preset === 'string' && input.global.layer.preset.trim() !== '') {
    return { name: input.global.layer.preset.trim(), source: input.global };
  }
  return null;
}



/**
 * Resolves the selected preset (if any) into per-role agent overrides.
 * Never throws: a preset that is missing, invalid or cyclic is omitted with
 * a warning and the run continues with the current configuration.
 */
export function resolveAgentPreset(input: ResolveAgentPresetInput): PresetResolution {
  const warnings: string[] = [];
  const selection = selectLayer(input);
  if (!selection) {
    return { agents: { ...input.agents }, warnings };
  }

  const projectDefinitions = input.project
    ? normalizeDefinitions(input.project, warnings)
    : new Map<string, PresetDefinition>();
  const globalDefinitions = input.global
    ? normalizeDefinitions(input.global, warnings)
    : new Map<string, PresetDefinition>();

  // Project definitions win over global ones with the same name.
  const definitions = new Map([...globalDefinitions, ...projectDefinitions]);

  const baseDefinition = definitions.get(selection.name);
  if (!baseDefinition) {
    warnings.push(
      `preset "${selection.name}" not found in global${input.project ? ' or project' : ''} configuration; ignoring`,
    );
    return { agents: { ...input.agents }, warnings };
  }
  let depth = 0;
  // Resolve the extends chain, child wins field by field.
  const chain: PresetDefinition[] = [];
  let cursorName: string | undefined = selection.name;
  let current: PresetDefinition | undefined = baseDefinition;
  while (current && depth < MAX_CHAIN_DEPTH) {
    chain.unshift(current);
    cursorName = current.extends;
    if (cursorName === selection.name) {
      warnings.push(`preset "${selection.name}" extends itself; ignoring`);
      return { agents: { ...input.agents }, warnings };
    }
    current = cursorName ? definitions.get(cursorName) : undefined;
    if (cursorName && !current) {
      warnings.push(
        `preset "${selection.name}" extends unknown preset "${cursorName}"; ignoring`,
      );
      return { agents: { ...input.agents }, warnings };
    }
    depth += 1;
  }
  if (depth >= MAX_CHAIN_DEPTH) {
    warnings.push(`preset "${selection.name}" has an extends loop; ignoring`);
    return { agents: { ...input.agents }, warnings };
  }

  const mergedFields: Record<string, unknown> = {};
  for (const definition of chain) {
    for (const [role, agentConfig] of Object.entries(definition.agents)) {
      mergedFields[role] = deepMergePresets(
        isPlainObject(mergedFields[role]) ? (mergedFields[role] as Record<string, unknown>) : {},
        { ...agentConfig },
      );
    }
  }

  const agents: AgentsByRole = { ...input.agents };
  for (const role of ROLES) {
    if (isPlainObject(mergedFields[role])) {
      agents[role] = {
        ...agents[role],
        ...parsePresetAgentConfig(mergedFields[role]),
      };
    }
  }
  return { agents, warnings };
}
