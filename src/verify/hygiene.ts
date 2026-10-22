import { gitOrThrow } from '../git/git';

export interface HygieneFinding {
  file: string;
  reason: string;
}

export interface ScanCommitHygieneOptions {
  cwd: string;
  extraBlockedPaths?: string[];
  disableDefaultPatterns?: boolean;
}

/**
 * Paths that never belong in a delivered change. The list is conservative:
 * credentials and generated artifacts that leak from verification runs.
 */
const DEFAULT_BLOCKED_PATHS = [
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  'id_rsa*',
  'id_ecdsa*',
  'id_ed25519*',
  'secrets/',
  '__pycache__/',
  '*.pyc',
  'node_modules/',
  '.venv/',
  'venv/',
];

/**
 * Secret shapes worth a deterministic gate. Findings report the shape, never
 * the matched content: secrets must not end up in logs or reports.
 */
const DEFAULT_SECRET_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'AWS access key id', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  {
    name: 'GitHub token',
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/,
  },
  {
    name: 'private key block',
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/,
  },
  { name: 'Slack token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'Stripe key', pattern: /\b(?:sk|rk)_(?:live|test)_[0-9a-zA-Z]{16,}\b/ },
];

/** gitignore-like glob to regex: a basename matches anywhere, a path anchors to the root. */
export function hygienePathRegex(glob: string): RegExp {
  const isDir = glob.endsWith('/');
  const base = isDir ? glob.slice(0, -1) : glob;
  const escaped = base
    .split('**')
    .map((segment) =>
      segment
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '[^/]'),
    )
    .join('.*');
  const left = base.includes('/') ? '^' : '(?:^|/)';
  const right = isDir ? '(?:/|$)' : '$';
  return new RegExp(`${left}${escaped}${right}`);
}

function fileAgainstBlockedPaths(
  file: string,
  blockedPaths: string[],
): HygieneFinding[] {
  const findings: HygieneFinding[] = [];
  for (const blocked of blockedPaths) {
    if (hygienePathRegex(blocked).test(file)) {
      findings.push({ file, reason: `forbidden path (${blocked})` });
      break;
    }
  }
  return findings;
}

function addedLinesOfStagedDiff(diff: string): Map<string, string[]> {
  const added = new Map<string, string[]>();
  let current = '';
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      current = '';
      continue;
    }
    if (line.startsWith('+++ b/')) {
      current = line.slice(6);
      continue;
    }
    if (line.startsWith('+++ ')) {
      current = line.slice(4).replace(/^"(?:.*\/)?/, '').replace(/"$/, '');
      continue;
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      const list = added.get(current) ?? [];
      list.push(line.slice(1));
      added.set(current, list);
    }
  }
  return added;
}

/**
 * Inspect what the next commit would include. This stages the worktree
 * (`git add -A`), like the commit stage does: call it right before delivering.
 * Findings name forbidden paths and secret shapes; they never quote the
 * matched content.
 */
export function scanCommitHygiene(
  options: ScanCommitHygieneOptions,
): HygieneFinding[] {
  gitOrThrow(['add', '-A'], options.cwd);
  const changed = gitOrThrow(
    ['diff', '--cached', '--name-only', '--diff-filter=AM'],
    options.cwd,
  );
  const files = changed
    .split('\n')
    .map((file) => file.trim())
    .filter((file) => file.length > 0);
  if (files.length === 0) {
    return [];
  }

  const blockedPaths = options.disableDefaultPatterns
    ? (options.extraBlockedPaths ?? [])
    : [...DEFAULT_BLOCKED_PATHS, ...(options.extraBlockedPaths ?? [])];
  const findings: HygieneFinding[] = [];
  for (const file of files) {
    findings.push(...fileAgainstBlockedPaths(file, blockedPaths));
  }

  if (!options.disableDefaultPatterns) {
    const diff = gitOrThrow(['diff', '--cached', '--unified=0'], options.cwd);
    const added = addedLinesOfStagedDiff(diff);
    for (const [file, lines] of added) {
      for (const pattern of DEFAULT_SECRET_PATTERNS) {
        if (lines.some((line) => pattern.pattern.test(line))) {
          findings.push({ file, reason: `${pattern.name} in an added line` });
          break;
        }
      }
    }
  }

  return findings;
}

/** Leave the index as it was: the rejection must not half-stage anything. */
export function abortHygieneScan(cwd: string): void {
  gitOrThrow(['reset', '-q'], cwd);
}

export function hygieneFeedback(findings: HygieneFinding[]): string {
  const lines = findings.map((finding) => `- ${finding.file}: ${finding.reason}`);
  return [
    'Commit hygiene gate blocked the delivery:',
    ...lines,
    'Remove the forbidden files and the generated artifacts from the change.',
  ].join('\n');
}
