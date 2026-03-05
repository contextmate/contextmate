#!/usr/bin/env node
import { program } from '../cli/index.js';
import { loadConfig, getConfigPath } from '../config.js';
import { getVersionFilePath } from '../utils/paths.js';
import { writeFile, access } from 'node:fs/promises';

// Stamp version file (fire-and-forget) so the persistent service restarts on updates
(async () => {
  try {
    await access(getConfigPath());
    const config = await loadConfig();
    const versionFile = getVersionFilePath(config);
    await writeFile(versionFile, program.version() ?? '', 'utf-8');
  } catch {
    // Not initialized yet, skip
  }
})();

program.parse();
