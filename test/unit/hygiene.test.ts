import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  abortHygieneScan,
  hygieneFeedback,
  hygienePathRegex,
  scanCommitHygiene,
} from '../../src/verify/hygiene';

const dirs: string[] = [];

function createRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'crew-hygiene-'));
  dirs.push(dir);
  const run = (args: string[]) =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  run(['init', '-b', 'main']);
  run(['config', 'user.email', 'crew@test']);
  run(['config', 'user.name', 'crew']);
  writeFileSync(path.join(dir, 'README.md'), 'crew\n');
  run(['add', '.']);
  run(['commit', '-m', 'initial']);
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('hygienePathRegex', () => {
  it('matches basename patterns anywhere and path patterns at the root', () => {
    expect(hygienePathRegex('.env').test('.env')).toBe(true);
    expect(hygienePathRegex('.env').test('src/.env')).toBe(true);
    expect(hygienePathRegex('.env').test('.env.example')).toBe(false);
    expect(hygienePathRegex('.env.*').test('config/.env.test')).toBe(true);
    expect(hygienePathRegex('*.pem').test('certs/server.pem')).toBe(true);
    expect(hygienePathRegex('id_rsa*').test('keys/id_rsa_backup')).toBe(true);
    expect(hygienePathRegex('secrets/').test('app/secrets/token.yml')).toBe(true);
    expect(hygienePathRegex('secrets/').test('secret.txt')).toBe(false);
    expect(hygienePathRegex('__pycache__/').test('app/__pycache__/x.pyc')).toBe(true);
    expect(hygienePathRegex('src/plumbing/**').test('src/plumbing/deep/x')).toBe(true);
    expect(hygienePathRegex('src/plumbing/**').test('app/src/plumbing/deep/x')).toBe(false);
  });
});

describe('scanCommitHygiene', () => {
  it('flags forbidden paths and secrets in new files, without quoting them', () => {
    const repo = createRepo();
    writeFileSync(path.join(repo, '.env'), 'DEBUG=true\nAKIAABCDEFGHIJKLMNOP\n');
    mkdirSync(path.join(repo, '__pycache__'), { recursive: true });
    writeFileSync(path.join(repo, '__pycache__', 'app.pyc'), 'binary-ish\n');
    writeFileSync(
      path.join(repo, 'notes.txt'),
      'token ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n',
    );

    const findings = scanCommitHygiene({ cwd: repo });
    const reasonsFor = (file: string) =>
      findings.filter((finding) => finding.file === file).map((finding) => finding.reason);
    expect(reasonsFor('.env')).toContain('forbidden path (.env)');
    expect(reasonsFor('.env')).toContain('AWS access key id in an added line');
    expect(reasonsFor('__pycache__/app.pyc')).toEqual([
      'forbidden path (__pycache__/)',
    ]);
    expect(reasonsFor('notes.txt')).toEqual(['GitHub token in an added line']);
    abortHygieneScan(repo);
  });

  it('flags secrets in the added lines of the staged diff', () => {
    const repo = createRepo();
    writeFileSync(path.join(repo, 'config.yml'), 'setting: plain\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'base file', '-q');

    writeFileSync(path.join(repo, 'config.yml'), 'setting: plain\nkey: xoxb-abcdefghij-1234567890\n');
    const findings = scanCommitHygiene({ cwd: repo });
    const flagged = findings.find((finding) => finding.file === 'config.yml');
    expect(flagged?.reason).toBe('Slack token in an added line');
    abortHygieneScan(repo);
  });

  it('stays silent for clean changes and honours extra and disabled patterns', () => {
    const repo = createRepo();
    writeFileSync(path.join(repo, 'hello.txt'), 'clean line\n');
    const findings = scanCommitHygiene({
      cwd: repo,
      extraBlockedPaths: ['internal/**'],
    });
    expect(findings).toEqual([]);
    abortHygieneScan(repo);

    mkdirSync(path.join(repo, 'internal'), { recursive: true });
    writeFileSync(path.join(repo, 'internal/note.txt'), 'internal only\n');
    const flagged = scanCommitHygiene({ cwd: repo, extraBlockedPaths: ['internal/**'] });
    expect(flagged).toEqual([
      { file: 'internal/note.txt', reason: 'forbidden path (internal/**)' },
    ]);
    abortHygieneScan(repo);

    writeFileSync(
      path.join(repo, 'token.yml'),
      'pat: github_pat_ThisIsAVeryLongTokenString123456\n',
    );
    const withoutDefaults = scanCommitHygiene({
      cwd: repo,
      disableDefaultPatterns: true,
    });
    expect(withoutDefaults).toEqual([]);
    abortHygieneScan(repo);
  });

  it('shows the findings in the feedback without echoing the secret', () => {
    const text = hygieneFeedback([
      { file: '.env', reason: 'forbidden path (.env)' },
      { file: 'config.yml', reason: 'Slack token in an added line' },
    ]);
    expect(text).toContain('.env: forbidden path (.env)');
    expect(text).toContain('config.yml: Slack token in an added line');
    expect(text).toContain('hygiene gate');
  });
});
