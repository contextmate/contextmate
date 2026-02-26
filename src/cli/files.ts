import { Command } from 'commander';
import chalk from 'chalk';
import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { access, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import picomatch from 'picomatch';
import { loadConfig, getConfigDir } from '../config.js';
import { getSyncDbPath } from '../utils/paths.js';
import type { SyncFile, SyncState } from '../types.js';

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function colorState(state: string): string {
  switch (state) {
    case 'synced':
      return chalk.green(state);
    case 'modified':
      return chalk.yellow(state);
    case 'pending':
      return chalk.dim(state);
    case 'conflict':
      return chalk.red(state);
    default:
      return state;
  }
}

function formatDate(timestamp: number): string {
  const d = new Date(timestamp);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

function getAgentPrefix(filePath: string): string {
  const firstSegment = filePath.split('/')[0];
  return firstSegment ?? 'other';
}

function printFileRow(file: SyncFile): void {
  const state = colorState(file.syncState).padEnd(10 + (colorState(file.syncState).length - file.syncState.length));
  const path = file.path.padEnd(35);
  const version = String(file.version).padEnd(9);
  const size = formatSize(file.size).padEnd(11);
  const lastSynced = formatDate(file.lastModified);

  console.log(`  ${state}${path}${version}${size}${lastSynced}`);
}

function printTableHeader(): void {
  console.log(
    chalk.bold('  STATE') + '     ' +
    chalk.bold('PATH') + '                               ' +
    chalk.bold('VERSION') + '  ' +
    chalk.bold('SIZE') + '       ' +
    chalk.bold('LAST SYNCED'),
  );
  console.log(chalk.dim('  ' + '─'.repeat(86)));
}

export const filesCommand = new Command('files')
  .description('List and manage tracked files')
  .option('-s, --state <state>', 'Filter by sync state (synced, modified, pending, conflict)')
  .option('-a, --agent <agent>', 'Filter by agent prefix (openclaw, claude, skills)')
  .option('--group', 'Group files by agent prefix')
  .option('--json', 'Output as JSON')
  .action(async (opts) => {
    try {
      const configDir = getConfigDir();

      if (!(await fileExists(configDir))) {
        console.log(chalk.red('ContextMate is not initialized. Run "contextmate init" first.'));
        process.exit(1);
      }

      const config = await loadConfig();
      const dbPath = getSyncDbPath(config);

      if (!(await fileExists(dbPath))) {
        console.log(chalk.dim('No sync database found. Run a sync first.'));
        process.exit(0);
      }

      const { SyncStateDB } = await import('../sync/index.js');
      const db = new SyncStateDB(dbPath);

      let files: SyncFile[];
      if (opts.state) {
        files = db.getFilesByState(opts.state as SyncState);
      } else {
        files = db.getAllFiles();
      }

      db.close();

      // Filter by agent prefix
      if (opts.agent) {
        const prefix = opts.agent as string;
        files = files.filter((f) => f.path.startsWith(prefix));
      }

      if (files.length === 0) {
        console.log(chalk.dim('No files tracked.'));
        return;
      }

      if (opts.json) {
        console.log(JSON.stringify(files, null, 2));
        return;
      }

      console.log('');

      if (opts.group) {
        // Group by agent prefix
        const groups = new Map<string, SyncFile[]>();
        for (const file of files) {
          const prefix = getAgentPrefix(file.path);
          const group = groups.get(prefix);
          if (group) {
            group.push(file);
          } else {
            groups.set(prefix, [file]);
          }
        }

        for (const [prefix, groupFiles] of groups) {
          console.log(chalk.bold.underline(`  ${prefix}`) + chalk.dim(` (${groupFiles.length} files)`));
          console.log('');
          printTableHeader();

          for (const file of groupFiles) {
            printFileRow(file);
          }

          console.log('');
        }
      } else {
        printTableHeader();

        for (const file of files) {
          printFileRow(file);
        }

        console.log('');
      }

      // Summary
      const synced = files.filter((f) => f.syncState === 'synced').length;
      const modified = files.filter((f) => f.syncState === 'modified').length;
      const pending = files.filter((f) => f.syncState === 'pending').length;
      const conflicts = files.filter((f) => f.syncState === 'conflict').length;
      const totalSize = files.reduce((sum, f) => sum + f.size, 0);

      console.log(
        chalk.dim(`  ${files.length} files (${formatSize(totalSize)}) | `) +
        chalk.green(`${synced} synced`) + chalk.dim(' | ') +
        chalk.yellow(`${modified} modified`) + chalk.dim(' | ') +
        chalk.dim(`${pending} pending`) + chalk.dim(' | ') +
        chalk.red(`${conflicts} conflicts`),
      );
      console.log('');
    } catch (err) {
      console.error(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
      process.exit(1);
    }
  });

filesCommand
  .command('delete')
  .description('Delete files matching a pattern from vault, sync DB, and server')
  .argument('<pattern>', 'Glob pattern or exact path (e.g. "claude/**")')
  .option('-y, --yes', 'Skip confirmation prompt')
  .option('--dry-run', 'Show what would be deleted without actually deleting')
  .action(async (pattern: string, opts: { yes?: boolean; dryRun?: boolean }) => {
    try {
      const configDir = getConfigDir();

      if (!(await fileExists(configDir))) {
        console.error(chalk.red('ContextMate is not initialized. Run "contextmate init" first.'));
        process.exit(1);
      }

      const config = await loadConfig();
      const dbPath = getSyncDbPath(config);

      if (!(await fileExists(dbPath))) {
        console.log(chalk.dim('No sync database found. Nothing to delete.'));
        return;
      }

      const { SyncStateDB } = await import('../sync/index.js');
      const db = new SyncStateDB(dbPath);
      const allFiles = db.getAllFiles();

      // Match files against pattern
      const isMatch = picomatch(pattern);
      const matching = allFiles.filter((f) => isMatch(f.path) || f.path === pattern);

      if (matching.length === 0) {
        db.close();
        console.log(chalk.dim(`No tracked files match "${pattern}".`));
        return;
      }

      // Show what will be deleted
      console.log('');
      console.log(chalk.bold(`Files matching "${pattern}":`));
      console.log('');
      for (const file of matching) {
        console.log(`  ${chalk.red('×')} ${file.path}`);
      }
      console.log('');
      console.log(`  ${chalk.bold(String(matching.length))} file${matching.length === 1 ? '' : 's'} will be deleted from vault, sync DB, and server.`);
      console.log('');

      if (opts.dryRun) {
        db.close();
        console.log(chalk.dim('Dry run — no files were deleted.'));
        return;
      }

      // Confirm
      if (!opts.yes) {
        const rl = readline.createInterface({ input: stdin, output: stdout });
        const answer = await rl.question(chalk.bold.red('Type "delete" to confirm: '));
        rl.close();
        if (answer.trim() !== 'delete') {
          db.close();
          console.log('Aborted.');
          return;
        }
        console.log('');
      }

      // Load auth token for server deletion
      let authToken = '';
      try {
        const authPath = join(config.data.path, 'auth.json');
        const auth = JSON.parse(await readFile(authPath, 'utf-8'));
        authToken = auth.token || '';
      } catch {
        // No auth — skip server deletion
      }

      const { SyncClient } = await import('../sync/index.js');
      const client = authToken ? new SyncClient(config.server.url, authToken) : null;

      let deleted = 0;
      let errors = 0;

      for (const file of matching) {
        try {
          // Delete from server
          if (client) {
            try {
              await client.deleteFile(file.path);
            } catch (err) {
              console.log(chalk.yellow(`  Warning: Could not delete ${file.path} from server (${err instanceof Error ? err.message : String(err)})`));
            }
          }

          // Delete from local vault
          try {
            await unlink(join(config.vault.path, file.path));
          } catch {
            // File may not exist locally
          }

          // Delete from sync DB
          db.removeFile(file.path);
          db.addSyncLog('delete', file.path, 'Deleted via CLI');

          deleted++;
          console.log(`  ${chalk.green('✓')} ${file.path}`);
        } catch (err) {
          errors++;
          console.log(`  ${chalk.red('✗')} ${file.path}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      db.close();

      console.log('');
      console.log(
        chalk.green(`${deleted} deleted`) +
        (errors > 0 ? chalk.red(`, ${errors} failed`) : ''),
      );
      console.log('');
    } catch (err) {
      console.error(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
      process.exit(1);
    }
  });
