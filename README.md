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

**1. Install and create your encrypted vault**

```bash
contextmate init
```

**2. Connect your agents**

```bash
contextmate adapter claude init
contextmate adapter openclaw init
```

**3. Start syncing**

```bash
contextmate daemon start
```

That's it. File changes are detected, encrypted locally, and pushed to the cloud. Other devices pull and decrypt in real time via WebSocket.

## CLI Reference

| Command | Description |
|---------|-------------|
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
| `contextmate mcp serve` | Start the local MCP server (BM25 search) |
| `contextmate mcp api-key` | Manage MCP API keys |
| `contextmate reset` | Remove all ContextMate data and symlinks from this machine |

### Multi-device login

To set up ContextMate on a second machine, install and choose "Log into existing account" during init. You'll need your User ID and passphrase.

```bash
contextmate init
# Choose: Log into existing account
# Enter your User ID and passphrase
```

### Scanning project-specific skills

To import skills from project directories (e.g. `.claude/skills/` inside your repos), add `scanPaths` to your config:

```toml
# ~/.contextmate/config.toml
[adapters.claude]
scanPaths = ["/Users/you/Developer"]
```

Then re-run `contextmate adapter claude init` to pick them up.

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

## Supported Agents

| Agent | Status |
|-------|--------|
| Claude Code | Supported |
| OpenClaw | Supported |
| Cursor | Coming soon |
| ChatGPT | Coming soon |

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
  cli/                #   Commands (init, status, adapter, daemon, mcp, files, log, reset)
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
