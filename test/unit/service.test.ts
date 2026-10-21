import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildServiceDefinition,
  detectServiceManager,
  installService,
  LAUNCHD_LABEL,
  readLogTail,
  renderLaunchdPlist,
  renderSystemdUnit,
  resolveCrewCommand,
  serviceEnvironment,
  serviceStatus,
  uninstallService,
  type CommandRunner,
} from '../../src/app/service';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'crew-service-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

const OPTIONS = {
  command: ['/usr/bin/node', '/opt/crew/dist/crew.js', 'daemon', 'run', '--json'],
  env: {
    CREW_DATA_DIR: '/data',
    CREW_STATE_DIR: '/state',
    CREW_DB_PATH: '/state/crew.db',
  },
  workDir: '/data',
  logDir: '/data/logs',
};

describe('service manager detection', () => {
  it('detects launchd on macOS and systemd on Linux', () => {
    expect(detectServiceManager('darwin')).toBe('launchd');
    expect(detectServiceManager('linux')).toBe('systemd');
    expect(detectServiceManager('win32')).toBeNull();
  });
});

describe('unit files', () => {
  it('renders a launchd plist with the command, environment and logs', () => {
    const plist = renderLaunchdPlist(OPTIONS, LAUNCHD_LABEL);
    expect(plist).toContain(`<key>Label</key>\n  <string>${LAUNCHD_LABEL}</string>`);
    expect(plist).toContain('<string>/opt/crew/dist/crew.js</string>');
    expect(plist).toContain('<string>daemon</string>');
    expect(plist).toContain('<key>RunAtLoad</key>\n  <true/>');
    expect(plist).toContain('<key>KeepAlive</key>\n  <true/>');
    expect(plist).toContain('<key>CREW_DATA_DIR</key>');
    expect(plist).toContain('<string>/data/logs/daemon.log</string>');
  });

  it('escapes xml special characters in the launchd plist', () => {
    const plist = renderLaunchdPlist(
      { ...OPTIONS, env: { CREW_TITLE: 'a & b <c>' } },
      LAUNCHD_LABEL,
    );
    expect(plist).toContain('a &amp; b &lt;c&gt;');
    expect(plist).not.toContain('a & b <c>');
  });

  it('renders a systemd unit with restart policy and the same environment', () => {
    const unit = renderSystemdUnit(OPTIONS);
    expect(unit).toContain('ExecStart=/usr/bin/node /opt/crew/dist/crew.js daemon run --json');
    expect(unit).toContain('Environment="CREW_DATA_DIR=/data"');
    expect(unit).toContain('Restart=always');
    expect(unit).toContain('WantedBy=default.target');
    expect(unit).toContain('StandardOutput=append:/data/logs/daemon.log');
  });

  it('escapes quotes in the systemd environment values', () => {
    const unit = renderSystemdUnit({
      ...OPTIONS,
      env: { CREW_TITLE: 'say "hi"' },
    });
    expect(unit).toContain('Environment="CREW_TITLE=say \\"hi\\""');
  });
});

describe('service definition', () => {
  it('targets the user launch agent on macOS', () => {
    const definition = buildServiceDefinition(OPTIONS, 'launchd', '/home/dev', 501);
    expect(definition.unitPath).toBe(
      '/home/dev/Library/LaunchAgents/com.crewmate.daemon.plist',
    );
    expect(definition.install.map((command) => command.join(' '))).toEqual([
      'launchctl bootout gui/501/com.crewmate.daemon',
      'launchctl bootstrap gui/501 /home/dev/Library/LaunchAgents/com.crewmate.daemon.plist',
      'launchctl enable gui/501/com.crewmate.daemon',
    ]);
  });

  it('targets the systemd user unit on Linux', () => {
    const definition = buildServiceDefinition(OPTIONS, 'systemd', '/home/dev');
    expect(definition.unitPath).toBe('/home/dev/.config/systemd/user/crewmate.service');
    expect(definition.install.map((command) => command.join(' '))).toEqual([
      'systemctl --user daemon-reload',
      'systemctl --user enable --now crewmate.service',
    ]);
  });
});

describe('install, status and uninstall', () => {
  it('writes the unit file and loads it', () => {
    const dir = tempDir();
    const definition = buildServiceDefinition(
      { ...OPTIONS, logDir: path.join(dir, 'logs') },
      'launchd',
      dir,
      501,
    );
    const calls: string[][] = [];
    const runner: CommandRunner = (command) => {
      calls.push(command);
      return { status: 0, stdout: '', stderr: '' };
    };

    const result = installService(definition, runner);
    expect(result.installed).toBe(true);
    expect(readFileSync(result.unitPath, 'utf8')).toContain(LAUNCHD_LABEL);
    expect(calls).toHaveLength(3);
    expect(calls[1]?.[0]).toBe('launchctl');
  });

  it('reports a running service with its pid', () => {
    const dir = tempDir();
    const definition = buildServiceDefinition(
      { ...OPTIONS, logDir: path.join(dir, 'logs') },
      'launchd',
      dir,
      501,
    );
    installService(definition, () => ({ status: 0, stdout: '', stderr: '' }));

    const status = serviceStatus(definition, () => ({
      status: 0,
      stdout: 'state = running\npid = 4242\n',
      stderr: '',
    }));
    expect(status.running).toBe(true);
    expect(status.pid).toBe(4242);
    expect(status.state).toBe('running');
    expect(status.installed).toBe(true);
  });

  it('reports a service that is installed but not loaded', () => {
    const dir = tempDir();
    const definition = buildServiceDefinition(
      { ...OPTIONS, logDir: path.join(dir, 'logs') },
      'launchd',
      dir,
      501,
    );
    installService(definition, () => ({ status: 0, stdout: '', stderr: '' }));

    const status = serviceStatus(definition, () => ({
      status: 113,
      stdout: '',
      stderr: 'Could not find service',
    }));
    expect(status.running).toBe(false);
    expect(status.installed).toBe(true);
    expect(status.state).toBe('installed but not loaded');
  });

  it('removes the unit file and unloads the service', () => {
    const dir = tempDir();
    const definition = buildServiceDefinition(
      { ...OPTIONS, logDir: path.join(dir, 'logs') },
      'launchd',
      dir,
      501,
    );
    installService(definition, () => ({ status: 0, stdout: '', stderr: '' }));

    const calls: string[][] = [];
    const result = uninstallService(definition, (command) => {
      calls.push(command);
      return { status: 0, stdout: '', stderr: '' };
    });
    expect(result.removed).toBe(true);
    expect(calls[0]).toEqual(['launchctl', 'bootout', 'gui/501/com.crewmate.daemon']);
    expect(() => readFileSync(definition.unitPath, 'utf8')).toThrow();
  });

  it('tolerates a failed unload when uninstalling', () => {
    const dir = tempDir();
    const definition = buildServiceDefinition(
      { ...OPTIONS, logDir: path.join(dir, 'logs') },
      'launchd',
      dir,
      501,
    );
    const result = uninstallService(definition, () => ({
      status: 1,
      stdout: '',
      stderr: 'not loaded',
    }));
    expect(result.removed).toBe(false);
  });
});

describe('logs', () => {
  it('returns the last lines of the log', () => {
    const dir = tempDir();
    const file = path.join(dir, 'daemon.log');
    writeFileSync(file, 'one\ntwo\nthree\n', 'utf8');
    expect(readLogTail(file, 2)).toEqual(['two', 'three']);
    expect(readLogTail(path.join(dir, 'missing.log'), 5)).toEqual([]);
  });
});

describe('service environment', () => {
  it('pins the crew paths so the service uses the same state', () => {
    const env = serviceEnvironment(
      {
        configDir: '/config',
        dataDir: '/data',
        stateDir: '/state',
        dbPath: '/state/crew.db',
      },
      { CREW_DATA_DIR: '/ignored' },
    );
    expect(env.CREW_DATA_DIR).toBe('/data');
    expect(env.CREW_CONFIG_DIR).toBe('/config');
    expect(env.CREW_STATE_DIR).toBe('/state');
    expect(env.CREW_DB_PATH).toBe('/state/crew.db');
  });
});

describe('crew command resolution', () => {
  it('uses the compiled CLI when it is the entry point', () => {
    const dir = tempDir();
    const script = path.join(dir, 'crew.js');
    writeFileSync(script, '// crew', 'utf8');
    const command = resolveCrewCommand(['node', script], {});
    expect(command[0]).toBe(process.execPath);
    expect(command[1]).toBe(script);
  });

  it('falls back to the crew binary on the PATH', () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, 'crew'), '#!/usr/bin/env node', 'utf8');
    const command = resolveCrewCommand(['node', '/nonexistent/main.ts'], {
      PATH: dir,
    });
    expect(command[1]).toBe(path.join(dir, 'crew'));
  });

  it('fails when no entry point can be found', () => {
    expect(() => resolveCrewCommand(['node', '/nonexistent/main.ts'], { PATH: '' })).toThrow(
      /Could not find the crew CLI/,
    );
  });
});
