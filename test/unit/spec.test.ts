import { describe, expect, it } from 'vitest';
import {
  normalizeSpec,
  parseMethodology,
  parseSpecText,
  resolveMethodology,
  specFromOptions,
  validateSpec,
} from '../../src/spec/spec';

describe('task spec', () => {
  it('normalizes a spec and generates acceptance ids', () => {
    const spec = validateSpec(
      normalizeSpec({
        goal: 'Ship the feature',
        acceptance_criteria: [{ text: 'It works' }, { text: 'It is tested' }],
      }),
    );
    expect(spec.schema).toBe('crew.spec/v1');
    expect(spec.acceptance_criteria.map((criterion) => criterion.id)).toEqual([
      'AC1',
      'AC2',
    ]);
  });

  it('builds a spec from CLI acceptance options', () => {
    const spec = specFromOptions({
      goal: 'Add a marker',
      acceptance: ['The marker exists', 'The marker has content'],
      nonGoals: ['Do not touch the main checkout'],
    });
    expect(spec.goal).toBe('Add a marker');
    expect(spec.acceptance_criteria).toHaveLength(2);
    expect(spec.non_goals).toEqual(['Do not touch the main checkout']);
  });

  it('rejects a spec without acceptance criteria', () => {
    expect(() => specFromOptions({ goal: 'Do something' })).toThrow('at least one');
  });

  it('rejects duplicate acceptance ids', () => {
    expect(() =>
      validateSpec({
        schema: 'crew.spec/v1',
        goal: 'Do something',
        acceptance_criteria: [
          { id: 'AC1', text: 'One' },
          { id: 'AC1', text: 'Two' },
        ],
      }),
    ).toThrow('Duplicate acceptance criterion');
  });

  it('parses YAML and JSON spec text', () => {
    const yaml = parseSpecText('goal: Do it\nacceptance_criteria:\n  - text: It works\n');
    const json = parseSpecText('{"goal":"Do it","acceptance_criteria":[{"text":"It works"}]}');
    expect(validateSpec(normalizeSpec(yaml)).goal).toBe('Do it');
    expect(validateSpec(normalizeSpec(json)).acceptance_criteria[0]?.id).toBe('AC1');
  });

  it('resolves methodology precedence', () => {
    expect(resolveMethodology(undefined, undefined)).toBe('free');
    expect(resolveMethodology(undefined, 'spec')).toBe('spec');
    expect(resolveMethodology('tdd', 'spec')).toBe('tdd');
    expect(parseMethodology('spec')).toBe('spec');
    expect(() => parseMethodology('waterfall')).toThrow('Unknown methodology');
  });
});
