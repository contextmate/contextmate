import { Command } from 'commander';
import chalk from 'chalk';
import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { readFile, writeFile, unlink, access } from 'node:fs/promises';
import { join } from 'node:path';
import { hexToBytes } from '@noble/hashes/utils';
import { loadConfig, getConfigPath } from '../config.js';
import { getPidFilePath } from '../utils/paths.js';
import { deriveMasterKey, deriveVaultKey, decryptString } from '../crypto/index.js';

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
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const answer = await rl.question(prompt);
  rl.close();
  return answer;
}

const startCommand = new Command('start')
  .description('Start the sync daemon')
  .option('--foreground', 'Run in the foreground (default for MVP)')
  .action(async () => {
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

      // Prompt for passphrase
      const passphrase = await readPassphrase(chalk.bold('Enter passphrase: '));
      if (!passphrase) {
        console.error(chalk.red('Error: Passphrase cannot be empty.'));
        process.exit(1);
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

      // Write PID file
      await writeFile(pidFile, String(process.pid), 'utf-8');

      // Start sync engine (foreground)
      console.log(chalk.green(`Daemon started (PID: ${process.pid})`));
      console.log(chalk.dim('Press Ctrl+C to stop.'));

      const { SyncEngine } = await import('../sync/index.js');
      const engine = new SyncEngine(config, vaultKey);
      await engine.start();

      // Handle graceful shutdown
      const shutdown = async () => {
        console.log(chalk.dim('\nStopping daemon...'));
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
    } catch (err) {
      console.error(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
      process.exit(1);
    }
  });

export const daemonCommand = new Command('daemon')
  .description('Manage the sync daemon')
  .addCommand(startCommand)
  .addCommand(stopCommand)
  .addCommand(statusSubCommand);
