# ContextMate

**Zero-knowledge encrypted sync for AI agent context.**

[![npm version](https://img.shields.io/npm/v/contextmate)](https://www.npmjs.com/package/contextmate)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![tests](https://img.shields.io/github/actions/workflow/status/contextmate/contextmate/test.yml?label=tests)](https://github.com/contextmate/contextmate/actions)

Dropbox for your AI brain. Memories, skills, and rules -- encrypted and auto-synced across every agent and device.

## Quick Install

```bash
curl -fsSL https://raw.githubusercontent.com/contextmate/contextmate/main/install.sh | bash
```

## What It Does

Your AI agents (Claude Code, Cursor, OpenClaw) store knowledge in markdown files -- memories, skills, rules, and identity. These files live on one machine in one agent's directory.

ContextMate syncs them everywhere:

- **Cross-device**: Your skills and memories follow you to every machine.
- **Cross-agent**: Knowledge written in Claude Code flows to OpenClaw and back.
- **Zero-knowledge encryption**: Your passphrase never leaves your device. The server stores only encrypted blobs.

## Quick Start

**One command does everything:**

```bash
contextmate setup
```

This guided setup will:
1. Create your account (or log into an existing one)
2. Auto-detect Claude Code and OpenClaw
3. Import your skills, rules, and memories
4. Ask which directories to scan for project skills
5. Sync all files to the cloud
6. Open the web dashboard at [app.contextmate.dev](https://app.contextmate.dev)
7. Start the sync daemon

That's it. Your AI context is now encrypted, synced, and accessible from any device.

### Web Dashboard

Manage your vault, devices, and API keys from [app.contextmate.dev](https://app.contextmate.dev). View synced files, edit per-device scan paths, and create API keys -- all from the browser.

### Multi-device

On a second machine, run the same command and choose "Log into existing account":

```bash
contextmate setup
# Choose: 2. Log into existing account
# Enter your User ID and passphrase
```

## CLI Reference

| Command | Description |
|---------|-------------|
| **`contextmate setup`** | **Complete guided setup -- account, adapters, sync, and dashboard** |
| `contextmate init` | Create a new account or log into an existing one |
| `contextmate status` | Show connection status, account info, and sync state |
| `contextmate adapter claude init` | Import Claude Code files and create symlinks |
| `contextmate adapter claude status` | Check Claude Code symlink health |
| `contextmate adapter claude remove` | Remove symlinks and restore originals |
| `contextmate adapter openclaw init` | Import OpenClaw files and create symlinks |
| `contextmate adapter openclaw status` | Check OpenClaw symlink health |
| `contextmate adapter openclaw remove` | Remove symlinks and restore originals |
| `contextmate daemon start` | Start the background sync daemon |
| `contextmate daemon stop` | Stop the sync daemon |
| `contextmate daemon status` | Check if the daemon is running |
| `contextmate files` | List all tracked files in your vault |
| `contextmate log` | Show recent sync activity |
| `contextmate mcp setup` | Auto-configure MCP for Claude, Cursor, Windsurf, ChatGPT |
| `contextmate mcp serve` | Start the local MCP server (BM25 search) |
| `contextmate mcp api-key` | Manage MCP API keys |
| `contextmate reset` | Remove all ContextMate data and symlinks from this machine |

Most users only need `contextmate setup`. The other commands are available for advanced usage and troubleshooting.

## Architecture

```
Passphrase --> Argon2id --> Master Key --> HKDF branches
                             |
                             +-- vault key (per-file AES-256-GCM encryption)
                             +-- auth key  (server authentication)
                             +-- sharing key (future sharing features)
```

- All encryption happens on your device with AES-256-GCM.
- The server only ever sees encrypted blobs.
- Keys are derived using Argon2id (t=3, m=64MB, p=4) and HKDF-SHA256.

Read the full security model at [contextmate.dev/security](https://contextmate.dev/security).

### Connect to More AI Apps

After setup, connect ContextMate's MCP server to Cursor, Windsurf, Claude Desktop, or ChatGPT:

```bash
contextmate mcp setup
```

This auto-detects installed apps and writes their MCP configs. Your AI apps get 6 tools: search, read, and write your memories and skills.

## Supported Agents

| Agent | Status |
|-------|--------|
| Claude Code | Supported (adapter + MCP) |
| Claude Desktop | Supported (MCP) |
| OpenClaw | Supported (adapter) |
| Cursor | Supported (MCP) |
| Windsurf | Supported (MCP) |
| ChatGPT Desktop | Supported (MCP) |

## Development

### Prerequisites

- Node.js 20+

### Setup

```bash
# Clone the repo
git clone https://github.com/contextmate/contextmate.git
cd contextmate

# CLI (root)
npm install
npm run build

# Server
cd server
npm install

# Web dashboard
cd web
npm install

# Marketing site
cd www
npm install
```

### Run Tests

```bash
npm test
```

## Project Structure

```
src/                  # CLI client
  bin/                #   Entry point
  cli/                #   Commands (setup, init, status, adapter, daemon, mcp, files, log, reset)
  crypto/             #   Encryption (AES-256-GCM, Argon2id, HKDF, BLAKE3)
  sync/               #   Sync engine (watcher, state, WebSocket)
  adapters/           #   Agent adapters (Claude Code, OpenClaw)
  mcp/                #   Local MCP server (BM25 search)
server/               # Cloud API (Hono, SQLite, WebSocket)
web/                  # Web dashboard (React, Vite, Web Crypto API)
www/                  # Marketing site (Astro 5, Tailwind CSS v4)
tests/                # Test suites (Vitest)
```

## Security

ContextMate is built on a zero-knowledge architecture. Your passphrase is never transmitted, and the server cannot decrypt your data. All cryptographic operations use audited libraries (`@noble/ciphers`, `@noble/hashes`).

For details, see [contextmate.dev/security](https://contextmate.dev/security).

## License

MIT -- Copyright (c) 2026 Alex Furmansky / MagneticStudio

## Links

- [Website](https://contextmate.dev)
- [Security Model](https://contextmate.dev/security)
- [Privacy](https://contextmate.dev/privacy)
- [GitHub](https://github.com/contextmate/contextmate)
