import { Command } from 'commander';
import chalk from 'chalk';
import { access, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir, platform } from 'node:os';

const MCP_SERVER_ENTRY = {
  command: 'npx',
  args: ['-y', 'contextmate', 'mcp', 'serve'],
};

interface AppTarget {
  name: string;
  slug: string;
  detectDir: string | null;
  configPath: string | null;
  mode: 'auto-write' | 'cli-command' | 'gui-only';
  cliCommand?: string;
  guiInstructions?: string[];
}

function getAppTargets(): AppTarget[] {
  const home = homedir();
  const isMac = platform() === 'darwin';
  const isWin = platform() === 'win32';

  const claudeDesktopDir = isMac
    ? join(home, 'Library', 'Application Support', 'Claude')
    : isWin
      ? join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'Claude')
      : null;

  const chatGptDir = isMac
    ? join(home, 'Library', 'Application Support', 'com.openai.chat')
    : isWin
      ? join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'com.openai.chat')
      : null;

  return [
    {
      name: 'Claude Desktop',
      slug: 'claude-desktop',
      detectDir: claudeDesktopDir,
      configPath: claudeDesktopDir ? join(claudeDesktopDir, 'claude_desktop_config.json') : null,
      mode: 'auto-write',
    },
    {
      name: 'Claude Code',
      slug: 'claude-code',
      detectDir: join(home, '.claude'),
      configPath: null,
      mode: 'cli-command',
      cliCommand: 'claude mcp add contextmate -- npx -y contextmate mcp serve',
    },
    {
      name: 'Cursor',
      slug: 'cursor',
      detectDir: join(home, '.cursor'),
      configPath: join(home, '.cursor', 'mcp.json'),
      mode: 'auto-write',
    },
    {
      name: 'Windsurf',
      slug: 'windsurf',
      detectDir: join(home, '.codeium', 'windsurf'),
      configPath: join(home, '.codeium', 'windsurf', 'mcp_config.json'),
      mode: 'auto-write',
    },
    {
      name: 'ChatGPT Desktop',
      slug: 'chatgpt',
      detectDir: chatGptDir,
      configPath: null,
      mode: 'gui-only',
      guiInstructions: [
        'Open ChatGPT > Settings > MCP Servers > Add Server',
        '',
        `  Name:      ${chalk.bold('ContextMate')}`,
        `  Command:   ${chalk.bold('npx')}`,
        `  Arguments: ${chalk.bold('-y contextmate mcp serve')}`,
      ],
    },
  ];
}

async function dirExists(path: string | null): Promise<boolean> {
  if (!path) return false;
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

type MergeResult = 'created' | 'updated' | 'already-configured';

async function mergeAndWriteConfig(configPath: string): Promise<MergeResult> {
  let existing: Record<string, unknown> = {};
  let fileExisted = false;

  try {
    const raw = await readFile(configPath, 'utf-8');
    existing = JSON.parse(raw) as Record<string, unknown>;
    fileExisted = true;
  } catch {
    // File doesn't exist or isn't valid JSON — start fresh
  }

  const servers = (existing.mcpServers || {}) as Record<string, unknown>;

  // Check if already configured with identical entry
  const current = servers.contextmate as Record<string, unknown> | undefined;
  if (current) {
    const currentCmd = current.command as string;
    const currentArgs = current.args as string[];
    if (
      currentCmd === MCP_SERVER_ENTRY.command &&
      Array.isArray(currentArgs) &&
      currentArgs.length === MCP_SERVER_ENTRY.args.length &&
      currentArgs.every((a, i) => a === MCP_SERVER_ENTRY.args[i])
    ) {
      return 'already-configured';
    }
  }

  servers.contextmate = { ...MCP_SERVER_ENTRY };
  existing.mcpServers = servers;

  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify(existing, null, 2) + '\n', 'utf-8');

  return fileExisted ? 'updated' : 'created';
}

function shortenPath(path: string): string {
  const home = homedir();
  if (path.startsWith(home)) {
    return '~' + path.slice(home.length);
  }
  return path;
}

export async function runMcpSetup(): Promise<void> {
  const targets = getAppTargets();

  console.log('');
  console.log(chalk.bold('ContextMate MCP Setup'));
  console.log(chalk.dim('─'.repeat(40)));
  console.log('');
  console.log(chalk.dim('Connects your AI apps to ContextMate\'s MCP server.'));
  console.log(chalk.dim('Apps get 6 tools: search, read, and write memories + skills.'));
  console.log('');

  const detected: AppTarget[] = [];
  const notDetected: AppTarget[] = [];

  for (const target of targets) {
    if (await dirExists(target.detectDir)) {
      detected.push(target);
    } else {
      notDetected.push(target);
    }
  }

  if (detected.length === 0) {
    console.log(chalk.dim('  No supported AI apps detected on this machine.'));
    console.log('');
    console.log('  To configure manually, add this to your app\'s MCP config:');
    console.log('');
    console.log(chalk.cyan(JSON.stringify({ mcpServers: { contextmate: MCP_SERVER_ENTRY } }, null, 2)));
    console.log('');
    return;
  }

  let configured = 0;

  for (const target of detected) {
    console.log(`  ${chalk.green('*')} ${chalk.bold(target.name)}`);

    if (target.mode === 'auto-write' && target.configPath) {
      const shortPath = shortenPath(target.configPath);
      console.log(chalk.dim(`    Config: ${shortPath}`));

      try {
        const result = await mergeAndWriteConfig(target.configPath);
        if (result === 'already-configured') {
          console.log(`    ${chalk.green('Already configured')}`);
        } else if (result === 'created') {
          console.log(`    ${chalk.green('Config file created')}`);
          configured++;
        } else {
          console.log(`    ${chalk.green('Config updated')} ${chalk.dim('(existing servers preserved)')}`);
          configured++;
        }
      } catch (err) {
        console.log(`    ${chalk.yellow('Could not write config:')} ${err instanceof Error ? err.message : String(err)}`);
        console.log(`    ${chalk.dim('Add this manually to')} ${shortPath}${chalk.dim(':')}`);
        console.log(chalk.dim(`    ${JSON.stringify({ contextmate: MCP_SERVER_ENTRY }, null, 2).replace(/\n/g, '\n    ')}`));
      }
    } else if (target.mode === 'cli-command' && target.cliCommand) {
      console.log(`    Run: ${chalk.cyan(target.cliCommand)}`);
    } else if (target.mode === 'gui-only' && target.guiInstructions) {
      for (const line of target.guiInstructions) {
        console.log(`    ${line}`);
      }
    }

    console.log('');
  }

  for (const target of notDetected) {
    if (target.configPath) {
      console.log(`  ${chalk.dim('o')} ${chalk.dim(target.name)} ${chalk.dim('— not detected')} ${chalk.dim(`(${shortenPath(target.configPath)})`)}`);
    } else {
      console.log(`  ${chalk.dim('o')} ${chalk.dim(target.name)} ${chalk.dim('— not detected')}`);
    }
  }

  if (notDetected.length > 0) console.log('');

  console.log(chalk.dim('─'.repeat(40)));
  if (configured > 0) {
    console.log(chalk.green('Restart your AI apps to load the new MCP server.'));
  }
  console.log('');
  console.log(`Verify by asking your AI: ${chalk.cyan('"List my skills"')}`);
  console.log('');
}

export const mcpSetupCommand = new Command('setup')
  .description('Auto-configure MCP for Claude, Cursor, Windsurf, ChatGPT')
  .option('--json', 'Print the MCP config JSON and exit')
  .action(async (opts: { json?: boolean }) => {
    if (opts.json) {
      const config = { mcpServers: { contextmate: MCP_SERVER_ENTRY } };
      console.log(JSON.stringify(config, null, 2));
      return;
    }

    await runMcpSetup();
  });
