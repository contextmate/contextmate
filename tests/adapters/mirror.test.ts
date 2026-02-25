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

  it('createSymlinks() symlinks all vault files when no include filter', async () => {
    await createMockVault(vaultPath);
    const adapter = new MirrorAdapter({ vaultPath, backupsPath });

    const result = await adapter.createSymlinks(targetPath);
    expect(result.errors.length).toBe(0);
    expect(result.created.length).toBe(4);

    // Verify symlinks exist and are readable
    const stats = await lstat(join(targetPath, 'openclaw', 'MEMORY.md'));
    expect(stats.isSymbolicLink()).toBe(true);

    const content = await readFile(join(targetPath, 'openclaw', 'MEMORY.md'), 'utf-8');
    expect(content).toContain('Agent memory content');
  });

  it('createSymlinks() only symlinks files matching include patterns', async () => {
    await createMockVault(vaultPath);
    const adapter = new MirrorAdapter({
      vaultPath,
      backupsPath,
      include: ['openclaw/**'],
    });

    const result = await adapter.createSymlinks(targetPath);
    expect(result.errors.length).toBe(0);
    // Only openclaw/ files (3), not skills/ (1)
    expect(result.created.length).toBe(3);

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
    // Put files in target directory
    await writeFile(join(targetPath, 'README.md'), '# Readme');
    await mkdir(join(targetPath, 'docs'), { recursive: true });
    await writeFile(join(targetPath, 'docs', 'guide.md'), '# Guide');

    const adapter = new MirrorAdapter({ vaultPath, backupsPath });
    const result = await adapter.import(targetPath);

    expect(result.errors.length).toBe(0);
    expect(result.imported.length).toBe(2);

    // Verify files were copied to vault root (no prefix)
    const content = await readFile(join(vaultPath, 'README.md'), 'utf-8');
    expect(content).toBe('# Readme');

    const guideContent = await readFile(join(vaultPath, 'docs', 'guide.md'), 'utf-8');
    expect(guideContent).toBe('# Guide');
  });

  it('import() skips identical content', async () => {
    // Pre-populate vault
    await writeFile(join(vaultPath, 'README.md'), '# Readme');

    // Put same content in target
    await writeFile(join(targetPath, 'README.md'), '# Readme');

    const adapter = new MirrorAdapter({ vaultPath, backupsPath });
    const result = await adapter.import(targetPath);

    expect(result.imported.length).toBe(0);
    expect(result.skipped.length).toBe(1);
  });

  it('verifySymlinks() identifies valid and broken symlinks', async () => {
    await createMockVault(vaultPath);
    const adapter = new MirrorAdapter({ vaultPath, backupsPath });

    await adapter.createSymlinks(targetPath);
    const result = await adapter.verifySymlinks(targetPath);

    expect(result.valid.length).toBe(4);
    expect(result.broken.length).toBe(0);
  });

  it('removeSymlinks() restores files from vault copies', async () => {
    await createMockVault(vaultPath);
    const adapter = new MirrorAdapter({ vaultPath, backupsPath });

    await adapter.createSymlinks(targetPath);

    // Verify it's a symlink
    let stats = await lstat(join(targetPath, 'openclaw', 'MEMORY.md'));
    expect(stats.isSymbolicLink()).toBe(true);

    await adapter.removeSymlinks(targetPath);

    // Should now be a regular file (restored from vault copy)
    stats = await lstat(join(targetPath, 'openclaw', 'MEMORY.md'));
    expect(stats.isSymbolicLink()).toBe(false);
    expect(stats.isFile()).toBe(true);

    const content = await readFile(join(targetPath, 'openclaw', 'MEMORY.md'), 'utf-8');
    expect(content).toContain('Agent memory content');
  });

  it('refreshSymlinks() only creates missing symlinks', async () => {
    await createMockVault(vaultPath);
    const adapter = new MirrorAdapter({ vaultPath, backupsPath });

    // Create initial symlinks
    await adapter.createSymlinks(targetPath);

    // Add a new file to vault
    await writeFile(join(vaultPath, 'openclaw', 'HEARTBEAT.md'), '# Heartbeat');

    // Refresh should only create the new one
    const result = await adapter.refreshSymlinks(targetPath);
    expect(result.created.length).toBe(1);
    expect(result.created[0]).toBe(join('openclaw', 'HEARTBEAT.md'));

    // Verify the new symlink works
    const content = await readFile(join(targetPath, 'openclaw', 'HEARTBEAT.md'), 'utf-8');
    expect(content).toContain('Heartbeat');
  });

  it('throws error when target is inside vault', async () => {
    const adapter = new MirrorAdapter({ vaultPath, backupsPath });
    const badTarget = join(vaultPath, 'mirror-output');
    await mkdir(badTarget, { recursive: true });

    await expect(adapter.createSymlinks(badTarget)).rejects.toThrow(
      'Mirror target cannot be inside the vault',
    );
  });

  it('throws error when vault is inside target', async () => {
    // Create adapter where vault is inside target
    const outerTarget = tmpDir;
    const adapter = new MirrorAdapter({
      vaultPath: join(outerTarget, 'vault'),
      backupsPath,
    });

    await expect(adapter.createSymlinks(outerTarget)).rejects.toThrow(
      'Mirror target cannot be inside the vault',
    );
  });
});
