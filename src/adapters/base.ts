import { readFile, writeFile, mkdir, copyFile, stat } from 'node:fs/promises';
import { join, dirname, relative } from 'node:path';

export interface AdapterOptions {
  vaultPath: string;
  backupsPath: string;
  scanPaths?: string[];
  extraFiles?: string[];
  extraGlobs?: string[];
  include?: string[];
}

export interface ImportResult {
  imported: string[];
  skipped: string[];
  errors: string[];
}

export interface CopyResult {
  copied: string[];
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
  abstract copyToWorkspace(workspacePath: string): Promise<CopyResult>;
  abstract verifySync(workspacePath: string): Promise<{ synced: string[]; stale: string[] }>;
  abstract disconnect(workspacePath: string): Promise<void>;
  abstract syncFromVault(workspacePath: string): Promise<{ synced: string[] }>;

  protected async backupFile(sourcePath: string, agentName: string): Promise<void> {
    const relativeSrc = relative('/', sourcePath);
    const backupDest = join(this.backupsPath, agentName, relativeSrc);
    await mkdir(dirname(backupDest), { recursive: true });
    await copyFile(sourcePath, backupDest);
  }

  protected async copyToVault(sourcePath: string, vaultRelativePath: string): Promise<void> {
    const dest = join(this.vaultPath, vaultRelativePath);
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(sourcePath, dest);
  }

  protected async copyFromVault(vaultRelativePath: string, destPath: string): Promise<void> {
    const src = join(this.vaultPath, vaultRelativePath);
    await mkdir(dirname(destPath), { recursive: true });
    await copyFile(src, destPath);
  }

  protected async filesMatch(pathA: string, pathB: string): Promise<boolean> {
    try {
      const [a, b] = await Promise.all([readFile(pathA), readFile(pathB)]);
      return Buffer.compare(a, b) === 0;
    } catch {
      return false;
    }
  }

  protected async fileExists(path: string): Promise<boolean> {
    try {
      const s = await stat(path);
      return s.isFile();
    } catch {
      return false;
    }
  }
}
