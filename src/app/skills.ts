import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';

export interface DiscoveredSkill {
  name: string;
  description: string;
  /** Absolute path of the SKILL.md file. */
  path: string;
  scope: 'project' | 'global';
  /** The root directory the skill was found in. */
  source: string;
}

export interface SkillRoots {
  project: string[];
  global: string[];
}

/**
 * The places an agent looks for skills.
 *
 * Global: ~/.config/opencode/skills, ~/.claude/skills, ~/.agents/skills.
 * Project: <root>/.opencode/skills, <root>/.claude/skills, <root>/.agents/skills.
 */
export function skillRoots(projectRoot?: string | null): SkillRoots {
  const home = homedir();
  const global = [
    path.join(home, '.config', 'opencode', 'skills'),
    path.join(home, '.claude', 'skills'),
    path.join(home, '.agents', 'skills'),
  ];
  const project = projectRoot
    ? [
        path.join(projectRoot, '.opencode', 'skills'),
        path.join(projectRoot, '.claude', 'skills'),
        path.join(projectRoot, '.agents', 'skills'),
      ]
    : [];
  return { project, global };
}

function readFrontmatter(filePath: string): { name?: string; description?: string } {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch {
    return {};
  }
  if (!content.startsWith('---')) {
    return {};
  }
  const end = content.indexOf('\n---', 3);
  if (end === -1) {
    return {};
  }
  try {
    const parsed = parse(content.slice(3, end)) as {
      name?: unknown;
      description?: unknown;
    } | null;
    if (!parsed || typeof parsed !== 'object') {
      return {};
    }
    return {
      name: typeof parsed.name === 'string' ? parsed.name : undefined,
      description:
        typeof parsed.description === 'string' ? parsed.description : undefined,
    };
  } catch {
    return {};
  }
}

function readSkillDirectory(
  root: string,
  scope: 'project' | 'global',
): DiscoveredSkill[] {
  if (!existsSync(root)) {
    return [];
  }
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const skills: DiscoveredSkill[] = [];
  for (const entry of entries) {
    const skillDir = path.join(root, entry);
    try {
      // A dangling symlink is not a skill.
      if (!statSync(skillDir).isDirectory()) {
        continue;
      }
    } catch {
      continue;
    }
    const file = path.join(skillDir, 'SKILL.md');
    if (!existsSync(file)) {
      continue;
    }
    const frontmatter = readFrontmatter(file);
    const name = frontmatter.name ?? entry;
    if (!name || !frontmatter.description) {
      continue;
    }
    skills.push({
      name,
      description: frontmatter.description,
      path: file,
      scope,
      source: root,
    });
  }
  return skills;
}

/**
 * Discovers the skills an agent can load. The project wins over the global
 * ones with the same name.
 */
export function discoverSkills(
  options: { projectRoot?: string | null } = {},
): DiscoveredSkill[] {
  const roots = skillRoots(options.projectRoot);
  const found = new Map<string, DiscoveredSkill>();
  for (const root of roots.global) {
    for (const skill of readSkillDirectory(root, 'global')) {
      if (!found.has(skill.name)) {
        found.set(skill.name, skill);
      }
    }
  }
  for (const root of roots.project) {
    for (const skill of readSkillDirectory(root, 'project')) {
      found.set(skill.name, skill);
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Walks up from a directory to find the repository root, so the project
 * skills of the repository the user is standing in are found.
 */
export function findProjectRoot(startDir: string = process.cwd()): string | null {
  let current = path.resolve(startDir);
  for (;;) {
    if (
      existsSync(path.join(current, '.opencode', 'skills')) ||
      existsSync(path.join(current, '.claude', 'skills')) ||
      existsSync(path.join(current, '.agents', 'skills')) ||
      existsSync(path.join(current, '.git'))
    ) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}
