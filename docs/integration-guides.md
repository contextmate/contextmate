# ContextMate Integration Guides

Connect any MCP-compatible AI agent to ContextMate's local MCP server for shared access to your memories, skills, and daily logs -- all decrypted locally on your machine.

## Quick Setup (All Apps)

The easiest way to connect ContextMate to your AI apps:

```bash
contextmate mcp setup
```

This auto-detects installed apps (Claude Desktop, Claude Code, Cursor, Windsurf, ChatGPT) and configures them. For the JSON config only:

```bash
contextmate mcp setup --json
```

---

## Prerequisites

```bash
# Install
npm install -g contextmate

# Initialize (creates vault, config, encryption keys)
contextmate setup
```

This creates:
- `~/.contextmate/config.toml` -- configuration file
- `~/.contextmate/vault/` -- your decrypted vault directory
- `~/.contextmate/data/` -- internal databases and credentials

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

## 1. Claude Desktop

The Claude desktop app supports MCP servers, letting you use your ContextMate memories and skills in regular Claude conversations.

### Auto-Setup (Recommended)

```bash
contextmate mcp setup
```

### Manual Setup

Edit the Claude desktop app's MCP configuration file:

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

Add the ContextMate server:

```json
{
  "mcpServers": {
    "contextmate": {
      "command": "npx",
      "args": ["-y", "contextmate", "mcp", "serve"]
    }
  }
}
```

Restart the Claude desktop app after editing the config.

### Verify It Works

Start a new conversation and ask:

> "List all my skills"

Claude should call the `list-skills` tool and show your vault's skills. Try also:

> "Search my memories for the architecture decisions I made last week"

### Troubleshooting

| Issue | Solution |
|-------|----------|
| Tools not appearing | Restart Claude desktop after editing config. Check the hammer icon in the chat input. |
| "ContextMate is not initialized" | Run `contextmate setup` first. |
| Config file not found | Create the directory and file if they don't exist. |
| `npx` not found | Claude desktop needs `npx` in its PATH. You may need to use the full path: `/usr/local/bin/npx` or the path from `which npx`. |

---

## 2. Claude Code

Claude Code natively supports MCP servers. You can connect ContextMate as an MCP server and optionally use the Claude Code adapter for full file-level sync.

### Auto-Setup (Recommended)

```bash
claude mcp add contextmate -- npx -y contextmate mcp serve
```

### Verify It Works

Open a new Claude Code session. You should see ContextMate listed among available MCP servers. Try asking:

> "Search my memories for React patterns"

Claude Code will call the `search-memory` tool and return ranked results from your vault.

### Optional: Use the Claude Code Adapter

In addition to MCP access, you can sync Claude Code's own context files (rules, project memories, CLAUDE.md) into the ContextMate vault:

```bash
contextmate adapter claude init
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
contextmate adapter claude status
```

### Troubleshooting

| Issue | Solution |
|-------|----------|
| "ContextMate is not initialized" | Run `contextmate setup` first. |
| MCP server not appearing | Run `claude mcp list` to verify it was added. Restart Claude Code after adding. |
| "No results found" from search | Your vault may be empty. Add some memory or skill files first, or run an adapter init. |

---

## 3. Cursor

Cursor supports MCP servers and can connect to ContextMate for reading skills, searching memories, and accessing project context while you code.

### Auto-Setup (Recommended)

```bash
contextmate mcp setup
```

### Manual Setup

Create or edit `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "contextmate": {
      "command": "npx",
      "args": ["-y", "contextmate", "mcp", "serve"]
    }
  }
}
```

You can also configure this through Cursor's settings UI: **Settings** > **MCP** > **Add Server**.

### Verify It Works

In Cursor's AI chat, ask:

> "List my available skills"

Cursor should call `list-skills` and show your vault's skills. Try also:

> "Search my memories for authentication patterns"

### Troubleshooting

| Issue | Solution |
|-------|----------|
| "ContextMate is not initialized" | Run `contextmate setup` first. |
| MCP server not appearing | Ensure `~/.cursor/mcp.json` is valid JSON. Restart Cursor after changes. |
| `npx` not found | Ensure Node.js 20+ is installed (`node --version`). |

---

## 4. Windsurf

Windsurf supports MCP servers for AI-assisted coding with your ContextMate memories and skills.

### Auto-Setup (Recommended)

```bash
contextmate mcp setup
```

### Manual Setup

Create or edit `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "contextmate": {
      "command": "npx",
      "args": ["-y", "contextmate", "mcp", "serve"]
    }
  }
}
```

### Verify It Works

Ask Windsurf's AI:

> "Search my memories for deployment strategies"

### Troubleshooting

| Issue | Solution |
|-------|----------|
| "ContextMate is not initialized" | Run `contextmate setup` first. |
| MCP server not appearing | Restart Windsurf after editing config. |
| Config directory missing | Create `~/.codeium/windsurf/` first. |

---

## 5. ChatGPT Desktop

ChatGPT's desktop app (macOS/Windows) supports MCP servers. The web interface does not support MCP.

### Setup

1. Open the ChatGPT desktop app.
2. Go to **Settings** (gear icon).
3. Navigate to **MCP Servers**.
4. Click **Add Server**.
5. Enter:

   - **Name**: `ContextMate`
   - **Command**: `npx`
   - **Arguments**: `-y contextmate mcp serve`

### Verify It Works

Start a new ChatGPT conversation. Ask:

> "Search my memories for deployment strategies"

ChatGPT should invoke the `search-memory` tool and return results from your vault.

### Troubleshooting

| Issue | Solution |
|-------|----------|
| "ContextMate is not initialized" | Run `contextmate setup` first. |
| ChatGPT doesn't show MCP tools | Ensure you're using the desktop app, not the web interface. Restart the app after adding. |
| Server process not starting | Ensure Node.js 20+ is installed. Try running `npx -y contextmate mcp serve` manually to check for errors. |

---

## 6. Other MCP-Compatible Agents

Any agent that supports the Model Context Protocol over stdio can connect to ContextMate.

### Generic JSON Config

Most MCP-compatible agents accept a configuration like this:

```json
{
  "mcpServers": {
    "contextmate": {
      "command": "npx",
      "args": ["-y", "contextmate", "mcp", "serve"]
    }
  }
}
```

### API Key Scoping (Optional)

Use scoped API keys to restrict what each agent can access:

```bash
# Create a read-only key for skills only
contextmate mcp api-key create --name "my-agent" --scope "skills/*" --permissions read

# Create a full-access key
contextmate mcp api-key create --name "my-agent" --scope "*" --permissions read-write

# List existing keys
contextmate mcp api-key list

# Revoke a key
contextmate mcp api-key revoke <key-id>
```

Then add the key to your config:

```json
{
  "mcpServers": {
    "contextmate": {
      "command": "npx",
      "args": ["-y", "contextmate", "mcp", "serve", "--api-key", "YOUR_KEY_ID"]
    }
  }
}
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

---

## Security Notes

- **Local decryption**: The MCP server runs entirely on your machine. All vault content is decrypted locally. No plaintext ever leaves your device via the MCP server.
- **Scope enforcement**: API keys restrict which files and operations each agent can access. Always use scoped keys for agents you don't fully control.
- **No network access**: The MCP server itself does not make network requests. It reads from and writes to your local vault directory only. (The sync daemon, started separately with `contextmate daemon start`, handles encrypted cloud sync.)
- **Path traversal protection**: The server validates all file paths to prevent reads/writes outside the vault directory.

---

## General Troubleshooting

| Issue | Solution |
|-------|----------|
| "ContextMate is not initialized" | Run `contextmate setup` to create the vault and config. |
| Empty search results | Your vault may have no content. Add files to `~/.contextmate/vault/` or run an adapter init. |
| Node.js version errors | ContextMate requires Node.js >= 20. Check with `node --version`. |
| Permission denied on vault | Ensure `~/.contextmate/vault/` is readable/writable by your user. |
| Multiple agents writing simultaneously | Each agent gets its own MCP server process. Writes go to the local filesystem. The sync daemon handles propagation. |
