import { Command } from 'commander';
import chalk from 'chalk';
import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import {
  generateSalt,
  deriveMasterKey,
  deriveAuthKey,
  deriveVaultKey,
  encryptString,
  createAuthHash,
} from '../crypto/index.js';
import {
  getConfigDir,
  getConfigPath,
  getDefaultConfig,
  saveConfig,
  ensureDirectories,
} from '../config.js';

async function ask(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const answer = await rl.question(prompt);
  rl.close();
  return answer;
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
    // Device registration is non-critical
  }
  return null;
}

async function setupDirectories() {
  const config = getDefaultConfig();
  await ensureDirectories(config);
  await saveConfig(config);
  return config;
}

function printSuccess(userId: string, serverUrl: string) {
  console.log('');
  console.log(chalk.green.bold('ContextMate is ready!'));
  console.log('');
  console.log(`  ${chalk.bold('User ID:')}     ${userId}`);
  console.log(`  ${chalk.bold('Server:')}      ${serverUrl}`);
  console.log('');
  console.log(chalk.yellow.bold('  ⚠  Save your User ID and passphrase somewhere safe.'));
  console.log(chalk.yellow('     You need both to log in on other devices.'));
  console.log('');
  console.log(chalk.bold('Next steps:'));
  console.log(`  ${chalk.cyan('contextmate adapter claude init')}    Connect Claude Code`);
  console.log(`  ${chalk.cyan('contextmate adapter openclaw init')}  Connect OpenClaw`);
  console.log(`  ${chalk.cyan('contextmate daemon start')}           Begin syncing`);
  console.log('');
}

async function createNewAccount() {
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
  const vaultKey = deriveVaultKey(masterKey);

  const config = await setupDirectories();

  // Save credentials locally
  const encryptedMasterKey = encryptString(bytesToHex(masterKey), vaultKey);
  const credentials = {
    salt: bytesToHex(salt),
    encryptedMasterKey: bytesToHex(encryptedMasterKey),
  };
  await writeFile(
    join(config.data.path, 'credentials.json'),
    JSON.stringify(credentials, null, 2),
    { mode: 0o600 },
  );

  // Register with server
  const authHash = createAuthHash(authKey);
  const authPath = join(config.data.path, 'auth.json');

  console.log(chalk.dim('Registering with server...'));
  try {
    const res = await fetch(`${config.server.url}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        authKeyHash: authHash,
        salt: bytesToHex(salt),
        encryptedMasterKey: bytesToHex(encryptedMasterKey),
      }),
    });

    if (res.ok) {
      const { userId, token } = (await res.json()) as { userId: string; token: string };
      const deviceId = await registerDevice(config.server.url, token);
      await writeFile(authPath, JSON.stringify({ authHash, userId, token, deviceId }, null, 2), { mode: 0o600 });
      printSuccess(userId, config.server.url);
    } else if (res.status === 409) {
      console.error(chalk.red('Error: An account with this passphrase already exists.'));
      console.error(chalk.dim('If this is your account, choose "Log into existing account" instead.'));
      process.exit(1);
    } else {
      await writeFile(authPath, JSON.stringify({ authHash }, null, 2), { mode: 0o600 });
      console.log('');
      console.log(chalk.green('ContextMate initialized locally.'));
      console.log(chalk.yellow('Warning: Server registration failed. Run "contextmate init" again later.'));
    }
  } catch {
    await writeFile(authPath, JSON.stringify({ authHash }, null, 2), { mode: 0o600 });
    console.log('');
    console.log(chalk.green('ContextMate initialized locally.'));
    console.log(chalk.yellow('Warning: Could not reach server. Run "contextmate init" again later.'));
  }
}

async function loginExistingAccount() {
  const userId = await ask(chalk.bold('User ID: '));
  if (!userId.trim()) {
    console.error(chalk.red('Error: User ID cannot be empty.'));
    process.exit(1);
  }

  const passphrase = await ask(chalk.bold('Passphrase: '));
  if (!passphrase || !passphrase.trim()) {
    console.error(chalk.red('Error: Passphrase cannot be empty.'));
    process.exit(1);
  }

  const config = await setupDirectories();

  // Fetch salt from server
  console.log(chalk.dim('Connecting to server...'));
  let salt: Uint8Array;
  try {
    const res = await fetch(`${config.server.url}/api/auth/salt/${encodeURIComponent(userId.trim())}`);
    if (res.status === 404) {
      console.error(chalk.red('Error: User ID not found on server.'));
      process.exit(1);
    }
    if (!res.ok) {
      console.error(chalk.red(`Error: Server returned ${res.status}.`));
      process.exit(1);
    }
    const data = (await res.json()) as { salt: string };
    salt = hexToBytes(data.salt);
  } catch (err) {
    console.error(chalk.red(`Error: Could not reach server (${err instanceof Error ? err.message : String(err)}).`));
    process.exit(1);
  }

  // Derive keys with the server-provided salt
  console.log(chalk.dim('Deriving encryption keys...'));
  const masterKey = await deriveMasterKey(passphrase, salt);
  const authKey = deriveAuthKey(masterKey);
  const vaultKey = deriveVaultKey(masterKey);
  const authHash = createAuthHash(authKey);

  // Log in
  console.log(chalk.dim('Authenticating...'));
  try {
    const res = await fetch(`${config.server.url}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ authKeyHash: authHash }),
    });

    if (res.status === 401) {
      console.error(chalk.red('Error: Incorrect passphrase for this account.'));
      process.exit(1);
    }
    if (!res.ok) {
      console.error(chalk.red(`Error: Server returned ${res.status}.`));
      process.exit(1);
    }

    const { token } = (await res.json()) as { userId: string; token: string };
    const deviceId = await registerDevice(config.server.url, token);

    // Save credentials locally
    const encryptedMasterKey = encryptString(bytesToHex(masterKey), vaultKey);
    const credentials = {
      salt: bytesToHex(salt),
      encryptedMasterKey: bytesToHex(encryptedMasterKey),
    };
    await writeFile(
      join(config.data.path, 'credentials.json'),
      JSON.stringify(credentials, null, 2),
      { mode: 0o600 },
    );
    await writeFile(
      join(config.data.path, 'auth.json'),
      JSON.stringify({ authHash, userId: userId.trim(), token, deviceId }, null, 2),
      { mode: 0o600 },
    );

    printSuccess(userId.trim(), config.server.url);
  } catch (err) {
    console.error(chalk.red(`Error: Could not reach server (${err instanceof Error ? err.message : String(err)}).`));
    process.exit(1);
  }
}

export const initCommand = new Command('init')
  .description('Set up ContextMate — create a new account or log into an existing one')
  .action(async () => {
    try {
      const configPath = getConfigPath();

      // Check if already initialized
      let alreadyInitialized = false;
      try {
        await access(configPath);
        alreadyInitialized = true;
      } catch {
        // Not initialized
      }

      // Check for existing account
      let existingUserId: string | null = null;
      if (alreadyInitialized) {
        try {
          const config = getDefaultConfig();
          const authPath = join(config.data.path, 'auth.json');
          const auth = JSON.parse(await readFile(authPath, 'utf-8'));
          if (auth.userId) existingUserId = auth.userId;
        } catch {
          // No auth file or no userId
        }

        if (existingUserId) {
          console.log('');
          console.log(chalk.bold('ContextMate is already set up.'));
          console.log(`  User ID: ${existingUserId}`);
          console.log('');
          console.log('  1. Keep current account (nothing to do)');
          console.log('  2. Log into a different account');
          console.log('  3. Create a brand new account');
          console.log('');

          const choice = await ask(chalk.bold('Choose (1, 2, or 3): '));
          console.log('');

          if (choice.trim() === '2') {
            await loginExistingAccount();
          } else if (choice.trim() === '3') {
            const confirm = await ask(
              chalk.yellow('This will create a new account and disconnect from the current one. Continue? (y/N): '),
            );
            if (confirm.toLowerCase() !== 'y') {
              console.log('Aborted.');
              return;
            }
            console.log('');
            await createNewAccount();
          } else {
            console.log('No changes made.');
          }
          return;
        }

        // Initialized but no userId (local-only setup)
        const answer = await ask(
          chalk.yellow('ContextMate is initialized but not registered. Re-initialize? (y/N): '),
        );
        if (answer.toLowerCase() !== 'y') {
          console.log('Aborted.');
          return;
        }
      }

      // Fresh setup
      console.log('');
      console.log(chalk.bold('ContextMate Setup'));
      console.log('');
      console.log('  1. Create new account');
      console.log('  2. Log into existing account');
      console.log('');

      const choice = await ask(chalk.bold('Choose (1 or 2): '));

      console.log('');

      if (choice.trim() === '2') {
        await loginExistingAccount();
      } else {
        await createNewAccount();
      }
    } catch (err) {
      console.error(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
      process.exit(1);
    }
  });
