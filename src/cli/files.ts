import { Command } from 'commander';
import chalk from 'chalk';
import { access } from 'node:fs/promises';
import { loadConfig, getConfigDir } from '../config.js';
import { getSyncDbPath } from '../utils/paths.js';
import { SyncStateDB } from '../sync/index.js';
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
  .description('List tracked files')
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
