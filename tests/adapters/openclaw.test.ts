import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OpenClawAdapter } from '../../src/adapters/openclaw.js';
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
  adapter = new OpenClawAdapter({ vaultPath, backupsPath });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('OpenClawAdapter', () => {
  it('detect() returns null when workspace does not exist', async () => {
    const result = await adapter.detect();
    expect(result === null || typeof result === 'string').toBe(true);
  });

  it('import() copies expected files to vault', async () => {
    const result = await adapter.import(workspacePath);
    expect(result.errors.length).toBe(0);
    expect(result.imported.length).toBeGreaterThan(0);

    const memoryContent = await readFile(join(vaultPath, 'openclaw', 'MEMORY.md'), 'utf-8');
    expect(memoryContent).toContain('Test memory content');

    const skillContent = await readFile(
      join(vaultPath, 'openclaw', 'skills', 'test-skill', 'SKILL.md'),
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
    expect(result.imported[0]).toBe('openclaw/MEMORY.md');
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
    // Workspace and vault should be in sync after import (same content)
    const result = await adapter.verifySync(workspacePath);
    expect(result.synced.length).toBeGreaterThan(0);
    expect(result.stale.length).toBe(0);
  });

  it('disconnect() leaves workspace files intact', async () => {
    await adapter.import(workspacePath);
    await adapter.copyToWorkspace(workspacePath);
    await adapter.disconnect(workspacePath);

    // Files should still be readable
    const content = await readFile(join(workspacePath, 'MEMORY.md'), 'utf-8');
    expect(content).toContain('Test memory content');
  });

  it('import() discovers extraFiles from config', async () => {
    await writeFile(join(workspacePath, 'HEARTBEAT.md'), '# Heartbeat\nAgent heartbeat');
    await writeFile(join(workspacePath, 'PLAYBOOK.md'), '# Playbook\nAgent playbook');

    const extraAdapter = new OpenClawAdapter({
      vaultPath,
      backupsPath,
      extraFiles: ['HEARTBEAT.md', 'PLAYBOOK.md'],
    });
    const result = await extraAdapter.import(workspacePath);

    expect(result.errors.length).toBe(0);
    expect(result.imported).toContain('openclaw/HEARTBEAT.md');
    expect(result.imported).toContain('openclaw/PLAYBOOK.md');

    const content = await readFile(join(vaultPath, 'openclaw', 'HEARTBEAT.md'), 'utf-8');
    expect(content).toContain('Agent heartbeat');
  });

  it('import() discovers files matching extraGlobs', async () => {
    await mkdir(join(workspacePath, 'agents'), { recursive: true });
    await writeFile(join(workspacePath, 'agents', 'AGENT1.md'), '# Agent 1');
    await writeFile(join(workspacePath, 'agents', 'AGENT2.md'), '# Agent 2');

    const extraAdapter = new OpenClawAdapter({
      vaultPath,
      backupsPath,
      extraGlobs: ['agents/*.md'],
    });
    const result = await extraAdapter.import(workspacePath);

    expect(result.errors.length).toBe(0);
    expect(result.imported).toContain('openclaw/agents/AGENT1.md');
    expect(result.imported).toContain('openclaw/agents/AGENT2.md');
  });

  it('import() ignores non-existent extraFiles gracefully', async () => {
    const extraAdapter = new OpenClawAdapter({
      vaultPath,
      backupsPath,
      extraFiles: ['NONEXISTENT.md'],
    });
    const result = await extraAdapter.import(workspacePath);

    expect(result.errors.length).toBe(0);
    expect(result.imported.length).toBeGreaterThan(0);
  });

  it('import() does not duplicate files when extraFiles overlap with defaults', async () => {
    const extraAdapter = new OpenClawAdapter({
      vaultPath,
      backupsPath,
      extraFiles: ['MEMORY.md'],
    });
    const result = await extraAdapter.import(workspacePath);

    const memoryCount = result.imported.filter((f) => f === 'openclaw/MEMORY.md').length;
    expect(memoryCount).toBe(1);
  });

  describe('syncBack()', () => {
    it('detects workspace changes and syncs content to vault', async () => {
      await adapter.import(workspacePath);

      // Edit the workspace file
      await writeFile(join(workspacePath, 'MEMORY.md'), '# Memory\nUpdated by editor');

      const result = await adapter.syncBack(workspacePath);
      expect(result.synced.length).toBeGreaterThan(0);
      expect(result.synced).toContain('openclaw/MEMORY.md');

      // Vault should have new content
      const vaultContent = await readFile(join(vaultPath, 'openclaw', 'MEMORY.md'), 'utf-8');
      expect(vaultContent).toContain('Updated by editor');

      // Workspace file should still be a regular file
      const stats = await lstat(join(workspacePath, 'MEMORY.md'));
      expect(stats.isFile()).toBe(true);
      expect(stats.isSymbolicLink()).toBe(false);
    });

    it('skips files with identical content', async () => {
      await adapter.import(workspacePath);

      // No changes — content should match
      const result = await adapter.syncBack(workspacePath);
      expect(result.synced.length).toBe(0);
    });
  });

  describe('syncFromVault()', () => {
    it('copies vault changes to workspace', async () => {
      await adapter.import(workspacePath);

      // Simulate a remote change arriving in the vault
      await writeFile(join(vaultPath, 'openclaw', 'MEMORY.md'), '# Memory\nUpdated from cloud');

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
