import { Command } from 'commander';
import chalk from 'chalk';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig, getConfigDir } from '../config.js';
import { getSyncDbPath, getPidFilePath } from '../utils/paths.js';

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
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

function directionLabel(direction: string): string {
  switch (direction) {
    case 'send-receive': return chalk.green('enabled');
    case 'receive-only': return chalk.yellow('receive-only');
    case 'off': return chalk.dim('disabled');
    default: return chalk.dim(direction);
  }
}

export const statusCommand = new Command('status')
  .description('Show ContextMate status')
  .action(async () => {
    try {
      const configDir = getConfigDir();

      // Check if initialized
      if (!(await fileExists(configDir))) {
        console.log(chalk.red('ContextMate is not initialized. Run "contextmate init" first.'));
        process.exit(1);
      }

      const config = await loadConfig();

      console.log('');
      console.log(chalk.bold('ContextMate Status'));
      console.log(chalk.dim('─'.repeat(40)));

      // Vault info
      console.log(`  Vault:     ${config.vault.path}`);
      console.log(`  Data:      ${config.data.path}`);
      console.log(`  Server:    ${config.server.url}`);

      // Show userId if registered
      const authFile = join(config.data.path, 'auth.json');
      if (await fileExists(authFile)) {
        try {
          const auth = JSON.parse(await readFile(authFile, 'utf-8'));
          if (auth.userId) {
            console.log(`  User ID:   ${auth.userId}`);
          } else {
            console.log(`  User ID:   ${chalk.dim('not registered (re-run "contextmate init")')}`);
          }
        } catch {
          // ignore malformed auth file
        }
      }

      // Sync state summary
      const dbPath = getSyncDbPath(config);
      if (await fileExists(dbPath)) {
        const { SyncStateDB } = await import('../sync/index.js');
        const db = new SyncStateDB(dbPath);
        const allFiles = db.getAllFiles();
        const synced = allFiles.filter((f) => f.syncState === 'synced').length;
        const pending = allFiles.filter((f) => f.syncState === 'pending' || f.syncState === 'modified').length;
        const conflicts = db.getConflicts();

        console.log('');
        console.log(chalk.bold('  Sync State'));
        console.log(`    ${chalk.green(`${synced} synced`)}  ${chalk.yellow(`${pending} pending`)}  ${chalk.red(`${conflicts.length} conflicts`)}`);

        if (conflicts.length > 0) {
          console.log('');
          console.log(chalk.red('  Conflicts:'));
          for (const conflict of conflicts) {
            console.log(`    - ${conflict.path}`);
          }
        }

        db.close();
      } else {
        console.log('');
        console.log(chalk.dim('  Sync state: No sync database found'));
      }

      // Load effective sync settings written by daemon
      let effectiveSettings: { openclaw?: string; claude?: string } | null = null;
      const effectivePath = join(config.data.path, 'effective-sync.json');
      if (await fileExists(effectivePath)) {
        try {
          effectiveSettings = JSON.parse(await readFile(effectivePath, 'utf-8'));
        } catch {
          // ignore
        }
      }

      // Adapter status
      console.log('');
      console.log(chalk.bold('  Adapters'));

      // OpenClaw
      if (effectiveSettings?.openclaw) {
        console.log(`    OpenClaw:    ${directionLabel(effectiveSettings.openclaw)}`);
      } else {
        const openclawStatus = config.adapters.openclaw.enabled
          ? chalk.green('enabled')
          : chalk.dim('disabled');
        const workspaceIds = Object.keys(config.adapters.openclaw.workspaces);
        const workspaceLabel = workspaceIds.length > 0 ? workspaceIds.join(', ') : 'none';
        console.log(`    OpenClaw:    ${openclawStatus}  (${workspaceLabel})`);
      }

      // Claude Code
      if (effectiveSettings?.claude) {
        console.log(`    Claude Code: ${directionLabel(effectiveSettings.claude)}  (${config.adapters.claude.skillsPath})`);
      } else {
        const claudeStatus = config.adapters.claude.enabled
          ? chalk.green('enabled')
          : chalk.dim('disabled');
        console.log(`    Claude Code: ${claudeStatus}  (${config.adapters.claude.skillsPath})`);
      }

      // Daemon status
      console.log('');
      console.log(chalk.bold('  Daemon'));
      const pidFile = getPidFilePath(config);
      if (await fileExists(pidFile)) {
        const pidStr = await readFile(pidFile, 'utf-8');
        const pid = parseInt(pidStr.trim(), 10);
        if (isPidRunning(pid)) {
          console.log(`    Status: ${chalk.green('running')} (PID: ${pid})`);
        } else {
          console.log(`    Status: ${chalk.red('stale PID file')} (PID: ${pid} not running)`);
        }
      } else {
        console.log(`    Status: ${chalk.dim('stopped')}`);
      }

      // MCP server config
      console.log('');
      console.log(chalk.bold('  MCP Server'));
      console.log(`    Port: ${config.mcp.port}  Host: ${config.mcp.host}`);
      console.log('');
    } catch (err) {
      console.error(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
      process.exit(1);
    }
  });
