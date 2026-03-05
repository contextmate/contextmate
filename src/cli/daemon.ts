import { Command } from 'commander';
import chalk from 'chalk';
import * as readline from 'node:readline/promises';
import { Writable } from 'node:stream';
import { stdin, stdout } from 'node:process';
import { readFile, writeFile, unlink, access } from 'node:fs/promises';
import { join } from 'node:path';
import { hexToBytes } from '@noble/hashes/utils';
import { loadConfig, getConfigPath } from '../config.js';
import { getPidFilePath, getBackupsPath } from '../utils/paths.js';
import { deriveMasterKey, deriveVaultKey, decryptString } from '../crypto/index.js';
import { OpenClawAdapter, OpenClawGlobalSync, discoverWorkspaces, getOpenClawRoot } from '../adapters/openclaw.js';
import { ClaudeCodeAdapter } from '../adapters/claude.js';
import { FileWatcher } from '../sync/watcher.js';
import { retrievePassphrase, isKeychainAvailable, storePassphrase, deletePassphrase } from '../utils/keychain.js';
import { installService, uninstallService, isServiceInstalled, writeVersionFile } from './service.js';

type SyncDirection = 'send-receive' | 'receive-only' | 'off';

interface DeviceSyncSettings {
  adapters: {
    claude: SyncDirection;
    openclaw: SyncDirection;
  };
}

const DEFAULT_SYNC: DeviceSyncSettings = {
  adapters: { claude: 'send-receive', openclaw: 'send-receive' },
};

async function loadDeviceSyncSettings(
  serverUrl: string,
  token: string,
  deviceId: string,
  vaultKey: Uint8Array,
): Promise<DeviceSyncSettings> {
  try {
    const res = await fetch(`${serverUrl}/api/auth/devices/${encodeURIComponent(deviceId)}/settings`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) return DEFAULT_SYNC;
    const data = (await res.json()) as { encryptedSettings?: string };
    if (!data.encryptedSettings) return DEFAULT_SYNC;
    const decrypted = decryptString(hexToBytes(data.encryptedSettings), vaultKey);
    const parsed = JSON.parse(decrypted);

    const MIGRATE: Record<string, SyncDirection> = {
      'bidirectional': 'send-receive',
      'pull-only': 'receive-only',
      'disabled': 'off',
    };

    function resolveDirection(raw: unknown): SyncDirection {
      if (typeof raw === 'boolean') return raw ? 'send-receive' : 'off';
      if (raw && typeof raw === 'object') {
        const obj = raw as Record<string, unknown>;
        if (!obj.enabled) return 'off';
        const dir = obj.syncDirection as string;
        const migrated = MIGRATE[dir] ?? dir;
        if (['send-receive', 'receive-only', 'off'].includes(migrated)) {
          return migrated as SyncDirection;
        }
        return 'send-receive';
      }
      return 'off';
    }

    return {
      adapters: {
        claude: resolveDirection(parsed.adapters?.claude),
        openclaw: resolveDirection(parsed.adapters?.openclaw),
      },
    };
  } catch {
    return DEFAULT_SYNC;
  }
}

async function isInitialized(): Promise<boolean> {
  try {
    await access(getConfigPath());
    return true;
  } catch {
    return false;
  }
}

function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readPassphrase(prompt: string): Promise<string> {
  stdout.write(prompt);
  const muted = new Writable({ write(_chunk, _enc, cb) { cb(); } });
  const rl = readline.createInterface({ input: stdin, output: muted, terminal: true });
  const answer = await rl.question('');
  rl.close();
  stdout.write('\n');
  return answer;
}

const startCommand = new Command('start')
  .description('Start the sync daemon in foreground (use "install" for persistent service)')
  .option('--foreground', 'Run in the foreground')
  .option('--service', 'Running as OS service (read passphrase from keychain)')
  .action(async (_opts: { foreground?: boolean; service?: boolean }) => {
    try {
      if (!(await isInitialized())) {
        console.error(chalk.red('ContextMate is not initialized. Run "contextmate init" first.'));
        process.exit(1);
      }

      const config = await loadConfig();
      const pidFile = getPidFilePath(config);

      // Check if already running
      try {
        await access(pidFile);
        const pidStr = await readFile(pidFile, 'utf-8');
        const pid = parseInt(pidStr.trim(), 10);
        if (isPidRunning(pid)) {
          console.error(chalk.red(`Daemon is already running (PID: ${pid}).`));
          process.exit(1);
        }
        // Stale PID file, remove it
        await unlink(pidFile);
      } catch {
        // No PID file or already cleaned up
      }

      // Load credentials
      const credentialsPath = join(config.data.path, 'credentials.json');
      let credentialsRaw: string;
      try {
        credentialsRaw = await readFile(credentialsPath, 'utf-8');
      } catch {
        console.error(chalk.red('No credentials found. Run "contextmate init" first.'));
        process.exit(1);
      }

      const credentials = JSON.parse(credentialsRaw) as {
        salt: string;
        encryptedMasterKey: string;
      };

      // Get passphrase (from keychain in service mode, or prompt interactively)
      const opts = startCommand.opts();
      let passphrase: string;
      if (opts.service || !process.stdin.isTTY) {
        const stored = await retrievePassphrase();
        if (!stored) {
          console.error(chalk.red('No passphrase found in OS keychain.'));
          console.error(chalk.dim('Run "contextmate daemon install" to store passphrase and install service.'));
          process.exit(1);
        }
        passphrase = stored;
      } else {
        passphrase = await readPassphrase(chalk.bold('Enter passphrase: '));
        if (!passphrase) {
          console.error(chalk.red('Error: Passphrase cannot be empty.'));
          process.exit(1);
        }
      }

      // Derive keys
      console.log(chalk.dim('Deriving encryption keys...'));
      const salt = hexToBytes(credentials.salt);
      const masterKey = await deriveMasterKey(passphrase, salt);
      const vaultKey = deriveVaultKey(masterKey);

      // Verify passphrase by trying to decrypt the stored master key
      try {
        const encryptedMasterKeyBytes = hexToBytes(credentials.encryptedMasterKey);
        decryptString(encryptedMasterKeyBytes, vaultKey);
      } catch {
        console.error(chalk.red('Error: Invalid passphrase.'));
        process.exit(1);
      }

      // Load auth token and device ID
      let authToken = '';
      let deviceId = '';
      try {
        const authPath = join(config.data.path, 'auth.json');
        const auth = JSON.parse(await readFile(authPath, 'utf-8'));
        authToken = auth.token || '';
        deviceId = auth.deviceId || '';
      } catch {
        console.error(chalk.red('No auth token found. Run "contextmate init" first.'));
        process.exit(1);
      }

      // Load device sync settings (sync direction per adapter)
      let syncSettings = DEFAULT_SYNC;
      if (deviceId) {
        syncSettings = await loadDeviceSyncSettings(config.server.url, authToken, deviceId, vaultKey);
        const dirs = syncSettings.adapters;
        console.log(chalk.dim(`  Sync direction: openclaw=${dirs.openclaw}, claude=${dirs.claude}`));
      }

      // Write PID file and version file
      await writeFile(pidFile, String(process.pid), 'utf-8');
      await writeVersionFile(config);

      // Start sync engine (foreground)
      console.log(chalk.green(`Daemon started (PID: ${process.pid})`));
      if (!opts.service) {
        console.log(chalk.dim('Press Ctrl+C to stop.'));
      }

      const { SyncEngine } = await import('../sync/index.js');
      const engine = new SyncEngine(config, vaultKey, authToken);
      await engine.start();

      // Start OpenClaw workspace watchers if enabled
      const openclawDirection = syncSettings.adapters.openclaw;
      const openclawCanPush = openclawDirection === 'send-receive';
      const openclawInstances: Array<{ interval: ReturnType<typeof setInterval>; watcher: FileWatcher | null }> = [];
      if (config.adapters.openclaw.enabled && openclawDirection !== 'off') {
        const workspaces = Object.entries(config.adapters.openclaw.workspaces);
        for (const [agentId, ws] of workspaces) {
          const openclawAdapter = new OpenClawAdapter({
            vaultPath: config.vault.path,
            backupsPath: getBackupsPath(),
            agentId,
            exclude: ws.exclude,
            maxFileSizeBytes: ws.maxFileSizeBytes,
          });
          const workspacePath = ws.workspacePath;

          // Initial sync back (only if bidirectional)
          if (openclawCanPush) {
            const backed = await openclawAdapter.syncBack(workspacePath);
            if (backed.synced.length > 0) {
              console.log(chalk.dim(`  OpenClaw [${agentId}]: ${backed.synced.length} file${backed.synced.length === 1 ? '' : 's'} synced back`));
            }
          }

          // Watch workspace for changes (only if bidirectional)
          let watcher: FileWatcher | null = null;
          if (openclawCanPush) {
            watcher = new FileWatcher(workspacePath, config.sync.debounceMs);
            watcher.start();

            const handleChange = async () => {
              try {
                const result = await openclawAdapter.syncBack(workspacePath);
                if (result.synced.length > 0) {
                  console.log(chalk.dim(`  OpenClaw [${agentId}]: ${result.synced.length} file${result.synced.length === 1 ? '' : 's'} synced back`));
                }
              } catch {
                // Non-critical
              }
            };
            watcher.on('file-changed', () => void handleChange());
            watcher.on('file-added', () => void handleChange());
          }

          const interval = setInterval(async () => {
            try {
              if (openclawCanPush) await openclawAdapter.syncBack(workspacePath);
              await openclawAdapter.syncFromVault(workspacePath);
            } catch {
              // Non-critical
            }
          }, config.sync.pollIntervalMs);

          openclawInstances.push({ interval, watcher: watcher! });
        }

        // Global sync: config, sessions, cron
        const globalSync = new OpenClawGlobalSync(config.vault.path);
        if (openclawCanPush) {
          const globalBacked = await globalSync.syncBack();
          if (globalBacked.synced.length > 0) {
            console.log(chalk.dim(`  OpenClaw [global]: ${globalBacked.synced.length} file${globalBacked.synced.length === 1 ? '' : 's'} synced back`));
          }
        }

        // Watch ~/.openclaw/ for config/session changes (only if bidirectional)
        let openclawRootWatcher: FileWatcher | null = null;
        if (openclawCanPush) {
          openclawRootWatcher = new FileWatcher(getOpenClawRoot(), config.sync.debounceMs);
          openclawRootWatcher.start();

          const handleGlobalChange = async () => {
            try {
              const result = await globalSync.syncBack();
              if (result.synced.length > 0) {
                console.log(chalk.dim(`  OpenClaw [global]: ${result.synced.length} file${result.synced.length === 1 ? '' : 's'} synced back`));
              }
            } catch {
              // Non-critical
            }
          };
          openclawRootWatcher.on('file-changed', () => void handleGlobalChange());
          openclawRootWatcher.on('file-added', () => void handleGlobalChange());
        }

        const globalInterval = setInterval(async () => {
          try {
            if (openclawCanPush) await globalSync.syncBack();
            await globalSync.syncFromVault();
          } catch {
            // Non-critical
          }
        }, config.sync.pollIntervalMs);

        if (openclawRootWatcher) {
          openclawInstances.push({ interval: globalInterval, watcher: openclawRootWatcher });
        } else {
          // No watcher but still need to track the interval for cleanup
          openclawInstances.push({ interval: globalInterval, watcher: null });
        }
      }

      // Start Claude workspace watcher if enabled
      const claudeDirection = syncSettings.adapters.claude;
      const claudeCanPush = claudeDirection === 'send-receive';
      let claudeInterval: ReturnType<typeof setInterval> | null = null;
      let claudeWatcher: FileWatcher | null = null;
      if (config.adapters.claude.enabled && config.adapters.claude.claudeDir && claudeDirection !== 'off') {
        const claudeAdapter = new ClaudeCodeAdapter({
          vaultPath: config.vault.path,
          backupsPath: getBackupsPath(),
          scanPaths: config.adapters.claude.scanPaths,
        });
        const claudeDir = config.adapters.claude.claudeDir;

        // Initial sync back (only if bidirectional)
        if (claudeCanPush) {
          const backed = await claudeAdapter.syncBack(claudeDir);
          if (backed.synced.length > 0) {
            console.log(chalk.dim(`  Claude: ${backed.synced.length} file${backed.synced.length === 1 ? '' : 's'} synced back`));
          }
        }

        // Initial pull from vault
        await claudeAdapter.syncFromVault(claudeDir);

        // Watch Claude directory for changes (only if bidirectional)
        if (claudeCanPush) {
          claudeWatcher = new FileWatcher(claudeDir, config.sync.debounceMs);
          claudeWatcher.start();

          const handleClaudeChange = async () => {
            try {
              const result = await claudeAdapter.syncBack(claudeDir);
              if (result.synced.length > 0) {
                console.log(chalk.dim(`  Claude: ${result.synced.length} file${result.synced.length === 1 ? '' : 's'} synced back`));
              }
            } catch {
              // Non-critical
            }
          };
          claudeWatcher.on('file-changed', () => void handleClaudeChange());
          claudeWatcher.on('file-added', () => void handleClaudeChange());
        }

        claudeInterval = setInterval(async () => {
          try {
            if (claudeCanPush) await claudeAdapter.syncBack(claudeDir);
            await claudeAdapter.syncFromVault(claudeDir);
          } catch {
            // Non-critical
          }
        }, config.sync.pollIntervalMs);
      }

      // Handle graceful shutdown
      const shutdown = async () => {
        console.log(chalk.dim('\nStopping daemon...'));
        for (const oc of openclawInstances) {
          clearInterval(oc.interval);
          if (oc.watcher) await oc.watcher.stop();
        }
        if (claudeInterval) clearInterval(claudeInterval);
        if (claudeWatcher) await claudeWatcher.stop();
        await engine.stop();
        try {
          await unlink(pidFile);
        } catch {
          // Already removed
        }
        console.log(chalk.green('Daemon stopped.'));
        process.exit(0);
      };

      process.on('SIGINT', () => void shutdown());
      process.on('SIGTERM', () => void shutdown());
    } catch (err) {
      console.error(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
      process.exit(1);
    }
  });

const stopCommand = new Command('stop')
  .description('Stop the sync daemon')
  .action(async () => {
    try {
      if (!(await isInitialized())) {
        console.error(chalk.red('ContextMate is not initialized. Run "contextmate init" first.'));
        process.exit(1);
      }

      const config = await loadConfig();
      const pidFile = getPidFilePath(config);

      let pidStr: string;
      try {
        pidStr = await readFile(pidFile, 'utf-8');
      } catch {
        console.log(chalk.dim('Daemon is not running.'));
        return;
      }

      const pid = parseInt(pidStr.trim(), 10);

      if (!isPidRunning(pid)) {
        console.log(chalk.dim('Daemon is not running (stale PID file).'));
        await unlink(pidFile);
        return;
      }

      // Send SIGTERM
      process.kill(pid, 'SIGTERM');
      console.log(chalk.dim(`Sent SIGTERM to PID ${pid}...`));

      // Wait for process to exit (up to 10 seconds)
      let stopped = false;
      for (let i = 0; i < 20; i++) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        if (!isPidRunning(pid)) {
          stopped = true;
          break;
        }
      }

      if (stopped) {
        try {
          await unlink(pidFile);
        } catch {
          // Already removed by the daemon
        }
        console.log(chalk.green('Daemon stopped.'));
      } else {
        console.log(chalk.yellow(`Daemon (PID: ${pid}) did not stop within 10 seconds.`));
        console.log(chalk.dim(`You may need to kill it manually: kill ${pid}`));
      }
    } catch (err) {
      console.error(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
      process.exit(1);
    }
  });

const statusSubCommand = new Command('status')
  .description('Check daemon status')
  .action(async () => {
    try {
      if (!(await isInitialized())) {
        console.error(chalk.red('ContextMate is not initialized. Run "contextmate init" first.'));
        process.exit(1);
      }

      const config = await loadConfig();
      const pidFile = getPidFilePath(config);

      let pidStr: string;
      try {
        pidStr = await readFile(pidFile, 'utf-8');
      } catch {
        console.log(chalk.dim('Daemon is not running.'));
        return;
      }

      const pid = parseInt(pidStr.trim(), 10);

      if (isPidRunning(pid)) {
        console.log(chalk.green(`Daemon is running (PID: ${pid}).`));
      } else {
        console.log(chalk.red(`Daemon is not running (stale PID file, PID: ${pid}).`));
      }

      // Show service status
      if (await isServiceInstalled()) {
        console.log(chalk.dim('  Service: installed (persistent)'));
      } else {
        console.log(chalk.dim('  Service: not installed'));
      }
    } catch (err) {
      console.error(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
      process.exit(1);
    }
  });

async function stopRunningDaemon(config: Awaited<ReturnType<typeof loadConfig>>): Promise<void> {
  const pidFile = getPidFilePath(config);
  try {
    const pidStr = await readFile(pidFile, 'utf-8');
    const pid = parseInt(pidStr.trim(), 10);
    if (isPidRunning(pid)) {
      process.kill(pid, 'SIGTERM');
      for (let i = 0; i < 20; i++) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        if (!isPidRunning(pid)) break;
      }
    }
    await unlink(pidFile);
  } catch {
    // No daemon running
  }
}

const installCommand = new Command('install')
  .description('Install daemon as a persistent OS service (recommended)')
  .action(async () => {
    try {
      if (!(await isInitialized())) {
        console.error(chalk.red('ContextMate is not initialized. Run "contextmate setup" first.'));
        process.exit(1);
      }

      const config = await loadConfig();

      // Check if already installed
      if (await isServiceInstalled()) {
        const answer = await readPassphrase('Service already installed. Reinstall? (y/N): ');
        if (answer.trim().toLowerCase() !== 'y') return;
        await uninstallService();
      }

      // Check keychain availability
      if (!(await isKeychainAvailable())) {
        console.error(chalk.red('OS keychain is not available on this system.'));
        console.error(chalk.dim('macOS requires /usr/bin/security. Linux requires secret-tool (libsecret).'));
        process.exit(1);
      }

      // Stop running daemon if any
      console.log(chalk.dim('Stopping any running daemon...'));
      await stopRunningDaemon(config);

      // Prompt for passphrase and verify
      const passphrase = await readPassphrase(chalk.bold('Enter passphrase: '));
      if (!passphrase) {
        console.error(chalk.red('Passphrase cannot be empty.'));
        process.exit(1);
      }

      const credentialsPath = join(config.data.path, 'credentials.json');
      const credentials = JSON.parse(await readFile(credentialsPath, 'utf-8')) as {
        salt: string;
        encryptedMasterKey: string;
      };
      const salt = hexToBytes(credentials.salt);
      const masterKey = await deriveMasterKey(passphrase, salt);
      const vaultKey = deriveVaultKey(masterKey);
      try {
        decryptString(hexToBytes(credentials.encryptedMasterKey), vaultKey);
      } catch {
        console.error(chalk.red('Invalid passphrase.'));
        process.exit(1);
      }

      // Store in keychain
      console.log(chalk.dim('Storing passphrase in OS keychain...'));
      await storePassphrase(passphrase);

      // Write version file
      await writeVersionFile(config);

      // Install service
      console.log(chalk.dim('Installing OS service...'));
      await installService(config);

      console.log(chalk.green('Daemon service installed and started.'));
      console.log(chalk.dim('The daemon will start automatically on login/boot.'));
    } catch (err) {
      console.error(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
      process.exit(1);
    }
  });

const uninstallCommand = new Command('uninstall')
  .description('Remove daemon OS service and keychain entry')
  .action(async () => {
    try {
      if (!(await isServiceInstalled())) {
        console.log(chalk.dim('No service installed.'));
        return;
      }

      console.log(chalk.dim('Removing OS service...'));
      await uninstallService();

      try {
        await deletePassphrase();
        console.log(chalk.dim('Passphrase removed from OS keychain.'));
      } catch {
        // Already removed or not stored
      }

      console.log(chalk.green('Daemon service uninstalled.'));
    } catch (err) {
      console.error(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
      process.exit(1);
    }
  });

export const daemonCommand = new Command('daemon')
  .description('Manage the sync daemon')
  .addCommand(startCommand)
  .addCommand(stopCommand)
  .addCommand(statusSubCommand)
  .addCommand(installCommand)
  .addCommand(uninstallCommand);
