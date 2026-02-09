import { parse, stringify } from 'smol-toml';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface ContextMateConfig {
  server: {
    url: string;
    apiKey?: string;
  };
  vault: {
    path: string;
  };
  data: {
    path: string;
  };
  sync: {
    pollIntervalMs: number;
    debounceMs: number;
    maxRetries: number;
  };
  adapters: {
    openclaw: {
      enabled: boolean;
      workspacePath: string;
    };
    claude: {
      enabled: boolean;
      skillsPath: string;
      claudeDir: string;
      syncRules: boolean;
      syncProjectMemories: boolean;
      syncGlobalMemory: boolean;
    };
  };
  mcp: {
    port: number;
    host: string;
  };
}

export function getConfigDir(): string {
  return join(homedir(), '.contextmate');
}

export function getConfigPath(): string {
  return join(getConfigDir(), 'config.toml');
}

export function getDefaultConfig(): ContextMateConfig {
  const configDir = getConfigDir();
  return {
    server: {
      url: 'https://api.contextmate.dev',
    },
    vault: {
      path: join(configDir, 'vault'),
    },
    data: {
      path: join(configDir, 'data'),
    },
    sync: {
      pollIntervalMs: 60000,
      debounceMs: 500,
      maxRetries: 3,
    },
    adapters: {
      openclaw: {
        enabled: false,
        workspacePath: join(homedir(), '.openclaw', 'workspace'),
      },
      claude: {
        enabled: false,
        skillsPath: join(homedir(), '.agents', 'skills'),
        claudeDir: join(homedir(), '.claude'),
        syncRules: true,
        syncProjectMemories: true,
        syncGlobalMemory: true,
      },
    },
    mcp: {
      port: 3100,
      host: 'localhost',
    },
  };
}

function deepMerge(defaults: Record<string, unknown>, overrides: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...defaults };
  for (const key of Object.keys(overrides)) {
    const defaultVal = result[key];
    const overrideVal = overrides[key];
    if (
      defaultVal !== null &&
      overrideVal !== null &&
      typeof defaultVal === 'object' &&
      typeof overrideVal === 'object' &&
      !Array.isArray(defaultVal) &&
      !ArrayBuffer.isView(defaultVal)
    ) {
      result[key] = deepMerge(
        defaultVal as Record<string, unknown>,
        overrideVal as Record<string, unknown>,
      );
    } else if (overrideVal !== undefined) {
      result[key] = overrideVal;
    }
  }
  return result;
}

export async function loadConfig(): Promise<ContextMateConfig> {
  const defaults = getDefaultConfig();
  const configPath = getConfigPath();

  let raw: string;
  try {
    raw = await readFile(configPath, 'utf-8');
  } catch {
    return defaults;
  }

  const parsed = parse(raw) as Record<string, unknown>;
  return deepMerge(defaults as unknown as Record<string, unknown>, parsed) as unknown as ContextMateConfig;
}

export async function saveConfig(config: ContextMateConfig): Promise<void> {
  const configDir = getConfigDir();
  await mkdir(configDir, { recursive: true });
  const toml = stringify(config as unknown as Record<string, unknown>);
  await writeFile(getConfigPath(), toml, 'utf-8');
}

export async function ensureDirectories(config: ContextMateConfig): Promise<void> {
  await Promise.all([
    mkdir(config.vault.path, { recursive: true }),
    mkdir(config.data.path, { recursive: true }),
    mkdir(join(getConfigDir(), 'backups'), { recursive: true }),
  ]);
}
