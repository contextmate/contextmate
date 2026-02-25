import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FileWatcher } from '../../src/sync/watcher.js';
import { tmpdir } from 'node:os';
import { mkdtemp, rm, writeFile, mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';

let tmpDir: string;
let watcher: FileWatcher;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'contextmate-watcher-test-'));
  watcher = new FileWatcher(tmpDir, 200, { usePolling: true });
});

afterEach(async () => {
  await watcher.stop();
  await rm(tmpDir, { recursive: true, force: true });
});

function waitForEvent(
  emitter: FileWatcher,
  eventName: string,
  timeoutMs: number = 5000,
): Promise<{ path: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for '${eventName}' event`));
    }, timeoutMs);
    emitter.once(eventName, (event: { path: string }) => {
      clearTimeout(timer);
      resolve(event);
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('FileWatcher', () => {
  it('detects new file creation', async () => {
    watcher.start();
    await waitForEvent(watcher, 'ready');

    const eventPromise = waitForEvent(watcher, 'file-added');
    await writeFile(join(tmpDir, 'new-file.md'), 'hello');
    const event = await eventPromise;
    expect(event.path).toBe('new-file.md');
  });

  it('detects file modification', async () => {
    // Create file before starting watcher
    await writeFile(join(tmpDir, 'existing.md'), 'original');
    watcher.start();
    await waitForEvent(watcher, 'ready');

    const eventPromise = waitForEvent(watcher, 'file-changed');
    await writeFile(join(tmpDir, 'existing.md'), 'modified');
    const event = await eventPromise;
    expect(event.path).toBe('existing.md');
  });

  it('detects file deletion', async () => {
    // Create file before starting watcher
    await writeFile(join(tmpDir, 'to-delete.md'), 'content');
    watcher.start();
    await waitForEvent(watcher, 'ready');

    const eventPromise = waitForEvent(watcher, 'file-removed');
    await unlink(join(tmpDir, 'to-delete.md'));
    const event = await eventPromise;
    expect(event.path).toBe('to-delete.md');
  });

  it('does not emit events for ignored files (.DS_Store)', async () => {
    watcher.start();
    await waitForEvent(watcher, 'ready');

    const events: string[] = [];
    watcher.on('file-added', (e: { path: string }) => events.push(e.path));

    // .DS_Store is a dotfile, should be ignored by the /(^|\/)\../ pattern
    await writeFile(join(tmpDir, '.DS_Store'), 'ignored');
    // Also write a visible file to ensure events are working
    await writeFile(join(tmpDir, 'visible.md'), 'visible');

    await delay(800); // wait for debounce

    expect(events).toContain('visible.md');
    expect(events).not.toContain('.DS_Store');
  });

  it('debounce: rapid writes produce fewer events than writes', async () => {
    watcher.start();
    await waitForEvent(watcher, 'ready');

    const events: Array<{ path: string }> = [];
    watcher.on('file-changed', (e: { path: string }) => events.push(e));
    watcher.on('file-added', (e: { path: string }) => events.push(e));

    // Write 5 rapid changes to the same file
    const filePath = join(tmpDir, 'rapid.md');
    await writeFile(filePath, 'v1');
    await delay(50);
    await writeFile(filePath, 'v2');
    await delay(50);
    await writeFile(filePath, 'v3');
    await delay(50);
    await writeFile(filePath, 'v4');
    await delay(50);
    await writeFile(filePath, 'v5');

    // Wait for debounce to flush — polling watchers in CI may need extra time
    let rapidEvents: Array<{ path: string }> = [];
    for (let i = 0; i < 10; i++) {
      await delay(500);
      rapidEvents = events.filter((e) => e.path === 'rapid.md');
      if (rapidEvents.length > 0) break;
    }

    // Due to debouncing, we should get fewer events than 5 writes
    expect(rapidEvents.length).toBeLessThan(5);
    expect(rapidEvents.length).toBeGreaterThan(0);
  });

  it('start and stop work without errors', async () => {
    expect(() => watcher.start()).not.toThrow();
    await delay(100);
    await expect(watcher.stop()).resolves.not.toThrow();
  });
});
