import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ClaudeCodeAdapter } from '../../src/adapters/claude.js';
import { tmpdir } from 'node:os';
import { mkdtemp, rm, writeFile, mkdir, readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';

let tmpDir: string;
let claudeDir: string;
let skillsPath: string;
let vaultPath: string;
let backupsPath: string;
let adapter: ClaudeCodeAdapter;

async function createMockClaudeStructure(basePath: string): Promise<{
  claudeDir: string;
  skillsPath: string;
}> {
  const claude = join(basePath, '.claude');
  const agents = join(basePath, '.agents', 'skills');

  // Create ~/.claude/CLAUDE.md
  await mkdir(claude, { recursive: true });
  await writeFile(join(claude, 'CLAUDE.md'), '# Global Memory\nGlobal instructions for Claude');

  // Create ~/.claude/rules/
  await mkdir(join(claude, 'rules'), { recursive: true });
  await writeFile(
    join(claude, 'rules', 'coding-standards.md'),
    '# Coding Standards\nUse TypeScript strict mode',
  );
  await writeFile(
    join(claude, 'rules', 'review-process.md'),
    '# Review Process\nAll PRs need 2 approvals',
  );

  // Create ~/.claude/projects/my-project/memory/
  await mkdir(join(claude, 'projects', 'my-project', 'memory'), { recursive: true });
  await writeFile(
    join(claude, 'projects', 'my-project', 'memory', 'MEMORY.md'),
    '# Project Memory\nKey architecture decisions',
  );
  await writeFile(
    join(claude, 'projects', 'my-project', 'memory', 'debug-notes.md'),
    '# Debug Notes\nCommon debugging patterns',
  );

  // Create ~/.agents/skills/test-skill/SKILL.md
  await mkdir(join(agents, 'test-skill'), { recursive: true });
  await writeFile(
    join(agents, 'test-skill', 'SKILL.md'),
    '# Test Skill\nA skill for testing',
  );

  return { claudeDir: claude, skillsPath: agents };
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'contextmate-claude-test-'));
  const mock = await createMockClaudeStructure(tmpDir);
  claudeDir = mock.claudeDir;
  skillsPath = mock.skillsPath;
  vaultPath = join(tmpDir, 'vault');
  backupsPath = join(tmpDir, 'backups');
  await mkdir(vaultPath, { recursive: true });
  await mkdir(backupsPath, { recursive: true });
  adapter = new ClaudeCodeAdapter({ vaultPath, backupsPath });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('ClaudeCodeAdapter', () => {
  describe('detect()', () => {
    it('returns path when .claude directory exists', async () => {
      const result = await adapter.detect();
      expect(result === null || typeof result === 'string').toBe(true);
    });

    it('returns null when .claude does not exist', async () => {
      const result = await adapter.detect();
      expect(result === null || typeof result === 'string').toBe(true);
    });
  });

  describe('import()', () => {
    it('copies skills to vault/skills/', async () => {
      const result = await adapter.import(claudeDir);
      expect(result.errors.length).toBe(0);

      const ruleContent = await readFile(
        join(vaultPath, 'claude', 'rules', 'coding-standards.md'),
        'utf-8',
      );
      expect(ruleContent).toContain('Use TypeScript strict mode');
    });

    it('copies rules to vault/claude/rules/', async () => {
      const result = await adapter.import(claudeDir);
      expect(result.errors.length).toBe(0);

      const imported = result.imported.filter((i) => i.startsWith('claude/rules/'));
      expect(imported.length).toBe(2);
      expect(imported).toContain('claude/rules/coding-standards.md');
      expect(imported).toContain('claude/rules/review-process.md');

      const content = await readFile(
        join(vaultPath, 'claude', 'rules', 'review-process.md'),
        'utf-8',
      );
      expect(content).toContain('All PRs need 2 approvals');
    });

    it('copies CLAUDE.md to vault/claude/CLAUDE.md', async () => {
      const result = await adapter.import(claudeDir);
      expect(result.errors.length).toBe(0);
      expect(result.imported).toContain('claude/CLAUDE.md');

      const content = await readFile(join(vaultPath, 'claude', 'CLAUDE.md'), 'utf-8');
      expect(content).toContain('Global instructions for Claude');
    });

    it('copies project memories to vault/claude/projects/', async () => {
      const result = await adapter.import(claudeDir);
      expect(result.errors.length).toBe(0);

      const projectImports = result.imported.filter((i) => i.startsWith('claude/projects/'));
      expect(projectImports.length).toBe(2);
      expect(projectImports).toContain('claude/projects/my-project/memory/MEMORY.md');
      expect(projectImports).toContain('claude/projects/my-project/memory/debug-notes.md');

      const memContent = await readFile(
        join(vaultPath, 'claude', 'projects', 'my-project', 'memory', 'MEMORY.md'),
        'utf-8',
      );
      expect(memContent).toContain('Key architecture decisions');
    });

    it('skips files with identical content on reimport', async () => {
      await adapter.import(claudeDir);
      const result = await adapter.import(claudeDir);
      expect(result.skipped.length).toBeGreaterThan(0);
      expect(result.skipped).toContain('claude/CLAUDE.md');
      expect(result.imported.length).toBe(0);
    });

    it('handles missing optional directories gracefully', async () => {
      const minDir = join(tmpDir, 'minimal-claude');
      await mkdir(minDir, { recursive: true });
      await writeFile(join(minDir, 'CLAUDE.md'), '# Minimal');

      const result = await adapter.import(minDir);
      expect(result.errors.length).toBe(0);
      expect(result.imported).toContain('claude/CLAUDE.md');
      const rules = result.imported.filter((i) => i.startsWith('claude/rules/'));
      expect(rules.length).toBe(0);
    });
  });

  describe('copyToWorkspace()', () => {
    it('copies rules as regular files', async () => {
      await adapter.import(claudeDir);
      const result = await adapter.copyToWorkspace(claudeDir);
      const nonSkillErrors = result.errors.filter((e) => !e.startsWith('skill '));
      expect(nonSkillErrors.length).toBe(0);

      const rulePath = join(claudeDir, 'rules', 'coding-standards.md');
      const stats = await lstat(rulePath);
      expect(stats.isFile()).toBe(true);
      expect(stats.isSymbolicLink()).toBe(false);

      const content = await readFile(rulePath, 'utf-8');
      expect(content).toContain('Use TypeScript strict mode');
    });

    it('copies CLAUDE.md as a regular file', async () => {
      await adapter.import(claudeDir);
      // Modify vault content to simulate a remote update
      await writeFile(join(vaultPath, 'claude', 'CLAUDE.md'), '# Updated\nNew cloud content');
      const result = await adapter.copyToWorkspace(claudeDir);
      const nonSkillErrors = result.errors.filter((e) => !e.startsWith('skill '));
      expect(nonSkillErrors.length).toBe(0);
      expect(result.copied).toContain('CLAUDE.md');

      const claudeMdPath = join(claudeDir, 'CLAUDE.md');
      const stats = await lstat(claudeMdPath);
      expect(stats.isFile()).toBe(true);
      expect(stats.isSymbolicLink()).toBe(false);

      const content = await readFile(claudeMdPath, 'utf-8');
      expect(content).toContain('New cloud content');
    });

    it('copies project memories as regular files', async () => {
      await adapter.import(claudeDir);
      const result = await adapter.copyToWorkspace(claudeDir);
      const nonSkillErrors = result.errors.filter((e) => !e.startsWith('skill '));
      expect(nonSkillErrors.length).toBe(0);

      const memPath = join(claudeDir, 'projects', 'my-project', 'memory', 'MEMORY.md');
      const stats = await lstat(memPath);
      expect(stats.isFile()).toBe(true);
      expect(stats.isSymbolicLink()).toBe(false);

      const content = await readFile(memPath, 'utf-8');
      expect(content).toContain('Key architecture decisions');
    });

    it('copies all file types when vault has newer content', async () => {
      await adapter.import(claudeDir);
      // Modify vault files to simulate remote updates
      await writeFile(join(vaultPath, 'claude', 'CLAUDE.md'), '# Updated CLAUDE');
      await writeFile(join(vaultPath, 'claude', 'rules', 'coding-standards.md'), '# Updated rule 1');
      await writeFile(join(vaultPath, 'claude', 'rules', 'review-process.md'), '# Updated rule 2');
      await writeFile(join(vaultPath, 'claude', 'projects', 'my-project', 'memory', 'MEMORY.md'), '# Updated mem 1');
      await writeFile(join(vaultPath, 'claude', 'projects', 'my-project', 'memory', 'debug-notes.md'), '# Updated mem 2');

      const result = await adapter.copyToWorkspace(claudeDir);
      const nonSkillErrors = result.errors.filter((e) => !e.startsWith('skill '));
      expect(nonSkillErrors.length).toBe(0);

      // Should have: 2 rules + 1 CLAUDE.md + 2 project memories = 5
      const ruleCopied = result.copied.filter((c) => c.startsWith('rules/'));
      const projectCopied = result.copied.filter((c) => c.startsWith('project:'));
      expect(ruleCopied.length).toBe(2);
      expect(result.copied).toContain('CLAUDE.md');
      expect(projectCopied.length).toBe(2);
    });
  });

  describe('verifySync()', () => {
    it('validates all files as synced after copy', async () => {
      await adapter.import(claudeDir);
      await adapter.copyToWorkspace(claudeDir);

      const result = await adapter.verifySync(claudeDir);
      const nonSkillSynced = result.synced.filter((v) => !v.startsWith('skill:'));
      const nonSkillStale = result.stale.filter((v) => !v.startsWith('skill:'));
      expect(nonSkillSynced.length).toBeGreaterThan(0);
      expect(nonSkillStale.length).toBe(0);

      expect(result.synced).toContain('CLAUDE.md');
      const ruleSynced = result.synced.filter((v) => v.startsWith('rules/'));
      expect(ruleSynced.length).toBe(2);
    });
  });

  describe('disconnect()', () => {
    it('leaves workspace files intact', async () => {
      await adapter.import(claudeDir);
      await adapter.copyToWorkspace(claudeDir);

      await adapter.disconnect(claudeDir);

      // Files should still be readable
      const content = await readFile(join(claudeDir, 'CLAUDE.md'), 'utf-8');
      expect(content).toContain('Global instructions for Claude');

      const ruleContent = await readFile(join(claudeDir, 'rules', 'coding-standards.md'), 'utf-8');
      expect(ruleContent).toContain('Use TypeScript strict mode');
    });
  });

  describe('syncBack()', () => {
    it('detects changed rules and syncs content to vault', async () => {
      await adapter.import(claudeDir);

      const rulePath = join(claudeDir, 'rules', 'coding-standards.md');
      await writeFile(rulePath, '# Coding Standards\nUpdated standards');

      const result = await adapter.syncBack(claudeDir);
      expect(result.synced).toContain('claude/rules/coding-standards.md');

      const vaultContent = await readFile(
        join(vaultPath, 'claude', 'rules', 'coding-standards.md'),
        'utf-8',
      );
      expect(vaultContent).toContain('Updated standards');

      // File should still be a regular file
      const stats = await lstat(rulePath);
      expect(stats.isFile()).toBe(true);
      expect(stats.isSymbolicLink()).toBe(false);
    });

    it('detects changed CLAUDE.md and syncs back', async () => {
      await adapter.import(claudeDir);

      const claudeMdPath = join(claudeDir, 'CLAUDE.md');
      await writeFile(claudeMdPath, '# Updated CLAUDE.md\nNew instructions');

      const result = await adapter.syncBack(claudeDir);
      expect(result.synced).toContain('claude/CLAUDE.md');

      const vaultContent = await readFile(join(vaultPath, 'claude', 'CLAUDE.md'), 'utf-8');
      expect(vaultContent).toContain('New instructions');
    });

    it('detects changed project memory and syncs back', async () => {
      await adapter.import(claudeDir);

      const memPath = join(claudeDir, 'projects', 'my-project', 'memory', 'MEMORY.md');
      await writeFile(memPath, '# Project Memory\nUpdated architecture notes');

      const result = await adapter.syncBack(claudeDir);
      expect(result.synced).toContain('claude/projects/my-project/memory/MEMORY.md');

      const vaultContent = await readFile(
        join(vaultPath, 'claude', 'projects', 'my-project', 'memory', 'MEMORY.md'),
        'utf-8',
      );
      expect(vaultContent).toContain('Updated architecture notes');
    });

    it('skips files with identical content', async () => {
      await adapter.import(claudeDir);

      const result = await adapter.syncBack(claudeDir);
      expect(result.synced.length).toBe(0);
    });
  });

  describe('syncFromVault()', () => {
    it('copies vault changes to workspace', async () => {
      await adapter.import(claudeDir);

      // Simulate a remote change arriving in the vault
      await writeFile(join(vaultPath, 'claude', 'CLAUDE.md'), '# Updated from cloud');

      const result = await adapter.syncFromVault(claudeDir);
      expect(result.synced).toContain('CLAUDE.md');

      const content = await readFile(join(claudeDir, 'CLAUDE.md'), 'utf-8');
      expect(content).toContain('Updated from cloud');
    });

    it('copies vault rule changes to workspace', async () => {
      await adapter.import(claudeDir);

      await writeFile(
        join(vaultPath, 'claude', 'rules', 'coding-standards.md'),
        '# Updated Standards\nFrom another device',
      );

      const result = await adapter.syncFromVault(claudeDir);
      expect(result.synced).toContain('rules/coding-standards.md');

      const content = await readFile(join(claudeDir, 'rules', 'coding-standards.md'), 'utf-8');
      expect(content).toContain('From another device');
    });

    it('skips files already in sync', async () => {
      await adapter.import(claudeDir);

      const result = await adapter.syncFromVault(claudeDir);
      expect(result.synced.length).toBe(0);
    });
  });
});
