import { Command } from 'commander';
import chalk from 'chalk';
import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { access, readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { hostname, homedir } from 'node:os';
import { exec } from 'node:child_process';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import {
  generateSalt,
  deriveMasterKey,
  deriveAuthKey,
  deriveVaultKey,
  encryptString,
  decryptString,
  createAuthHash,
  encryptFile,
  hashContent,
  deriveKeyForPath,
} from '../crypto/index.js';
import {
  getConfigPath,
  getDefaultConfig,
  loadConfig,
  saveConfig,
  ensureDirectories,
  type ContextMateConfig,
} from '../config.js';
import { getAdapter } from '../adapters/index.js';
import { getBackupsPath, getPidFilePath, getSyncDbPath } from '../utils/paths.js';

async function ask(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const answer = await rl.question(prompt);
  rl.close();
  return answer;
}

function openBrowser(url: string) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  exec(`${cmd} ${url}`);
}

function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function registerDevice(serverUrl: string, token: string): Promise<string | null> {
  try {
    const res = await fetch(`${serverUrl}/api/auth/devices`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ name: hostname() }),
    });
    if (res.ok) {
      const { deviceId } = (await res.json()) as { deviceId: string };
      return deviceId;
    }
  } catch {
    // Non-critical
  }
  return null;
}

async function pushDeviceSettings(
  config: ContextMateConfig,
  token: string,
  deviceId: string,
  vaultKey: Uint8Array,
): Promise<void> {
  const settings = {
    scanPaths: config.adapters.claude.scanPaths,
    adapters: {
      claude: config.adapters.claude.enabled,
      openclaw: config.adapters.openclaw.enabled,
    },
  };

  const encrypted = encryptString(JSON.stringify(settings), vaultKey);
  const encryptedHex = bytesToHex(encrypted);

  try {
    await fetch(`${config.server.url}/api/auth/devices/${deviceId}/settings`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ encryptedSettings: encryptedHex }),
    });
  } catch {
    // Non-critical
  }
}

async function initialSync(
  config: ContextMateConfig,
  vaultKey: Uint8Array,
  token: string,
): Promise<{ uploaded: number; errors: number }> {
  let uploaded = 0;
  let errors = 0;

  // Discover all files in the vault
  const files = await discoverFiles(config.vault.path, config.vault.path);

  for (const filePath of files) {
    try {
      const absolutePath = join(config.vault.path, filePath);
      const content = await readFile(absolutePath);
      const contentBytes = new Uint8Array(content);

      const fileKey = deriveKeyForPath(vaultKey, filePath);
      const encrypted = encryptFile(contentBytes, fileKey);
      const encryptedHash = hashContent(encrypted);

      const res = await fetch(
        `${config.server.url}/api/files/${encodeURIComponent(filePath)}`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/octet-stream',
            'Authorization': `Bearer ${token}`,
            'X-Content-Hash': encryptedHash,
            'X-Version': '0',
          },
          body: encrypted as unknown as globalThis.BodyInit,
        },
      );

      if (res.ok || res.status === 409) {
        uploaded++;
      } else {
        errors++;
      }
    } catch {
      errors++;
    }
  }

  return { uploaded, errors };
}

async function discoverFiles(dir: string, base: string): Promise<string[]> {
  const { readdir, stat } = await import('node:fs/promises');
  const { relative } = await import('node:path');
  const paths: string[] = [];
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return paths;
  }
  for (const name of entries) {
    if (name.startsWith('.') || name === 'node_modules') continue;
    const full = join(dir, name);
    try {
      const s = await stat(full);
      if (s.isDirectory()) {
        paths.push(...await discoverFiles(full, base));
      } else if (s.isFile()) {
        paths.push(relative(base, full));
      }
    } catch {
      // Skip
    }
  }
  return paths;
}

function countByPrefix(items: string[], prefix: string): number {
  return items.filter((i) => i.startsWith(prefix)).length;
}

export const setupCommand = new Command('setup')
  .description('Complete guided setup — account, adapters, sync, and dashboard')
  .action(async () => {
    try {
      console.log('');
      console.log(chalk.bold.cyan('ContextMate Setup'));
      console.log(chalk.dim('─'.repeat(40)));
      console.log('');

      // ─── Step 1: Account ───
      let config: ContextMateConfig;
      let token: string;
      let userId: string;
      let vaultKey: Uint8Array;
      let deviceId: string | null = null;

      const configPath = getConfigPath();
      let alreadyInitialized = false;
      try {
        await access(configPath);
        alreadyInitialized = true;
      } catch {
        // Not initialized
      }

      // Check for existing account
      let existingAuth: { token?: string; userId?: string; deviceId?: string } = {};
      if (alreadyInitialized) {
        try {
          config = await loadConfig();
          const authPath = join(config.data.path, 'auth.json');
          existingAuth = JSON.parse(await readFile(authPath, 'utf-8'));
        } catch {
          // No auth
        }
      }

      if (existingAuth.userId && existingAuth.token) {
        console.log(chalk.green('✓ Account found'));
        console.log(`  User ID: ${existingAuth.userId}`);
        console.log('');

        const choice = await ask(chalk.bold('Use this account? (Y/n): '));
        if (choice.trim().toLowerCase() === 'n') {
          console.log(chalk.dim('Run "contextmate init" to switch accounts, then run setup again.'));
          return;
        }

        config = await loadConfig();
        userId = existingAuth.userId;
        token = existingAuth.token;
        deviceId = existingAuth.deviceId || null;

        // We need the vault key — ask for passphrase
        console.log('');
        const passphrase = await ask(chalk.bold('Passphrase: '));
        if (!passphrase || !passphrase.trim()) {
          console.error(chalk.red('Error: Passphrase cannot be empty.'));
          process.exit(1);
        }

        // Load salt and derive keys
        const credPath = join(config.data.path, 'credentials.json');
        const creds = JSON.parse(await readFile(credPath, 'utf-8'));
        const salt = hexToBytes(creds.salt);
        const masterKey = await deriveMasterKey(passphrase, salt);
        vaultKey = deriveVaultKey(masterKey);

        // Verify passphrase
        try {
          decryptString(hexToBytes(creds.encryptedMasterKey), vaultKey);
        } catch {
          console.error(chalk.red('Error: Incorrect passphrase.'));
          process.exit(1);
        }
      } else {
        // Fresh setup
        console.log('  1. Create new account');
        console.log('  2. Log into existing account');
        console.log('');

        const choice = await ask(chalk.bold('Choose (1 or 2): '));
        const isLogin = choice.trim() === '2';

        if (isLogin) {
          // Login flow
          userId = (await ask(chalk.bold('User ID: '))).trim();
          if (!userId) {
            console.error(chalk.red('Error: User ID cannot be empty.'));
            process.exit(1);
          }

          const passphrase = await ask(chalk.bold('Passphrase: '));
          if (!passphrase || !passphrase.trim()) {
            console.error(chalk.red('Error: Passphrase cannot be empty.'));
            process.exit(1);
          }

          config = getDefaultConfig();
          await ensureDirectories(config);
          await saveConfig(config);

          // Fetch salt from server
          console.log(chalk.dim('Connecting to server...'));
          const saltRes = await fetch(`${config.server.url}/api/auth/salt/${encodeURIComponent(userId)}`);
          if (saltRes.status === 404) {
            console.error(chalk.red('Error: User ID not found.'));
            process.exit(1);
          }
          if (!saltRes.ok) {
            console.error(chalk.red(`Error: Server returned ${saltRes.status}.`));
            process.exit(1);
          }
          const { salt: saltHex } = (await saltRes.json()) as { salt: string };
          const salt = hexToBytes(saltHex);

          console.log(chalk.dim('Deriving encryption keys...'));
          const masterKey = await deriveMasterKey(passphrase, salt);
          const authKey = deriveAuthKey(masterKey);
          vaultKey = deriveVaultKey(masterKey);
          const authHash = createAuthHash(authKey);

          // Login
          console.log(chalk.dim('Authenticating...'));
          const loginRes = await fetch(`${config.server.url}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ authKeyHash: authHash }),
          });
          if (loginRes.status === 401) {
            console.error(chalk.red('Error: Incorrect passphrase.'));
            process.exit(1);
          }
          if (!loginRes.ok) {
            console.error(chalk.red(`Error: Server returned ${loginRes.status}.`));
            process.exit(1);
          }

          const loginData = (await loginRes.json()) as { userId: string; token: string };
          token = loginData.token;
          userId = loginData.userId;

          // Save credentials
          const encryptedMasterKey = encryptString(bytesToHex(masterKey), vaultKey);
          await writeFile(
            join(config.data.path, 'credentials.json'),
            JSON.stringify({ salt: saltHex, encryptedMasterKey: bytesToHex(encryptedMasterKey) }, null, 2),
            { mode: 0o600 },
          );
          deviceId = await registerDevice(config.server.url, token);
          await writeFile(
            join(config.data.path, 'auth.json'),
            JSON.stringify({ authHash, userId, token, deviceId }, null, 2),
            { mode: 0o600 },
          );
        } else {
          // Create account flow
          const passphrase = await ask(chalk.bold('Choose a passphrase: '));
          if (!passphrase || !passphrase.trim()) {
            console.error(chalk.red('Error: Passphrase cannot be empty.'));
            process.exit(1);
          }
          const confirmation = await ask(chalk.bold('Confirm passphrase: '));
          if (passphrase !== confirmation) {
            console.error(chalk.red('Error: Passphrases do not match.'));
            process.exit(1);
          }

          console.log(chalk.dim('Deriving encryption keys...'));
          const salt = generateSalt();
          const masterKey = await deriveMasterKey(passphrase, salt);
          const authKey = deriveAuthKey(masterKey);
          vaultKey = deriveVaultKey(masterKey);

          config = getDefaultConfig();
          await ensureDirectories(config);
          await saveConfig(config);

          const encryptedMasterKey = encryptString(bytesToHex(masterKey), vaultKey);
          await writeFile(
            join(config.data.path, 'credentials.json'),
            JSON.stringify({
              salt: bytesToHex(salt),
              encryptedMasterKey: bytesToHex(encryptedMasterKey),
            }, null, 2),
            { mode: 0o600 },
          );

          const authHash = createAuthHash(authKey);

          console.log(chalk.dim('Registering with server...'));
          const regRes = await fetch(`${config.server.url}/api/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              authKeyHash: authHash,
              salt: bytesToHex(salt),
              encryptedMasterKey: bytesToHex(encryptedMasterKey),
            }),
          });

          if (regRes.ok) {
            const regData = (await regRes.json()) as { userId: string; token: string };
            token = regData.token;
            userId = regData.userId;
            deviceId = await registerDevice(config.server.url, token);
            await writeFile(
              join(config.data.path, 'auth.json'),
              JSON.stringify({ authHash, userId, token, deviceId }, null, 2),
              { mode: 0o600 },
            );
          } else if (regRes.status === 409) {
            console.error(chalk.red('Error: An account with this passphrase already exists.'));
            process.exit(1);
          } else {
            console.error(chalk.red(`Error: Server returned ${regRes.status}.`));
            process.exit(1);
          }
        }

        console.log(chalk.green('✓ Account ready'));
        console.log(`  User ID: ${userId}`);
        console.log('');
        console.log(chalk.yellow.bold('  ⚠  Save your User ID and passphrase somewhere safe.'));
        console.log('');
      }

      // Register device if we don't have one
      if (!deviceId) {
        deviceId = await registerDevice(config!.server.url, token!);
        if (deviceId) {
          // Update auth.json with deviceId
          try {
            const authPath = join(config!.data.path, 'auth.json');
            const auth = JSON.parse(await readFile(authPath, 'utf-8'));
            auth.deviceId = deviceId;
            await writeFile(authPath, JSON.stringify(auth, null, 2), { mode: 0o600 });
          } catch {
            // Non-critical
          }
        }
      }

      // ─── Step 2: Adapters ───
      console.log(chalk.bold('Detecting AI agents...'));
      console.log('');

      // Claude
      const claudeDir = join(homedir(), '.claude');
      let claudeDetected = false;
      try {
        await access(claudeDir);
        claudeDetected = true;
      } catch {
        // Not found
      }

      if (claudeDetected) {
        console.log(chalk.green('  ✓ Claude Code detected'));
        const adapter = getAdapter('claude', {
          vaultPath: config!.vault.path,
          backupsPath: getBackupsPath(),
          scanPaths: config!.adapters.claude.scanPaths,
        });

        // Import files
        console.log(chalk.dim('    Importing files...'));
        const importResult = await adapter.import(claudeDir);

        const skills = countByPrefix(importResult.imported, 'skills/') +
          countByPrefix(importResult.skipped, 'skills/');
        const rules = countByPrefix(importResult.imported, 'claude/rules/') +
          countByPrefix(importResult.skipped, 'claude/rules/');
        console.log(`    ${skills} skills, ${rules} rules`);
        console.log(
          `    ${chalk.green(`${importResult.imported.length} new`)}, ` +
          `${chalk.dim(`${importResult.skipped.length} unchanged`)}`,
        );

        // Create symlinks
        console.log(chalk.dim('    Creating symlinks...'));
        const symlinkResult = await adapter.createSymlinks(claudeDir);
        console.log(`    ${chalk.green(`${symlinkResult.created.length} symlinks`)}`);

        config!.adapters.claude.enabled = true;
        config!.adapters.claude.claudeDir = claudeDir;
      } else {
        console.log(chalk.dim('  ○ Claude Code not detected'));
      }

      // OpenClaw
      const openclawDir = join(homedir(), '.openclaw', 'workspace');
      let openclawDetected = false;
      try {
        await access(openclawDir);
        openclawDetected = true;
      } catch {
        // Not found
      }

      if (openclawDetected) {
        console.log(chalk.green('  ✓ OpenClaw detected'));
        const adapter = getAdapter('openclaw', {
          vaultPath: config!.vault.path,
          backupsPath: getBackupsPath(),
          scanPaths: [],
        });

        console.log(chalk.dim('    Importing files...'));
        const importResult = await adapter.import(openclawDir);
        console.log(
          `    ${chalk.green(`${importResult.imported.length} new`)}, ` +
          `${chalk.dim(`${importResult.skipped.length} unchanged`)}`,
        );

        console.log(chalk.dim('    Creating symlinks...'));
        const symlinkResult = await adapter.createSymlinks(openclawDir);
        console.log(`    ${chalk.green(`${symlinkResult.created.length} symlinks`)}`);

        config!.adapters.openclaw.enabled = true;
        config!.adapters.openclaw.workspacePath = openclawDir;
      } else {
        console.log(chalk.dim('  ○ OpenClaw not detected'));
      }

      console.log('');

      // ─── Step 3: Scan paths ───
      if (claudeDetected && config!.adapters.claude.scanPaths.length === 0) {
        console.log(chalk.bold('Project skills'));
        console.log(chalk.dim('  ContextMate can scan directories for project-specific'));
        console.log(chalk.dim('  skills in .claude/skills/ folders inside each repo.'));
        console.log('');

        const scanPath = await ask(chalk.bold('  Directory to scan (e.g. ~/Developer), or Enter to skip: '));
        const trimmed = scanPath.trim();

        if (trimmed) {
          const resolved = trimmed.startsWith('~') ? trimmed.replace('~', homedir()) : trimmed;
          config!.adapters.claude.scanPaths = [resolved];
          console.log(chalk.green(`  ✓ Scan path added: ${resolved}`));

          // Re-import with scan paths
          const adapter = getAdapter('claude', {
            vaultPath: config!.vault.path,
            backupsPath: getBackupsPath(),
            scanPaths: config!.adapters.claude.scanPaths,
          });
          console.log(chalk.dim('  Scanning for project skills...'));
          const importResult = await adapter.import(claudeDir);
          if (importResult.imported.length > 0) {
            console.log(`  ${chalk.green(`${importResult.imported.length} additional files imported`)}`);
          }
        }
        console.log('');
      }

      // Save config
      await saveConfig(config!);

      // ─── Step 4: Push device settings ───
      if (deviceId) {
        await pushDeviceSettings(config!, token!, deviceId, vaultKey!);
      }

      // ─── Step 5: Initial sync ───
      console.log(chalk.bold('Syncing files to server...'));
      const syncResult = await initialSync(config!, vaultKey!, token!);
      if (syncResult.uploaded > 0) {
        console.log(chalk.green(`  ✓ ${syncResult.uploaded} files uploaded`));
      } else {
        console.log(chalk.dim('  No files to sync'));
      }
      if (syncResult.errors > 0) {
        console.log(chalk.yellow(`  ${syncResult.errors} files failed`));
      }
      console.log('');

      // ─── Step 6: Open dashboard ───
      console.log(chalk.bold('Opening web dashboard...'));
      openBrowser('https://app.contextmate.dev');
      console.log(chalk.dim('  app.contextmate.dev'));
      console.log('');

      // ─── Step 7: Start daemon ───
      console.log(chalk.dim('─'.repeat(40)));
      console.log('');
      console.log(chalk.green.bold('Setup complete!'));
      console.log('');
      console.log(`  ${chalk.bold('User ID:')}  ${userId!}`);
      console.log(`  ${chalk.bold('Server:')}   ${config!.server.url}`);
      console.log(`  ${chalk.bold('Dashboard:')} https://app.contextmate.dev`);
      console.log('');

      const startDaemon = await ask(chalk.bold('Start sync daemon now? (Y/n): '));
      if (startDaemon.trim().toLowerCase() === 'n') {
        console.log('');
        console.log(chalk.dim('Run "contextmate daemon start" whenever you\'re ready to sync.'));
        return;
      }

      // Start daemon
      const pidFile = getPidFilePath(config!);
      try {
        await access(pidFile);
        const pidStr = await readFile(pidFile, 'utf-8');
        const pid = parseInt(pidStr.trim(), 10);
        if (isPidRunning(pid)) {
          console.log(chalk.green(`Daemon already running (PID: ${pid}).`));
          return;
        }
        await unlink(pidFile);
      } catch {
        // No PID file
      }

      await writeFile(pidFile, String(process.pid), 'utf-8');
      console.log(chalk.green(`Daemon started (PID: ${process.pid})`));
      console.log(chalk.dim('Press Ctrl+C to stop.'));

      const { SyncEngine } = await import('../sync/index.js');
      const engine = new SyncEngine(config!, vaultKey!, token!);
      await engine.start();

      const shutdown = async () => {
        console.log(chalk.dim('\nStopping daemon...'));
        await engine.stop();
        try { await unlink(pidFile); } catch { /* Already removed */ }
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
