import { readFile, readdir, access, stat, mkdir, writeFile, copyFile } from 'node:fs/promises';
import { join, relative, dirname } from 'node:path';
import { homedir } from 'node:os';
import picomatch from 'picomatch';
import { BaseAdapter, type AdapterOptions, type ImportResult, type CopyResult } from './base.js';

const DEFAULT_EXCLUDE = [
  'node_modules/**',
  '.git/**',
  '.vercel/**',
  '__pycache__/**',
  '*.db',
  '*.sqlite',
];

const DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

// Directories under ~/.openclaw/ that should never be synced
const OPENCLAW_SKIP_DIRS = new Set([
  'credentials',
  'browser',
  'media',
  'telegram',
]);

export interface OpenClawWorkspace {
  id: string;
  name?: string;
  workspace: string;
  default?: boolean;
}

export function getOpenClawRoot(): string {
  return join(homedir(), '.openclaw');
}

export async function discoverWorkspaces(): Promise<OpenClawWorkspace[]> {
  const configPath = join(getOpenClawRoot(), 'openclaw.json');
  try {
    const raw = await readFile(configPath, 'utf-8');
    const config = JSON.parse(raw) as {
      agents?: {
        defaults?: { workspace?: string };
        list?: Array<{ id: string; name?: string; default?: boolean; workspace?: string }>;
      };
    };

    const agents = config.agents?.list ?? [];
    if (agents.length === 0) {
      const defaultWorkspace = config.agents?.defaults?.workspace ?? join(getOpenClawRoot(), 'workspace');
      return [{ id: 'main', workspace: defaultWorkspace, default: true }];
    }

    const defaultWorkspace = config.agents?.defaults?.workspace ?? join(getOpenClawRoot(), 'workspace');
    return agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      workspace: agent.workspace ?? (agent.default ? defaultWorkspace : ''),
      default: agent.default,
    })).filter((a) => a.workspace);
  } catch {
    const defaultPath = join(getOpenClawRoot(), 'workspace');
    try {
      await access(defaultPath);
      return [{ id: 'main', workspace: defaultPath, default: true }];
    } catch {
      return [];
    }
  }
}

// ─── Workspace Adapter (one per agent workspace) ───

export class OpenClawAdapter extends BaseAdapter {
  private agentId: string;
  private excludePatterns: string[];
  private maxFileSizeBytes: number;

  constructor(options: AdapterOptions) {
    super(options);
    this.agentId = options.agentId ?? 'main';
    this.excludePatterns = options.exclude ?? DEFAULT_EXCLUDE;
    this.maxFileSizeBytes = options.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE;
  }

  get name(): string {
    return 'openclaw';
  }

  private get vaultPrefix(): string {
    return join('openclaw', this.agentId);
  }

  async detect(): Promise<string | null> {
    const workspaces = await discoverWorkspaces();
    const match = workspaces.find((w) => w.id === this.agentId);
    if (match) {
      try {
        await access(match.workspace);
        return match.workspace;
      } catch {
        return null;
      }
    }
    return null;
  }

  async import(workspacePath: string): Promise<ImportResult> {
    const result: ImportResult = { imported: [], skipped: [], errors: [] };
    const filesToImport = await this.discoverFiles(workspacePath);

    for (const filePath of filesToImport) {
      const relativeSrc = relative(workspacePath, filePath);
      const vaultRelative = join(this.vaultPrefix, relativeSrc);

      try {
        const sourceContent = await readFile(filePath);
        const vaultDest = join(this.vaultPath, vaultRelative);
        try {
          const existingContent = await readFile(vaultDest);
          if (Buffer.compare(sourceContent, existingContent) === 0) {
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

  async copyToWorkspace(workspacePath: string): Promise<CopyResult> {
    const result: CopyResult = { copied: [], errors: [] };
    const vaultFiles = await this.discoverVaultFiles();
    const prefix = this.vaultPrefix + '/';

    for (const vaultRelative of vaultFiles) {
      const relativeSrc = vaultRelative.slice(prefix.length);
      const destPath = join(workspacePath, relativeSrc);
      const vaultFilePath = join(this.vaultPath, vaultRelative);

      try {
        if (await this.filesMatch(vaultFilePath, destPath)) {
          continue;
        }

        await mkdir(dirname(destPath), { recursive: true });
        await copyFile(vaultFilePath, destPath);
        result.copied.push(relativeSrc);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result.errors.push(`${relativeSrc}: ${message}`);
      }
    }

    return result;
  }

  async verifySync(workspacePath: string): Promise<{ synced: string[]; stale: string[] }> {
    const synced: string[] = [];
    const stale: string[] = [];
    const vaultFiles = await this.discoverVaultFiles();
    const prefix = this.vaultPrefix + '/';

    for (const vaultRelative of vaultFiles) {
      const relativeSrc = vaultRelative.slice(prefix.length);
      const workspaceFile = join(workspacePath, relativeSrc);
      const vaultFile = join(this.vaultPath, vaultRelative);

      if (await this.filesMatch(workspaceFile, vaultFile)) {
        synced.push(relativeSrc);
      } else {
        stale.push(relativeSrc);
      }
    }

    return { synced, stale };
  }

  async disconnect(_workspacePath: string): Promise<void> {
    // Workspace files are real copies — nothing to restore.
  }

  async syncBack(workspacePath: string): Promise<{ synced: string[] }> {
    const synced: string[] = [];
    const filesToCheck = await this.discoverFiles(workspacePath);

    for (const filePath of filesToCheck) {
      const relativeSrc = relative(workspacePath, filePath);
      const vaultRelative = join(this.vaultPrefix, relativeSrc);
      const vaultFilePath = join(this.vaultPath, vaultRelative);

      try {
        const workspaceContent = await readFile(filePath);

        try {
          const vaultContent = await readFile(vaultFilePath);
          if (Buffer.compare(workspaceContent, vaultContent) === 0) {
            continue;
          }
        } catch {
          // Vault file doesn't exist yet
        }

        await mkdir(dirname(vaultFilePath), { recursive: true });
        await writeFile(vaultFilePath, workspaceContent);

        synced.push(vaultRelative);
      } catch {
        // Skip unreadable files
      }
    }

    return { synced };
  }

  async syncFromVault(workspacePath: string): Promise<{ synced: string[] }> {
    const synced: string[] = [];
    const vaultFiles = await this.discoverVaultFiles();
    const prefix = this.vaultPrefix + '/';

    for (const vaultRelative of vaultFiles) {
      const relativeSrc = vaultRelative.slice(prefix.length);
      const destPath = join(workspacePath, relativeSrc);
      const vaultFilePath = join(this.vaultPath, vaultRelative);

      try {
        if (await this.filesMatch(vaultFilePath, destPath)) {
          continue;
        }

        await mkdir(dirname(destPath), { recursive: true });
        await copyFile(vaultFilePath, destPath);
        synced.push(relativeSrc);
      } catch {
        // Skip errors
      }
    }

    return { synced };
  }

  private async discoverFiles(workspacePath: string): Promise<string[]> {
    const isExcluded = picomatch(this.excludePatterns);
    const files: string[] = [];

    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir);
      } catch {
        return;
      }
      for (const name of entries) {
        if (name.startsWith('.')) continue;
        const full = join(dir, name);
        const rel = relative(workspacePath, full);

        if (isExcluded(rel)) continue;

        try {
          const s = await stat(full);
          if (s.isDirectory()) {
            await walk(full);
          } else if (s.isFile() && s.size <= this.maxFileSizeBytes) {
            files.push(full);
          }
        } catch {
          // Skip inaccessible
        }
      }
    };

    await walk(workspacePath);
    return files;
  }

  private async discoverVaultFiles(): Promise<string[]> {
    const files: string[] = [];
    const agentVault = join(this.vaultPath, 'openclaw', this.agentId);

    const walkDir = async (dir: string, baseDir: string): Promise<void> => {
      try {
        const names = await readdir(dir);
        for (const name of names) {
          const fullPath = join(dir, name);
          const s = await stat(fullPath);
          if (s.isDirectory()) {
            await walkDir(fullPath, baseDir);
          } else if (s.isFile()) {
            const rel = relative(baseDir, fullPath);
            files.push(join('openclaw', this.agentId, rel));
          }
        }
      } catch {
        // Directory doesn't exist or not readable
      }
    };

    await walkDir(agentVault, agentVault);
    return files;
  }
}

// ─── Global Sync (config, sessions, cron — outside workspaces) ───

interface SourceMapping {
  sourcePath: string;
  vaultPrefix: string;
}

export class OpenClawGlobalSync {
  private vaultPath: string;
  private openclawRoot: string;
  private maxFileSizeBytes: number;

  constructor(vaultPath: string, openclawRoot?: string, maxFileSizeBytes = DEFAULT_MAX_FILE_SIZE) {
    this.vaultPath = vaultPath;
    this.openclawRoot = openclawRoot ?? getOpenClawRoot();
    this.maxFileSizeBytes = maxFileSizeBytes;
  }

  async discoverMappings(): Promise<SourceMapping[]> {
    const root = this.openclawRoot;
    const mappings: SourceMapping[] = [];

    // Config files: openclaw.json → openclaw/config/openclaw.json
    const configFile = join(root, 'openclaw.json');
    if (await fileExists(configFile)) {
      mappings.push({ sourcePath: configFile, vaultPrefix: 'openclaw/config' });
    }

    // Cron jobs: cron/jobs.json → openclaw/config/cron/jobs.json
    const cronFile = join(root, 'cron', 'jobs.json');
    if (await fileExists(cronFile)) {
      mappings.push({ sourcePath: cronFile, vaultPrefix: 'openclaw/config/cron' });
    }

    // Session transcripts: agents/{agentId}/sessions/*.jsonl → openclaw/{agentId}-sessions/
    const agentsDir = join(root, 'agents');
    try {
      const agentNames = await readdir(agentsDir);
      for (const agentName of agentNames) {
        if (agentName.startsWith('.') || OPENCLAW_SKIP_DIRS.has(agentName)) continue;
        const sessionsDir = join(agentsDir, agentName, 'sessions');
        try {
          const s = await stat(sessionsDir);
          if (s.isDirectory()) {
            mappings.push({
              sourcePath: sessionsDir,
              vaultPrefix: `openclaw/${agentName}-sessions`,
            });
          }
        } catch {
          // No sessions dir for this agent
        }
      }
    } catch {
      // No agents dir
    }

    return mappings;
  }

  async syncBack(): Promise<{ synced: string[] }> {
    const synced: string[] = [];
    const mappings = await this.discoverMappings();

    for (const mapping of mappings) {
      const s = await stat(mapping.sourcePath).catch(() => null);
      if (!s) continue;

      if (s.isFile()) {
        // Single file mapping (config files)
        const fileName = mapping.sourcePath.split('/').pop()!;
        const vaultRelative = join(mapping.vaultPrefix, fileName);
        if (await this.syncFileToVault(mapping.sourcePath, vaultRelative)) {
          synced.push(vaultRelative);
        }
      } else if (s.isDirectory()) {
        // Directory mapping (sessions)
        const files = await this.walkDir(mapping.sourcePath);
        for (const filePath of files) {
          const rel = relative(mapping.sourcePath, filePath);
          const vaultRelative = join(mapping.vaultPrefix, rel);
          if (await this.syncFileToVault(filePath, vaultRelative)) {
            synced.push(vaultRelative);
          }
        }
      }
    }

    return { synced };
  }

  async syncFromVault(): Promise<{ synced: string[] }> {
    const synced: string[] = [];
    const mappings = await this.discoverMappings();

    for (const mapping of mappings) {
      const s = await stat(mapping.sourcePath).catch(() => null);

      if (s?.isFile()) {
        // Single file: vault → source
        const fileName = mapping.sourcePath.split('/').pop()!;
        const vaultRelative = join(mapping.vaultPrefix, fileName);
        const vaultFilePath = join(this.vaultPath, vaultRelative);
        if (await this.syncFileFromVault(vaultFilePath, mapping.sourcePath)) {
          synced.push(vaultRelative);
        }
      } else if (s?.isDirectory()) {
        // Directory: walk vault prefix and copy back
        const vaultDir = join(this.vaultPath, mapping.vaultPrefix);
        const vaultFiles = await this.walkDir(vaultDir);
        for (const vaultFilePath of vaultFiles) {
          const rel = relative(vaultDir, vaultFilePath);
          const destPath = join(mapping.sourcePath, rel);
          const vaultRelative = join(mapping.vaultPrefix, rel);
          if (await this.syncFileFromVault(vaultFilePath, destPath)) {
            synced.push(vaultRelative);
          }
        }
      }
    }

    return { synced };
  }

  private async syncFileToVault(sourcePath: string, vaultRelative: string): Promise<boolean> {
    try {
      const sourceContent = await readFile(sourcePath);
      const vaultFilePath = join(this.vaultPath, vaultRelative);

      try {
        const vaultContent = await readFile(vaultFilePath);
        if (Buffer.compare(sourceContent, vaultContent) === 0) {
          return false;
        }
      } catch {
        // Vault file doesn't exist yet
      }

      await mkdir(dirname(vaultFilePath), { recursive: true });
      await writeFile(vaultFilePath, sourceContent);
      return true;
    } catch {
      return false;
    }
  }

  private async syncFileFromVault(vaultFilePath: string, destPath: string): Promise<boolean> {
    try {
      const vaultContent = await readFile(vaultFilePath);

      try {
        const destContent = await readFile(destPath);
        if (Buffer.compare(vaultContent, destContent) === 0) {
          return false;
        }
      } catch {
        // Dest doesn't exist yet
      }

      await mkdir(dirname(destPath), { recursive: true });
      await writeFile(destPath, vaultContent);
      return true;
    } catch {
      return false;
    }
  }

  private async walkDir(dir: string): Promise<string[]> {
    const files: string[] = [];
    try {
      const entries = await readdir(dir);
      for (const name of entries) {
        if (name.startsWith('.')) continue;
        const full = join(dir, name);
        try {
          const s = await stat(full);
          if (s.isDirectory()) {
            files.push(...await this.walkDir(full));
          } else if (s.isFile() && s.size <= this.maxFileSizeBytes) {
            files.push(full);
          }
        } catch {
          // Skip
        }
      }
    } catch {
      // Dir doesn't exist
    }
    return files;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isFile();
  } catch {
    return false;
  }
}
