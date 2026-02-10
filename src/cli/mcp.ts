import { Command } from 'commander';
import chalk from 'chalk';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, access, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { loadConfig, getConfigPath } from '../config.js';
import { mcpSetupCommand } from './mcp-setup.js';
import { getSearchDbPath } from '../utils/paths.js';
import type { ApiKeyInfo, ApiPermission } from '../types.js';

async function isInitialized(): Promise<boolean> {
  try {
    await access(getConfigPath());
    return true;
  } catch {
    return false;
  }
}

function getApiKeysPath(dataPath: string): string {
  return join(dataPath, 'api-keys.json');
}

async function loadApiKeys(dataPath: string): Promise<ApiKeyInfo[]> {
  const keysPath = getApiKeysPath(dataPath);
  try {
    const raw = await readFile(keysPath, 'utf-8');
    return JSON.parse(raw) as ApiKeyInfo[];
  } catch {
    return [];
  }
}

async function saveApiKeys(dataPath: string, keys: ApiKeyInfo[]): Promise<void> {
  const keysPath = getApiKeysPath(dataPath);
  await mkdir(dirname(keysPath), { recursive: true });
  await writeFile(keysPath, JSON.stringify(keys, null, 2), 'utf-8');
}

const serveCommand = new Command('serve')
  .description('Start local MCP server')
  .option('--api-key <key-id>', 'API key ID to enforce scope/permissions')
  .action(async (opts: { apiKey?: string }) => {
    try {
      if (!(await isInitialized())) {
        console.error(chalk.red('ContextMate is not initialized. Run "contextmate init" first.'));
        process.exit(1);
      }

      const config = await loadConfig();
      const searchDbPath = getSearchDbPath(config);

      // Look up API key if provided
      let scopeOptions: { scope: string; permission: ApiPermission } | undefined;
      if (opts.apiKey) {
        const keys = await loadApiKeys(config.data.path);
        const keyInfo = keys.find((k) => k.id === opts.apiKey);
        if (!keyInfo) {
          console.error(chalk.red(`API key with ID "${opts.apiKey}" not found.`));
          process.exit(1);
        }
        scopeOptions = { scope: keyInfo.scope, permission: keyInfo.permissions };
        console.error(chalk.dim(`Enforcing scope: ${keyInfo.scope} (${keyInfo.permissions})`));
      }

      console.error(chalk.dim('Starting MCP server...'));

      // Handle graceful shutdown
      const shutdown = () => {
        console.error(chalk.dim('\nShutting down MCP server...'));
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);

      const { startMcpServer } = await import('../mcp/index.js');
      await startMcpServer(config.vault.path, searchDbPath, scopeOptions);
      console.error('MCP server running on stdio');
    } catch (err) {
      console.error(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
      process.exit(1);
    }
  });

const apiKeyCommand = new Command('api-key').description('Manage MCP API keys');

apiKeyCommand
  .command('create')
  .description('Create a scoped API key')
  .option('--name <name>', 'Name for the API key', 'default')
  .option('--scope <scope>', 'Scope pattern', '*')
  .option('--permissions <permissions>', 'Permissions: read or read-write', 'read')
  .action(async (opts: { name: string; scope: string; permissions: string }) => {
    try {
      if (!(await isInitialized())) {
        console.error(chalk.red('ContextMate is not initialized. Run "contextmate init" first.'));
        process.exit(1);
      }

      const config = await loadConfig();
      const permissions = opts.permissions as ApiPermission;
      if (permissions !== 'read' && permissions !== 'read-write') {
        console.error(chalk.red('Error: permissions must be "read" or "read-write".'));
        process.exit(1);
      }

      const keys = await loadApiKeys(config.data.path);

      const newKey: ApiKeyInfo = {
        id: randomBytes(8).toString('hex'),
        name: opts.name,
        scope: opts.scope,
        permissions,
        createdAt: Date.now(),
        lastUsed: null,
      };

      keys.push(newKey);
      await saveApiKeys(config.data.path, keys);

      console.log('');
      console.log(chalk.green('API key created:'));
      console.log(`  Name:        ${newKey.name}`);
      console.log(`  ID:          ${chalk.bold(newKey.id)}`);
      console.log(`  Scope:       ${newKey.scope}`);
      console.log(`  Permissions: ${newKey.permissions}`);
      console.log('');
      console.log(`  Use with: ${chalk.cyan(`contextmate mcp serve --api-key ${newKey.id}`)}`);
      console.log('');
    } catch (err) {
      console.error(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
      process.exit(1);
    }
  });

apiKeyCommand
  .command('list')
  .description('List API keys')
  .action(async () => {
    try {
      if (!(await isInitialized())) {
        console.error(chalk.red('ContextMate is not initialized. Run "contextmate init" first.'));
        process.exit(1);
      }

      const config = await loadConfig();
      const keys = await loadApiKeys(config.data.path);

      if (keys.length === 0) {
        console.log(chalk.dim('No API keys configured.'));
        return;
      }

      console.log('');
      console.log(chalk.bold('API Keys'));
      console.log(chalk.dim('─'.repeat(60)));

      for (const key of keys) {
        const created = new Date(key.createdAt).toISOString().slice(0, 19).replace('T', ' ');
        const lastUsed = key.lastUsed
          ? new Date(key.lastUsed).toISOString().slice(0, 19).replace('T', ' ')
          : 'never';

        console.log(`  ${chalk.bold(key.name)} (${key.id})`);
        console.log(`    Scope: ${key.scope}  Permissions: ${key.permissions}`);
        console.log(`    Created: ${created}  Last used: ${lastUsed}`);
        console.log('');
      }
    } catch (err) {
      console.error(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
      process.exit(1);
    }
  });

apiKeyCommand
  .command('revoke')
  .description('Revoke an API key')
  .argument('<id>', 'API key ID to revoke')
  .action(async (id: string) => {
    try {
      if (!(await isInitialized())) {
        console.error(chalk.red('ContextMate is not initialized. Run "contextmate init" first.'));
        process.exit(1);
      }

      const config = await loadConfig();
      const keys = await loadApiKeys(config.data.path);
      const idx = keys.findIndex((k) => k.id === id);

      if (idx === -1) {
        console.error(chalk.red(`API key with ID "${id}" not found.`));
        process.exit(1);
      }

      const removed = keys.splice(idx, 1)[0]!;
      await saveApiKeys(config.data.path, keys);

      console.log(chalk.green(`API key "${removed.name}" (${removed.id}) revoked.`));
    } catch (err) {
      console.error(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
      process.exit(1);
    }
  });

export const mcpCommand = new Command('mcp')
  .description('Manage MCP server and API keys')
  .addCommand(serveCommand)
  .addCommand(mcpSetupCommand)
  .addCommand(apiKeyCommand);
