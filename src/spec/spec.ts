import { existsSync, readFileSync } from 'node:fs';
import Ajv, { type ValidateFunction } from 'ajv';
import { parse as parseYaml } from 'yaml';
import { CrewError } from '../core/errors';
import type { Methodology, TaskSpec } from '../core/types';

function schemaUrl(name: string): URL {
  const direct = new URL(`../../contracts/${name}`, import.meta.url);
  if (existsSync(direct)) {
    return direct;
  }
  return new URL(`../../../contracts/${name}`, import.meta.url);
}

function loadSchema(name: string): object {
  const url = schemaUrl(name);
  if (!existsSync(url)) {
    throw new CrewError('SCHEMA_NOT_FOUND', `Contract schema not found: ${url.pathname}`);
  }
  return JSON.parse(readFileSync(url, 'utf8')) as object;
}

const ajv = new Ajv({ allErrors: true, strict: false });
const validateSpecSchema: ValidateFunction = ajv.compile(loadSchema('spec.v1.schema.json'));

export function parseSpecText(text: string, source = 'spec'): unknown {
  try {
    return parseYaml(text) as unknown;
  } catch (error) {
    throw new CrewError(
      'SPEC_INVALID',
      `Could not parse ${source}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function loadSpecFile(filePath: string): unknown {
  if (!existsSync(filePath)) {
    throw new CrewError('SPEC_NOT_FOUND', `Spec file not found: ${filePath}`);
  }
  return parseSpecText(readFileSync(filePath, 'utf8'), filePath);
}

export function normalizeSpec(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return raw;
  }
  const record = { ...(raw as Record<string, unknown>) };
  if (record.schema === undefined) {
    record.schema = 'crew.spec/v1';
  }
  if (Array.isArray(record.acceptance_criteria)) {
    record.acceptance_criteria = record.acceptance_criteria.map((item, index) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        return item;
      }
      const criterion = { ...(item as Record<string, unknown>) };
      if (criterion.id === undefined || criterion.id === null || criterion.id === '') {
        criterion.id = `AC${index + 1}`;
      }
      return criterion;
    });
  }
  return record;
}

export function validateSpec(raw: unknown): TaskSpec {
  const normalized = normalizeSpec(raw);
  if (!validateSpecSchema(normalized)) {
    throw new CrewError(
      'SPEC_INVALID',
      `Invalid task spec: ${ajv.errorsText(validateSpecSchema.errors, { separator: '; ' })}`,
    );
  }
  const spec = normalized as TaskSpec;
  const seen = new Set<string>();
  for (const criterion of spec.acceptance_criteria) {
    if (seen.has(criterion.id)) {
      throw new CrewError('SPEC_INVALID', `Duplicate acceptance criterion id: ${criterion.id}`);
    }
    seen.add(criterion.id);
  }
  return spec;
}

export function specFromOptions(input: {
  goal: string;
  acceptance?: string[];
  nonGoals?: string[];
  constraints?: string[];
}): TaskSpec {
  const goal = input.goal.trim();
  if (!goal) {
    throw new CrewError('SPEC_REQUIRED', 'A spec or brief goal is required');
  }
  const criteria = (input.acceptance ?? [])
    .map((text) => text.trim())
    .filter(Boolean)
    .map((text, index) => ({ id: `AC${index + 1}`, text }));
  if (criteria.length === 0) {
    throw new CrewError(
      'SPEC_REQUIRED',
      'The spec and tdd methodologies require at least one acceptance criterion',
    );
  }
  return validateSpec({
    schema: 'crew.spec/v1',
    goal,
    acceptance_criteria: criteria,
    non_goals: (input.nonGoals ?? []).map((text) => text.trim()).filter(Boolean),
    constraints: (input.constraints ?? []).map((text) => text.trim()).filter(Boolean),
  });
}

export function parseMethodology(value: string): Methodology {
  if (value === 'free' || value === 'spec' || value === 'tdd') {
    return value;
  }
  throw new CrewError('INVALID_METHODOLOGY', `Unknown methodology: ${value}`);
}

export function resolveMethodology(
  explicit: Methodology | undefined,
  projectDefault: Methodology | undefined,
): Methodology {
  return explicit ?? projectDefault ?? 'free';
}

export function methodologyRequiresSpec(methodology: Methodology): boolean {
  return methodology !== 'free';
}
