import { Command } from 'commander';
import chalk from 'chalk';
import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { rm, access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getConfigDir, getConfigPath, loadConfig } from '../config.js';
import { getAdapter } from '../adapters/index.js';
import { getBackupsPath } from '../utils/paths.js';

async function ask(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const answer = await rl.question(prompt);
  rl.close();
  return answer;
}

export const resetCommand = new Command('reset')
  .description('Remove all ContextMate data and symlinks from this machine')
  .action(async () => {
    try {
      const configDir = getConfigDir();
      const configPath = getConfigPath();

      // Check if initialized
      try {
        await access(configPath);
      } catch {
        console.log(chalk.dim('ContextMate is not initialized. Nothing to reset.'));
        return;
      }

      const config = await loadConfig();

      // Show what will be removed
      console.log('');
      console.log(chalk.bold.red('ContextMate Reset'));
      console.log('');
      console.log('This will:');
      console.log(`  - Remove all adapter symlinks (Claude Code, OpenClaw)`);

      // Show userId if registered
      let userId: string | null = null;
      try {
        const authPath = join(config.data.path, 'auth.json');
        const auth = JSON.parse(await readFile(authPath, 'utf-8'));
        if (auth.userId) userId = auth.userId;
      } catch {
        // No auth file
      }

      if (userId) {
        console.log(`  - Disconnect from account ${chalk.bold(userId)}`);
      }

      console.log(`  - Delete ${chalk.bold(configDir)} (vault, config, credentials)`);
      console.log('');
      console.log(chalk.yellow('Your server account will NOT be deleted.'));
      console.log(chalk.yellow('You can log back in with your User ID and passphrase.'));
      console.log('');

      const answer = await ask(chalk.bold.red('Type "reset" to confirm: '));
      if (answer.trim() !== 'reset') {
        console.log('Aborted.');
        return;
      }

      console.log('');

      // 1. Remove adapter symlinks (always attempt, regardless of enabled flag)
      const adapterOpts = {
        vaultPath: config.vault.path,
        backupsPath: getBackupsPath(),
        scanPaths: config.adapters.claude.scanPaths,
      };

      try {
        console.log(chalk.dim('Removing Claude Code symlinks...'));
        const adapter = getAdapter('claude', adapterOpts);
        await adapter.removeSymlinks(config.adapters.claude.claudeDir);
        console.log(chalk.green('  Claude Code symlinks removed.'));
      } catch (err) {
        console.log(chalk.yellow(`  Warning: Could not remove Claude symlinks (${err instanceof Error ? err.message : String(err)})`));
      }

      try {
        console.log(chalk.dim('Removing OpenClaw symlinks...'));
        const adapter = getAdapter('openclaw', adapterOpts);
        await adapter.removeSymlinks(config.adapters.openclaw.workspacePath);
        console.log(chalk.green('  OpenClaw symlinks removed.'));
      } catch (err) {
        console.log(chalk.yellow(`  Warning: Could not remove OpenClaw symlinks (${err instanceof Error ? err.message : String(err)})`));
      }

      // 2. Delete the entire ~/.contextmate directory
      console.log(chalk.dim('Deleting ContextMate data...'));
      await rm(configDir, { recursive: true, force: true });
      console.log(chalk.green('  Data deleted.'));

      console.log('');
      console.log(chalk.green.bold('ContextMate has been reset.'));
      console.log(chalk.dim('Run "contextmate init" to set up again.'));
      console.log('');
    } catch (err) {
      console.error(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
      process.exit(1);
    }
  });
