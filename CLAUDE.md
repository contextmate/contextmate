# ContextMate

Zero-knowledge encrypted sync for AI agent context (memories, skills, rules).
Primary use case: **OpenClaw** agent context management. Also supports Claude Code and arbitrary mirror targets.

## Project Structure

```
src/                  # CLI client (TypeScript, ESM)
  bin/                #   Entry point
  cli/                #   Commands (setup, init, status, adapter, daemon, mcp, files, log, reset)
  crypto/             #   Encryption (AES-256-GCM, Argon2id, HKDF, BLAKE3)
  sync/               #   Sync engine (watcher, state, WebSocket)
  adapters/           #   Agent adapters (OpenClaw, Claude Code, Mirror)
  mcp/                #   Local MCP server (BM25 + TF-IDF hybrid search)
server/               # Cloud API (Hono, SQLite, WebSocket)
web/                  # Web dashboard (React 19, Vite, Web Crypto API)
www/                  # Marketing site (Astro 5, Tailwind CSS v4)
tests/                # Test suites (Vitest)
```

### Key Files
| File | Description |
|------|-------------|
| `src/adapters/base.ts` | Abstract base adapter — copy utilities, abstract interface |
| `src/adapters/openclaw.ts` | OpenClaw adapter (primary) |
| `src/adapters/claude.ts` | Claude Code adapter (~600 lines, largest) |
| `src/adapters/mirror.ts` | Mirror adapter (copies vault to arbitrary target) |
| `src/cli/daemon.ts` | Daemon — persistent sync service (launchd/systemd) |
| `src/cli/setup.ts` | Interactive setup wizard (~890 lines) |
| `src/sync/engine.ts` | Sync engine — file watching, WebSocket, cloud sync |
| `src/config.ts` | Config loader (`~/.contextmate/config.toml`) |

### Vault Folder Structure
```
~/.contextmate/vault/
  openclaw/           # OpenClaw workspace files (MEMORY.md, IDENTITY.md, skills/, memory/)
  claude/             # Claude Code files (CLAUDE.md, rules/, projects/)
  skills/             # Shared skills (from ~/.agents/skills/ and ~/.claude/skills/)
  custom/             # User-created custom files
```

## Build Commands

```bash
npm run build          # CLI — tsc
cd server && npm run build   # Server — tsc
cd web && npm run build      # Dashboard — tsc -b && vite build
cd www && npm run build      # Marketing — astro build
npm test               # Run all tests (vitest)
npm run lint           # Type check (tsc --noEmit)
```

## Key Architecture Decisions

### Adapter Sync Model (Copy Mode — v0.4.0+)

Adapters use **bidirectional copy-sync** (Dropbox model). Workspace files are real copies, not symlinks.

```
Workspace (real files) ↔ Vault (local cache) ↔ Cloud (encrypted)
```

- `import()` — workspace → vault (initial import)
- `copyToWorkspace()` — vault → workspace (initial setup)
- `syncBack()` — workspace → vault (user edits)
- `syncFromVault()` — vault → workspace (cloud updates arriving)
- `verifySync()` — compare content hashes
- `disconnect()` — disables adapter, workspace files stay as-is

The daemon runs both `syncBack()` and `syncFromVault()` on each adapter's periodic interval.

**Important**: `daemon install` is the recommended method (stores passphrase in OS keychain, creates persistent launchd/systemd service). `daemon start` runs in foreground only.

### Encryption Key Hierarchy
```
Passphrase → Argon2id(salt) → Master Key
  → HKDF('contextmate-vault-enc') → Vault Key
    → HKDF('contextmate-folder-' + folder) → Folder Key
      → HKDF('contextmate-file-' + rest) → File Key
  → HKDF('contextmate-auth') → Auth Key → BLAKE3 hash for server auth
```

- **Files** are encrypted with per-file keys (vault → folder → file HKDF chain)
- **Device settings** are encrypted with the vault key directly
- The web dashboard must replicate this hierarchy using Web Crypto API
- Info strings must match exactly between CLI and web (e.g., `'contextmate-vault-enc'`)

### Module System
- ESM with Node16 module resolution
- Internal imports require `.js` extension
- `package-lock.json` is gitignored — use `npm install` not `npm ci`

### Config & Data Paths
- Config: `~/.contextmate/config.toml` (smol-toml parser)
- Vault: `~/.contextmate/vault/` (local decrypted cache, NOT the cloud)
- Auth: `~/.contextmate/data/auth.json` (userId, token, deviceId)
- API keys: `~/.contextmate/data/api-keys.json`

### Adapters
- Use **copy-sync** to integrate with agents (no symlinks — OpenClaw skips symlinks)
- Claude adapter scans: `~/.agents/skills/` AND `~/.claude/skills/`
- Adapters import files into vault, then copy back to workspace
- Three adapters: `openclaw` (primary), `claude`, `mirror`

### Server
- File paths must be `decodeURIComponent()`'d when extracted from URLs
- Blobs stored at `data/blobs/{userId}/{filePath}`
- CORS `exposeHeaders` needed for `X-Version` and `X-Content-Hash`

### Sync
- Daemon reads auth token from `auth.json`, not `config.toml`
- `SyncEngine.syncAll()` discovers untracked local files and uploads them
- `listRemoteFiles()` returns `{ files: [...] }` — extract `.files`

## Common Pitfalls

- **Double URL encoding**: Server must decode paths from URLs before storing/querying
- **Key derivation mismatch**: Web and CLI must use identical HKDF info strings
- **Per-file vs vault key**: Files use per-file keys; device settings use vault key directly
- **Node 20 types**: Avoid `globalThis.BodyInit` — use `as any` for fetch body
- **Watcher tests**: Use chokidar `ready` event, not fixed delays
- **No symlinks**: All adapters use copy mode. OpenClaw's file injector skips symlinks entirely.
- **Vault is local**: The vault (`~/.contextmate/vault/`) is a local decrypted cache, not the cloud. Cloud stores encrypted blobs.
