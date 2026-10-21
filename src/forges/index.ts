import { CrewError } from '../core/errors';
import { GithubForge } from './github';
import { GitlabForge } from './gitlab';
import type { Forge } from './types';

const FORGES: Record<string, () => Forge> = {
  github: () => new GithubForge(),
  gitlab: () => new GitlabForge(),
};

export function getForge(id: string | null | undefined): Forge {
  const key = (id ?? 'github').toLowerCase();
  const factory = FORGES[key];
  if (!factory) {
    throw new CrewError(
      'FORGE_UNSUPPORTED',
      `Forge "${id}" is not supported; available forges: ${Object.keys(FORGES).join(', ')}`,
    );
  }
  return factory();
}

export function supportedForges(): string[] {
  return Object.keys(FORGES);
}
