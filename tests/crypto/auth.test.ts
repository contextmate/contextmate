import { describe, it, expect } from 'vitest';
import { createAuthHash, verifyAuthKey } from '../../src/crypto/auth.js';
import { generateSalt } from '../../src/crypto/keys.js';

function makeKey(): Uint8Array {
  return generateSalt();
}

describe('createAuthHash', () => {
  it('returns hex string', () => {
    const key = makeKey();
    const hash = createAuthHash(key);
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });

  it('is deterministic (same key = same hash)', () => {
    const key = makeKey();
    const hash1 = createAuthHash(key);
    const hash2 = createAuthHash(key);
    expect(hash1).toBe(hash2);
  });

  it('different keys produce different hashes', () => {
    const key1 = makeKey();
    const key2 = makeKey();
    expect(createAuthHash(key1)).not.toBe(createAuthHash(key2));
  });
});

describe('verifyAuthKey', () => {
  it('returns true for matching key and hash', () => {
    const key = makeKey();
    const hash = createAuthHash(key);
    expect(verifyAuthKey(key, hash)).toBe(true);
  });

  it('returns false for non-matching key', () => {
    const key1 = makeKey();
    const key2 = makeKey();
    const hash = createAuthHash(key1);
    expect(verifyAuthKey(key2, hash)).toBe(false);
  });
});
