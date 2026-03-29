# Changelog

All notable changes to ContextMate are documented here. Follows [Keep a Changelog](https://keepachangelog.com/).

## [0.4.24] - 2026-03-29

### Fixed
- **Bug #24: new files from other devices deleted instead of downloaded** — consistency check now downloads files that exist on the server but are missing from the local DB entirely (not just version mismatches). Previously, files uploaded before the `changes` table existed were invisible to incremental sync.

## [0.4.23] - 2026-03-29

### Fixed
- **Bug #23: stale file content after version bump** — incremental sync now includes a consistency check that compares DB versions against the server file list. Catches files where the change log entry was missed (e.g., created before the `changes` table existed, or cursor was set past it during first sync).

## [0.4.22] - 2026-03-29

### Major: Sync Engine Redesign

Complete rewrite of the bidirectional sync system following industry best practices (Dropbox/Box/Google Drive pattern).

### Added
- **Server-side change log** — every upload/delete recorded as an explicit event with sequence numbers. Clients use cursor-based `GET /api/files/changes?since=N` instead of inferring deletions from file absence.
- **Async mutex** — all sync operations serialized through a queue, preventing concurrent state corruption between `handleLocalChange`, `handleRemoteUpdate`, and `syncAll`.
- **Origin tracking** — files tagged as `local`, `remote`, or `synced` to distinguish "pending upload" from "remotely deleted." Eliminates the new-file vs deletion ambiguity.
- **Watcher suppression** — downloads add paths to a suppression set, preventing echo loops (download -> watcher -> re-upload).
- **Pure reconciliation function** — `reconcileFile()` handles all 12 state combinations (disk x DB x server) with full test coverage.
- **Deletion tombstone expiry** — tombstones auto-expire after 24 hours (were permanent before).
- **WebSocket `reconnected` event** — triggers immediate `syncAll()` on reconnection to catch missed events.
- **New tests** — `mutex.test.ts` (4), `reconcile.test.ts` (12), `state.test.ts` extended (+8). Total: 189 passing.

### Changed
- `syncAll()` uses change log for incremental sync; full reconciliation only on first sync.
- Adapters no longer delete vault files — `syncBack()` only copies workspace -> vault. Engine decides deletions using origin tracking.
- All bare `catch {}` blocks in daemon replaced with error logging.

### Removed
- Deletion logic from `OpenClawAdapter.syncBack()` — was the root cause of new cloud files being deleted before `syncFromVault` could copy them to workspace.

## [0.4.21] - 2026-03-29

### Fixed
- **Workspace file deletions now propagate immediately** via watcher `file-removed` handler (#20).
- `syncBack` no longer deletes vault files newer than 60 seconds (protects new cloud arrivals).
- `syncFromVault` runs before `syncBack` everywhere (initial + interval) to prevent cloud files from being treated as workspace deletions.

## [0.4.20] - 2026-03-29

### Added
- `contextmate files clear-tombstones [pattern]` CLI command for manual tombstone recovery.
- 5-minute grace period in `syncAll` — recently-tracked files are not tombstoned on crash/restart.

### Fixed
- OOM crash from `node_modules` in vault — `SKIP_DIRS` constant skips `node_modules`, `__pycache__`, `.venv`, `dist`, `.cache` in both watcher and `discoverLocalFiles`.
- Null `stateDb` crash in `handleLocalChange` and `handleRemoteUpdate` catch blocks.

## [0.4.19] - 2026-03-28

### Fixed
- **Daemon dying after 7-day JWT expiry** — WebSocket now accepts a token getter function for fresh tokens on reconnect. Daemon re-reads `auth.json` for refreshed tokens. JWT expiry increased from 7 to 90 days.

## [0.4.18] - 2026-03-26

### Added
- Refresh adapter sync settings from server every 30 seconds.
- Auto-update: daemon checks npm for new versions every 30 minutes and self-updates.
- Send `register-device` on WebSocket connect and heartbeat for dashboard presence.

## [0.4.16] - 2026-03-15

### Fixed
- EMFILE crash: skip `browser/`, `media/`, `credentials/` directories in watcher (#22).

## [0.4.12] - 2026-03-14

### Fixed
- Propagate workspace deletions to server via SyncEngine (#20).
- Daemon restart loop and `syncBack` overwriting cloud updates.

## [0.4.10] - 2026-03-13

### Fixed
- Race condition: use mtime to prevent vault from overwriting newer workspace edits (#21).
- Deleted files reappearing via adapter re-sync loop (#19).
- Device `last_seen` never updating after initial registration (#18).

## [0.4.6] - 2026-03-08

### Fixed
- Check deletion tombstones in `handleLocalChange` to prevent watcher re-uploads (#19).
- Deleted files reappearing via adapter re-sync loop (#19).

## [0.4.3] - 2026-03-06

### Fixed
- Daemon reinstall prompt not accepting input.
- Session file locking: sessions sync-back only, skip `.lock` files.

### Changed
- Remove Mirror adapter; rename sync directions to clearer labels.

## [0.4.1] - 2026-03-05

### Added
- Dashboard: vault visibility, source labeling, per-adapter sync controls (#15).
- OpenClaw multi-workspace auto-discovery, sync all file types, sessions & config sync.

## [0.4.0] - 2026-03-04

### Changed
- **Breaking**: Replace symlinks with copy-sync (Dropbox model). All adapters now use real file copies instead of symlinks. OpenClaw's file injector skips symlinks, so this was required for compatibility.

## [0.3.5] - 2026-02-26

### Added
- Persistent daemon service with OS keychain integration (launchd/systemd).

## [0.3.0] - 2026-02-25

### Added
- Mirror adapter and configurable OpenClaw file discovery.
- `files delete <pattern>` command for bulk file removal.
- Custom sync targets (`sync.extraPaths`) for arbitrary file sync.
