import { readFile, readdir, stat, unlink, copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join, relative, dirname } from 'node:path';
import picomatch from 'picomatch';
import { BaseAdapter, type AdapterOptions, type ImportResult, type SymlinkResult } from './base.js';

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

  async createSymlinks(targetPath: string): Promise<SymlinkResult> {
    this.validatePaths(targetPath);

    const result: SymlinkResult = { created: [], errors: [] };
    const vaultFiles = await this.discoverVaultFiles();

    for (const vaultRelative of vaultFiles) {
      const linkPath = join(targetPath, vaultRelative);
      const vaultFilePath = join(this.vaultPath, vaultRelative);

      try {
        await this.safeSymlink(vaultFilePath, linkPath);
        result.created.push(vaultRelative);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result.errors.push(`${vaultRelative}: ${message}`);
      }
    }

    return result;
  }

  async verifySymlinks(targetPath: string): Promise<{ valid: string[]; broken: string[] }> {
    const valid: string[] = [];
    const broken: string[] = [];
    const vaultFiles = await this.discoverVaultFiles();

    for (const vaultRelative of vaultFiles) {
      const linkPath = join(targetPath, vaultRelative);

      if (await this.isSymlink(linkPath)) {
        try {
          await stat(linkPath);
          valid.push(vaultRelative);
        } catch {
          broken.push(vaultRelative);
        }
      } else {
        broken.push(vaultRelative);
      }
    }

    return { valid, broken };
  }

  async removeSymlinks(targetPath: string): Promise<void> {
    const vaultFiles = await this.discoverVaultFiles();

    for (const vaultRelative of vaultFiles) {
      const linkPath = join(targetPath, vaultRelative);

      if (!(await this.isSymlink(linkPath))) {
        continue;
      }

      await unlink(linkPath);

      // Restore from vault copy
      try {
        const vaultFilePath = join(this.vaultPath, vaultRelative);
        await mkdir(dirname(linkPath), { recursive: true });
        await copyFile(vaultFilePath, linkPath);
      } catch {
        // Nothing to restore
      }
    }
  }

  async refreshSymlinks(targetPath: string): Promise<SymlinkResult> {
    this.validatePaths(targetPath);

    const result: SymlinkResult = { created: [], errors: [] };
    const vaultFiles = await this.discoverVaultFiles();

    for (const vaultRelative of vaultFiles) {
      const linkPath = join(targetPath, vaultRelative);

      // Skip if valid symlink already exists
      if (await this.isSymlink(linkPath)) {
        try {
          await stat(linkPath);
          continue;
        } catch {
          // Broken symlink, recreate
        }
      }

      const vaultFilePath = join(this.vaultPath, vaultRelative);

      try {
        await this.safeSymlink(vaultFilePath, linkPath);
        result.created.push(vaultRelative);
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
      const linkPath = join(targetPath, relativePath);

      // Skip if it's still a valid symlink — no editor breakage
      if (await this.isSymlink(linkPath)) continue;

      // This is a regular file where a symlink should be.
      // The editor broke the symlink on save.
      const vaultFilePath = join(this.vaultPath, relativePath);

      try {
        const targetContent = await readFile(linkPath);

        // Compare with vault — skip if identical
        try {
          const vaultContent = await readFile(vaultFilePath);
          if (Buffer.compare(targetContent, vaultContent) === 0) {
            // Content is the same, just re-create the symlink
            await unlink(linkPath);
            await this.safeSymlink(vaultFilePath, linkPath);
            continue;
          }
        } catch {
          // Vault file doesn't exist yet
        }

        // Copy changed content to vault
        await mkdir(dirname(vaultFilePath), { recursive: true });
        await writeFile(vaultFilePath, targetContent);

        // Replace the regular file with a symlink back to vault
        await unlink(linkPath);
        await this.safeSymlink(vaultFilePath, linkPath);

        synced.push(relativePath);
      } catch {
        // Skip unreadable files
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
