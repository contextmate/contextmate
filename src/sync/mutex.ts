/**
 * Async mutex that serializes operations.
 * All sync operations (handleLocalChange, handleRemoteUpdate, syncAll, adapter sync)
 * must go through this mutex to prevent concurrent state corruption.
 */
export class SyncMutex {
  private queue: Array<{
    fn: () => Promise<unknown>;
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
  }> = [];
  private running = false;

  async run<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        fn: fn as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      void this.drain();
    });
  }

  get pending(): number {
    return this.queue.length;
  }

  get isRunning(): boolean {
    return this.running;
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    while (this.queue.length > 0) {
      const item = this.queue.shift()!;
      try {
        const result = await item.fn();
        item.resolve(result);
      } catch (err) {
        item.reject(err);
      }
    }
    this.running = false;
  }
}
