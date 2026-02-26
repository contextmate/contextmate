import { readFile, writeFile, readdir, stat, mkdir, copyFile } from 'node:fs/promises';
import { join, relative, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import picomatch from 'picomatch';

export interface ExtraPathMapping {
  sourcePath: string;     // absolute path on disk
  vaultRelative: string;  // vault-relative path under custom/
}

export class ExtraPathsManager {
  private readonly patterns: string[];
  private readonly vaultPath: string;
  private readonly resolvedPatterns: { baseDir: string; pattern: string }[];
  // vaultRelative -> absolute source path
  private readonly mappings = new Map<string, string>();

  constructor(patterns: string[], vaultPath: string) {
    this.patterns = patterns;
    this.vaultPath = vaultPath;
    this.resolvedPatterns = this.parsePatterns();
  }

  private resolveTilde(p: string): string {
    return p.startsWith('~') ? p.replace('~', homedir()) : p;
  }

  private parsePatterns(): { baseDir: string; pattern: string }[] {
    return this.patterns.map((raw) => {
      const resolved = this.resolveTilde(raw);
      const scan = picomatch.scan(resolved);
      // scan.base is the static prefix (directory portion before any glob chars)
      const baseDir = scan.isGlob ? scan.base : dirname(resolved);
      return { baseDir, pattern: resolved };
    });
  }

  getWatchPaths(): string[] {
    const dirs = new Set<string>();
    for (const { baseDir } of this.resolvedPatterns) {
      dirs.add(baseDir);
    }
    return [...dirs];
  }

  sourceToVaultPath(absoluteSourcePath: string): string | null {
    // Check if this path matches any pattern
    for (const { baseDir, pattern } of this.resolvedPatterns) {
      const isMatch = picomatch(pattern);
      if (isMatch(absoluteSourcePath)) {
        const parentOfBase = dirname(baseDir);
        const rel = relative(parentOfBase, absoluteSourcePath);
        const vaultRelative = join('custom', rel);
        this.mappings.set(vaultRelative, absoluteSourcePath);
        return vaultRelative;
      }
    }
    return null;
  }

  getSourcePath(vaultRelative: string): string | null {
    return this.mappings.get(vaultRelative) ?? null;
  }

  async writeBackToSource(vaultRelative: string, content: Uint8Array): Promise<void> {
    const sourcePath = this.mappings.get(vaultRelative);
    if (!sourcePath) return;
    await mkdir(dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, content);
  }

  async importToVault(): Promise<{ imported: string[]; skipped: string[] }> {
    const imported: string[] = [];
    const skipped: string[] = [];
    const discovered = await this.discoverFiles();

    for (const { sourcePath, vaultRelative } of discovered) {
      const vaultDest = join(this.vaultPath, vaultRelative);

      try {
        const sourceContent = await readFile(sourcePath);

        // Check if vault already has identical content
        try {
          const existingContent = await readFile(vaultDest);
          if (Buffer.compare(sourceContent, existingContent) === 0) {
            skipped.push(vaultRelative);
            continue;
          }
        } catch {
          // Doesn't exist in vault yet
        }

        await mkdir(dirname(vaultDest), { recursive: true });
        await copyFile(sourcePath, vaultDest);
        imported.push(vaultRelative);
      } catch {
        // Source unreadable, skip
      }
    }

    return { imported, skipped };
  }

  async discoverFiles(): Promise<ExtraPathMapping[]> {
    const results: ExtraPathMapping[] = [];
    const seen = new Set<string>();

    for (const { baseDir, pattern } of this.resolvedPatterns) {
      const isMatch = picomatch(pattern);
      const scan = picomatch.scan(pattern);

      if (!scan.isGlob) {
        // Literal file path
        const resolved = resolve(pattern);
        if (seen.has(resolved)) continue;
        try {
          const s = await stat(resolved);
          if (s.isFile()) {
            const parentOfBase = dirname(baseDir);
            const rel = relative(parentOfBase, resolved);
            const vaultRelative = join('custom', rel);
            this.mappings.set(vaultRelative, resolved);
            results.push({ sourcePath: resolved, vaultRelative });
            seen.add(resolved);
          }
        } catch {
          // File doesn't exist
        }
        continue;
      }

      // Walk the base directory and match
      const matches = await this.walkAndMatch(baseDir, isMatch);
      const parentOfBase = dirname(baseDir);

      for (const absolutePath of matches) {
        if (seen.has(absolutePath)) continue;
        const rel = relative(parentOfBase, absolutePath);
        const vaultRelative = join('custom', rel);
        this.mappings.set(vaultRelative, absolutePath);
        results.push({ sourcePath: absolutePath, vaultRelative });
        seen.add(absolutePath);
      }
    }

    return results;
  }

  private async walkAndMatch(
    dir: string,
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
          matches.push(...await this.walkAndMatch(full, isMatch));
        } else if (s.isFile()) {
          if (isMatch(full)) {
            matches.push(full);
          }
        }
      } catch {
        // Skip inaccessible
      }
    }
    return matches;
  }
}
