import { Command } from 'commander';
import chalk from 'chalk';
import * as readline from 'node:readline/promises';
import { Writable } from 'node:stream';
import { stdin, stdout } from 'node:process';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { loadConfig, saveConfig, getConfigPath, type ContextMateConfig } from '../config.js';
import { getAdapter } from '../adapters/index.js';
import { getBackupsPath } from '../utils/paths.js';
import { deriveMasterKey, deriveVaultKey, encryptString } from '../crypto/index.js';

async function isInitialized(): Promise<boolean> {
  try {
    await access(getConfigPath());
    return true;
  } catch {
    return false;
  }
}

async function ask(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const answer = await rl.question(prompt);
  rl.close();
  return answer;
}

async function askSecret(prompt: string): Promise<string> {
  stdout.write(prompt);
  const muted = new Writable({ write(_chunk, _enc, cb) { cb(); } });
  const rl = readline.createInterface({ input: stdin, output: muted, terminal: true });
  const answer = await rl.question('');
  rl.close();
  stdout.write('\n');
  return answer;
}

async function promptScanPaths(config: ContextMateConfig): Promise<boolean> {
  if (config.adapters.claude.scanPaths.length > 0) return false;

  console.log('');
  console.log(chalk.bold('Scan for project-specific skills?'));
  console.log(chalk.dim('  ContextMate can scan your project directories for skills'));
  console.log(chalk.dim('  stored in .claude/skills/ folders inside each repo.'));
  console.log('');

  const path = await ask(chalk.bold('Directory to scan (e.g. ~/Developer), or press Enter to skip: '));
  const trimmed = path.trim();

  if (!trimmed) return false;

  // Expand ~ to home directory
  const { homedir } = await import('node:os');
  const resolved = trimmed.startsWith('~') ? trimmed.replace('~', homedir()) : trimmed;

  config.adapters.claude.scanPaths = [resolved];
  await saveConfig(config);
  console.log(chalk.green(`  Scan path added: ${resolved}`));
  console.log('');
  return true;
}

async function pushDeviceSettings(config: ContextMateConfig): Promise<void> {
  // Load auth info
  let auth: { token?: string; deviceId?: string };
  try {
    auth = JSON.parse(await readFile(join(config.data.path, 'auth.json'), 'utf-8'));
  } catch {
    return; // No auth info available
  }

  if (!auth.token || !auth.deviceId) return;

  // Ask for passphrase to encrypt settings
  console.log('');
  console.log(chalk.dim('Sync settings to the server so you can manage them from the web dashboard.'));
  const passphrase = await askSecret(chalk.bold('Passphrase (or press Enter to skip): '));
  if (!passphrase) {
    console.log(chalk.dim('  Skipped. You can sync settings later from the web dashboard.'));
    return;
  }

  // Load salt and derive vault key
  let credentials: { salt: string };
  try {
    credentials = JSON.parse(await readFile(join(config.data.path, 'credentials.json'), 'utf-8'));
  } catch {
    console.log(chalk.yellow('  Could not load credentials. Skipping settings sync.'));
    return;
  }

  try {
    const salt = hexToBytes(credentials.salt);
    const masterKey = await deriveMasterKey(passphrase, salt);
    const vaultKey = deriveVaultKey(masterKey);

    // Build settings payload
    const settings = {
      scanPaths: config.adapters.claude.scanPaths,
      adapters: {
        claude: config.adapters.claude.enabled,
        openclaw: config.adapters.openclaw.enabled,
      },
    };

    const encrypted = encryptString(JSON.stringify(settings), vaultKey);
    const encryptedHex = bytesToHex(encrypted);

    // Push to server
    const res = await fetch(`${config.server.url}/api/auth/devices/${auth.deviceId}/settings`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${auth.token}`,
      },
      body: JSON.stringify({ encryptedSettings: encryptedHex }),
    });

    if (res.ok) {
      console.log(chalk.green('  Settings synced to server.'));
    } else {
      console.log(chalk.yellow(`  Server returned ${res.status}. Settings saved locally only.`));
    }
  } catch (err) {
    console.log(chalk.yellow(`  Could not sync settings: ${err instanceof Error ? err.message : String(err)}`));
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
        let adapter = getAdapter(agentName, {
          vaultPath: config.vault.path,
          backupsPath: getBackupsPath(),
          scanPaths: config.adapters.claude.scanPaths,
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

        // Prompt for scan paths (Claude adapter only, first time)
        if (agentName === 'claude') {
          const changed = await promptScanPaths(config);
          if (changed) {
            // Recreate adapter with updated scanPaths
            adapter = getAdapter(agentName, {
              vaultPath: config.vault.path,
              backupsPath: getBackupsPath(),
              scanPaths: config.adapters.claude.scanPaths,
            });
          }
        }

        // Import files
        console.log(chalk.dim('Importing files to vault...'));
        const importResult = await adapter.import(workspacePath);

        if (agentName === 'claude') {
          const newSkills = countByPrefix(importResult.imported, 'skills/');
          const existingSkills = countByPrefix(importResult.skipped, 'skills/');
          const totalSkills = newSkills + existingSkills;
          const newRules = countByPrefix(importResult.imported, 'claude/rules/');
          const existingRules = countByPrefix(importResult.skipped, 'claude/rules/');
          const totalRules = newRules + existingRules;
          const memories = countByPrefix(importResult.imported, 'claude/projects/') +
            countByPrefix(importResult.skipped, 'claude/projects/');
          console.log(
            `  ${totalSkills} skills, ${totalRules} rules, ${memories} project memory files`,
          );
        }

        console.log(
          `  ${chalk.green(`${importResult.imported.length} new`)}, ` +
          `${chalk.dim(`${importResult.skipped.length} unchanged`)}`,
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

        // Push settings to server for web dashboard management
        await pushDeviceSettings(config);

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
          scanPaths: config.adapters.claude.scanPaths,
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
          scanPaths: config.adapters.claude.scanPaths,
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
