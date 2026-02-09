import { readFile, writeFile, mkdir, symlink, readlink, stat, lstat, copyFile, unlink, access, rename } from 'node:fs/promises';
import { join, dirname, relative } from 'node:path';

export interface AdapterOptions {
  vaultPath: string;
  backupsPath: string;
}

export interface ImportResult {
  imported: string[];
  skipped: string[];
  errors: string[];
}

export interface SymlinkResult {
  created: string[];
  errors: string[];
}

export abstract class BaseAdapter {
  protected vaultPath: string;
  protected backupsPath: string;

  constructor(options: AdapterOptions) {
    this.vaultPath = options.vaultPath;
    this.backupsPath = options.backupsPath;
  }

  abstract get name(): string;
  abstract detect(): Promise<string | null>;
  abstract import(workspacePath: string): Promise<ImportResult>;
  abstract createSymlinks(workspacePath: string): Promise<SymlinkResult>;
  abstract verifySymlinks(workspacePath: string): Promise<{ valid: string[]; broken: string[] }>;
  abstract removeSymlinks(workspacePath: string): Promise<void>;

  protected async backupFile(sourcePath: string, agentName: string): Promise<void> {
    const relativeSrc = relative('/', sourcePath);
    const backupDest = join(this.backupsPath, agentName, relativeSrc);
    await mkdir(dirname(backupDest), { recursive: true });
    await copyFile(sourcePath, backupDest);
  }

  protected async safeSymlink(target: string, linkPath: string): Promise<void> {
    await mkdir(dirname(linkPath), { recursive: true });

    try {
      const linkStat = await lstat(linkPath);
      if (linkStat.isSymbolicLink()) {
        await unlink(linkPath);
      } else {
        // Regular file exists — back it up first
        await this.backupFile(linkPath, this.name);
        await unlink(linkPath);
      }
    } catch {
      // Path does not exist, nothing to remove
    }

    await symlink(target, linkPath);
  }

  protected async isSymlink(path: string): Promise<boolean> {
    try {
      const stats = await lstat(path);
      return stats.isSymbolicLink();
    } catch {
      return false;
    }
  }

  protected async copyToVault(sourcePath: string, vaultRelativePath: string): Promise<void> {
    const dest = join(this.vaultPath, vaultRelativePath);
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(sourcePath, dest);
  }
}
