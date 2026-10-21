import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { CrewError } from '../core/errors';

export type ServiceManager = 'launchd' | 'systemd';

export const LAUNCHD_LABEL = 'com.crewmate.daemon';
export const SYSTEMD_UNIT = 'crewmate.service';

export interface ServiceOptions {
  command: string[];
  env: Record<string, string>;
  workDir: string;
  logDir: string;
  label?: string;
}

export interface ServiceDefinition {
  manager: ServiceManager;
  label: string;
  unitPath: string;
  content: string;
  install: string[][];
  uninstall: string[][];
  status: string[][];
  logPath: string;
  errorLogPath: string;
}

export type CommandRunner = (
  command: string[],
  options?: { allowFailure?: boolean },
) => { status: number; stdout: string; stderr: string };

const DEFAULT_ENV_KEYS = [
  'CREW_DATA_DIR',
  'CREW_STATE_DIR',
  'CREW_CONFIG_DIR',
  'CREW_DB_PATH',
];

export function detectServiceManager(platform: string = process.platform): ServiceManager | null {
  if (platform === 'darwin') {
    return 'launchd';
  }
  if (platform === 'linux') {
    return 'systemd';
  }
  return null;
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function systemdEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function serviceEnv(options: ServiceOptions): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(options.env)) {
    if (value) {
      result[key] = value;
    }
  }
  return result;
}

export function renderLaunchdPlist(options: ServiceOptions, label: string): string {
  const env = serviceEnv(options);
  const envEntries = Object.entries(env)
    .map(
      ([key, value]) =>
        `    <key>${xmlEscape(key)}</key>\n    <string>${xmlEscape(value)}</string>`,
    )
    .join('\n');
  const args = options.command
    .map((arg) => `    <string>${xmlEscape(arg)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${envEntries}
  </dict>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(options.workDir)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(path.join(options.logDir, 'daemon.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(path.join(options.logDir, 'daemon.error.log'))}</string>
</dict>
</plist>
`;
}

export function renderSystemdUnit(options: ServiceOptions): string {
  const env = serviceEnv(options);
  const envLines = Object.entries(env)
    .map(([key, value]) => `Environment="${key}=${systemdEscape(value)}"`)
    .join('\n');
  return `[Unit]
Description=Crewmate daemon
After=network-online.target

[Service]
Type=simple
ExecStart=${options.command.map((arg) => (arg.includes(' ') ? `"${arg}"` : arg)).join(' ')}
WorkingDirectory=${options.workDir}
${envLines}
Restart=always
RestartSec=10
StandardOutput=append:${path.join(options.logDir, 'daemon.log')}
StandardError=append:${path.join(options.logDir, 'daemon.error.log')}

[Install]
WantedBy=default.target
`;
}

export function launchdUnitPath(label: string, home: string = homedir()): string {
  return path.join(home, 'Library', 'LaunchAgents', `${label}.plist`);
}

export function systemdUnitPath(home: string = homedir()): string {
  const configHome = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  return path.join(configHome, 'systemd', 'user', SYSTEMD_UNIT);
}

export function buildServiceDefinition(
  options: ServiceOptions,
  manager: ServiceManager,
  home: string = homedir(),
  uid: number = typeof process.getuid === 'function' ? process.getuid() : 501,
): ServiceDefinition {
  const logPath = path.join(options.logDir, 'daemon.log');
  const errorLogPath = path.join(options.logDir, 'daemon.error.log');
  if (manager === 'launchd') {
    const label = options.label ?? LAUNCHD_LABEL;
    return {
      manager,
      label,
      unitPath: launchdUnitPath(label, home),
      content: renderLaunchdPlist(options, label),
      install: [
        ['launchctl', 'bootout', `gui/${uid}/${label}`],
        ['launchctl', 'bootstrap', `gui/${uid}`, launchdUnitPath(label, home)],
        ['launchctl', 'enable', `gui/${uid}/${label}`],
      ],
      uninstall: [['launchctl', 'bootout', `gui/${uid}/${label}`]],
      status: [['launchctl', 'print', `gui/${uid}/${label}`]],
      logPath,
      errorLogPath,
    };
  }
  return {
    manager,
    label: SYSTEMD_UNIT,
    unitPath: systemdUnitPath(home),
    content: renderSystemdUnit(options),
    install: [
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'enable', '--now', SYSTEMD_UNIT],
    ],
    uninstall: [['systemctl', '--user', 'disable', '--now', SYSTEMD_UNIT]],
    status: [['systemctl', '--user', 'is-active', SYSTEMD_UNIT]],
    logPath,
    errorLogPath,
  };
}

export const defaultCommandRunner: CommandRunner = (command, options = {}) => {
  try {
    const [binary, ...args] = command;
    if (!binary) {
      throw new CrewError('SERVICE_COMMAND_FAILED', 'Empty service command');
    }
    const stdout = execFileSync(binary, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout: stdout ?? '', stderr: '' };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    if (options.allowFailure) {
      return {
        status: typeof failure.status === 'number' ? failure.status : 1,
        stdout: failure.stdout ?? '',
        stderr: failure.stderr ?? '',
      };
    }
    throw new CrewError(
      'SERVICE_COMMAND_FAILED',
      `${command.join(' ')} failed: ${failure.stderr?.trim() || failure.stdout?.trim() || 'unknown error'}`,
    );
  }
};

export interface ServiceInstallResult {
  definition: ServiceDefinition;
  unitPath: string;
  installed: boolean;
  commands: string[][];
}

export function installService(
  definition: ServiceDefinition,
  runner: CommandRunner = defaultCommandRunner,
): ServiceInstallResult {
  mkdirSync(path.dirname(definition.unitPath), { recursive: true });
  mkdirSync(definition.logPath.split(path.sep).slice(0, -1).join(path.sep), {
    recursive: true,
  });
  writeFileSync(definition.unitPath, definition.content, 'utf8');
  if (definition.manager === 'systemd') {
    chmodSync(definition.unitPath, 0o644);
  }
  for (const command of definition.install) {
    runner(command, { allowFailure: command[1] === 'bootout' });
  }
  return {
    definition,
    unitPath: definition.unitPath,
    installed: true,
    commands: definition.install,
  };
}

export function uninstallService(
  definition: ServiceDefinition,
  runner: CommandRunner = defaultCommandRunner,
): { unitPath: string; removed: boolean; commands: string[][] } {
  for (const command of definition.uninstall) {
    runner(command, { allowFailure: true });
  }
  const removed = existsSync(definition.unitPath);
  if (removed) {
    rmSync(definition.unitPath, { force: true });
  }
  return { unitPath: definition.unitPath, removed, commands: definition.uninstall };
}

export interface ServiceStatus {
  manager: ServiceManager;
  label: string;
  unitPath: string;
  unitExists: boolean;
  installed: boolean;
  running: boolean;
  pid: number | null;
  state: string;
  logPath: string;
  errorLogPath: string;
  detail: string;
}

export function serviceStatus(
  definition: ServiceDefinition,
  runner: CommandRunner = defaultCommandRunner,
): ServiceStatus {
  const unitExists = existsSync(definition.unitPath);
  const statusCommand = definition.status[0] ?? [];
  const result = statusCommand.length
    ? runner(statusCommand, { allowFailure: true })
    : { status: 1, stdout: '', stderr: '' };
  const output = `${result.stdout}\n${result.stderr}`;
  let running = false;
  let pid: number | null = null;
  let state = 'not installed';
  if (result.status === 0) {
    if (definition.manager === 'launchd') {
      running = /\bstate = running\b/.test(output);
      state = running ? 'running' : 'loaded';
      const pidMatch = /\bpid = (\d+)/.exec(output);
      if (pidMatch) {
        pid = Number(pidMatch[1]);
      }
    } else {
      running = output.trim().startsWith('active');
      state = output.trim() || 'unknown';
    }
  } else if (unitExists) {
    state = 'installed but not loaded';
  }
  return {
    manager: definition.manager,
    label: definition.label,
    unitPath: definition.unitPath,
    unitExists,
    installed: unitExists,
    running,
    pid,
    state,
    logPath: definition.logPath,
    errorLogPath: definition.errorLogPath,
    detail: output.trim().split('\n').slice(0, 3).join(' | '),
  };
}

export function readLogTail(filePath: string, lines: number): string[] {
  if (!existsSync(filePath)) {
    return [];
  }
  const content = readFileSync(filePath, 'utf8');
  const all = content.split('\n').filter((line) => line.trim() !== '');
  return all.slice(Math.max(0, all.length - lines));
}

export function resolveCrewCommand(
  argv: string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const candidate = argv[1];
  if (candidate && existsSync(candidate) && candidate.endsWith('.js')) {
    return [process.execPath, path.resolve(candidate)];
  }
  const pathEntries = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const entry of pathEntries) {
    const installed = path.join(entry, 'crew');
    if (existsSync(installed)) {
      return [process.execPath, installed];
    }
  }
  if (candidate && existsSync(candidate) && candidate.endsWith('.ts')) {
    for (const entry of pathEntries) {
      const tsx = path.join(entry, 'tsx');
      if (existsSync(tsx)) {
        return [process.execPath, tsx, path.resolve(candidate)];
      }
    }
  }
  throw new CrewError(
    'SERVICE_ENTRYPOINT_UNAVAILABLE',
    'Could not find the crew CLI. Build it (pnpm build) or install it globally, then retry.',
  );
}

export function serviceEnvironment(
  paths: {
    configDir: string;
    dataDir: string;
    stateDir: string;
    dbPath: string;
  },
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of DEFAULT_ENV_KEYS) {
    const value = env[key];
    if (value) {
      result[key] = value;
    }
  }
  result.CREW_CONFIG_DIR = paths.configDir;
  result.CREW_DATA_DIR = paths.dataDir;
  result.CREW_STATE_DIR = paths.stateDir;
  result.CREW_DB_PATH = paths.dbPath;
  return result;
}
