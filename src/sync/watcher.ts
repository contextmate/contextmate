import chokidar, { type FSWatcher as ChokidarWatcher } from 'chokidar';
import { EventEmitter } from 'node:events';
import { relative } from 'node:path';

interface FileEvent {
  path: string;
}

export class FileWatcher extends EventEmitter {
  private watcher: ChokidarWatcher | null = null;
  private readonly watchPath: string;
  private readonly debounceMs: number;
  private pendingChanges: Map<string, 'added' | 'changed' | 'removed'> = new Map();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(watchPath: string, debounceMs: number = 500) {
    super();
    this.watchPath = watchPath;
    this.debounceMs = debounceMs;
  }

  start(): void {
    this.watcher = chokidar.watch(this.watchPath, {
      ignoreInitial: true,
      persistent: true,
      ignored: [
        /(^|\/)\../,
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
