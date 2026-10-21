import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const TSX = path.join(ROOT, 'node_modules', '.bin', 'tsx');
const CLI = path.join(ROOT, 'src', 'cli', 'main.ts');

interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
  json: any;
}

describe('crew service', () => {
  let tempRoot: string;
  let env: Record<string, string>;

  function cli(args: string[]): CliResult {
    const result = spawnSync(TSX, [CLI, ...args], {
      cwd: tempRoot,
      env: { ...process.env, ...env, NO_COLOR: '1', FORCE_COLOR: '0' },
      encoding: 'utf8',
      timeout: 60_000,
    });
    if (result.error) {
      throw result.error;
    }
    const stdout = result.stdout ?? '';
    let json: any = null;
    try {
      json = JSON.parse(stdout);
    } catch {
      json = null;
    }
    return { status: result.status ?? 1, stdout, stderr: result.stderr ?? '', json };
  }

  beforeAll(() => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'crew-service-'));
    const bin = path.join(tempRoot, 'bin');
    const home = path.join(tempRoot, 'home');
    mkdirSync(bin, { recursive: true });
    mkdirSync(home, { recursive: true });
    // Fake launchd and systemd: the real ones would unload the service of
    // whoever is running the tests.
    for (const name of ['launchctl', 'systemctl']) {
      const shim = path.join(bin, name);
      writeFileSync(
        shim,
        `#!/bin/sh
echo "$@" >> "$CREW_FAKE_SERVICE_LOG"
exit 0
`,
      );
      chmodSync(shim, 0o755);
    }
    env = {
      CREW_CONFIG_DIR: path.join(tempRoot, 'config'),
      CREW_DATA_DIR: path.join(tempRoot, 'data'),
      CREW_STATE_DIR: path.join(tempRoot, 'state'),
      // The unit file lives in the home directory: point it at a temporary
      // one so the test never touches the real launch agent or systemd unit.
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, '.config'),
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
      CREW_FAKE_SERVICE_LOG: path.join(tempRoot, 'service.log'),
    };
  });

  afterAll(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('renders the unit file without touching the system', () => {
    const result = cli([
      '--json',
      'service',
      'install',
      '--dry-run',
      '--manager',
      'launchd',
      '--interval',
      '9',
      '--concurrency',
      '2',
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.json.manager).toBe('launchd');
    expect(result.json.unitPath).toContain('com.crewmate.daemon.plist');
    expect(result.json.content).toContain('<string>daemon</string>');
    expect(result.json.content).toContain('<string>--interval</string>');
    expect(result.json.content).toContain('<string>9</string>');
    expect(result.json.content).toContain('<string>--concurrency</string>');
    expect(
      result.json.commands.map((command: string[]) => command.join(' ')).join(' | '),
    ).toContain('launchctl bootstrap');
  });

  it('renders a systemd unit when the manager is forced', () => {
    const result = cli([
      '--json',
      'service',
      'install',
      '--dry-run',
      '--manager',
      'systemd',
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.json.manager).toBe('systemd');
    expect(result.json.unitPath).toContain('crewmate.service');
    expect(result.json.content).toContain('ExecStart=');
    expect(result.json.content).toContain('daemon run');
    expect(result.json.content).toContain('Restart=always');
  });

  it('reports that the service is not installed', () => {
    const result = cli(['--json', 'service', 'status', '--manager', 'launchd']);

    expect(result.status).toBe(1);
    expect(result.json.installed).toBe(false);
    expect(result.json.running).toBe(false);
    expect(result.json.manager).toBe('launchd');
  });

  it('uninstalls the service through the system manager', () => {
    const result = cli(['--json', 'service', 'uninstall', '--manager', 'launchd']);

    expect(result.status, result.stderr).toBe(0);
    const calls = readFileSync(env.CREW_FAKE_SERVICE_LOG as string, 'utf8');
    expect(calls).toContain('bootout');
    expect(calls).toContain('com.crewmate.daemon');
  });

  it('shows the log tail even when the service never ran', () => {
    const result = cli(['--json', 'service', 'logs', '--manager', 'launchd']);

    expect(result.status, result.stderr).toBe(0);
    expect(result.json.path).toContain('daemon.log');
    expect(result.json.lines).toEqual([]);
  });
});
