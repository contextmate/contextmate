import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MirrorAdapter } from '../../src/adapters/mirror.js';
import { tmpdir } from 'node:os';
import { mkdtemp, rm, writeFile, mkdir, readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';

let tmpDir: string;
let vaultPath: string;
let backupsPath: string;
let targetPath: string;

async function createMockVault(vaultDir: string): Promise<void> {
  await mkdir(join(vaultDir, 'openclaw', 'memory'), { recursive: true });
  await mkdir(join(vaultDir, 'skills', 'test-skill'), { recursive: true });
  await writeFile(join(vaultDir, 'openclaw', 'MEMORY.md'), '# Memory\nAgent memory content');
  await writeFile(join(vaultDir, 'openclaw', 'IDENTITY.md'), '# Identity\nAgent identity');
  await writeFile(join(vaultDir, 'openclaw', 'memory', 'notes.md'), '# Notes\nSome notes');
  await writeFile(join(vaultDir, 'skills', 'test-skill', 'SKILL.md'), '# Skill\nTest skill');
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'contextmate-mirror-test-'));
  vaultPath = join(tmpDir, 'vault');
  backupsPath = join(tmpDir, 'backups');
  targetPath = join(tmpDir, 'target');
  await mkdir(vaultPath, { recursive: true });
  await mkdir(backupsPath, { recursive: true });
  await mkdir(targetPath, { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('MirrorAdapter', () => {
  it('detect() always returns null', async () => {
    const adapter = new MirrorAdapter({ vaultPath, backupsPath });
    const result = await adapter.detect();
    expect(result).toBeNull();
  });

  it('copyToWorkspace() copies all vault files as regular files when no include filter', async () => {
    await createMockVault(vaultPath);
    const adapter = new MirrorAdapter({ vaultPath, backupsPath });

    const result = await adapter.copyToWorkspace(targetPath);
    expect(result.errors.length).toBe(0);
    expect(result.copied.length).toBe(4);

    // Verify files are regular files (not symlinks) and readable
    const stats = await lstat(join(targetPath, 'openclaw', 'MEMORY.md'));
    expect(stats.isFile()).toBe(true);
    expect(stats.isSymbolicLink()).toBe(false);

    const content = await readFile(join(targetPath, 'openclaw', 'MEMORY.md'), 'utf-8');
    expect(content).toContain('Agent memory content');
  });

  it('copyToWorkspace() only copies files matching include patterns', async () => {
    await createMockVault(vaultPath);
    const adapter = new MirrorAdapter({
      vaultPath,
      backupsPath,
      include: ['openclaw/**'],
    });

    const result = await adapter.copyToWorkspace(targetPath);
    expect(result.errors.length).toBe(0);
    // Only openclaw/ files (3), not skills/ (1)
    expect(result.copied.length).toBe(3);

    // skills/ should not be present
    let hasSkill = false;
    try {
      await lstat(join(targetPath, 'skills', 'test-skill', 'SKILL.md'));
      hasSkill = true;
    } catch {
      // Expected
    }
    expect(hasSkill).toBe(false);
  });

  it('import() copies existing files from target to vault', async () => {
    await writeFile(join(targetPath, 'README.md'), '# Readme');
    await mkdir(join(targetPath, 'docs'), { recursive: true });
    await writeFile(join(targetPath, 'docs', 'guide.md'), '# Guide');

    const adapter = new MirrorAdapter({ vaultPath, backupsPath });
    const result = await adapter.import(targetPath);

    expect(result.errors.length).toBe(0);
    expect(result.imported.length).toBe(2);

    const content = await readFile(join(vaultPath, 'README.md'), 'utf-8');
    expect(content).toBe('# Readme');

    const guideContent = await readFile(join(vaultPath, 'docs', 'guide.md'), 'utf-8');
    expect(guideContent).toBe('# Guide');
  });

  it('import() respects include filters', async () => {
    await mkdir(join(targetPath, 'openclaw'), { recursive: true });
    await writeFile(join(targetPath, 'openclaw', 'MEMORY.md'), '# Memory');
    await writeFile(join(targetPath, 'unrelated.txt'), 'should be excluded');

    const adapter = new MirrorAdapter({
      vaultPath,
      backupsPath,
      include: ['openclaw/**'],
    });
    const result = await adapter.import(targetPath);

    expect(result.imported).toContain(join('openclaw', 'MEMORY.md'));
    const importedPaths = [...result.imported, ...result.skipped];
    expect(importedPaths).not.toContain('unrelated.txt');
  });

  it('import() skips identical content', async () => {
    await writeFile(join(vaultPath, 'README.md'), '# Readme');
    await writeFile(join(targetPath, 'README.md'), '# Readme');

    const adapter = new MirrorAdapter({ vaultPath, backupsPath });
    const result = await adapter.import(targetPath);

    expect(result.imported.length).toBe(0);
    expect(result.skipped.length).toBe(1);
  });

  it('verifySync() identifies synced and stale files', async () => {
    await createMockVault(vaultPath);
    const adapter = new MirrorAdapter({ vaultPath, backupsPath });

    await adapter.copyToWorkspace(targetPath);
    const result = await adapter.verifySync(targetPath);

    expect(result.synced.length).toBe(4);
    expect(result.stale.length).toBe(0);
  });

  it('disconnect() leaves workspace files intact', async () => {
    await createMockVault(vaultPath);
    const adapter = new MirrorAdapter({ vaultPath, backupsPath });

    await adapter.copyToWorkspace(targetPath);
    await adapter.disconnect(targetPath);

    const content = await readFile(join(targetPath, 'openclaw', 'MEMORY.md'), 'utf-8');
    expect(content).toContain('Agent memory content');
  });

  it('refreshCopies() only copies new or stale files', async () => {
    await createMockVault(vaultPath);
    const adapter = new MirrorAdapter({ vaultPath, backupsPath });

    // Initial copy
    await adapter.copyToWorkspace(targetPath);

    // Add a new file to vault
    await writeFile(join(vaultPath, 'openclaw', 'HEARTBEAT.md'), '# Heartbeat');

    // Refresh should only copy the new one
    const result = await adapter.refreshCopies(targetPath);
    expect(result.copied.length).toBe(1);
    expect(result.copied[0]).toBe(join('openclaw', 'HEARTBEAT.md'));

    const content = await readFile(join(targetPath, 'openclaw', 'HEARTBEAT.md'), 'utf-8');
    expect(content).toContain('Heartbeat');
  });

  it('throws error when target is inside vault', async () => {
    const adapter = new MirrorAdapter({ vaultPath, backupsPath });
    const badTarget = join(vaultPath, 'mirror-output');
    await mkdir(badTarget, { recursive: true });

    await expect(adapter.copyToWorkspace(badTarget)).rejects.toThrow(
      'Mirror target cannot be inside the vault',
    );
  });

  it('syncBack() detects workspace changes and copies content to vault', async () => {
    await createMockVault(vaultPath);
    const adapter = new MirrorAdapter({ vaultPath, backupsPath });

    // Copy files to target
    await adapter.copyToWorkspace(targetPath);

    // Edit a file in the target
    const filePath = join(targetPath, 'openclaw', 'MEMORY.md');
    await writeFile(filePath, '# Updated Memory\nEdited by user');

    const result = await adapter.syncBack(targetPath);
    expect(result.synced.length).toBe(1);
    expect(result.synced[0]).toBe(join('openclaw', 'MEMORY.md'));

    // Vault should have the updated content
    const vaultContent = await readFile(join(vaultPath, 'openclaw', 'MEMORY.md'), 'utf-8');
    expect(vaultContent).toBe('# Updated Memory\nEdited by user');

    // Target file should still be a regular file
    const stats = await lstat(filePath);
    expect(stats.isFile()).toBe(true);
    expect(stats.isSymbolicLink()).toBe(false);
  });

  it('syncBack() skips files with identical content', async () => {
    await createMockVault(vaultPath);
    const adapter = new MirrorAdapter({ vaultPath, backupsPath });

    await adapter.copyToWorkspace(targetPath);

    // No changes — all files identical
    const result = await adapter.syncBack(targetPath);
    expect(result.synced.length).toBe(0);
  });

  it('syncFromVault() copies vault changes to target', async () => {
    await createMockVault(vaultPath);
    const adapter = new MirrorAdapter({ vaultPath, backupsPath });

    await adapter.copyToWorkspace(targetPath);

    // Simulate a remote change arriving in the vault
    await writeFile(join(vaultPath, 'openclaw', 'MEMORY.md'), '# Memory\nUpdated from cloud');

    const result = await adapter.syncFromVault(targetPath);
    expect(result.synced.length).toBe(1);

    const content = await readFile(join(targetPath, 'openclaw', 'MEMORY.md'), 'utf-8');
    expect(content).toContain('Updated from cloud');
  });

  it('throws error when vault is inside target', async () => {
    const outerTarget = tmpDir;
    const adapter = new MirrorAdapter({
      vaultPath: join(outerTarget, 'vault'),
      backupsPath,
    });

    await expect(adapter.copyToWorkspace(outerTarget)).rejects.toThrow(
      'Mirror target cannot be inside the vault',
    );
  });
});
