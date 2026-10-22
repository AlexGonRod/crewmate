import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { stringify } from 'yaml';
import { CrewError } from '../core/errors';
import {
  detectDefaultBranch,
  detectForge,
  detectRemoteUrl,
  resolveRepoRoot,
} from '../git/git';
import { readProjectConfig, projectConfigPath } from '../config/config';
import type { Project } from '../core/types';
import type { Store } from '../store/store';
import { detectVerifyCommands } from './intake';

export interface InitProjectResult {
  rootPath: string;
  configPath: string;
  name: string;
  defaultBranch: string;
  verify: string[];
}

export function initProject(cwd: string, force = false): InitProjectResult {
  const rootPath = resolveRepoRoot(cwd);
  const configPath = projectConfigPath(rootPath);
  if (existsSync(configPath) && !force) {
    throw new CrewError(
      'PROJECT_CONFIG_EXISTS',
      `${configPath} already exists. Use --force to overwrite it.`,
    );
  }

  const name = path.basename(rootPath);
  const defaultBranch = detectDefaultBranch(rootPath);
  const verify = detectVerifyCommands(rootPath).commands;
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(
    configPath,
    stringify(
      {
        schema: 'crew.project/v1',
        name,
        default_branch: defaultBranch,
        methodology: 'spec',
        verify,
      },
      { lineWidth: 0 },
    ),
  );

  return { rootPath, configPath, name, defaultBranch, verify };
}

export function addProject(store: Store, inputPath: string, nameOption?: string): Project {
  const rootPath = resolveRepoRoot(path.resolve(inputPath));
  const projectConfig = readProjectConfig(rootPath);
  const name = nameOption ?? projectConfig?.name ?? path.basename(rootPath);
  const defaultBranch =
    projectConfig?.default_branch ?? detectDefaultBranch(rootPath);
  const remoteUrl = detectRemoteUrl(rootPath);
  const forge = detectForge(remoteUrl);

  return store.createProject({
    name,
    rootPath,
    defaultBranch,
    remoteUrl,
    forge,
  });
}
