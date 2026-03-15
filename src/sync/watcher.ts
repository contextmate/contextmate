import chokidar, { type FSWatcher as ChokidarWatcher } from 'chokidar';
import { EventEmitter } from 'node:events';
import { relative } from 'node:path';

interface FileEvent {
  path: string;
}

export interface WatcherOptions {
  usePolling?: boolean;
  followSymlinks?: boolean;
  /** Directory names (relative to watch root) to completely ignore */
  ignoredDirs?: string[];
}

export class FileWatcher extends EventEmitter {
  private watcher: ChokidarWatcher | null = null;
  private readonly watchPath: string;
  private readonly debounceMs: number;
  private readonly options: WatcherOptions;
  private pendingChanges: Map<string, 'added' | 'changed' | 'removed'> = new Map();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(watchPath: string, debounceMs: number = 500, options: WatcherOptions = {}) {
    super();
    this.watchPath = watchPath;
    this.debounceMs = debounceMs;
    this.options = options;
  }

  start(): void {
    const watchBase = this.watchPath;
    const skipDirs = new Set(this.options.ignoredDirs ?? []);
    this.watcher = chokidar.watch(this.watchPath, {
      ignoreInitial: true,
      persistent: true,
      usePolling: this.options.usePolling,
      followSymlinks: this.options.followSymlinks ?? false,
      ignored: [
        // Only ignore dot-files/dirs WITHIN the watched directory, not parent segments.
        // Also skip explicitly ignored directory names.
        (filePath: string) => {
          if (filePath === watchBase) return false;
          const rel = relative(watchBase, filePath);
          const segments = rel.split('/');
          return segments.some((seg) => seg.startsWith('.') || skipDirs.has(seg));
        },
        /\.conflict\.md$/,
        /node_modules/,
      ],
    });

    this.watcher.on('add', (filePath: string) => {
      this.queueChange(filePath, 'added');
    });

    this.watcher.on('change', (filePath: string) => {
      this.queueChange(filePath, 'changed');
    });

    this.watcher.on('unlink', (filePath: string) => {
      this.queueChange(filePath, 'removed');
    });

    this.watcher.on('ready', () => {
      this.emit('ready');
    });
  }

  async stop(): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }

  private queueChange(absolutePath: string, type: 'added' | 'changed' | 'removed'): void {
    const relPath = relative(this.watchPath, absolutePath);
    this.pendingChanges.set(relPath, type);

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.flushChanges();
    }, this.debounceMs);
  }

  private flushChanges(): void {
    const changes = new Map(this.pendingChanges);
    this.pendingChanges.clear();

    for (const [path, type] of changes) {
      const event: FileEvent = { path };
      switch (type) {
        case 'added':
          this.emit('file-added', event);
          break;
        case 'changed':
          this.emit('file-changed', event);
          break;
        case 'removed':
          this.emit('file-removed', event);
          break;
      }
    }
  }
}
