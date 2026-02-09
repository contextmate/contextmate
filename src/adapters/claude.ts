import { readFile, readdir, access, stat, unlink, copyFile, mkdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { homedir } from 'node:os';
import { BaseAdapter, type ImportResult, type SymlinkResult } from './base.js';

export class ClaudeCodeAdapter extends BaseAdapter {
  private scanPaths: string[];

  constructor(options: ConstructorParameters<typeof BaseAdapter>[0]) {
    super(options);
    this.scanPaths = options.scanPaths ?? [];
  }

  get name(): string {
    return 'claude';
  }

  async detect(): Promise<string | null> {
    const claudeDir = join(homedir(), '.claude');
    try {
      await access(claudeDir);
      return claudeDir;
    } catch {
      return null;
    }
  }

  async import(claudeDir: string): Promise<ImportResult> {
    const result: ImportResult = { imported: [], skipped: [], errors: [] };

    const skillsPath = join(homedir(), '.agents', 'skills');

    // 1. Import skills: ~/.agents/skills/*/SKILL.md -> vault/skills/*/SKILL.md
    await this.importSkills(skillsPath, result);

    // 2. Scan configured directories for project-specific skills
    await this.importProjectSkills(result);

    // 3. Import rules: ~/.claude/rules/*.md -> vault/claude/rules/*.md
    await this.importRules(join(claudeDir, 'rules'), result);

    // 4. Import global CLAUDE.md: ~/.claude/CLAUDE.md -> vault/claude/CLAUDE.md
    await this.importSingleFile(
      join(claudeDir, 'CLAUDE.md'),
      join('claude', 'CLAUDE.md'),
      result,
    );

    // 5. Import project memories: ~/.claude/projects/*/memory/*.md -> vault/claude/projects/*/memory/*.md
    await this.importProjectMemories(join(claudeDir, 'projects'), result);

    return result;
  }

  async createSymlinks(claudeDir: string): Promise<SymlinkResult> {
    const result: SymlinkResult = { created: [], errors: [] };

    const skillsPath = join(homedir(), '.agents', 'skills');

    // 1. Skills: link vault/skills/* into ~/.agents/skills/
    await this.symlinkSkills(skillsPath, result);

    // 2. Rules: link vault/claude/rules/*.md back to ~/.claude/rules/
    await this.symlinkFiles(
      join(this.vaultPath, 'claude', 'rules'),
      join(claudeDir, 'rules'),
      result,
      'rules/',
    );

    // 3. CLAUDE.md: link vault/claude/CLAUDE.md to ~/.claude/CLAUDE.md
    const vaultClaudeMd = join(this.vaultPath, 'claude', 'CLAUDE.md');
    try {
      await access(vaultClaudeMd);
      await this.safeSymlink(vaultClaudeMd, join(claudeDir, 'CLAUDE.md'));
      result.created.push('CLAUDE.md');
    } catch {
      // No CLAUDE.md in vault
    }

    // 4. Project memories: link vault/claude/projects/*/memory/*.md back to ~/.claude/projects/*/memory/
    await this.symlinkProjectMemories(claudeDir, result);

    return result;
  }

  async verifySymlinks(claudeDir: string): Promise<{ valid: string[]; broken: string[] }> {
    const valid: string[] = [];
    const broken: string[] = [];

    const skillsPath = join(homedir(), '.agents', 'skills');

    // 1. Verify skill symlinks
    await this.verifySkillSymlinks(skillsPath, valid, broken);

    // 2. Verify rule symlinks
    await this.verifyFileSymlinks(
      join(this.vaultPath, 'claude', 'rules'),
      join(claudeDir, 'rules'),
      valid,
      broken,
      'rules/',
    );

    // 3. Verify CLAUDE.md symlink
    const claudeMdLink = join(claudeDir, 'CLAUDE.md');
    const vaultClaudeMd = join(this.vaultPath, 'claude', 'CLAUDE.md');
    try {
      await access(vaultClaudeMd);
      if (await this.isSymlink(claudeMdLink)) {
        try {
          await stat(claudeMdLink);
          valid.push('CLAUDE.md');
        } catch {
          broken.push('CLAUDE.md');
        }
      } else {
        broken.push('CLAUDE.md');
      }
    } catch {
      // No CLAUDE.md in vault, skip
    }

    // 4. Verify project memory symlinks
    await this.verifyProjectMemorySymlinks(claudeDir, valid, broken);

    return { valid, broken };
  }

  async removeSymlinks(claudeDir: string): Promise<void> {
    const skillsPath = join(homedir(), '.agents', 'skills');

    // 1. Remove skill symlinks
    await this.removeSkillSymlinks(skillsPath);

    // 2. Remove rule symlinks
    await this.removeFileSymlinks(
      join(this.vaultPath, 'claude', 'rules'),
      join(claudeDir, 'rules'),
    );

    // 3. Remove CLAUDE.md symlink
    await this.removeSingleSymlink(
      join(claudeDir, 'CLAUDE.md'),
      join(this.vaultPath, 'claude', 'CLAUDE.md'),
    );

    // 4. Remove project memory symlinks
    await this.removeProjectMemorySymlinks(claudeDir);
  }

  // --- Import helpers ---

  /**
   * Scan configured scanPaths for project-specific skills.
   * Looks for <scanPath>/<project>/.claude/skills/<name>/SKILL.md
   */
  private async importProjectSkills(result: ImportResult): Promise<void> {
    for (const scanPath of this.scanPaths) {
      let projectNames: string[];
      try {
        projectNames = await readdir(scanPath);
      } catch {
        continue; // Directory doesn't exist or isn't readable
      }

      for (const projectName of projectNames) {
        const projectSkillsDir = join(scanPath, projectName, '.claude', 'skills');
        const skillDirs = await this.discoverSkillDirs(projectSkillsDir);

        for (const skillDir of skillDirs) {
          const skillName = relative(projectSkillsDir, skillDir);
          const skillFile = join(skillDir, 'SKILL.md');
          const vaultRelative = join('skills', skillName, 'SKILL.md');

          try {
            await this.importSingleFile(skillFile, vaultRelative, result);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            result.errors.push(`project skill ${skillName}: ${message}`);
          }
        }
      }
    }
  }

  private async importSkills(skillsPath: string, result: ImportResult): Promise<void> {
    const skillDirs = await this.discoverSkillDirs(skillsPath);

    for (const skillDir of skillDirs) {
      const skillName = relative(skillsPath, skillDir);
      const skillFile = join(skillDir, 'SKILL.md');
      const vaultRelative = join('skills', skillName, 'SKILL.md');

      try {
        await this.importSingleFile(skillFile, vaultRelative, result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result.errors.push(`skill ${skillName}: ${message}`);
      }
    }
  }

  private async importRules(rulesDir: string, result: ImportResult): Promise<void> {
    let names: string[];
    try {
      names = await readdir(rulesDir);
    } catch {
      return; // No rules directory
    }

    for (const name of names) {
      if (!name.endsWith('.md')) continue;
      const filePath = join(rulesDir, name);
      let s;
      try {
        s = await stat(filePath);
      } catch {
        continue; // Broken symlink or inaccessible file
      }
      if (!s.isFile()) continue;

      const vaultRelative = join('claude', 'rules', name);
      try {
        await this.importSingleFile(filePath, vaultRelative, result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result.errors.push(`rule ${name}: ${message}`);
      }
    }
  }

  private async importProjectMemories(projectsDir: string, result: ImportResult): Promise<void> {
    let projectNames: string[];
    try {
      projectNames = await readdir(projectsDir);
    } catch {
      return; // No projects directory
    }

    for (const projectName of projectNames) {
      const memoryDir = join(projectsDir, projectName, 'memory');
      let memoryFiles: string[];
      try {
        memoryFiles = await readdir(memoryDir);
      } catch {
        continue; // No memory directory in this project
      }

      for (const fileName of memoryFiles) {
        if (!fileName.endsWith('.md')) continue;
        const filePath = join(memoryDir, fileName);
        let s;
        try {
          s = await stat(filePath);
        } catch {
          continue; // Broken symlink or inaccessible file
        }
        if (!s.isFile()) continue;

        const vaultRelative = join('claude', 'projects', projectName, 'memory', fileName);
        try {
          await this.importSingleFile(filePath, vaultRelative, result);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          result.errors.push(`project memory ${projectName}/${fileName}: ${message}`);
        }
      }
    }
  }

  private async importSingleFile(
    sourcePath: string,
    vaultRelative: string,
    result: ImportResult,
  ): Promise<void> {
    let sourceContent: string;
    try {
      sourceContent = await readFile(sourcePath, 'utf-8');
    } catch {
      return; // Source file doesn't exist
    }

    const vaultDest = join(this.vaultPath, vaultRelative);
    try {
      const existingContent = await readFile(vaultDest, 'utf-8');
      if (existingContent === sourceContent) {
        result.skipped.push(vaultRelative);
        return;
      }
    } catch {
      // File doesn't exist in vault yet
    }

    await this.copyToVault(sourcePath, vaultRelative);
    result.imported.push(vaultRelative);
  }

  // --- Symlink helpers ---

  private async symlinkSkills(skillsPath: string, result: SymlinkResult): Promise<void> {
    await mkdir(skillsPath, { recursive: true });

    const vaultSkillsDir = join(this.vaultPath, 'skills');
    let skillNames: string[];
    try {
      skillNames = await readdir(vaultSkillsDir);
    } catch {
      return;
    }

    for (const name of skillNames) {
      const vaultSkillDir = join(vaultSkillsDir, name);
      const s = await stat(vaultSkillDir);
      if (!s.isDirectory()) continue;

      const linkPath = join(skillsPath, name);

      try {
        if (!(await this.isSymlink(linkPath))) {
          try {
            await access(linkPath);
            await this.backupDirectory(linkPath, name);
          } catch {
            // Doesn't exist
          }
        }

        await this.safeSymlink(vaultSkillDir, linkPath);
        result.created.push(`skill:${name}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result.errors.push(`skill ${name}: ${message}`);
      }
    }
  }

  private async symlinkFiles(
    vaultDir: string,
    targetDir: string,
    result: SymlinkResult,
    prefix: string,
  ): Promise<void> {
    let names: string[];
    try {
      names = await readdir(vaultDir);
    } catch {
      return;
    }

    await mkdir(targetDir, { recursive: true });

    for (const name of names) {
      const vaultFile = join(vaultDir, name);
      const s = await stat(vaultFile);
      if (!s.isFile()) continue;

      const linkPath = join(targetDir, name);

      try {
        await this.safeSymlink(vaultFile, linkPath);
        result.created.push(`${prefix}${name}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result.errors.push(`${prefix}${name}: ${message}`);
      }
    }
  }

  private async symlinkProjectMemories(claudeDir: string, result: SymlinkResult): Promise<void> {
    const vaultProjectsDir = join(this.vaultPath, 'claude', 'projects');
    let projectNames: string[];
    try {
      projectNames = await readdir(vaultProjectsDir);
    } catch {
      return;
    }

    for (const projectName of projectNames) {
      const vaultMemoryDir = join(vaultProjectsDir, projectName, 'memory');
      let memoryFiles: string[];
      try {
        memoryFiles = await readdir(vaultMemoryDir);
      } catch {
        continue;
      }

      const targetMemoryDir = join(claudeDir, 'projects', projectName, 'memory');
      await mkdir(targetMemoryDir, { recursive: true });

      for (const fileName of memoryFiles) {
        const vaultFile = join(vaultMemoryDir, fileName);
        const s = await stat(vaultFile);
        if (!s.isFile()) continue;

        const linkPath = join(targetMemoryDir, fileName);
        try {
          await this.safeSymlink(vaultFile, linkPath);
          result.created.push(`project:${projectName}/memory/${fileName}`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          result.errors.push(`project ${projectName}/${fileName}: ${message}`);
        }
      }
    }
  }

  // --- Verify helpers ---

  private async verifySkillSymlinks(
    skillsPath: string,
    valid: string[],
    broken: string[],
  ): Promise<void> {
    const vaultSkillsDir = join(this.vaultPath, 'skills');
    let skillNames: string[];
    try {
      skillNames = await readdir(vaultSkillsDir);
    } catch {
      return;
    }

    for (const name of skillNames) {
      const vaultSkillDir = join(vaultSkillsDir, name);
      const s = await stat(vaultSkillDir);
      if (!s.isDirectory()) continue;

      const linkPath = join(skillsPath, name);
      if (await this.isSymlink(linkPath)) {
        try {
          await stat(linkPath);
          valid.push(`skill:${name}`);
        } catch {
          broken.push(`skill:${name}`);
        }
      } else {
        broken.push(`skill:${name}`);
      }
    }
  }

  private async verifyFileSymlinks(
    vaultDir: string,
    targetDir: string,
    valid: string[],
    broken: string[],
    prefix: string,
  ): Promise<void> {
    let names: string[];
    try {
      names = await readdir(vaultDir);
    } catch {
      return;
    }

    for (const name of names) {
      const vaultFile = join(vaultDir, name);
      const s = await stat(vaultFile);
      if (!s.isFile()) continue;

      const linkPath = join(targetDir, name);
      if (await this.isSymlink(linkPath)) {
        try {
          await stat(linkPath);
          valid.push(`${prefix}${name}`);
        } catch {
          broken.push(`${prefix}${name}`);
        }
      } else {
        broken.push(`${prefix}${name}`);
      }
    }
  }

  private async verifyProjectMemorySymlinks(
    claudeDir: string,
    valid: string[],
    broken: string[],
  ): Promise<void> {
    const vaultProjectsDir = join(this.vaultPath, 'claude', 'projects');
    let projectNames: string[];
    try {
      projectNames = await readdir(vaultProjectsDir);
    } catch {
      return;
    }

    for (const projectName of projectNames) {
      const vaultMemoryDir = join(vaultProjectsDir, projectName, 'memory');
      let memoryFiles: string[];
      try {
        memoryFiles = await readdir(vaultMemoryDir);
      } catch {
        continue;
      }

      const targetMemoryDir = join(claudeDir, 'projects', projectName, 'memory');

      for (const fileName of memoryFiles) {
        const vaultFile = join(vaultMemoryDir, fileName);
        const s = await stat(vaultFile);
        if (!s.isFile()) continue;

        const linkPath = join(targetMemoryDir, fileName);
        const label = `project:${projectName}/memory/${fileName}`;
        if (await this.isSymlink(linkPath)) {
          try {
            await stat(linkPath);
            valid.push(label);
          } catch {
            broken.push(label);
          }
        } else {
          broken.push(label);
        }
      }
    }
  }

  // --- Remove helpers ---

  private async removeSkillSymlinks(skillsPath: string): Promise<void> {
    const vaultSkillsDir = join(this.vaultPath, 'skills');
    let skillNames: string[];
    try {
      skillNames = await readdir(vaultSkillsDir);
    } catch {
      return;
    }

    for (const name of skillNames) {
      const vaultSkillDir = join(vaultSkillsDir, name);
      const s = await stat(vaultSkillDir);
      if (!s.isDirectory()) continue;

      const linkPath = join(skillsPath, name);
      if (!(await this.isSymlink(linkPath))) continue;

      await unlink(linkPath);

      const backupPath = join(this.backupsPath, 'claude', name);
      try {
        await access(backupPath);
        await this.restoreDirectory(backupPath, linkPath);
      } catch {
        try {
          await this.restoreDirectory(vaultSkillDir, linkPath);
        } catch {
          // Nothing to restore
        }
      }
    }
  }

  private async removeFileSymlinks(vaultDir: string, targetDir: string): Promise<void> {
    let names: string[];
    try {
      names = await readdir(vaultDir);
    } catch {
      return;
    }

    for (const name of names) {
      const linkPath = join(targetDir, name);
      await this.removeSingleSymlink(linkPath, join(vaultDir, name));
    }
  }

  private async removeSingleSymlink(linkPath: string, vaultSource: string): Promise<void> {
    if (!(await this.isSymlink(linkPath))) return;

    await unlink(linkPath);

    // Restore from backup or vault copy
    const backupPath = join(this.backupsPath, 'claude', relative(this.vaultPath, vaultSource));
    try {
      await access(backupPath);
      await copyFile(backupPath, linkPath);
    } catch {
      try {
        await access(vaultSource);
        await copyFile(vaultSource, linkPath);
      } catch {
        // Nothing to restore
      }
    }
  }

  private async removeProjectMemorySymlinks(claudeDir: string): Promise<void> {
    const vaultProjectsDir = join(this.vaultPath, 'claude', 'projects');
    let projectNames: string[];
    try {
      projectNames = await readdir(vaultProjectsDir);
    } catch {
      return;
    }

    for (const projectName of projectNames) {
      const vaultMemoryDir = join(vaultProjectsDir, projectName, 'memory');
      let memoryFiles: string[];
      try {
        memoryFiles = await readdir(vaultMemoryDir);
      } catch {
        continue;
      }

      const targetMemoryDir = join(claudeDir, 'projects', projectName, 'memory');

      for (const fileName of memoryFiles) {
        const linkPath = join(targetMemoryDir, fileName);
        const vaultFile = join(vaultMemoryDir, fileName);
        await this.removeSingleSymlink(linkPath, vaultFile);
      }
    }
  }

  // --- Utility ---

  private async discoverSkillDirs(skillsPath: string): Promise<string[]> {
    const dirs: string[] = [];

    try {
      const names = await readdir(skillsPath);
      for (const name of names) {
        const dirPath = join(skillsPath, name);
        const s = await stat(dirPath);
        if (s.isDirectory()) {
          const skillFile = join(dirPath, 'SKILL.md');
          try {
            await access(skillFile);
            dirs.push(dirPath);
          } catch {
            // No SKILL.md in this directory
          }
        }
      }
    } catch {
      // Skills directory doesn't exist
    }

    return dirs;
  }

  private async backupDirectory(dirPath: string, skillName: string): Promise<void> {
    const backupDest = join(this.backupsPath, 'claude', skillName);
    await mkdir(backupDest, { recursive: true });

    const names = await readdir(dirPath);
    for (const name of names) {
      const filePath = join(dirPath, name);
      const s = await stat(filePath);
      if (s.isFile()) {
        await copyFile(filePath, join(backupDest, name));
      }
    }
  }

  private async restoreDirectory(sourcePath: string, destPath: string): Promise<void> {
    await mkdir(destPath, { recursive: true });

    const names = await readdir(sourcePath);
    for (const name of names) {
      const filePath = join(sourcePath, name);
      const s = await stat(filePath);
      if (s.isFile()) {
        await copyFile(filePath, join(destPath, name));
      }
    }
  }
}
