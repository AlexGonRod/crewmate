import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { stringify } from 'yaml';
import { projectConfigPath } from '../config/config';
import { CrewError } from '../core/errors';
import { detectDefaultBranch, detectForge, detectRemoteUrl } from '../git/git';
import type { Project } from '../core/types';
import type { Store } from '../store/store';

export interface RepoRef {
  owner: string;
  name: string;
  slug: string;
  cloneUrl: string;
}

const GITHUB_URL = /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i;
const GITHUB_SSH = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i;
const GITHUB_SHORT = /^([\w.-]+)\/([\w.-]+)$/;

export function parseRepoRef(input: string): RepoRef {
  const value = input.trim();
  let match = GITHUB_URL.exec(value) ?? GITHUB_SSH.exec(value);
  if (!match) {
    match = GITHUB_SHORT.exec(value);
  }
  if (!match) {
    throw new CrewError(
      'REPO_URL_INVALID',
      `Cannot parse a GitHub repository from: ${input}`,
    );
  }
  const owner = match[1] as string;
  const name = match[2] as string;
  return {
    owner,
    name,
    slug: `${owner}-${name}`,
    cloneUrl: `https://github.com/${owner}/${name}.git`,
  };
}

function run(command: string, args: string[], cwd?: string): { ok: boolean; output: string } {
  try {
    const output = execFileSync(command, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, output };
  } catch {
    return { ok: false, output: '' };
  }
}

export function checkRepoAccess(cloneUrl: string): { accessible: boolean; error?: string } {
  const result = run('git', ['ls-remote', '--heads', cloneUrl]);
  return result.ok
    ? { accessible: true }
    : { accessible: false, error: `Cannot reach ${cloneUrl}` };
}

export function cloneRepository(cloneUrl: string, destination: string): string {
  if (existsSync(destination)) {
    throw new CrewError(
      'CLONE_TARGET_EXISTS',
      `${destination} already exists; remove it or choose another --dir`,
    );
  }
  mkdirSync(path.dirname(destination), { recursive: true });
  const result = run('git', ['clone', cloneUrl, destination]);
  if (!result.ok) {
    throw new CrewError('CLONE_FAILED', `Failed to clone ${cloneUrl}`);
  }
  return destination;
}

export function binaryExists(binary: string): boolean {
  const entries = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const entry of entries) {
    for (const extension of extensions) {
      const candidate = path.join(entry, `${binary}${extension}`);
      if (existsSync(candidate)) {
        return true;
      }
    }
  }
  return false;
}

export interface VerifyDetection {
  commands: string[];
  packageManager: string | null;
  language: string | null;
}

function readJson(filePath: string): Record<string, unknown> | null {
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function detectVerifyCommands(rootPath: string): VerifyDetection {
  const commands: string[] = [];
  let packageManager: string | null = null;
  let language: string | null = null;

  if (existsSync(path.join(rootPath, 'pnpm-lock.yaml'))) {
    packageManager = 'pnpm';
  } else if (existsSync(path.join(rootPath, 'yarn.lock'))) {
    packageManager = 'yarn';
  } else if (existsSync(path.join(rootPath, 'package-lock.json'))) {
    packageManager = 'npm';
  }

  const packageJson = readJson(path.join(rootPath, 'package.json'));
  if (packageJson) {
    language = 'node';
    const scripts = (packageJson.scripts ?? {}) as Record<string, string>;
    const manager = packageManager ?? 'npm';
    if (typeof scripts.test === 'string') {
      commands.push(`${manager} test`);
    }
    if (typeof scripts.typecheck === 'string') {
      commands.push(`${manager} run typecheck`);
    } else if (typeof scripts['type-check'] === 'string') {
      commands.push(`${manager} run type-check`);
    }
  }

  if (existsSync(path.join(rootPath, 'Cargo.toml'))) {
    language = 'rust';
    commands.push('cargo test');
  }

  if (existsSync(path.join(rootPath, 'go.mod'))) {
    language = language ?? 'go';
    commands.push('go test ./...');
  }

  if (existsSync(path.join(rootPath, 'pyproject.toml'))) {
    language = language ?? 'python';
    commands.push('python -m pytest');
  }

  const makefile = path.join(rootPath, 'Makefile');
  if (existsSync(makefile)) {
    const content = readFileSync(makefile, 'utf8');
    if (/^test:/m.test(content)) {
      commands.push('make test');
    }
  }

  return { commands: [...new Set(commands)], packageManager, language };
}

export interface ConsentItem {
  action: string;
  command: string | null;
  reason: string;
}

export function detectConsentItems(rootPath: string): ConsentItem[] {
  const items: ConsentItem[] = [];
  const detection = detectVerifyCommands(rootPath);

  const toolchain: Record<string, string> = {
    node: 'Node.js',
    pnpm: 'pnpm',
    yarn: 'yarn',
    npm: 'npm',
    cargo: 'Rust toolchain',
    go: 'Go toolchain',
    python3: 'Python 3',
  };
  const required: string[] = [];
  if (detection.language === 'node') {
    required.push('node');
    if (detection.packageManager) {
      required.push(detection.packageManager);
    }
  } else if (detection.language === 'rust') {
    required.push('cargo');
  } else if (detection.language === 'go') {
    required.push('go');
  } else if (detection.language === 'python') {
    required.push('python3');
  }

  for (const binary of required) {
    if (!binaryExists(binary)) {
      items.push({
        action: 'install_toolchain',
        command: null,
        reason: `${toolchain[binary] ?? binary} is not available in PATH`,
      });
    }
  }

  if (
    detection.language === 'node' &&
    !existsSync(path.join(rootPath, 'node_modules'))
  ) {
    const manager = detection.packageManager ?? 'npm';
    items.push({
      action: 'install_dependencies',
      command: `${manager} install`,
      reason: 'node_modules is missing',
    });
  }

  return items;
}

export interface IntakeResult {
  project: Project;
  clone: {
    url: string;
    path: string;
    defaultBranch: string;
    forge: string | null;
  };
  config: {
    path: string;
    verify: string[];
    created: boolean;
  };
  consent: ConsentItem[];
}

export interface IntakeOptions {
  url: string;
  projectsDir: string;
  name?: string;
  dir?: string;
  register?: boolean;
  clone?: (cloneUrl: string, destination: string) => string;
  checkAccess?: (cloneUrl: string) => { accessible: boolean; error?: string };
}

export function intakeProject(store: Store, options: IntakeOptions): IntakeResult {
  const ref = parseRepoRef(options.url);
  const access = (options.checkAccess ?? checkRepoAccess)(ref.cloneUrl);
  if (!access.accessible) {
    throw new CrewError(
      'REPO_NOT_ACCESSIBLE',
      access.error ?? `Cannot reach ${ref.cloneUrl}`,
    );
  }

  const destination = options.dir
    ? path.resolve(options.dir)
    : path.join(options.projectsDir, ref.slug);
  (options.clone ?? cloneRepository)(ref.cloneUrl, destination);

  const remoteUrl = detectRemoteUrl(destination);
  const defaultBranch = detectDefaultBranch(destination);
  const forge = detectForge(remoteUrl) ?? 'github';

  const detection = detectVerifyCommands(destination);
  const configPath = projectConfigPath(destination);
  const created = !existsSync(configPath);
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(
    configPath,
    stringify(
      {
        schema: 'crew.project/v1',
        name: options.name ?? ref.name,
        default_branch: defaultBranch,
        methodology: 'spec',
        verify: detection.commands,
      },
      { lineWidth: 0 },
    ),
    'utf8',
  );

  const project = store.createProject({
    name: options.name ?? ref.name,
    rootPath: destination,
    defaultBranch,
    remoteUrl,
    forge,
  });

  return {
    project,
    clone: {
      url: ref.cloneUrl,
      path: destination,
      defaultBranch,
      forge,
    },
    config: {
      path: configPath,
      verify: detection.commands,
      created,
    },
    consent: detectConsentItems(destination),
  };
}
