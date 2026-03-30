# ContextMate

Zero-knowledge encrypted sync for AI agent context (memories, skills, rules).
Primary use case: **OpenClaw** agent context management. Also supports Claude Code.

## Project Structure

```
src/                  # CLI client (TypeScript, ESM)
  bin/                #   Entry point
  cli/                #   Commands (setup, init, status, adapter, daemon, mcp, files, log, reset)
  crypto/             #   Encryption (AES-256-GCM, Argon2id, HKDF, BLAKE3)
  sync/               #   Sync engine (engine, reconcile, mutex, state, watcher, WebSocket, client)
  adapters/           #   Agent adapters (OpenClaw, Claude Code)
  mcp/                #   Local MCP server (BM25 + TF-IDF hybrid search)
server/               # Cloud API (Hono, SQLite, WebSocket)
web/                  # Web dashboard (React 19, Vite, Web Crypto API)
www/                  # Marketing site (Astro 5, Tailwind CSS v4)
tests/                # Test suites (Vitest)
```

### Key Files
| File | Description |
|------|-------------|
| `src/sync/engine.ts` | Sync engine — mutex-protected, change-log-based sync |
| `src/sync/reconcile.ts` | Pure reconciliation function — 12-case three-way merge logic |
| `src/sync/mutex.ts` | Async operation queue — serializes all sync operations |
| `src/sync/state.ts` | SQLite state DB — file tracking, cursors, deletion records |
| `src/sync/client.ts` | HTTP client — upload, download, getChanges, token refresh |
| `src/sync/websocket.ts` | WebSocket client — real-time events, reconnection |
| `src/adapters/openclaw.ts` | OpenClaw adapter — workspace ↔ vault copy-sync |
| `src/adapters/claude.ts` | Claude Code adapter (~600 lines, largest) |
| `src/cli/daemon.ts` | Daemon — persistent sync service (launchd/systemd) |
| `src/cli/setup.ts` | Interactive setup wizard (~890 lines) |
| `src/config.ts` | Config loader (`~/.contextmate/config.toml`) |
| `server/src/routes/files.ts` | Server file API — upload, download, delete, changes |
| `server/src/db.ts` | Server DB schema — files, changes, users, devices |

### Vault Folder Structure
```
~/.contextmate/vault/
  openclaw/           # OpenClaw workspace files (MEMORY.md, IDENTITY.md, skills/, memory/)
  claude/             # Claude Code files (CLAUDE.md, rules/, projects/)
  skills/             # Shared skills (from ~/.agents/skills/ and ~/.claude/skills/)
  custom/             # User-created custom files
```

## Build & Test Commands

```bash
npm run build                # CLI — tsc
cd server && npm run build   # Server — tsc
cd web && npm run build      # Dashboard — tsc -b && vite build
cd www && npm run build      # Marketing — astro build
npx vitest run               # Run all tests (189 tests)
npx vitest run tests/sync/   # Run sync tests only
npm run lint                 # Type check (tsc --noEmit)
```

## Key Architecture Decisions

### Sync Architecture (v0.4.22+)

The sync system follows the Dropbox/Box/Google Drive pattern: **server-side change log with cursor-based sync**. Deletions are explicit server events, never inferred from file absence.

```
Workspace (real files) ↔ Vault (local cache) ↔ Cloud (encrypted)
```

#### Server-Side Change Log
Every upload and delete is recorded in a `changes` table with an auto-incrementing sequence number. Clients call `GET /api/files/changes?since=N` to get explicit create/modify/delete events since their last cursor.

#### Sync Engine (src/sync/engine.ts)
- **Mutex**: All operations (`handleLocalChange`, `handleRemoteUpdate`, `syncAll`, etc.) go through `SyncMutex` — only one mutates state at a time.
- **Watcher suppression**: Downloads add paths to a `suppressedPaths` set. Watcher events for suppressed paths are ignored, preventing echo loops.
- **syncAll()**: Uses change log for incremental sync. Full reconciliation only on first sync (no cursor yet).
- **Origin tracking**: Files tagged as `local` (pending upload), `remote` (just downloaded), or `synced` (confirmed on both sides). Prevents "pending upload" from being mistaken for "remotely deleted."

#### Reconciliation (src/sync/reconcile.ts)
Pure function `reconcileFile()` handles every state combination:
- Disk + DB + Server all present → check for local/remote changes, conflicts
- On disk but not server → upload (if origin=local) or delete_local (if origin=synced, meaning remote deleted it)
- On server but not disk → download (new) or delete_remote (if origin=synced, meaning locally deleted)
- Key invariant: **origin=local files are NEVER deleted** — they are pending uploads

#### Adapter Sync Model (Copy Mode — v0.4.0+)
Adapters use **bidirectional copy-sync**. Workspace files are real copies, not symlinks.

- `syncBack()` — workspace → vault (user edits only, NO deletion logic)
- `syncFromVault()` — vault → workspace (cloud updates arriving)
- Adapters NEVER delete vault files — only the sync engine decides deletions using origin tracking
- `import()` / `copyToWorkspace()` / `verifySync()` / `disconnect()` — lifecycle methods

The daemon runs `syncFromVault()` THEN `syncBack()` (in that order) on each adapter's periodic interval.

#### Deletion Tracking
- Deletion tombstones stored in `deleted_files` table with version, timestamp, and `deleted_by` (local/remote)
- Tombstones expire after 24 hours — prevents permanent accumulation
- `isRecentDeletion()` blocks re-upload of recently deleted files
- `clear-tombstones` CLI command available for manual recovery

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
- Sync DB: `~/.contextmate/data/sync.db` (file state, cursors, deletion records)
- Auth: `~/.contextmate/data/auth.json` (userId, token, deviceId)
- API keys: `~/.contextmate/data/api-keys.json`

### Server
- File paths must be `decodeURIComponent()`'d when extracted from URLs
- Blobs stored at `data/blobs/{userId}/{filePath}`
- CORS `exposeHeaders` needed for `X-Version` and `X-Content-Hash`
- `changes` table records every upload/delete for cursor-based client sync
- JWT tokens expire after 90 days; client auto-refreshes via `SyncClient.refreshToken()`

## Release Workflow

1. Work on a branch, create a PR
2. Update `CHANGELOG.md` in the PR
3. Bump version in `package.json` (minor = 0.4.X, NOT 0.5.0)
4. Merge to main → server auto-deploys on Railway
5. `npm publish` to publish CLI (requires OTP 2FA)

## Common Pitfalls

- **Never infer deletions from absence**: Use the server change log (`/api/files/changes?since=N`). A file missing from a list could be new, not deleted.
- **Mutex required**: All sync operations MUST go through `SyncMutex`. Direct DB/file writes outside the mutex cause race conditions.
- **Watcher suppression**: When writing files to disk during download, add the path to `suppressedPaths` BEFORE writing. Otherwise the watcher fires and re-uploads.
- **Adapters don't delete**: `syncBack()` only copies workspace → vault. The engine decides deletions using origin tracking. Never add deletion logic to adapters.
- **Origin tracking**: New local files get `origin: 'local'`. Only after successful upload+confirmation do they become `origin: 'synced'`. Never delete a file with `origin: 'local'` — it's a pending upload.
- **Double URL encoding**: Server must decode paths from URLs before storing/querying
- **Key derivation mismatch**: Web and CLI must use identical HKDF info strings
- **Per-file vs vault key**: Files use per-file keys; device settings use vault key directly
- **No symlinks**: All adapters use copy mode. OpenClaw's file injector skips symlinks entirely.
- **Vault is local**: The vault (`~/.contextmate/vault/`) is a local decrypted cache, not the cloud. Cloud stores encrypted blobs.
- **SKIP_DIRS**: The vault watcher and `discoverLocalFiles` skip `node_modules`, `__pycache__`, `.venv`, `dist`, `.cache` to prevent OOM.
- **Test command**: Use `npx vitest run`, not `npm test` (no test script in package.json).

## CLI Quick Reference

```bash
contextmate status              # Is sync working? Check daemon, adapters, file counts
contextmate log                 # Recent sync activity (uploads, downloads, errors)
contextmate files               # List all tracked files with sync state
contextmate daemon status       # Is the daemon running?
contextmate daemon install      # Install + start persistent daemon (recommended)
contextmate daemon stop         # Stop the daemon
```

## Troubleshooting Sync

**Files not syncing? Follow this checklist:**

1. `contextmate daemon status` — is the daemon running? If not: `contextmate daemon install`
2. `contextmate status` — check for errors, conflicts, adapter state
3. `contextmate log` — look for recent errors or missing upload/download entries
4. Check the daemon error log: `tail -50 ~/.contextmate/data/daemon.err.log`

**Specific problems:**

| Symptom | Fix |
|---------|-----|
| New files from another device never appear | `contextmate files reset-cursor` then restart daemon — forces full re-reconciliation |
| File shows "synced" in DB but content is stale | `contextmate files reset-cursor` then restart daemon |
| Deleted files keep coming back | `contextmate files clear-tombstones [path-prefix]` then restart daemon |
| Daemon keeps restarting / auto-update loop | `npm install -g contextmate@latest` then `contextmate daemon stop && contextmate daemon install` |
| Token expired / 401 errors | Restart daemon — it will get a fresh token from keychain |

**Nuclear option (reset sync state, keep vault files):**
```bash
contextmate daemon stop
rm ~/.contextmate/data/sync.db
contextmate daemon install
# Daemon will do full reconciliation from scratch
```

## Deployment

- **Server + web dashboard**: Hosted on Railway. Auto-deploys on push to `main` — no manual deploy needed.
- **CLI (`contextmate` npm package)**: Published manually via `npm publish` (requires OTP 2FA). Bump version in `package.json` before publishing.
