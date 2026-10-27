import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readProjectConfig } from '../../src/config/config';
import {
  deepMergePresets,
  resolveAgentPreset,
  type PresetSource,
  type AgentsByRole,
} from '../../src/config/presets';

const dirs: string[] = [];

function tempProjectDir(configYaml?: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'crew-preset-'));
  dirs.push(dir);
  if (configYaml !== undefined) {
    mkdirSync(path.join(dir, '.crew'), { recursive: true });
    writeFileSync(path.join(dir, '.crew', 'config.yaml'), configYaml, 'utf8');
  }
  return dir;
}

function cleanupAll(): void {
  while (dirs.length > 0) {
    rmSync(dirs.pop() as string, { recursive: true, force: true });
  }
}

function layer(
  where: string,
  layer: PresetSource['layer'],
): PresetSource {
  return { where, layer };
}

const baseAgents: AgentsByRole = {
  developer: { harness: 'fake' },
  tester: { harness: 'fake' },
  captain: { harness: 'fake' },
};

describe('deepMergePresets', () => {
  it('merges field by field and the child wins', () => {
    const merged = deepMergePresets(
      { model: 'base/model', harness: 'fake' },
      { model: 'child/model' },
    );
    expect(merged).toEqual({ model: 'child/model', harness: 'fake' });
  });
});

describe('resolveAgentPreset without selection', () => {
  it('passes the configured agents through untouched', () => {
    const result = resolveAgentPreset({
      global: layer('global', {
        presets: { fast: { agents: { developer: { model: 'x' } } } },
      }),
      project: layer('project', {
        presets: { fast: { agents: { developer: { model: 'y' } } } },
      }),
      agents: baseAgents,
    });
    expect(result.agents).toEqual(baseAgents);
    expect(result.warnings).toEqual([]);
  });
});

describe('AC1: preset with extends', () => {
  it('inherits the base fields and overrides them field by field', () => {
    const result = resolveAgentPreset({
      global: layer('global', {
        presets: {
          base: { agents: { developer: { harness: 'opencode', model: 'base/model' } } },
          child: {
            extends: 'base',
            agents: {
              developer: { model: 'child/model' },
              tester: { harness: 'opencode' },
            },
          },
        },
        preset: 'child',
      }),
      agents: baseAgents,
    });
    expect(result.warnings).toEqual([]);
    expect(result.agents.developer).toEqual({ harness: 'opencode', model: 'child/model' });
    expect(result.agents.tester).toEqual({ harness: 'opencode' });
    expect(result.agents.captain).toEqual({ harness: 'fake' });
  });

  it('applies the preset fields over the configured agents', () => {
    const configured: AgentsByRole = {
      developer: { harness: 'fake', agent: 'dev' },
      tester: {},
      captain: {},
    };
    const result = resolveAgentPreset({
      global: layer('global', {
        presets: { p: { agents: { developer: { harness: 'opencode' } } } },
        preset: 'p',
      }),
      agents: configured,
    });
    expect(result.agents.developer).toEqual({ harness: 'opencode', agent: 'dev' });
  });
});

describe('AC2: selection precedence env > project > global', () => {
  const global = layer('global', {
    presets: {
      env: { agents: { developer: { model: 'env/model' } } },
      project: { agents: { developer: { model: 'project/model' } } },
      globalOnly: { agents: { developer: { model: 'global/model' } } },
    },
  });

  it('CREW_PRESET wins over project and global', () => {
    const result = resolveAgentPreset({
      envPreset: 'env',
      project: layer('project', { preset: 'project', presets: global.layer.presets }),
      global,
      agents: baseAgents,
    });
    expect(result.agents.developer.model).toBe('env/model');
  });

  it('project selection wins over global', () => {
    const result = resolveAgentPreset({
      project: layer('project', { preset: 'project', presets: global.layer.presets }),
      global,
      agents: baseAgents,
    });
    expect(result.agents.developer.model).toBe('project/model');
  });

  it('global selection applies when nothing else is set', () => {
    const result = resolveAgentPreset({
      global: layer('global', { preset: 'globalOnly', presets: global.layer.presets }),
      agents: baseAgents,
    });
    expect(result.agents.developer.model).toBe('global/model');
  });

  it('a missing name in project falls back to global definitions', () => {
    const result = resolveAgentPreset({
      project: layer('project', { preset: 'globalOnly' }),
      global,
      agents: baseAgents,
    });
    expect(result.agents.developer.model).toBe('global/model');
  });
});

describe('AC3: invalid or missing presets are omitted with a warning', () => {
  it('warns and keeps the configured agents when the preset is missing', () => {
    const result = resolveAgentPreset({
      global: layer('global', { preset: 'nope' }),
      agents: baseAgents,
    });
    expect(result.agents).toEqual(baseAgents);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/"nope".*not found/);
  });

  it('warns and keeps the configured agents when the preset is invalid', () => {
    const result = resolveAgentPreset({
      global: layer('global', { preset: 'bad', presets: { bad: 'not-an-object' } }),
      agents: baseAgents,
    });
    expect(result.agents).toEqual(baseAgents);
    expect(result.warnings.join('\n')).toMatch(/invalid|not an object/i);
  });

  it('warns when extends points to an unknown preset', () => {
    const result = resolveAgentPreset({
      global: layer('global', {
        presets: { child: { extends: 'ghost', agents: { developer: { model: 'x' } } } },
        preset: 'child',
      }),
      agents: baseAgents,
    });
    expect(result.agents).toEqual(baseAgents);
    expect(result.warnings.join('\n')).toMatch(/extends unknown preset "ghost"/);
  });

  it('warns on a self-extends loop', () => {
    const result = resolveAgentPreset({
      global: layer('global', {
        presets: { loop: { extends: 'loop', agents: { developer: { model: 'x' } } } },
        preset: 'loop',
      }),
      agents: baseAgents,
    });
    expect(result.agents).toEqual(baseAgents);
    expect(result.warnings.join('\n')).toMatch(/extends itself/);
  });
});

describe('AC4: the preset reaches the pipeline resolution point', () => {
  it('overrides developer and tester model/harness that pipeline.ts reads', () => {
    const result = resolveAgentPreset({
      global: layer('global', {
        presets: {
          cheap: {
            agents: {
              developer: { harness: 'opencode', agent: 'builder', model: 'opencode/glm-5.3-flash-free' },
              tester: { harness: 'opencode', agent: 'guard', model: 'opencode/glm-5.3-flash-free' },
            },
          },
        },
        preset: 'cheap',
      }),
      agents: {
        developer: { harness: 'fake', model: 'premium/model' },
        tester: { harness: 'fake' },
        captain: { harness: 'fake' },
      },
    });
    // pipeline.ts resolves agents.<role>.{harness,agent,model} from these values.
    expect(result.agents.developer).toEqual({
      harness: 'opencode',
      agent: 'builder',
      model: 'opencode/glm-5.3-flash-free',
    });
    expect(result.agents.tester.harness).toBe('opencode');
    expect(result.agents.captain).toEqual({ harness: 'fake' });
  });
});

describe('project config accepts and validates preset keys', () => {
  it('reads preset and presets from .crew/config.yaml', () => {
    const dir = tempProjectDir(
      [
        'preset: cheap',
        'presets:',
        '  cheap:',
        '    extends: base',
        '    agents:',
        '      developer:',
        '        model: x/model',
      ].join('\n'),
    );
    const config = readProjectConfig(dir);
    expect(config?.preset).toBe('cheap');
    expect(config?.presets?.cheap).toEqual({
      extends: 'base',
      agents: { developer: { model: 'x/model' } },
    });
    cleanupAll();
  });

  it('rejects a non-string preset', () => {
    const dir = tempProjectDir('preset: [1, 2]\n');
    expect(() => readProjectConfig(dir)).toThrow(/preset must be a string/);
    cleanupAll();
  });

  it('rejects a non-map presets block', () => {
    const dir = tempProjectDir('presets: [1, 2]\n');
    expect(() => readProjectConfig(dir)).toThrow(/presets must be a map/);
    cleanupAll();
  });
});
