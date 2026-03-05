import { readFile, readdir, access, stat, copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join, relative, dirname } from 'node:path';
import { homedir } from 'node:os';
import { BaseAdapter, type ImportResult, type CopyResult } from './base.js';

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

    // 1b. Import skills from ~/.claude/skills/ (Claude Code's native global skills location)
    await this.importSkills(join(claudeDir, 'skills'), result);

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

  async copyToWorkspace(claudeDir: string): Promise<CopyResult> {
    const result: CopyResult = { copied: [], errors: [] };

    const skillsPath = join(homedir(), '.agents', 'skills');

    // 1. Skills: copy vault/skills/* into ~/.agents/skills/ and ~/.claude/skills/
    await this.copySkillsToWorkspace(skillsPath, result);
    await this.copySkillsToWorkspace(join(claudeDir, 'skills'), result);

    // 2. Rules: copy vault/claude/rules/*.md to ~/.claude/rules/
    await this.copyFilesToWorkspace(
      join(this.vaultPath, 'claude', 'rules'),
      join(claudeDir, 'rules'),
      result,
      'rules/',
    );

    // 3. CLAUDE.md: copy vault/claude/CLAUDE.md to ~/.claude/CLAUDE.md
    const vaultClaudeMd = join(this.vaultPath, 'claude', 'CLAUDE.md');
    const destClaudeMd = join(claudeDir, 'CLAUDE.md');
    try {
      await access(vaultClaudeMd);
      if (!(await this.filesMatch(vaultClaudeMd, destClaudeMd))) {
        await mkdir(dirname(destClaudeMd), { recursive: true });
        await copyFile(vaultClaudeMd, destClaudeMd);
        result.copied.push('CLAUDE.md');
      }
    } catch {
      // No CLAUDE.md in vault
    }

    // 4. Project memories: copy vault/claude/projects/*/memory/*.md to ~/.claude/projects/*/memory/
    await this.copyProjectMemoriesToWorkspace(claudeDir, result);

    return result;
  }

  async verifySync(claudeDir: string): Promise<{ synced: string[]; stale: string[] }> {
    const synced: string[] = [];
    const stale: string[] = [];

    const skillsPath = join(homedir(), '.agents', 'skills');

    // 1. Verify skills in ~/.agents/skills/ and ~/.claude/skills/
    await this.verifySkillSync(skillsPath, synced, stale);
    await this.verifySkillSync(join(claudeDir, 'skills'), synced, stale);

    // 2. Verify rules
    await this.verifyFileSync(
      join(this.vaultPath, 'claude', 'rules'),
      join(claudeDir, 'rules'),
      synced,
      stale,
      'rules/',
    );

    // 3. Verify CLAUDE.md
    const vaultClaudeMd = join(this.vaultPath, 'claude', 'CLAUDE.md');
    const destClaudeMd = join(claudeDir, 'CLAUDE.md');
    try {
      await access(vaultClaudeMd);
      if (await this.filesMatch(vaultClaudeMd, destClaudeMd)) {
        synced.push('CLAUDE.md');
      } else {
        stale.push('CLAUDE.md');
      }
    } catch {
      // No CLAUDE.md in vault, skip
    }

    // 4. Verify project memories
    await this.verifyProjectMemorySync(claudeDir, synced, stale);

    return { synced, stale };
  }

  async disconnect(_claudeDir: string): Promise<void> {
    // Workspace files are real copies — nothing to restore.
  }

  async syncBack(claudeDir: string): Promise<{ synced: string[] }> {
    const synced: string[] = [];

    const skillsPath = join(homedir(), '.agents', 'skills');

    // 1. Skills in ~/.agents/skills/ and ~/.claude/skills/
    await this.syncBackSkills(skillsPath, synced);
    await this.syncBackSkills(join(claudeDir, 'skills'), synced);

    // 2. Rules: ~/.claude/rules/*.md
    await this.syncBackFiles(
      join(claudeDir, 'rules'),
      join('claude', 'rules'),
      synced,
    );

    // 3. CLAUDE.md
    await this.syncBackSingleFile(
      join(claudeDir, 'CLAUDE.md'),
      join('claude', 'CLAUDE.md'),
      synced,
    );

    // 4. Project memories: ~/.claude/projects/*/memory/*.md
    await this.syncBackProjectMemories(claudeDir, synced);

    return { synced };
  }

  async syncFromVault(claudeDir: string): Promise<{ synced: string[] }> {
    const synced: string[] = [];

    const skillsPath = join(homedir(), '.agents', 'skills');

    // 1. Skills
    await this.syncSkillsFromVault(skillsPath, synced);
    await this.syncSkillsFromVault(join(claudeDir, 'skills'), synced);

    // 2. Rules
    await this.syncFilesFromVault(
      join(this.vaultPath, 'claude', 'rules'),
      join(claudeDir, 'rules'),
      synced,
      'rules/',
    );

    // 3. CLAUDE.md
    const vaultClaudeMd = join(this.vaultPath, 'claude', 'CLAUDE.md');
    const destClaudeMd = join(claudeDir, 'CLAUDE.md');
    try {
      await access(vaultClaudeMd);
      if (!(await this.filesMatch(vaultClaudeMd, destClaudeMd))) {
        await mkdir(dirname(destClaudeMd), { recursive: true });
        await copyFile(vaultClaudeMd, destClaudeMd);
        synced.push('CLAUDE.md');
      }
    } catch {
      // No CLAUDE.md in vault
    }

    // 4. Project memories
    await this.syncProjectMemoriesFromVault(claudeDir, synced);

    return { synced };
  }

  // --- SyncBack helpers ---

  private async syncBackSkills(skillsPath: string, synced: string[]): Promise<void> {
    const vaultSkillsDir = join(this.vaultPath, 'skills');
    let skillNames: string[];
    try {
      skillNames = await readdir(vaultSkillsDir);
    } catch {
      return;
    }

    for (const name of skillNames) {
      const vaultSkillDir = join(vaultSkillsDir, name);
      try {
        const s = await stat(vaultSkillDir);
        if (!s.isDirectory()) continue;
      } catch {
        continue;
      }

      const skillFile = join(skillsPath, name, 'SKILL.md');
      const vaultSkillFile = join(vaultSkillDir, 'SKILL.md');

      try {
        const localContent = await readFile(skillFile);
        try {
          const vaultContent = await readFile(vaultSkillFile);
          if (Buffer.compare(localContent, vaultContent) === 0) {
            continue;
          }
        } catch {
          // Vault file doesn't exist
        }

        await mkdir(dirname(vaultSkillFile), { recursive: true });
        await writeFile(vaultSkillFile, localContent);
        synced.push(join('skills', name, 'SKILL.md'));
      } catch {
        // Skill file not readable
      }
    }
  }

  private async syncBackFiles(
    sourceDir: string,
    vaultPrefix: string,
    synced: string[],
  ): Promise<void> {
    let names: string[];
    try {
      names = await readdir(sourceDir);
    } catch {
      return;
    }

    for (const name of names) {
      if (!name.endsWith('.md')) continue;
      const filePath = join(sourceDir, name);

      const vaultRelative = join(vaultPrefix, name);
      const vaultFilePath = join(this.vaultPath, vaultRelative);

      try {
        const localContent = await readFile(filePath);
        try {
          const vaultContent = await readFile(vaultFilePath);
          if (Buffer.compare(localContent, vaultContent) === 0) {
            continue;
          }
        } catch {
          // Vault file doesn't exist
        }

        await mkdir(dirname(vaultFilePath), { recursive: true });
        await writeFile(vaultFilePath, localContent);
        synced.push(vaultRelative);
      } catch {
        // Skip unreadable files
      }
    }
  }

  private async syncBackSingleFile(
    filePath: string,
    vaultRelative: string,
    synced: string[],
  ): Promise<void> {
    const vaultFilePath = join(this.vaultPath, vaultRelative);

    try {
      const localContent = await readFile(filePath);
      try {
        const vaultContent = await readFile(vaultFilePath);
        if (Buffer.compare(localContent, vaultContent) === 0) {
          return;
        }
      } catch {
        // Vault file doesn't exist
      }

      await mkdir(dirname(vaultFilePath), { recursive: true });
      await writeFile(vaultFilePath, localContent);
      synced.push(vaultRelative);
    } catch {
      // File not readable or doesn't exist
    }
  }

  private async syncBackProjectMemories(claudeDir: string, synced: string[]): Promise<void> {
    const vaultProjectsDir = join(this.vaultPath, 'claude', 'projects');
    let projectNames: string[];
    try {
      projectNames = await readdir(vaultProjectsDir);
    } catch {
      return;
    }

    for (const projectName of projectNames) {
      const targetMemoryDir = join(claudeDir, 'projects', projectName, 'memory');
      const vaultPrefix = join('claude', 'projects', projectName, 'memory');
      await this.syncBackFiles(targetMemoryDir, vaultPrefix, synced);
    }
  }

  // --- SyncFromVault helpers ---

  private async syncSkillsFromVault(skillsPath: string, synced: string[]): Promise<void> {
    const vaultSkillsDir = join(this.vaultPath, 'skills');
    let skillNames: string[];
    try {
      skillNames = await readdir(vaultSkillsDir);
    } catch {
      return;
    }

    for (const name of skillNames) {
      const vaultSkillDir = join(vaultSkillsDir, name);
      try {
        const s = await stat(vaultSkillDir);
        if (!s.isDirectory()) continue;
      } catch {
        continue;
      }

      const vaultSkillFile = join(vaultSkillDir, 'SKILL.md');
      const destSkillFile = join(skillsPath, name, 'SKILL.md');

      try {
        await access(vaultSkillFile);
        if (!(await this.filesMatch(vaultSkillFile, destSkillFile))) {
          await mkdir(dirname(destSkillFile), { recursive: true });
          await copyFile(vaultSkillFile, destSkillFile);
          synced.push(join('skills', name, 'SKILL.md'));
        }
      } catch {
        // Skip
      }
    }
  }

  private async syncFilesFromVault(
    vaultDir: string,
    targetDir: string,
    synced: string[],
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
      try {
        const s = await stat(vaultFile);
        if (!s.isFile()) continue;
      } catch {
        continue;
      }

      const destFile = join(targetDir, name);
      try {
        if (!(await this.filesMatch(vaultFile, destFile))) {
          await mkdir(dirname(destFile), { recursive: true });
          await copyFile(vaultFile, destFile);
          synced.push(`${prefix}${name}`);
        }
      } catch {
        // Skip
      }
    }
  }

  private async syncProjectMemoriesFromVault(claudeDir: string, synced: string[]): Promise<void> {
    const vaultProjectsDir = join(this.vaultPath, 'claude', 'projects');
    let projectNames: string[];
    try {
      projectNames = await readdir(vaultProjectsDir);
    } catch {
      return;
    }

    for (const projectName of projectNames) {
      const vaultMemoryDir = join(vaultProjectsDir, projectName, 'memory');
      const targetMemoryDir = join(claudeDir, 'projects', projectName, 'memory');
      await this.syncFilesFromVault(
        vaultMemoryDir,
        targetMemoryDir,
        synced,
        `project:${projectName}/memory/`,
      );
    }
  }

  // --- Copy to workspace helpers ---

  private async copySkillsToWorkspace(skillsPath: string, result: CopyResult): Promise<void> {
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

      const destDir = join(skillsPath, name);

      try {
        // Copy all files in the skill directory
        await this.copyDirectory(vaultSkillDir, destDir);
        result.copied.push(`skill:${name}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result.errors.push(`skill ${name}: ${message}`);
      }
    }
  }

  private async copyFilesToWorkspace(
    vaultDir: string,
    targetDir: string,
    result: CopyResult,
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

      const destFile = join(targetDir, name);

      try {
        if (!(await this.filesMatch(vaultFile, destFile))) {
          await copyFile(vaultFile, destFile);
          result.copied.push(`${prefix}${name}`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result.errors.push(`${prefix}${name}: ${message}`);
      }
    }
  }

  private async copyProjectMemoriesToWorkspace(claudeDir: string, result: CopyResult): Promise<void> {
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

        const destFile = join(targetMemoryDir, fileName);
        try {
          if (!(await this.filesMatch(vaultFile, destFile))) {
            await copyFile(vaultFile, destFile);
            result.copied.push(`project:${projectName}/memory/${fileName}`);
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          result.errors.push(`project ${projectName}/${fileName}: ${message}`);
        }
      }
    }
  }

  // --- Verify helpers ---

  private async verifySkillSync(
    skillsPath: string,
    synced: string[],
    stale: string[],
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

      const vaultSkillFile = join(vaultSkillDir, 'SKILL.md');
      const destSkillFile = join(skillsPath, name, 'SKILL.md');

      if (await this.filesMatch(vaultSkillFile, destSkillFile)) {
        synced.push(`skill:${name}`);
      } else {
        stale.push(`skill:${name}`);
      }
    }
  }

  private async verifyFileSync(
    vaultDir: string,
    targetDir: string,
    synced: string[],
    stale: string[],
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

      const targetFile = join(targetDir, name);

      if (await this.filesMatch(vaultFile, targetFile)) {
        synced.push(`${prefix}${name}`);
      } else {
        stale.push(`${prefix}${name}`);
      }
    }
  }

  private async verifyProjectMemorySync(
    claudeDir: string,
    synced: string[],
    stale: string[],
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

        const targetFile = join(targetMemoryDir, fileName);
        const label = `project:${projectName}/memory/${fileName}`;

        if (await this.filesMatch(vaultFile, targetFile)) {
          synced.push(label);
        } else {
          stale.push(label);
        }
      }
    }
  }

  // --- Import helpers ---

  private async importProjectSkills(result: ImportResult): Promise<void> {
    for (const scanPath of this.scanPaths) {
      let projectNames: string[];
      try {
        projectNames = await readdir(scanPath);
      } catch {
        continue;
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
      return;
    }

    for (const name of names) {
      if (!name.endsWith('.md')) continue;
      const filePath = join(rulesDir, name);
      let s;
      try {
        s = await stat(filePath);
      } catch {
        continue;
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
      return;
    }

    for (const projectName of projectNames) {
      const memoryDir = join(projectsDir, projectName, 'memory');
      let memoryFiles: string[];
      try {
        memoryFiles = await readdir(memoryDir);
      } catch {
        continue;
      }

      for (const fileName of memoryFiles) {
        if (!fileName.endsWith('.md')) continue;
        const filePath = join(memoryDir, fileName);
        let s;
        try {
          s = await stat(filePath);
        } catch {
          continue;
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
      return;
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

  private async copyDirectory(sourcePath: string, destPath: string): Promise<void> {
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
