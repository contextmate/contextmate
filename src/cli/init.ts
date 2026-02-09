import { Command } from 'commander';
import chalk from 'chalk';
import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { access, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { bytesToHex } from '@noble/hashes/utils';
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

async function readPassphrase(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const answer = await rl.question(prompt);
  rl.close();
  return answer;
}

export const initCommand = new Command('init')
  .description('Initialize ContextMate with a new passphrase')
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

      if (alreadyInitialized) {
        const rl = readline.createInterface({ input: stdin, output: stdout });
        const answer = await rl.question(
          chalk.yellow('ContextMate is already initialized. Re-initialize? (y/N): '),
        );
        rl.close();

        if (answer.toLowerCase() !== 'y') {
          console.log('Aborted.');
          return;
        }
      }

      // Prompt for passphrase
      const passphrase = await readPassphrase(chalk.bold('Enter passphrase: '));
      if (!passphrase) {
        console.error(chalk.red('Error: Passphrase cannot be empty.'));
        process.exit(1);
      }

      const confirmation = await readPassphrase(chalk.bold('Confirm passphrase: '));
      if (passphrase !== confirmation) {
        console.error(chalk.red('Error: Passphrases do not match.'));
        process.exit(1);
      }

      // Generate salt and derive keys
      console.log(chalk.dim('Deriving encryption keys...'));
      const salt = generateSalt();
      const masterKey = await deriveMasterKey(passphrase, salt);
      const authKey = deriveAuthKey(masterKey);
      const vaultKey = deriveVaultKey(masterKey);

      // Create directory structure
      const config = getDefaultConfig();
      await ensureDirectories(config);

      // Save config
      await saveConfig(config);

      // Save credentials (salt + encrypted master key)
      const credentialsPath = join(config.data.path, 'credentials.json');

      // Encrypt the master key with the vault key for storage
      const encryptedMasterKey = encryptString(
        bytesToHex(masterKey),
        vaultKey,
      );

      const credentials = {
        salt: bytesToHex(salt),
        encryptedMasterKey: bytesToHex(encryptedMasterKey),
      };

      await writeFile(credentialsPath, JSON.stringify(credentials, null, 2), { mode: 0o600 });

      // Create auth hash for server registration
      const authHash = createAuthHash(authKey);
      const authPath = join(config.data.path, 'auth.json');
      await writeFile(authPath, JSON.stringify({ authHash }, null, 2), { mode: 0o600 });

      console.log('');
      console.log(chalk.green('ContextMate initialized successfully!'));
      console.log('');
      console.log(chalk.bold('Next steps:'));
      console.log(`  ${chalk.cyan("contextmate adapter openclaw init")}  Sync OpenClaw workspace`);
      console.log(`  ${chalk.cyan("contextmate adapter claude init")}    Sync Claude Code skills`);
      console.log(`  ${chalk.cyan("contextmate daemon start")}           Begin syncing`);
      console.log('');
    } catch (err) {
      console.error(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
      process.exit(1);
    }
  });
