import { join, relative } from 'node:path';
import { homedir } from 'node:os';
import type { ContextMateConfig } from '../config.js';

export function getVaultPath(config: ContextMateConfig): string {
  return config.vault.path;
}

export function getDataPath(config: ContextMateConfig): string {
  return config.data.path;
}

export function getBackupsPath(): string {
  return join(homedir(), '.contextmate', 'backups');
}

export function getSyncDbPath(config: ContextMateConfig): string {
  return join(config.data.path, 'sync.db');
}

export function getSearchDbPath(config: ContextMateConfig): string {
  return join(config.data.path, 'search.db');
}

export function getPidFilePath(config: ContextMateConfig): string {
  return join(config.data.path, 'daemon.pid');
}

export function relativePath(vaultPath: string, absolutePath: string): string {
  return relative(vaultPath, absolutePath);
}
