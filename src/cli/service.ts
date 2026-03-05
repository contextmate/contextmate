import { execFile as execFileCb } from 'node:child_process';
import { writeFile, unlink, access, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { ContextMateConfig } from '../config.js';
import { getVersionFilePath } from '../utils/paths.js';
import { VERSION } from '../utils/version.js';

const execFile = promisify(execFileCb);

const PLIST_LABEL = 'dev.contextmate.daemon';
const PLIST_PATH = join(homedir(), 'Library', 'LaunchAgents', `${PLIST_LABEL}.plist`);

const SYSTEMD_USER_DIR = join(homedir(), '.config', 'systemd', 'user');
const SYSTEMD_SERVICE = join(SYSTEMD_USER_DIR, 'contextmate.service');
const SYSTEMD_PATH_UNIT = join(SYSTEMD_USER_DIR, 'contextmate-version.path');
const SYSTEMD_RESTART_SERVICE = join(SYSTEMD_USER_DIR, 'contextmate-restart.service');

function getScriptPath(): string {
  const __filename = fileURLToPath(import.meta.url);
  // From dist/src/cli/service.js -> dist/src/bin/contextmate.js
  return join(dirname(__filename), '..', 'bin', 'contextmate.js');
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export async function writeVersionFile(config: ContextMateConfig): Promise<void> {
  const versionFile = getVersionFilePath(config);
  await writeFile(versionFile, VERSION, 'utf-8');
}

function generatePlist(config: ContextMateConfig): string {
  const nodePath = process.execPath;
  const scriptPath = getScriptPath();
  const versionFile = getVersionFilePath(config);
  const logDir = config.data.path;
  const nodeBinDir = dirname(nodePath);
  const envPath = `/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:${nodeBinDir}`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${PLIST_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${escapeXml(nodePath)}</string>
        <string>${escapeXml(scriptPath)}</string>
        <string>daemon</string>
        <string>start</string>
        <string>--foreground</string>
        <string>--service</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>WatchPaths</key>
    <array>
        <string>${escapeXml(versionFile)}</string>
    </array>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>StandardOutPath</key>
    <string>${escapeXml(join(logDir, 'daemon.log'))}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(join(logDir, 'daemon.err.log'))}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${escapeXml(envPath)}</string>
        <key>HOME</key>
        <string>${escapeXml(homedir())}</string>
    </dict>
</dict>
</plist>
`;
}

function generateSystemdService(): string {
  const nodePath = process.execPath;
  const scriptPath = getScriptPath();
  const nodeBinDir = dirname(nodePath);
  const envPath = `/usr/local/bin:/usr/bin:/bin:${nodeBinDir}`;

  return `[Unit]
Description=ContextMate Sync Daemon
After=network-online.target

[Service]
Type=simple
ExecStart=${nodePath} ${scriptPath} daemon start --foreground --service
Restart=on-failure
RestartSec=5
Environment=PATH=${envPath}
Environment=HOME=${homedir()}

[Install]
WantedBy=default.target
`;
}

function generateSystemdPathUnit(config: ContextMateConfig): string {
  const versionFile = getVersionFilePath(config);
  return `[Unit]
Description=ContextMate version watcher

[Path]
PathModified=${versionFile}
Unit=contextmate-restart.service

[Install]
WantedBy=default.target
`;
}

function generateSystemdRestartService(): string {
  return `[Unit]
Description=Restart ContextMate on version change

[Service]
Type=oneshot
ExecStart=/usr/bin/systemctl --user restart contextmate.service
`;
}

export async function installService(config: ContextMateConfig): Promise<void> {
  const platform = process.platform;

  if (platform === 'darwin') {
    const plistDir = dirname(PLIST_PATH);
    await mkdir(plistDir, { recursive: true });
    await writeFile(PLIST_PATH, generatePlist(config), 'utf-8');
    await execFile('launchctl', ['load', '-w', PLIST_PATH]);
  } else if (platform === 'linux') {
    await mkdir(SYSTEMD_USER_DIR, { recursive: true });
    await writeFile(SYSTEMD_SERVICE, generateSystemdService(), 'utf-8');
    await writeFile(SYSTEMD_PATH_UNIT, generateSystemdPathUnit(config), 'utf-8');
    await writeFile(SYSTEMD_RESTART_SERVICE, generateSystemdRestartService(), 'utf-8');
    await execFile('systemctl', ['--user', 'daemon-reload']);
    await execFile('systemctl', ['--user', 'enable', '--now', 'contextmate.service']);
    await execFile('systemctl', ['--user', 'enable', '--now', 'contextmate-version.path']);
  } else {
    throw new Error(`Persistent service is not supported on ${platform}. Use "contextmate daemon start --foreground" instead.`);
  }
}

export async function uninstallService(): Promise<void> {
  const platform = process.platform;

  if (platform === 'darwin') {
    try {
      await execFile('launchctl', ['unload', PLIST_PATH]);
    } catch {
      // Service may not be loaded
    }
    try {
      await unlink(PLIST_PATH);
    } catch {
      // File may not exist
    }
  } else if (platform === 'linux') {
    try { await execFile('systemctl', ['--user', 'disable', '--now', 'contextmate.service']); } catch { /* */ }
    try { await execFile('systemctl', ['--user', 'disable', '--now', 'contextmate-version.path']); } catch { /* */ }
    try { await unlink(SYSTEMD_SERVICE); } catch { /* */ }
    try { await unlink(SYSTEMD_PATH_UNIT); } catch { /* */ }
    try { await unlink(SYSTEMD_RESTART_SERVICE); } catch { /* */ }
    try { await execFile('systemctl', ['--user', 'daemon-reload']); } catch { /* */ }
  }
}

export async function isServiceInstalled(): Promise<boolean> {
  const platform = process.platform;
  const filePath = platform === 'darwin' ? PLIST_PATH : SYSTEMD_SERVICE;
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function restartService(): Promise<void> {
  const platform = process.platform;
  if (platform === 'darwin') {
    try {
      await execFile('launchctl', ['unload', PLIST_PATH]);
    } catch { /* */ }
    await execFile('launchctl', ['load', '-w', PLIST_PATH]);
  } else if (platform === 'linux') {
    await execFile('systemctl', ['--user', 'restart', 'contextmate.service']);
  }
}
