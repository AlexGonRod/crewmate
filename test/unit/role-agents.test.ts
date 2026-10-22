import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ROLE_CONTRACTS,
  type RoleContract,
  resolveRoleAgents,
  roleAgentsPath,
  roleAgentsTemplate,
  roleContractFor,
} from '../../src/app/role-agents';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'crew-roles-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    rmSync(dirs.pop() as string, { recursive: true, force: true });
  }
});

describe('roleContractFor', () => {
  it('maps the agent role to its contract', () => {
    expect(roleContractFor('developer', 'pr')).toBe('developer');
    expect(roleContractFor('tester', 'pr')).toBe('tester');
  });

  it('maps a scout delivery to the scout contract', () => {
    expect(roleContractFor('developer', 'scout')).toBe('scout');
  });
});

describe('the default contracts', () => {
  it('gives every role hard rules and a definition of done', () => {
    for (const contract of ROLE_CONTRACTS) {
      const content = roleAgentsTemplate(contract);
      expect(content).toContain('# ');
      expect(content).toContain('## Reglas duras, por orden de prioridad');
    }
    for (const contract of ['developer', 'tester', 'scout'] as RoleContract[]) {
      expect(roleAgentsTemplate(contract)).toContain('## Definición de terminado');
    }
  });

  it('gives the captain the contract it has always had', () => {
    const content = roleAgentsTemplate('captain');
    expect(content).toContain('# Captain (crew)');
    expect(content).toContain('## Antes de terminar');
    expect(content).toContain('Nunca fusiones sin la palabra de la persona');
  });

  it('tells the developer not to touch the pipeline', () => {
    const content = roleAgentsTemplate('developer');
    expect(content).toContain('Nunca escribas fuera de tu worktree');
    expect(content).toContain('No toques el pipeline');
    expect(content).toContain('No hagas `push`');
  });

  it('tells the tester to judge and not to fix', () => {
    const content = roleAgentsTemplate('tester');
    expect(content).toContain('Nunca modifiques el código');
    expect(content).toContain('No confíes en el informe del developer');
    expect(content).toContain('Rechaza con un hallazgo bloqueante');
  });

  it('tells the scout to only read', () => {
    const content = roleAgentsTemplate('scout');
    expect(content).toContain('Solo lectura');
    expect(content).toContain('El informe es el entregable');
  });

  it('tells the developer to answer the tester on a review iteration', () => {
    const content = roleAgentsTemplate('developer', {
      reviewIteration: 2,
      methodology: 'tdd',
    });
    expect(content).toContain('iteración de revisión 2');
    expect(content).toContain('Previous messages');
  });

  it('gives the tester the developer report of the run', () => {
    const content = roleAgentsTemplate('tester', {
      reviewIteration: 1,
      methodology: 'tdd',
      developerReportPath: '/tmp/worktree/.crew/reports/dev.json',
    });
    expect(content).toContain('/tmp/worktree/.crew/reports/dev.json');
    expect(content).toContain('Iteración de revisión: 1');
  });
});

describe('resolveRoleAgents', () => {
  it('uses the default when the project has no contract of its own', () => {
    const resolution = resolveRoleAgents('developer', { projectRoot: tempDir() });
    expect(resolution.source).toBe('default');
    expect(resolution.content).toBe(roleAgentsTemplate('developer'));
  });

  it('prefers the contract of the project', () => {
    const root = tempDir();
    const target = roleAgentsPath(root, 'tester');
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, '# Tester (proyecto)\n', 'utf8');
    const resolution = resolveRoleAgents('tester', { projectRoot: root });
    expect(resolution.source).toBe('project');
    expect(resolution.content).toContain('# Tester (proyecto)');
    expect(resolution.path).toBe(target);
  });

  it('works without a project', () => {
    const resolution = resolveRoleAgents('scout');
    expect(resolution.source).toBe('default');
    expect(resolution.path).toBeNull();
  });
});

describe('roleAgentsPath', () => {
  it('lives under .crew/roles', () => {
    expect(roleAgentsPath('/repo', 'developer')).toBe(
      path.join('/repo', '.crew', 'roles', 'developer.md'),
    );
  });
});
