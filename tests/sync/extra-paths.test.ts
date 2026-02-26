import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ExtraPathsManager } from '../../src/sync/extra-paths.js';
import { tmpdir } from 'node:os';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

let sourceDir: string;
let vaultDir: string;

beforeEach(async () => {
  sourceDir = await mkdtemp(join(tmpdir(), 'contextmate-extra-src-'));
  vaultDir = await mkdtemp(join(tmpdir(), 'contextmate-extra-vault-'));
});

afterEach(async () => {
  await rm(sourceDir, { recursive: true, force: true });
  await rm(vaultDir, { recursive: true, force: true });
});

describe('ExtraPathsManager', () => {
  it('discovers files matching a glob pattern', async () => {
    await mkdir(join(sourceDir, 'notes'), { recursive: true });
    await writeFile(join(sourceDir, 'notes', 'a.md'), 'note a');
    await writeFile(join(sourceDir, 'notes', 'b.md'), 'note b');
    await writeFile(join(sourceDir, 'notes', 'c.txt'), 'not markdown');

    const manager = new ExtraPathsManager(
      [`${sourceDir}/notes/**/*.md`],
      vaultDir,
    );
    const files = await manager.discoverFiles();

    expect(files.length).toBe(2);
    const paths = files.map((f) => f.vaultRelative).sort();
    expect(paths.some((p) => p.endsWith('notes/a.md'))).toBe(true);
    expect(paths.some((p) => p.endsWith('notes/b.md'))).toBe(true);
    expect(paths.every((p) => p.startsWith('custom/'))).toBe(true);
  });

  it('discovers a literal file path', async () => {
    await writeFile(join(sourceDir, 'single.md'), 'hello');

    const manager = new ExtraPathsManager(
      [`${sourceDir}/single.md`],
      vaultDir,
    );
    const files = await manager.discoverFiles();

    expect(files.length).toBe(1);
    expect(files[0].sourcePath).toBe(join(sourceDir, 'single.md'));
  });

  it('imports files into the vault under custom/ prefix', async () => {
    await mkdir(join(sourceDir, 'docs'), { recursive: true });
    await writeFile(join(sourceDir, 'docs', 'guide.md'), 'guide content');

    const manager = new ExtraPathsManager(
      [`${sourceDir}/docs/**/*.md`],
      vaultDir,
    );
    const result = await manager.importToVault();

    expect(result.imported.length).toBe(1);
    expect(result.imported[0]).toContain('custom/');
    expect(result.imported[0]).toContain('docs/guide.md');

    // Verify file exists in vault
    const vaultContent = await readFile(join(vaultDir, result.imported[0]), 'utf-8');
    expect(vaultContent).toBe('guide content');
  });

  it('skips files with identical content on re-import', async () => {
    await writeFile(join(sourceDir, 'file.md'), 'content');

    const manager = new ExtraPathsManager(
      [`${sourceDir}/file.md`],
      vaultDir,
    );

    const first = await manager.importToVault();
    expect(first.imported.length).toBe(1);

    const second = await manager.importToVault();
    expect(second.imported.length).toBe(0);
    expect(second.skipped.length).toBe(1);
  });

  it('re-imports files when content changes', async () => {
    await writeFile(join(sourceDir, 'file.md'), 'v1');

    const manager = new ExtraPathsManager(
      [`${sourceDir}/file.md`],
      vaultDir,
    );

    await manager.importToVault();
    await writeFile(join(sourceDir, 'file.md'), 'v2');

    const result = await manager.importToVault();
    expect(result.imported.length).toBe(1);
  });

  it('deduplicates files matched by multiple patterns', async () => {
    await mkdir(join(sourceDir, 'notes'), { recursive: true });
    await writeFile(join(sourceDir, 'notes', 'a.md'), 'content');

    const manager = new ExtraPathsManager(
      [`${sourceDir}/notes/**/*.md`, `${sourceDir}/notes/a.md`],
      vaultDir,
    );
    const files = await manager.discoverFiles();

    expect(files.length).toBe(1);
  });

  it('maps vault paths back to source paths', async () => {
    await writeFile(join(sourceDir, 'test.md'), 'content');

    const manager = new ExtraPathsManager(
      [`${sourceDir}/test.md`],
      vaultDir,
    );
    const files = await manager.discoverFiles();
    const vaultRel = files[0].vaultRelative;

    const sourcePath = manager.getSourcePath(vaultRel);
    expect(sourcePath).toBe(join(sourceDir, 'test.md'));
  });

  it('writes back to source from vault path', async () => {
    await writeFile(join(sourceDir, 'test.md'), 'original');

    const manager = new ExtraPathsManager(
      [`${sourceDir}/test.md`],
      vaultDir,
    );
    await manager.importToVault();
    const files = await manager.discoverFiles();
    const vaultRel = files[0].vaultRelative;

    await manager.writeBackToSource(vaultRel, Buffer.from('updated'));
    const content = await readFile(join(sourceDir, 'test.md'), 'utf-8');
    expect(content).toBe('updated');
  });

  it('returns correct watch paths', async () => {
    const manager = new ExtraPathsManager(
      [`${sourceDir}/notes/**/*.md`, `${sourceDir}/docs/*.txt`],
      vaultDir,
    );
    const watchPaths = manager.getWatchPaths();

    expect(watchPaths).toContain(join(sourceDir, 'notes'));
    expect(watchPaths).toContain(join(sourceDir, 'docs'));
  });

  it('sourceToVaultPath returns null for non-matching paths', () => {
    const manager = new ExtraPathsManager(
      [`${sourceDir}/notes/**/*.md`],
      vaultDir,
    );

    const result = manager.sourceToVaultPath('/some/random/path.md');
    expect(result).toBeNull();
  });

  it('handles empty patterns gracefully', async () => {
    const manager = new ExtraPathsManager([], vaultDir);
    const files = await manager.discoverFiles();
    expect(files.length).toBe(0);

    const result = await manager.importToVault();
    expect(result.imported.length).toBe(0);
    expect(result.skipped.length).toBe(0);
  });

  it('handles non-existent source paths gracefully', async () => {
    const manager = new ExtraPathsManager(
      [`${sourceDir}/nonexistent/**/*.md`],
      vaultDir,
    );
    const files = await manager.discoverFiles();
    expect(files.length).toBe(0);
  });

  it('skips dotfiles and node_modules', async () => {
    await mkdir(join(sourceDir, '.hidden'), { recursive: true });
    await mkdir(join(sourceDir, 'node_modules'), { recursive: true });
    await mkdir(join(sourceDir, 'visible'), { recursive: true });
    await writeFile(join(sourceDir, '.hidden', 'secret.md'), 'hidden');
    await writeFile(join(sourceDir, 'node_modules', 'pkg.md'), 'pkg');
    await writeFile(join(sourceDir, 'visible', 'ok.md'), 'ok');

    const manager = new ExtraPathsManager(
      [`${sourceDir}/**/*.md`],
      vaultDir,
    );
    const files = await manager.discoverFiles();

    expect(files.length).toBe(1);
    expect(files[0].sourcePath).toContain('visible/ok.md');
  });
});
