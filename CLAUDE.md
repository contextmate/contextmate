# ContextMate

Zero-knowledge encrypted sync for AI agent context (memories, skills, rules).

## Project Structure

```
src/                  # CLI client (TypeScript, ESM)
  bin/                #   Entry point
  cli/                #   Commands (setup, init, status, adapter, daemon, mcp, files, log, reset)
  crypto/             #   Encryption (AES-256-GCM, Argon2id, HKDF, BLAKE3)
  sync/               #   Sync engine (watcher, state, WebSocket)
  adapters/           #   Agent adapters (Claude Code, OpenClaw)
  mcp/                #   Local MCP server (BM25 + TF-IDF hybrid search)
server/               # Cloud API (Hono, SQLite, WebSocket)
web/                  # Web dashboard (React 19, Vite, Web Crypto API)
www/                  # Marketing site (Astro 5, Tailwind CSS v4)
tests/                # Test suites (Vitest, 129 tests)
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
- Vault: `~/.contextmate/vault/`
- Auth: `~/.contextmate/data/auth.json` (userId, token, deviceId)
- API keys: `~/.contextmate/data/api-keys.json`

### Adapters
- Use symlinks to integrate with agents (Claude Code, OpenClaw)
- Claude adapter scans: `~/.agents/skills/` AND `~/.claude/skills/`
- Adapters import files into vault, then symlink back

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
