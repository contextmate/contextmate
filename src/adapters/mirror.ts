import { readFile, readdir, stat, copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join, relative, dirname } from 'node:path';
import picomatch from 'picomatch';
import { BaseAdapter, type AdapterOptions, type ImportResult, type CopyResult } from './base.js';

export class MirrorAdapter extends BaseAdapter {
  private include: string[];

  constructor(options: AdapterOptions) {
    super(options);
    this.include = options.include ?? [];
  }

  get name(): string {
    return 'mirror';
  }

  async detect(): Promise<string | null> {
    // Mirror adapter is not auto-detectable; user specifies the path.
    return null;
  }

  async import(targetPath: string): Promise<ImportResult> {
    const result: ImportResult = { imported: [], skipped: [], errors: [] };
    let files = await this.walkDir(targetPath, targetPath);

    if (this.include.length > 0) {
      const isMatch = picomatch(this.include);
      files = files.filter((f) => isMatch(f));
    }

    for (const relativeSrc of files) {
      try {
        const sourceContent = await readFile(join(targetPath, relativeSrc), 'utf-8');

        const vaultDest = join(this.vaultPath, relativeSrc);
        try {
          const existingContent = await readFile(vaultDest, 'utf-8');
          if (existingContent === sourceContent) {
            result.skipped.push(relativeSrc);
            continue;
          }
        } catch {
          // File doesn't exist in vault yet
        }

        await this.copyToVault(join(targetPath, relativeSrc), relativeSrc);
        result.imported.push(relativeSrc);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result.errors.push(`${relativeSrc}: ${message}`);
      }
    }

    return result;
  }

  async copyToWorkspace(targetPath: string): Promise<CopyResult> {
    this.validatePaths(targetPath);

    const result: CopyResult = { copied: [], errors: [] };
    const vaultFiles = await this.discoverVaultFiles();

    for (const vaultRelative of vaultFiles) {
      const destPath = join(targetPath, vaultRelative);
      const vaultFilePath = join(this.vaultPath, vaultRelative);

      try {
        if (await this.filesMatch(vaultFilePath, destPath)) {
          continue;
        }

        await mkdir(dirname(destPath), { recursive: true });
        await copyFile(vaultFilePath, destPath);
        result.copied.push(vaultRelative);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result.errors.push(`${vaultRelative}: ${message}`);
      }
    }

    return result;
  }

  async verifySync(targetPath: string): Promise<{ synced: string[]; stale: string[] }> {
    const synced: string[] = [];
    const stale: string[] = [];
    const vaultFiles = await this.discoverVaultFiles();

    for (const vaultRelative of vaultFiles) {
      const targetFile = join(targetPath, vaultRelative);
      const vaultFile = join(this.vaultPath, vaultRelative);

      if (await this.filesMatch(targetFile, vaultFile)) {
        synced.push(vaultRelative);
      } else {
        stale.push(vaultRelative);
      }
    }

    return { synced, stale };
  }

  async disconnect(_targetPath: string): Promise<void> {
    // Workspace files are real copies — nothing to restore.
  }

  async refreshCopies(targetPath: string): Promise<CopyResult> {
    this.validatePaths(targetPath);

    const result: CopyResult = { copied: [], errors: [] };
    const vaultFiles = await this.discoverVaultFiles();

    for (const vaultRelative of vaultFiles) {
      const destPath = join(targetPath, vaultRelative);
      const vaultFilePath = join(this.vaultPath, vaultRelative);

      try {
        // Skip if already in sync
        if (await this.filesMatch(vaultFilePath, destPath)) {
          continue;
        }

        await mkdir(dirname(destPath), { recursive: true });
        await copyFile(vaultFilePath, destPath);
        result.copied.push(vaultRelative);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result.errors.push(`${vaultRelative}: ${message}`);
      }
    }

    return result;
  }

  async syncBack(targetPath: string): Promise<{ synced: string[] }> {
    const synced: string[] = [];
    const targetFiles = await this.walkDir(targetPath, targetPath);

    for (const relativePath of targetFiles) {
      const filePath = join(targetPath, relativePath);
      const vaultFilePath = join(this.vaultPath, relativePath);

      try {
        const targetContent = await readFile(filePath);

        // Compare with vault — skip if identical
        try {
          const vaultContent = await readFile(vaultFilePath);
          if (Buffer.compare(targetContent, vaultContent) === 0) {
            continue;
          }
        } catch {
          // Vault file doesn't exist yet
        }

        // Copy changed content to vault
        await mkdir(dirname(vaultFilePath), { recursive: true });
        await writeFile(vaultFilePath, targetContent);

        synced.push(relativePath);
      } catch {
        // Skip unreadable files
      }
    }

    return { synced };
  }

  async syncFromVault(targetPath: string): Promise<{ synced: string[] }> {
    const synced: string[] = [];
    const vaultFiles = await this.discoverVaultFiles();

    for (const vaultRelative of vaultFiles) {
      const destPath = join(targetPath, vaultRelative);
      const vaultFilePath = join(this.vaultPath, vaultRelative);

      try {
        if (await this.filesMatch(vaultFilePath, destPath)) {
          continue;
        }

        await mkdir(dirname(destPath), { recursive: true });
        await copyFile(vaultFilePath, destPath);
        synced.push(vaultRelative);
      } catch {
        // Skip errors
      }
    }

    return { synced };
  }

  private async discoverVaultFiles(): Promise<string[]> {
    const allFiles = await this.walkDir(this.vaultPath, this.vaultPath);

    if (this.include.length === 0) {
      return allFiles;
    }

    const isMatch = picomatch(this.include);
    return allFiles.filter((f) => isMatch(f));
  }

  private async walkDir(dir: string, base: string): Promise<string[]> {
    const paths: string[] = [];
    let entries;
    try {
      entries = await readdir(dir);
    } catch {
      return paths;
    }
    for (const name of entries) {
      if (name.startsWith('.') || name === 'node_modules') continue;
      const full = join(dir, name);
      try {
        const s = await stat(full);
        if (s.isDirectory()) {
          paths.push(...(await this.walkDir(full, base)));
        } else if (s.isFile()) {
          paths.push(relative(base, full));
        }
      } catch {
        // Skip inaccessible
      }
    }
    return paths;
  }

  private validatePaths(targetPath: string): void {
    const resolvedTarget = join(targetPath, '/');
    const resolvedVault = join(this.vaultPath, '/');
    if (resolvedTarget.startsWith(resolvedVault) || resolvedVault.startsWith(resolvedTarget)) {
      throw new Error('Mirror target cannot be inside the vault, or vice versa.');
    }
  }
}
