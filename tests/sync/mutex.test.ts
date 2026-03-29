import { describe, it, expect } from 'vitest';
import { SyncMutex } from '../../src/sync/mutex.js';

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('SyncMutex', () => {
  it('executes operations sequentially', async () => {
    const mutex = new SyncMutex();
    const order: number[] = [];

    const p1 = mutex.run(async () => {
      await delay(50);
      order.push(1);
    });
    const p2 = mutex.run(async () => {
      order.push(2);
    });

    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2]); // p1 finishes before p2 starts
  });

  it('returns the result of the operation', async () => {
    const mutex = new SyncMutex();
    const result = await mutex.run(async () => 42);
    expect(result).toBe(42);
  });

  it('propagates errors without blocking queue', async () => {
    const mutex = new SyncMutex();

    const p1 = mutex.run(async () => {
      throw new Error('boom');
    });
    const p2 = mutex.run(async () => 'ok');

    await expect(p1).rejects.toThrow('boom');
    expect(await p2).toBe('ok');
  });

  it('tracks pending count', async () => {
    const mutex = new SyncMutex();

    const p1 = mutex.run(async () => {
      await delay(50);
    });
    // While p1 is running, queue p2
    const p2 = mutex.run(async () => {});

    // p1 is running, p2 is queued
    expect(mutex.isRunning).toBe(true);

    await Promise.all([p1, p2]);
  });
});
