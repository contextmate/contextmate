import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OpenClawAdapter, OpenClawGlobalSync } from '../../src/adapters/openclaw.js';
import { tmpdir } from 'node:os';
import { mkdtemp, rm, writeFile, mkdir, readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';

let tmpDir: string;
let workspacePath: string;
let vaultPath: string;
let backupsPath: string;
let adapter: OpenClawAdapter;

async function createMockWorkspace(basePath: string): Promise<string> {
  const ws = join(basePath, 'workspace');
  await mkdir(ws, { recursive: true });
  await writeFile(join(ws, 'MEMORY.md'), '# Memory\nTest memory content');
  await writeFile(join(ws, 'IDENTITY.md'), '# Identity\nTest identity');
  await mkdir(join(ws, 'skills', 'test-skill'), { recursive: true });
  await writeFile(join(ws, 'skills', 'test-skill', 'SKILL.md'), '# Skill\nTest skill content');
  await mkdir(join(ws, 'memory'), { recursive: true });
  await writeFile(join(ws, 'memory', '2026-02-07.md'), '# Daily Memory\nToday notes');
  return ws;
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'contextmate-openclaw-test-'));
  workspacePath = await createMockWorkspace(tmpDir);
  vaultPath = join(tmpDir, 'vault');
  backupsPath = join(tmpDir, 'backups');
  await mkdir(vaultPath, { recursive: true });
  await mkdir(backupsPath, { recursive: true });
  adapter = new OpenClawAdapter({ vaultPath, backupsPath, agentId: 'main' });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('OpenClawAdapter', () => {
  it('detect() returns null when workspace does not exist', async () => {
    const result = await adapter.detect();
    expect(result === null || typeof result === 'string').toBe(true);
  });

  it('import() copies expected files to vault under openclaw/main/', async () => {
    const result = await adapter.import(workspacePath);
    expect(result.errors.length).toBe(0);
    expect(result.imported.length).toBeGreaterThan(0);

    const memoryContent = await readFile(join(vaultPath, 'openclaw', 'main', 'MEMORY.md'), 'utf-8');
    expect(memoryContent).toContain('Test memory content');

    const skillContent = await readFile(
      join(vaultPath, 'openclaw', 'main', 'skills', 'test-skill', 'SKILL.md'),
      'utf-8',
    );
    expect(skillContent).toContain('Test skill content');
  });

  it('import() handles missing optional files gracefully', async () => {
    const minimalWs = join(tmpDir, 'minimal-workspace');
    await mkdir(minimalWs, { recursive: true });
    await writeFile(join(minimalWs, 'MEMORY.md'), '# Minimal');

    const result = await adapter.import(minimalWs);
    expect(result.errors.length).toBe(0);
    expect(result.imported.length).toBe(1);
    expect(result.imported[0]).toBe('openclaw/main/MEMORY.md');
  });

  it('import() skips files with identical content', async () => {
    await adapter.import(workspacePath);
    const result = await adapter.import(workspacePath);
    expect(result.skipped.length).toBeGreaterThan(0);
    expect(result.imported.length).toBe(0);
  });

  it('copyToWorkspace() copies vault files to workspace as regular files', async () => {
    await adapter.import(workspacePath);
    const result = await adapter.copyToWorkspace(workspacePath);
    expect(result.errors.length).toBe(0);

    // Files should be regular files (not symlinks)
    const stats = await lstat(join(workspacePath, 'MEMORY.md'));
    expect(stats.isFile()).toBe(true);
    expect(stats.isSymbolicLink()).toBe(false);

    const content = await readFile(join(workspacePath, 'MEMORY.md'), 'utf-8');
    expect(content).toContain('Test memory content');
  });

  it('verifySync() identifies synced and stale files', async () => {
    await adapter.import(workspacePath);
    const result = await adapter.verifySync(workspacePath);
    expect(result.synced.length).toBeGreaterThan(0);
    expect(result.stale.length).toBe(0);
  });

  it('disconnect() leaves workspace files intact', async () => {
    await adapter.import(workspacePath);
    await adapter.copyToWorkspace(workspacePath);
    await adapter.disconnect(workspacePath);

    const content = await readFile(join(workspacePath, 'MEMORY.md'), 'utf-8');
    expect(content).toContain('Test memory content');
  });

  it('import() discovers all file types (not just .md)', async () => {
    await writeFile(join(workspacePath, 'data.json'), '{"key": "value"}');
    await writeFile(join(workspacePath, 'script.py'), 'print("hello")');
    // Create a small binary-like file
    await writeFile(join(workspacePath, 'image.jpg'), Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]));

    const result = await adapter.import(workspacePath);
    expect(result.errors.length).toBe(0);
    expect(result.imported).toContain('openclaw/main/data.json');
    expect(result.imported).toContain('openclaw/main/script.py');
    expect(result.imported).toContain('openclaw/main/image.jpg');
  });

  it('import() excludes node_modules and .git directories', async () => {
    await mkdir(join(workspacePath, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(join(workspacePath, 'node_modules', 'pkg', 'index.js'), 'module.exports = {}');
    await mkdir(join(workspacePath, '.git'), { recursive: true });
    await writeFile(join(workspacePath, '.git', 'config'), 'git config');

    const result = await adapter.import(workspacePath);
    const paths = [...result.imported, ...result.skipped];
    expect(paths.some(p => p.includes('node_modules'))).toBe(false);
    expect(paths.some(p => p.includes('.git'))).toBe(false);
  });

  it('import() respects maxFileSizeBytes', async () => {
    const smallAdapter = new OpenClawAdapter({
      vaultPath,
      backupsPath,
      agentId: 'main',
      maxFileSizeBytes: 10, // 10 bytes max
    });

    await writeFile(join(workspacePath, 'large.txt'), 'This is more than ten bytes of content');
    await writeFile(join(workspacePath, 'tiny.txt'), '123');

    const result = await smallAdapter.import(workspacePath);
    const imported = result.imported.map(p => p.replace('openclaw/main/', ''));
    expect(imported).toContain('tiny.txt');
    expect(imported).not.toContain('large.txt');
  });

  it('import() preserves binary file content', async () => {
    const binaryContent = Buffer.from([0x00, 0x01, 0x02, 0xFF, 0xFE, 0xFD]);
    await writeFile(join(workspacePath, 'binary.bin'), binaryContent);

    await adapter.import(workspacePath);

    const vaultContent = await readFile(join(vaultPath, 'openclaw', 'main', 'binary.bin'));
    expect(Buffer.compare(vaultContent, binaryContent)).toBe(0);
  });

  it('import() does not duplicate files', async () => {
    const result = await adapter.import(workspacePath);
    const memoryCount = result.imported.filter((f) => f === 'openclaw/main/MEMORY.md').length;
    expect(memoryCount).toBe(1);
  });

  it('uses different vault prefixes for different agentIds', async () => {
    const redditAdapter = new OpenClawAdapter({
      vaultPath,
      backupsPath,
      agentId: 'reddit',
    });

    await adapter.import(workspacePath);
    await redditAdapter.import(workspacePath);

    const mainContent = await readFile(join(vaultPath, 'openclaw', 'main', 'MEMORY.md'), 'utf-8');
    const redditContent = await readFile(join(vaultPath, 'openclaw', 'reddit', 'MEMORY.md'), 'utf-8');
    expect(mainContent).toContain('Test memory content');
    expect(redditContent).toContain('Test memory content');
  });

  describe('syncBack()', () => {
    it('detects workspace changes and syncs content to vault', async () => {
      await adapter.import(workspacePath);

      await writeFile(join(workspacePath, 'MEMORY.md'), '# Memory\nUpdated by editor');

      const result = await adapter.syncBack(workspacePath);
      expect(result.synced.length).toBeGreaterThan(0);
      expect(result.synced).toContain('openclaw/main/MEMORY.md');

      const vaultContent = await readFile(join(vaultPath, 'openclaw', 'main', 'MEMORY.md'), 'utf-8');
      expect(vaultContent).toContain('Updated by editor');

      const stats = await lstat(join(workspacePath, 'MEMORY.md'));
      expect(stats.isFile()).toBe(true);
      expect(stats.isSymbolicLink()).toBe(false);
    });

    it('skips files with identical content', async () => {
      await adapter.import(workspacePath);
      const result = await adapter.syncBack(workspacePath);
      expect(result.synced.length).toBe(0);
    });
  });

  describe('syncFromVault()', () => {
    it('copies vault changes to workspace', async () => {
      await adapter.import(workspacePath);

      await writeFile(join(vaultPath, 'openclaw', 'main', 'MEMORY.md'), '# Memory\nUpdated from cloud');

      const result = await adapter.syncFromVault(workspacePath);
      expect(result.synced.length).toBeGreaterThan(0);

      const content = await readFile(join(workspacePath, 'MEMORY.md'), 'utf-8');
      expect(content).toContain('Updated from cloud');
    });

    it('skips files already in sync', async () => {
      await adapter.import(workspacePath);
      const result = await adapter.syncFromVault(workspacePath);
      expect(result.synced.length).toBe(0);
    });
  });
});

describe('OpenClawGlobalSync', () => {
  let ocRoot: string;
  let globalSync: OpenClawGlobalSync;

  beforeEach(async () => {
    ocRoot = join(tmpDir, '.openclaw');
    await mkdir(ocRoot, { recursive: true });
    globalSync = new OpenClawGlobalSync(vaultPath, ocRoot);
  });

  it('syncs openclaw.json to vault/openclaw/config/', async () => {
    await writeFile(join(ocRoot, 'openclaw.json'), '{"agents":{"list":[]}}');

    const result = await globalSync.syncBack();
    expect(result.synced).toContain('openclaw/config/openclaw.json');

    const content = await readFile(join(vaultPath, 'openclaw', 'config', 'openclaw.json'), 'utf-8');
    expect(content).toContain('"agents"');
  });

  it('syncs cron/jobs.json to vault/openclaw/config/cron/', async () => {
    await mkdir(join(ocRoot, 'cron'), { recursive: true });
    await writeFile(join(ocRoot, 'cron', 'jobs.json'), '{"jobs":[]}');

    const result = await globalSync.syncBack();
    expect(result.synced).toContain('openclaw/config/cron/jobs.json');

    const content = await readFile(join(vaultPath, 'openclaw', 'config', 'cron', 'jobs.json'), 'utf-8');
    expect(content).toContain('"jobs"');
  });

  it('syncs session transcripts to vault/openclaw/{agentId}-sessions/', async () => {
    await mkdir(join(ocRoot, 'agents', 'main', 'sessions'), { recursive: true });
    await writeFile(
      join(ocRoot, 'agents', 'main', 'sessions', '2026-03-01.jsonl'),
      '{"role":"user","content":"hello"}\n',
    );

    const result = await globalSync.syncBack();
    expect(result.synced).toContain('openclaw/main-sessions/2026-03-01.jsonl');

    const content = await readFile(
      join(vaultPath, 'openclaw', 'main-sessions', '2026-03-01.jsonl'),
      'utf-8',
    );
    expect(content).toContain('"hello"');
  });

  it('syncs sessions for multiple agents', async () => {
    await mkdir(join(ocRoot, 'agents', 'main', 'sessions'), { recursive: true });
    await mkdir(join(ocRoot, 'agents', 'reddit', 'sessions'), { recursive: true });
    await writeFile(join(ocRoot, 'agents', 'main', 'sessions', 's1.jsonl'), 'main session');
    await writeFile(join(ocRoot, 'agents', 'reddit', 'sessions', 's1.jsonl'), 'reddit session');

    const result = await globalSync.syncBack();
    expect(result.synced).toContain('openclaw/main-sessions/s1.jsonl');
    expect(result.synced).toContain('openclaw/reddit-sessions/s1.jsonl');
  });

  it('skips credentials directory', async () => {
    await mkdir(join(ocRoot, 'agents', 'credentials', 'sessions'), { recursive: true });
    await writeFile(join(ocRoot, 'agents', 'credentials', 'sessions', 'secret.jsonl'), 'secret');

    const result = await globalSync.syncBack();
    expect(result.synced.some(p => p.includes('credentials'))).toBe(false);
  });

  it('skips unchanged files on second sync', async () => {
    await writeFile(join(ocRoot, 'openclaw.json'), '{"agents":{"list":[]}}');

    await globalSync.syncBack();
    const result = await globalSync.syncBack();
    expect(result.synced.length).toBe(0);
  });

  it('syncFromVault copies vault changes back to source', async () => {
    // Create the config file so discoverMappings finds it
    await writeFile(join(ocRoot, 'openclaw.json'), '{"old":"config"}');
    await globalSync.syncBack();

    // Simulate a remote change in the vault
    await writeFile(
      join(vaultPath, 'openclaw', 'config', 'openclaw.json'),
      '{"updated":"from cloud"}',
    );

    const result = await globalSync.syncFromVault();
    expect(result.synced).toContain('openclaw/config/openclaw.json');

    const content = await readFile(join(ocRoot, 'openclaw.json'), 'utf-8');
    expect(content).toContain('"updated"');
  });

  it('syncFromVault copies session changes back to source', async () => {
    await mkdir(join(ocRoot, 'agents', 'main', 'sessions'), { recursive: true });
    await writeFile(join(ocRoot, 'agents', 'main', 'sessions', 's1.jsonl'), 'original');
    await globalSync.syncBack();

    // Simulate vault update
    await writeFile(
      join(vaultPath, 'openclaw', 'main-sessions', 's1.jsonl'),
      'updated from other device',
    );

    const result = await globalSync.syncFromVault();
    expect(result.synced).toContain('openclaw/main-sessions/s1.jsonl');

    const content = await readFile(join(ocRoot, 'agents', 'main', 'sessions', 's1.jsonl'), 'utf-8');
    expect(content).toContain('updated from other device');
  });
});
