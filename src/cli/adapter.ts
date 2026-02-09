import { Command } from 'commander';
import chalk from 'chalk';
import { loadConfig, saveConfig, getConfigPath } from '../config.js';
import { getAdapter } from '../adapters/index.js';
import { getBackupsPath } from '../utils/paths.js';
import { access } from 'node:fs/promises';

async function isInitialized(): Promise<boolean> {
  try {
    await access(getConfigPath());
    return true;
  } catch {
    return false;
  }
}

function countByPrefix(items: string[], prefix: string): number {
  return items.filter((i) => i.startsWith(prefix)).length;
}

function createAdapterSubcommands(agentName: string, displayName: string): Command {
  const cmd = new Command(agentName).description(`Manage ${displayName} adapter`);

  cmd
    .command('init')
    .description(`Import and symlink ${displayName} workspace`)
    .action(async () => {
      try {
        if (!(await isInitialized())) {
          console.error(chalk.red('ContextMate is not initialized. Run "contextmate init" first.'));
          process.exit(1);
        }

        const config = await loadConfig();
        const adapter = getAdapter(agentName, {
          vaultPath: config.vault.path,
          backupsPath: getBackupsPath(),
        });

        // Detect workspace
        console.log(chalk.dim(`Detecting ${displayName} workspace...`));
        const workspacePath = await adapter.detect();

        if (!workspacePath) {
          console.error(chalk.red(`Could not detect ${displayName} workspace.`));
          if (agentName === 'openclaw') {
            console.error(chalk.dim('  Expected at: ~/.openclaw/workspace'));
          } else {
            console.error(chalk.dim('  Expected at: ~/.claude'));
          }
          process.exit(1);
        }

        console.log(`  Found: ${workspacePath}`);

        // Import files
        console.log(chalk.dim('Importing files to vault...'));
        const importResult = await adapter.import(workspacePath);

        if (agentName === 'claude') {
          const skills = countByPrefix(importResult.imported, 'skills/');
          const rules = countByPrefix(importResult.imported, 'claude/rules/');
          const claudeMd = importResult.imported.includes('claude/CLAUDE.md') ? 1 : 0;
          const memories = countByPrefix(importResult.imported, 'claude/projects/');
          console.log(
            `  Found: ${skills} skills, ${rules} rules, ${memories} project memory files` +
            (claudeMd ? ', CLAUDE.md' : ''),
          );
        }

        console.log(
          `  ${chalk.green(`${importResult.imported.length} imported`)}, ` +
          `${chalk.dim(`${importResult.skipped.length} skipped`)}`,
        );

        if (importResult.errors.length > 0) {
          for (const err of importResult.errors) {
            console.log(`  ${chalk.red('Error:')} ${err}`);
          }
        }

        // Create symlinks
        console.log(chalk.dim('Creating symlinks...'));
        const symlinkResult = await adapter.createSymlinks(workspacePath);

        console.log(`  ${chalk.green(`${symlinkResult.created.length} symlinks created`)}`);

        if (symlinkResult.errors.length > 0) {
          for (const err of symlinkResult.errors) {
            console.log(`  ${chalk.red('Error:')} ${err}`);
          }
        }

        // Update config
        if (agentName === 'openclaw') {
          config.adapters.openclaw.enabled = true;
          config.adapters.openclaw.workspacePath = workspacePath;
        } else {
          config.adapters.claude.enabled = true;
          config.adapters.claude.claudeDir = workspacePath;
        }
        await saveConfig(config);

        console.log('');
        console.log(chalk.green(`${displayName} adapter initialized successfully.`));
      } catch (err) {
        console.error(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
      }
    });

  cmd
    .command('status')
    .description(`Show ${displayName} symlink status`)
    .action(async () => {
      try {
        if (!(await isInitialized())) {
          console.error(chalk.red('ContextMate is not initialized. Run "contextmate init" first.'));
          process.exit(1);
        }

        const config = await loadConfig();
        const adapter = getAdapter(agentName, {
          vaultPath: config.vault.path,
          backupsPath: getBackupsPath(),
        });

        const isEnabled =
          agentName === 'openclaw'
            ? config.adapters.openclaw.enabled
            : config.adapters.claude.enabled;

        if (!isEnabled) {
          console.log(chalk.dim(`${displayName} adapter is not enabled.`));
          console.log(chalk.dim(`Run "contextmate adapter ${agentName} init" to set it up.`));
          return;
        }

        const workspacePath =
          agentName === 'openclaw'
            ? config.adapters.openclaw.workspacePath
            : config.adapters.claude.claudeDir;

        const result = await adapter.verifySymlinks(workspacePath);

        console.log('');
        console.log(chalk.bold(`${displayName} Adapter Status`));
        console.log(chalk.dim('─'.repeat(40)));
        console.log(`  Workspace: ${workspacePath}`);
        console.log(`  Valid symlinks:  ${chalk.green(String(result.valid.length))}`);
        console.log(`  Broken symlinks: ${chalk.red(String(result.broken.length))}`);

        if (result.broken.length > 0) {
          console.log('');
          console.log(chalk.red('  Broken:'));
          for (const b of result.broken) {
            console.log(`    - ${b}`);
          }
        }
        console.log('');
      } catch (err) {
        console.error(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
      }
    });

  cmd
    .command('remove')
    .description(`Remove ${displayName} symlinks and restore originals`)
    .action(async () => {
      try {
        if (!(await isInitialized())) {
          console.error(chalk.red('ContextMate is not initialized. Run "contextmate init" first.'));
          process.exit(1);
        }

        const config = await loadConfig();
        const adapter = getAdapter(agentName, {
          vaultPath: config.vault.path,
          backupsPath: getBackupsPath(),
        });

        const isEnabled =
          agentName === 'openclaw'
            ? config.adapters.openclaw.enabled
            : config.adapters.claude.enabled;

        if (!isEnabled) {
          console.log(chalk.dim(`${displayName} adapter is not enabled.`));
          return;
        }

        const workspacePath =
          agentName === 'openclaw'
            ? config.adapters.openclaw.workspacePath
            : config.adapters.claude.claudeDir;

        console.log(chalk.dim('Removing symlinks and restoring originals...'));
        await adapter.removeSymlinks(workspacePath);

        // Update config
        if (agentName === 'openclaw') {
          config.adapters.openclaw.enabled = false;
        } else {
          config.adapters.claude.enabled = false;
        }
        await saveConfig(config);

        console.log(chalk.green(`${displayName} adapter removed.`));
      } catch (err) {
        console.error(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
      }
    });

  return cmd;
}

export const adapterCommand = new Command('adapter')
  .description('Manage agent adapters')
  .addCommand(createAdapterSubcommands('openclaw', 'OpenClaw'))
  .addCommand(createAdapterSubcommands('claude', 'Claude Code'));
