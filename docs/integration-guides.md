# ContextMate Integration Guides

Connect any MCP-compatible AI agent to ContextMate's local MCP server for shared access to your memories, skills, and daily logs -- all decrypted locally on your machine.

## Prerequisites (All Agents)

Before connecting any agent, you must have ContextMate initialized:

```bash
# Install dependencies
cd /path/to/contextmate
npm install

# Initialize ContextMate (creates vault, config, encryption keys)
npx tsx src/bin/contextmate.ts init
```

This creates:
- `~/.contextmate/config.toml` -- configuration file
- `~/.contextmate/vault/` -- your decrypted vault directory
- `~/.contextmate/data/` -- internal databases and credentials

Populate your vault with some content before connecting agents. You can do this by connecting an adapter (e.g., `contextmate adapter openclaw init`) or by manually placing markdown files in `~/.contextmate/vault/`.

---

## Available MCP Tools

All connected agents have access to the following tools:

| Tool | Description | Permission |
|------|-------------|------------|
| `search-memory` | Hybrid BM25 + vector search across all memories. Supports `keyword`, `semantic`, and `hybrid` modes. | read |
| `read-memory` | Read a specific memory file by relative path (e.g., `openclaw/MEMORY.md`). | read |
| `write-memory` | Append content to a memory file. Defaults to today's daily log if no file specified. | read-write |
| `read-skill` | Read a specific skill's SKILL.md by name (e.g., `my-skill`). | read |
| `list-skills` | List all available skills with their first few lines. | read |
| `list-memories` | List all memory files with modification timestamps. | read |

### Search Modes

The `search-memory` tool supports three modes via the `mode` parameter:

- **hybrid** (default): Combines BM25 keyword search and TF-IDF vector similarity via Reciprocal Rank Fusion. Best for general queries.
- **keyword**: BM25 only. Best for exact phrase matching.
- **semantic**: TF-IDF vector similarity only. Best for finding conceptually related content even when exact words differ.

---

## 1. Claude Code

Claude Code natively supports MCP servers via its configuration file. You can connect ContextMate as an MCP server and optionally use the Claude Code adapter for full file-level sync.

### Step 1: Add ContextMate as an MCP Server

Edit (or create) the Claude Code MCP configuration file at `~/.claude/mcp_servers.json`:

```json
{
  "mcpServers": {
    "contextmate": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/contextmate/src/bin/contextmate.ts", "mcp", "serve"]
    }
  }
}
```

Replace `/absolute/path/to/contextmate` with the actual absolute path to your ContextMate installation directory. For example:

```json
{
  "mcpServers": {
    "contextmate": {
      "command": "npx",
      "args": ["tsx", "/Users/yourname/Developer/contextmate/src/bin/contextmate.ts", "mcp", "serve"]
    }
  }
}
```

The MCP server communicates over stdio -- Claude Code will spawn the process and communicate with it directly.

### Step 2: Verify It Works

Open a new Claude Code session. You should see ContextMate listed among available MCP servers. Try asking:

> "Search my memories for React patterns"

Claude Code will call the `search-memory` tool and return ranked results from your vault.

You can also verify by asking:

> "List all my skills"

This calls `list-skills` and shows all SKILL.md files in your vault.

### Step 3 (Optional): Use the Claude Code Adapter

In addition to MCP access, you can sync Claude Code's own context files (rules, project memories, CLAUDE.md) into the ContextMate vault:

```bash
npx tsx src/bin/contextmate.ts adapter claude init
```

This will:
- Detect your Claude Code workspace at `~/.claude/`
- Import skills from `~/.agents/skills/*/SKILL.md` (shared across agents)
- Import rules from `~/.claude/rules/*.md`
- Import `~/.claude/CLAUDE.md` (global memory)
- Import project memories from `~/.claude/projects/*/memory/*.md`
- Replace original files with symlinks pointing to the vault

Check adapter health:

```bash
npx tsx src/bin/contextmate.ts adapter claude status
```

### Using an API Key with Scope (Optional)

For security, you can restrict the MCP server's access with a scoped API key:

```bash
# Create a read-write key for Claude Code with full access
npx tsx src/bin/contextmate.ts mcp api-key create \
  --name "claude-code" \
  --scope "*" \
  --permissions read-write
```

Note the key ID from the output, then reference it in your MCP config:

```json
{
  "mcpServers": {
    "contextmate": {
      "command": "npx",
      "args": [
        "tsx", "/absolute/path/to/contextmate/src/bin/contextmate.ts",
        "mcp", "serve",
        "--api-key", "YOUR_KEY_ID"
      ]
    }
  }
}
```

### Troubleshooting

| Issue | Solution |
|-------|----------|
| "ContextMate is not initialized" | Run `npx tsx src/bin/contextmate.ts init` first. |
| MCP server not appearing in Claude Code | Ensure the path in `mcp_servers.json` is an absolute path, not relative. Restart Claude Code after editing the config. |
| "No results found" from search | Your vault may be empty. Add some memory or skill files first, or run an adapter init. |
| Permission errors | Check that your user has read/write access to `~/.contextmate/vault/` and the ContextMate directory. |
| `tsx` not found | Run `npm install` in the ContextMate directory to install devDependencies, or install tsx globally: `npm install -g tsx`. |

---

## 2. Claude Desktop App

The Claude desktop app (claude.ai desktop client) supports MCP servers, separate from Claude Code. This lets you use your ContextMate memories and skills in regular Claude conversations.

### Step 1: Add ContextMate as an MCP Server

Edit the Claude desktop app's MCP configuration file:

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

Add the ContextMate server:

```json
{
  "mcpServers": {
    "contextmate": {
      "command": "npx",
      "args": [
        "tsx", "/absolute/path/to/contextmate/src/bin/contextmate.ts",
        "mcp", "serve"
      ]
    }
  }
}
```

Replace `/absolute/path/to/contextmate` with the actual path to your ContextMate installation.

### Step 2: Restart Claude

Quit and reopen the Claude desktop app. ContextMate should appear in the MCP tools indicator (hammer icon) in the chat input area.

### Step 3: Verify It Works

Start a new conversation and ask:

> "List all my skills"

Claude should call the `list-skills` tool and show your vault's skills. Try also:

> "Search my memories for the architecture decisions I made last week"

### Example Workflows

- **Conversation with context**: "Based on my memories, summarize the key decisions I've made about the auth system"
- **Skill reference**: "Read my API error handling skill and suggest improvements"
- **Daily journaling**: "Add to my daily log: Had a productive design review, decided to go with event sourcing"
- **Cross-agent memories**: Anything written by Claude Code, ChatGPT, or Cursor is searchable from Claude desktop

### With Scoped API Key (Optional)

```bash
npx tsx src/bin/contextmate.ts mcp api-key create \
  --name "claude-desktop" \
  --scope "*" \
  --permissions read-write
```

Then add `"--api-key", "YOUR_KEY_ID"` to the args array in the config.

### Troubleshooting

| Issue | Solution |
|-------|----------|
| Tools not appearing | Restart Claude desktop after editing config. Check the hammer icon in the chat input. |
| "ContextMate is not initialized" | Run `npx tsx src/bin/contextmate.ts init` first. |
| Config file not found | Create the directory and file if they don't exist. |
| `npx` not found | Claude desktop needs `npx` in its PATH. You may need to use the full path: `/usr/local/bin/npx` or the path from `which npx`. |

---

## 3. ChatGPT (Desktop App)

ChatGPT's desktop application supports MCP servers as of March 2025. This integration works via the desktop app only -- the web interface does not support MCP.

### Step 1: Create an API Key

Create a scoped API key for ChatGPT:

```bash
npx tsx src/bin/contextmate.ts mcp api-key create \
  --name "chatgpt" \
  --scope "*" \
  --permissions read-write
```

Save the key ID that is printed. You will need it for the configuration.

### Step 2: Configure ChatGPT MCP

1. Open the ChatGPT desktop app.
2. Go to **Settings** (gear icon in the sidebar).
3. Navigate to the **MCP Servers** or **Tools** section.
4. Click **Add Server** (or **Add MCP Server**).
5. Enter the following configuration:

   - **Name**: `ContextMate`
   - **Transport**: `stdio`
   - **Command**: `npx`
   - **Arguments**: `tsx /absolute/path/to/contextmate/src/bin/contextmate.ts mcp serve --api-key YOUR_KEY_ID`

Alternatively, if ChatGPT supports a JSON config file, use:

```json
{
  "mcpServers": {
    "contextmate": {
      "command": "npx",
      "args": [
        "tsx", "/absolute/path/to/contextmate/src/bin/contextmate.ts",
        "mcp", "serve",
        "--api-key", "YOUR_KEY_ID"
      ]
    }
  }
}
```

Replace `/absolute/path/to/contextmate` with the real path and `YOUR_KEY_ID` with the ID from Step 1.

### Step 3: Verify It Works

Start a new ChatGPT conversation. Ask:

> "Search my memories for deployment strategies"

ChatGPT should invoke the `search-memory` tool and return results from your vault.

Try also:

> "Write a note to my daily log: Finished migrating auth service to v2"

This calls `write-memory` and appends to today's daily log file.

### Example Workflows

- **Morning standup**: "What did I work on yesterday?" -- ChatGPT searches your memory logs.
- **Knowledge retrieval**: "Read my skill for database migrations" -- ChatGPT reads the SKILL.md for that skill.
- **Daily journaling**: "Add to my daily log: Resolved the caching issue with Redis TTL" -- appends to today's log.
- **Cross-agent context**: If you also use Claude Code or Cursor, memories written by those agents are searchable from ChatGPT.

### Limitations

- MCP support is only available in the **ChatGPT desktop app** (macOS/Windows), not the web interface.
- ChatGPT's MCP implementation may not support all parameter formats. If a tool call fails, try rephrasing your request with simpler terms.
- Some MCP features (like the `mode` parameter on `search-memory`) may need to be specified explicitly in your prompt if ChatGPT doesn't infer them.

### Troubleshooting

| Issue | Solution |
|-------|----------|
| "ContextMate is not initialized" | Run `npx tsx src/bin/contextmate.ts init` first. |
| ChatGPT doesn't show MCP tools | Ensure you are using the desktop app, not the web interface. Restart the app after adding the MCP config. |
| API key not found | Verify the key ID with `npx tsx src/bin/contextmate.ts mcp api-key list`. |
| Scope denied errors | The API key scope may be too restrictive. Use `--scope "*"` for full access. |
| Server process not starting | Ensure `npx` and `tsx` are available in your PATH. Try running the command manually in your terminal to check for errors. |

---

## 3. Cursor

Cursor supports MCP servers and can connect to ContextMate for reading skills, searching memories, and accessing project context while you code.

### Step 1: Create an API Key

Create a scoped API key for Cursor. For a typical coding workflow, read-only access to skills is often sufficient:

```bash
# Read-only access to skills only
npx tsx src/bin/contextmate.ts mcp api-key create \
  --name "cursor" \
  --scope "skills/*" \
  --permissions read
```

For broader access (read memories, write daily logs):

```bash
# Full read-write access
npx tsx src/bin/contextmate.ts mcp api-key create \
  --name "cursor" \
  --scope "*" \
  --permissions read-write
```

### Step 2: Configure Cursor MCP

Create or edit the file `.cursor/mcp.json` in your project directory (or your home directory for global config):

```json
{
  "mcpServers": {
    "contextmate": {
      "command": "npx",
      "args": [
        "tsx", "/absolute/path/to/contextmate/src/bin/contextmate.ts",
        "mcp", "serve",
        "--api-key", "YOUR_KEY_ID"
      ]
    }
  }
}
```

Replace `/absolute/path/to/contextmate` with the real path and `YOUR_KEY_ID` with the ID from Step 1.

You can also configure this through Cursor's settings UI:

1. Open Cursor.
2. Go to **Settings** > **MCP** (or **Tools**).
3. Add a new MCP server with the command and arguments above.

### Step 3: Verify It Works

In Cursor's AI chat or inline edit, ask:

> "List my available skills"

Cursor should call `list-skills` and show your vault's skills.

Try also:

> "Search my memories for authentication patterns"

### Example Workflows

- **Coding with context**: While editing code, ask Cursor "Read my skill for API error handling" to pull in your documented patterns.
- **Project knowledge**: "Search my memories for the database schema decisions" retrieves relevant past notes.
- **Scoped access**: Using a `skills/*` scope ensures Cursor can only read skills, not modify memories -- useful for limiting what your editor can access.

### Troubleshooting

| Issue | Solution |
|-------|----------|
| "ContextMate is not initialized" | Run `npx tsx src/bin/contextmate.ts init` first. |
| MCP server not appearing | Ensure `.cursor/mcp.json` is valid JSON. Restart Cursor after changes. |
| Scope denied on memory access | Your API key may be scoped to `skills/*` only. Create a new key with broader scope if needed. |
| `tsx` not found | Ensure `npx` resolves to your project's or global `tsx`. Run `npm install` in the ContextMate directory. |

---

## 4. Other MCP-Compatible Agents

Any agent that supports the Model Context Protocol over stdio can connect to ContextMate.

### Generic Configuration

The ContextMate MCP server uses **stdio transport**. The agent spawns the server process and communicates via stdin/stdout.

**Command to start the server:**

```bash
npx tsx /absolute/path/to/contextmate/src/bin/contextmate.ts mcp serve
```

**With a scoped API key:**

```bash
npx tsx /absolute/path/to/contextmate/src/bin/contextmate.ts mcp serve --api-key YOUR_KEY_ID
```

### Generic JSON Config

Most MCP-compatible agents accept a configuration like this:

```json
{
  "mcpServers": {
    "contextmate": {
      "command": "npx",
      "args": [
        "tsx", "/absolute/path/to/contextmate/src/bin/contextmate.ts",
        "mcp", "serve"
      ]
    }
  }
}
```

### API Key Scoping

Use scoped API keys to follow the principle of least privilege. Each agent should only have the permissions it needs.

```bash
# Create API keys with the CLI
npx tsx src/bin/contextmate.ts mcp api-key create \
  --name "<agent-name>" \
  --scope "<scope-pattern>" \
  --permissions <read|read-write>

# List existing keys
npx tsx src/bin/contextmate.ts mcp api-key list

# Revoke a key
npx tsx src/bin/contextmate.ts mcp api-key revoke <key-id>
```

**Scope patterns:**

| Pattern | Matches |
|---------|---------|
| `*` | Everything in the vault |
| `skills/*` | All skill files (including nested paths like `openclaw/skills/`) |
| `memories/*` | All memory files (paths containing `memory/` or ending with `MEMORY.md`) |
| `skills/*,memories/*` | Both skills and memories (comma-separated) |

**Permission levels:**

| Permission | Allows |
|------------|--------|
| `read` | `search-memory`, `read-memory`, `read-skill`, `list-skills`, `list-memories` |
| `read-write` | All of the above, plus `write-memory` |

### Tools Reference

| Tool | Parameters | Description |
|------|-----------|-------------|
| `search-memory` | `query` (string, required), `limit` (number, default 10), `mode` (keyword/semantic/hybrid, default hybrid) | Search across all memory files using hybrid ranking |
| `read-memory` | `file` (string, required) | Read a specific file by vault-relative path |
| `write-memory` | `content` (string, required), `file` (string, optional) | Append content to a file; defaults to today's daily log |
| `read-skill` | `skill` (string, required) | Read a skill by name (looks in `skills/<name>/SKILL.md`) |
| `list-skills` | (none) | List all skills with preview text |
| `list-memories` | (none) | List all memory files with modification dates |

---

## Security Notes

- **Local decryption**: The MCP server runs entirely on your machine. All vault content is decrypted locally. No plaintext ever leaves your device via the MCP server.
- **Scope enforcement**: API keys restrict which files and operations each agent can access. Always use scoped keys for agents you don't fully control.
- **No network access**: The MCP server itself does not make network requests. It reads from and writes to your local vault directory only. (The sync daemon, started separately with `contextmate daemon start`, handles encrypted cloud sync.)
- **Path traversal protection**: The server validates all file paths to prevent reads/writes outside the vault directory.

---

## Managing API Keys

```bash
# Create a new API key
npx tsx src/bin/contextmate.ts mcp api-key create \
  --name "my-agent" \
  --scope "skills/*,memories/*" \
  --permissions read

# List all API keys
npx tsx src/bin/contextmate.ts mcp api-key list

# Revoke an API key by ID
npx tsx src/bin/contextmate.ts mcp api-key revoke <key-id>
```

API key metadata (name, scope, permissions, creation date, last used) is stored locally at `~/.contextmate/data/api-keys.json`. The actual key value is only shown once at creation time.

---

## General Troubleshooting

| Issue | Solution |
|-------|----------|
| "ContextMate is not initialized" | Run `npx tsx src/bin/contextmate.ts init` to create the vault and config. |
| Empty search results | Your vault may have no content. Add files to `~/.contextmate/vault/` or run an adapter init. |
| `tsx` command not found | Install it: `npm install -g tsx`, or run from the ContextMate directory where it's a devDependency. |
| Node.js version errors | ContextMate requires Node.js >= 20. Check with `node --version`. |
| Permission denied on vault | Ensure `~/.contextmate/vault/` is readable/writable by your user: `chmod -R u+rw ~/.contextmate/vault/`. |
| Multiple agents writing simultaneously | Each agent gets its own MCP server process. Writes go to the local filesystem. The sync daemon handles propagation. Conflicts are resolved with remote-wins (local saved as `.conflict.md`). |
| API key ID vs key value | The `--api-key` flag on `mcp serve` expects the **key ID** (shown as the hex string in `api-key list`), not the `cs_...` key value. |
