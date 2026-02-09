import { Command } from 'commander';
import chalk from 'chalk';
import { access } from 'node:fs/promises';
import { loadConfig, getConfigDir } from '../config.js';
import { getSyncDbPath } from '../utils/paths.js';

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function parseSince(value: string): number {
  // Try duration format: 1h, 2d, 7d, 30m, etc.
  const match = value.match(/^(\d+)([mhd])$/);
  if (match) {
    const amount = parseInt(match[1]!, 10);
    const unit = match[2]!;
    const now = Date.now();
    switch (unit) {
      case 'm':
        return now - amount * 60 * 1000;
      case 'h':
        return now - amount * 60 * 60 * 1000;
      case 'd':
        return now - amount * 24 * 60 * 60 * 1000;
      default:
        return now;
    }
  }

  // Try ISO 8601 date
  const date = new Date(value);
  if (!isNaN(date.getTime())) {
    return date.getTime();
  }

  throw new Error(`Invalid --since value: "${value}". Use format like "1h", "7d", or an ISO 8601 date.`);
}

function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days >= 7) {
    // Absolute date for entries older than 7 days
    const d = new Date(timestamp);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return 'just now';
}

function colorAction(action: string): string {
  switch (action) {
    case 'upload':
      return chalk.green(action);
    case 'download':
      return chalk.blue(action);
    case 'delete':
      return chalk.red(action);
    case 'conflict':
      return chalk.yellow(action);
    case 'error':
      return chalk.red.bold(action);
    default:
      return action;
  }
}

export const logCommand = new Command('log')
  .description('Show sync activity log')
  .option('-a, --action <action>', 'Filter by action (upload, download, delete, conflict, error)')
  .option('-p, --path <path>', 'Filter by path prefix')
  .option('-n, --limit <n>', 'Number of entries', '20')
  .option('--since <duration>', 'Show entries after (e.g. "1h", "7d", ISO date)')
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

      let since: number | undefined;
      if (opts.since) {
        since = parseSince(opts.since as string);
      }

      const entries = db.getSyncLog({
        action: opts.action as string | undefined,
        path: opts.path as string | undefined,
        since,
        limit: parseInt(opts.limit as string, 10),
      });

      db.close();

      if (entries.length === 0) {
        console.log(chalk.dim('No sync activity found.'));
        return;
      }

      if (opts.json) {
        console.log(JSON.stringify(entries, null, 2));
        return;
      }

      // Table output
      console.log('');
      console.log(
        chalk.bold('  TIME') + '          ' +
        chalk.bold('ACTION') + '      ' +
        chalk.bold('PATH') + '                         ' +
        chalk.bold('DETAILS'),
      );
      console.log(chalk.dim('  ' + '─'.repeat(76)));

      for (const entry of entries) {
        const time = formatRelativeTime(entry.timestamp).padEnd(14);
        const action = colorAction(entry.action).padEnd(10 + (colorAction(entry.action).length - entry.action.length));
        const path = entry.path.padEnd(29);
        const details = entry.details ?? '';

        console.log(`  ${time}${action}${path}${details}`);
      }

      console.log('');
    } catch (err) {
      console.error(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
      process.exit(1);
    }
  });
