import { readFile, readdir, access, stat, unlink, copyFile, mkdir } from 'node:fs/promises';
import { join, relative, dirname } from 'node:path';
import { homedir } from 'node:os';
import picomatch from 'picomatch';
import { BaseAdapter, type AdapterOptions, type ImportResult, type SymlinkResult } from './base.js';

export class OpenClawAdapter extends BaseAdapter {
  private extraFiles: string[];
  private extraGlobs: string[];

  constructor(options: AdapterOptions) {
    super(options);
    this.extraFiles = options.extraFiles ?? [];
    this.extraGlobs = options.extraGlobs ?? [];
  }

  get name(): string {
    return 'openclaw';
  }

  async detect(): Promise<string | null> {
    const workspacePath = join(homedir(), '.openclaw', 'workspace');
    try {
      await access(workspacePath);
      return workspacePath;
    } catch {
      return null;
    }
  }

  async import(workspacePath: string): Promise<ImportResult> {
    const result: ImportResult = { imported: [], skipped: [], errors: [] };
    const filesToImport = await this.discoverFiles(workspacePath);

    for (const filePath of filesToImport) {
      const relativeSrc = relative(workspacePath, filePath);
      const vaultRelative = join('openclaw', relativeSrc);

      try {
        const sourceContent = await readFile(filePath, 'utf-8');

        // Check if file already exists in vault with same content
        const vaultDest = join(this.vaultPath, vaultRelative);
        try {
          const existingContent = await readFile(vaultDest, 'utf-8');
          if (existingContent === sourceContent) {
            result.skipped.push(vaultRelative);
            continue;
          }
        } catch {
          // File doesn't exist in vault yet
        }

        await this.copyToVault(filePath, vaultRelative);
        result.imported.push(vaultRelative);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result.errors.push(`${relativeSrc}: ${message}`);
      }
    }

    return result;
  }

  async createSymlinks(workspacePath: string): Promise<SymlinkResult> {
    const result: SymlinkResult = { created: [], errors: [] };
    const filesToLink = await this.discoverFiles(workspacePath);

    for (const filePath of filesToLink) {
      const relativeSrc = relative(workspacePath, filePath);
      const vaultRelative = join('openclaw', relativeSrc);
      const vaultPath = join(this.vaultPath, vaultRelative);

      try {
        if (!(await this.isSymlink(filePath))) {
          await this.backupFile(filePath, 'openclaw');
        }

        await this.safeSymlink(vaultPath, filePath);
        result.created.push(relativeSrc);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result.errors.push(`${relativeSrc}: ${message}`);
      }
    }

    return result;
  }

  async verifySymlinks(workspacePath: string): Promise<{ valid: string[]; broken: string[] }> {
    const valid: string[] = [];
    const broken: string[] = [];
    const filesToCheck = await this.discoverFiles(workspacePath);

    for (const filePath of filesToCheck) {
      const relativeSrc = relative(workspacePath, filePath);

      if (await this.isSymlink(filePath)) {
        try {
          await stat(filePath);
          valid.push(relativeSrc);
        } catch {
          broken.push(relativeSrc);
        }
      } else {
        broken.push(relativeSrc);
      }
    }

    return { valid, broken };
  }

  async removeSymlinks(workspacePath: string): Promise<void> {
    const filesToRestore = await this.discoverVaultFiles();

    for (const vaultRelative of filesToRestore) {
      const relativeSrc = vaultRelative.replace(/^openclaw\//, '');
      const originalPath = join(workspacePath, relativeSrc);

      if (!(await this.isSymlink(originalPath))) {
        continue;
      }

      await unlink(originalPath);

      // Try to restore from backup
      const backupPath = join(this.backupsPath, 'openclaw', relative('/', originalPath));
      try {
        await mkdir(dirname(originalPath), { recursive: true });
        await copyFile(backupPath, originalPath);
      } catch {
        // No backup -- move vault file back
        const vaultFilePath = join(this.vaultPath, vaultRelative);
        try {
          await copyFile(vaultFilePath, originalPath);
        } catch {
          // Vault file also missing
        }
      }
    }
  }

  private async discoverFiles(workspacePath: string): Promise<string[]> {
    const files: string[] = [];

    const topLevelFiles = ['MEMORY.md', 'IDENTITY.md', 'USER.md', 'SOUL.md'];
    for (const name of topLevelFiles) {
      const filePath = join(workspacePath, name);
      try {
        await access(filePath);
        files.push(filePath);
      } catch {
        // File doesn't exist
      }
    }

    // skills/*/SKILL.md
    try {
      const skillsDir = join(workspacePath, 'skills');
      const skillNames = await readdir(skillsDir);
      for (const name of skillNames) {
        const skillPath = join(skillsDir, name);
        const s = await stat(skillPath);
        if (s.isDirectory()) {
          const skillFile = join(skillPath, 'SKILL.md');
          try {
            await access(skillFile);
            files.push(skillFile);
          } catch {
            // No SKILL.md
          }
        }
      }
    } catch {
      // No skills directory
    }

    // memory/*.md
    try {
      const memoryDir = join(workspacePath, 'memory');
      const memoryNames = await readdir(memoryDir);
      for (const name of memoryNames) {
        if (name.endsWith('.md')) {
          const memPath = join(memoryDir, name);
          const s = await stat(memPath);
          if (s.isFile()) {
            files.push(memPath);
          }
        }
      }
    } catch {
      // No memory directory
    }

    // Extra files from config
    for (const name of this.extraFiles) {
      const filePath = join(workspacePath, name);
      try {
        await access(filePath);
        if (!files.includes(filePath)) {
          files.push(filePath);
        }
      } catch {
        // File doesn't exist, skip
      }
    }

    // Extra globs from config
    if (this.extraGlobs.length > 0) {
      const isMatch = picomatch(this.extraGlobs);
      const globMatches = await this.walkAndMatch(workspacePath, workspacePath, isMatch);
      for (const fp of globMatches) {
        if (!files.includes(fp)) {
          files.push(fp);
        }
      }
    }

    return files;
  }

  private async walkAndMatch(
    dir: string,
    base: string,
    isMatch: (path: string) => boolean,
  ): Promise<string[]> {
    const matches: string[] = [];
    let entries;
    try {
      entries = await readdir(dir);
    } catch {
      return matches;
    }
    for (const name of entries) {
      if (name.startsWith('.') || name === 'node_modules') continue;
      const full = join(dir, name);
      try {
        const s = await stat(full);
        if (s.isDirectory()) {
          matches.push(...await this.walkAndMatch(full, base, isMatch));
        } else if (s.isFile()) {
          const rel = relative(base, full);
          if (isMatch(rel)) {
            matches.push(full);
          }
        }
      } catch {
        // Skip inaccessible
      }
    }
    return matches;
  }

  private async discoverVaultFiles(): Promise<string[]> {
    const files: string[] = [];
    const openclawVault = join(this.vaultPath, 'openclaw');

    const walkDir = async (dir: string, baseDir: string): Promise<void> => {
      try {
        const names = await readdir(dir);
        for (const name of names) {
          const fullPath = join(dir, name);
          const s = await stat(fullPath);
          if (s.isDirectory()) {
            await walkDir(fullPath, baseDir);
          } else if (s.isFile() && name.endsWith('.md')) {
            const rel = relative(baseDir, fullPath);
            files.push(join('openclaw', rel));
          }
        }
      } catch {
        // Directory doesn't exist or not readable
      }
    };

    await walkDir(openclawVault, openclawVault);
    return files;
  }
}
