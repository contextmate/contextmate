import { Command } from 'commander';
import { initCommand } from './init.js';
import { statusCommand } from './status.js';
import { adapterCommand } from './adapter.js';
import { mcpCommand } from './mcp.js';
import { daemonCommand } from './daemon.js';
import { logCommand } from './log.js';
import { filesCommand } from './files.js';
import { resetCommand } from './reset.js';
import { setupCommand } from './setup.js';

export const program = new Command()
  .name('contextmate')
  .description('Zero-knowledge encrypted sync for AI agent context')
  .version('0.3.4');

program.addCommand(setupCommand);
program.addCommand(initCommand);
program.addCommand(statusCommand);
program.addCommand(adapterCommand);
program.addCommand(mcpCommand);
program.addCommand(daemonCommand);
program.addCommand(logCommand);
program.addCommand(filesCommand);
program.addCommand(resetCommand);
