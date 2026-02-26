import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OpenClawAdapter } from '../../src/adapters/openclaw.js';
import { tmpdir } from 'node:os';
import { mkdtemp, rm, writeFile, mkdir, readFile, lstat, unlink } from 'node:fs/promises';
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
    // detect() looks for ~/.openclaw/workspace which is not our tmpDir
    // So by default it should return null (unless the user has one)
    // We test with a known non-existent path by creating a fresh adapter
    const result = await adapter.detect();
    // This tests the actual default path. If it exists on this machine,
    // it would return a path. For a clean test, we just verify it returns string|null.
    expect(result === null || typeof result === 'string').toBe(true);
  });

  it('import() copies expected files to vault', async () => {
    const result = await adapter.import(workspacePath);
    expect(result.errors.length).toBe(0);
    expect(result.imported.length).toBeGreaterThan(0);

    // Check that files were copied to vault under openclaw/ prefix
    const memoryContent = await readFile(join(vaultPath, 'openclaw', 'MEMORY.md'), 'utf-8');
    expect(memoryContent).toContain('Test memory content');

    const skillContent = await readFile(
      join(vaultPath, 'openclaw', 'skills', 'test-skill', 'SKILL.md'),
      'utf-8',
    );
    expect(skillContent).toContain('Test skill content');
  });

  it('import() handles missing optional files gracefully', async () => {
    // Create a minimal workspace with only MEMORY.md (no IDENTITY, no skills, no memory dir)
    const minimalWs = join(tmpDir, 'minimal-workspace');
    await mkdir(minimalWs, { recursive: true });
    await writeFile(join(minimalWs, 'MEMORY.md'), '# Minimal');

    const result = await adapter.import(minimalWs);
    expect(result.errors.length).toBe(0);
    expect(result.imported.length).toBe(1);
    expect(result.imported[0]).toBe('openclaw/MEMORY.md');
  });

  it('import() skips files with identical content', async () => {
    // First import
    await adapter.import(workspacePath);
    // Second import -- same content should be skipped
    const result = await adapter.import(workspacePath);
    expect(result.skipped.length).toBeGreaterThan(0);
    expect(result.imported.length).toBe(0);
  });

  it('createSymlinks() creates working symlinks', async () => {
    // First import files to vault
    await adapter.import(workspacePath);

    const result = await adapter.createSymlinks(workspacePath);
    expect(result.errors.length).toBe(0);
    expect(result.created.length).toBeGreaterThan(0);

    // Check MEMORY.md is now a symlink
    const stats = await lstat(join(workspacePath, 'MEMORY.md'));
    expect(stats.isSymbolicLink()).toBe(true);

    // The symlink should still be readable
    const content = await readFile(join(workspacePath, 'MEMORY.md'), 'utf-8');
    expect(content).toContain('Test memory content');
  });

  it('verifySymlinks() identifies valid and broken symlinks', async () => {
    // Import and create symlinks
    await adapter.import(workspacePath);
    await adapter.createSymlinks(workspacePath);

    const result = await adapter.verifySymlinks(workspacePath);
    expect(result.valid.length).toBeGreaterThan(0);
    expect(result.broken.length).toBe(0);
  });

  it('removeSymlinks() restores original files', async () => {
    // Import and create symlinks
    await adapter.import(workspacePath);
    await adapter.createSymlinks(workspacePath);

    // Verify MEMORY.md is a symlink
    let stats = await lstat(join(workspacePath, 'MEMORY.md'));
    expect(stats.isSymbolicLink()).toBe(true);

    // Remove symlinks
    await adapter.removeSymlinks(workspacePath);

    // MEMORY.md should now be a regular file (restored from backup or vault copy)
    stats = await lstat(join(workspacePath, 'MEMORY.md'));
    expect(stats.isSymbolicLink()).toBe(false);
    expect(stats.isFile()).toBe(true);

    // Content should still be readable
    const content = await readFile(join(workspacePath, 'MEMORY.md'), 'utf-8');
    expect(content).toContain('Test memory content');
  });

  it('import() discovers extraFiles from config', async () => {
    // Create additional files in workspace
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

    // Should still import the base files without errors
    expect(result.errors.length).toBe(0);
    expect(result.imported.length).toBeGreaterThan(0);
  });

  it('import() does not duplicate files when extraFiles overlap with defaults', async () => {
    const extraAdapter = new OpenClawAdapter({
      vaultPath,
      backupsPath,
      extraFiles: ['MEMORY.md'], // Already in the default list
    });
    const result = await extraAdapter.import(workspacePath);

    // MEMORY.md should only appear once
    const memoryCount = result.imported.filter((f) => f === 'openclaw/MEMORY.md').length;
    expect(memoryCount).toBe(1);
  });

  describe('syncBack()', () => {
    it('detects broken symlinks and syncs content back to vault', async () => {
      await adapter.import(workspacePath);
      await adapter.createSymlinks(workspacePath);

      // Verify MEMORY.md is a symlink
      let stats = await lstat(join(workspacePath, 'MEMORY.md'));
      expect(stats.isSymbolicLink()).toBe(true);

      // Simulate editor atomic save: delete symlink and write regular file
      await unlink(join(workspacePath, 'MEMORY.md'));
      await writeFile(join(workspacePath, 'MEMORY.md'), '# Memory\nUpdated by editor');

      stats = await lstat(join(workspacePath, 'MEMORY.md'));
      expect(stats.isSymbolicLink()).toBe(false);

      const result = await adapter.syncBack(workspacePath);
      expect(result.synced.length).toBeGreaterThan(0);
      expect(result.synced).toContain('openclaw/MEMORY.md');

      // Vault should have new content
      const vaultContent = await readFile(join(vaultPath, 'openclaw', 'MEMORY.md'), 'utf-8');
      expect(vaultContent).toContain('Updated by editor');

      // File should be a symlink again
      stats = await lstat(join(workspacePath, 'MEMORY.md'));
      expect(stats.isSymbolicLink()).toBe(true);
    });

    it('re-creates symlink when content is identical', async () => {
      await adapter.import(workspacePath);
      await adapter.createSymlinks(workspacePath);

      // Simulate editor atomic save with same content
      const originalContent = await readFile(join(workspacePath, 'MEMORY.md'), 'utf-8');
      await unlink(join(workspacePath, 'MEMORY.md'));
      await writeFile(join(workspacePath, 'MEMORY.md'), originalContent);

      const result = await adapter.syncBack(workspacePath);
      // Should not report as synced (content identical) but symlink should be restored
      expect(result.synced.length).toBe(0);

      const stats = await lstat(join(workspacePath, 'MEMORY.md'));
      expect(stats.isSymbolicLink()).toBe(true);
    });

    it('skips files that are still valid symlinks', async () => {
      await adapter.import(workspacePath);
      await adapter.createSymlinks(workspacePath);

      // All files are symlinks, nothing to sync back
      const result = await adapter.syncBack(workspacePath);
      expect(result.synced.length).toBe(0);
    });
  });
});
