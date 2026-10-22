import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverSkills, findProjectRoot, skillRoots } from '../../src/app/skills';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'crew-skills-'));
  dirs.push(dir);
  return dir;
}

function writeSkill(
  root: string,
  name: string,
  description: string,
  options: { broken?: boolean } = {},
): void {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  if (options.broken) {
    writeFileSync(path.join(dir, 'SKILL.md'), 'no frontmatter here\n', 'utf8');
    return;
  }
  writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
    'utf8',
  );
}

afterEach(() => {
  while (dirs.length > 0) {
    rmSync(dirs.pop() as string, { recursive: true, force: true });
  }
});

describe('skill roots', () => {
  it('looks in the three global and the three project places', () => {
    const roots = skillRoots('/repo');
    expect(roots.global).toHaveLength(3);
    expect(roots.global[0]).toContain(path.join('.config', 'opencode', 'skills'));
    expect(roots.global[1]).toContain(path.join('.claude', 'skills'));
    expect(roots.global[2]).toContain(path.join('.agents', 'skills'));
    expect(roots.project).toHaveLength(3);
    expect(roots.project[0]).toContain(path.join('.opencode', 'skills'));
  });

  it('has no project roots without a project', () => {
    expect(skillRoots(null).project).toEqual([]);
  });
});

describe('discoverSkills', () => {
  it('finds the skills of the project and reads their frontmatter', () => {
    const repo = tempDir();
    writeSkill(path.join(repo, '.opencode', 'skills'), 'astro', 'Astro guide');
    writeSkill(path.join(repo, '.agents', 'skills'), 'review', 'How to review');

    const skills = discoverSkills({ projectRoot: repo });
    expect(skills.map((skill) => skill.name)).toEqual(['astro', 'review']);
    expect(skills[0]?.description).toBe('Astro guide');
    expect(skills[0]?.scope).toBe('project');
  });

  it('ignores a skill without frontmatter', () => {
    const repo = tempDir();
    writeSkill(path.join(repo, '.opencode', 'skills'), 'broken', '', { broken: true });
    expect(discoverSkills({ projectRoot: repo })).toEqual([]);
  });

  it('ignores a dangling symlink', () => {
    const repo = tempDir();
    const skillsDir = path.join(repo, '.opencode', 'skills');
    mkdirSync(skillsDir, { recursive: true });
    symlinkSync(path.join(repo, 'nowhere'), path.join(skillsDir, 'ghost'));
    expect(discoverSkills({ projectRoot: repo })).toEqual([]);
  });

  it('lets the project win over a global skill with the same name', () => {
    const repo = tempDir();
    writeSkill(path.join(repo, '.opencode', 'skills'), 'shared', 'the project one');
    const skills = discoverSkills({ projectRoot: repo });
    const shared = skills.find((skill) => skill.name === 'shared');
    expect(shared?.scope).toBe('project');
  });

  it('returns an empty list when there is nothing', () => {
    expect(discoverSkills({ projectRoot: tempDir() })).toEqual([]);
  });
});

describe('findProjectRoot', () => {
  it('finds the repository root from a nested directory', () => {
    const repo = tempDir();
    mkdirSync(path.join(repo, '.git'), { recursive: true });
    const nested = path.join(repo, 'src', 'deep');
    mkdirSync(nested, { recursive: true });
    expect(findProjectRoot(nested)).toBe(repo);
  });

  it('stops at the first directory that looks like a project', () => {
    const repo = tempDir();
    mkdirSync(path.join(repo, '.opencode', 'skills'), { recursive: true });
    const nested = path.join(repo, 'src');
    mkdirSync(nested, { recursive: true });
    expect(findProjectRoot(nested)).toBe(repo);
  });
});
