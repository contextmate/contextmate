import { describe, it, expect } from 'vitest';
import {
  encryptFile,
  decryptFile,
  hashContent,
  encryptString,
  decryptString,
  ENCRYPTION_VERSION,
  NONCE_LENGTH,
  VERSION_LENGTH,
} from '../../src/crypto/encrypt.js';
import { generateSalt } from '../../src/crypto/keys.js';

function makeKey(): Uint8Array {
  // Use generateSalt as a convenient way to get 32 random bytes
  return generateSalt();
}

describe('encryptFile / decryptFile round-trip', () => {
  it('works with small data (100 bytes)', () => {
    const key = makeKey();
    const plaintext = new Uint8Array(100).fill(42);
    const encrypted = encryptFile(plaintext, key);
    const decrypted = decryptFile(encrypted, key);
    expect(Buffer.from(decrypted).equals(Buffer.from(plaintext))).toBe(true);
  });

  it('works with medium data (10KB)', () => {
    const key = makeKey();
    const plaintext = new Uint8Array(10 * 1024);
    for (let i = 0; i < plaintext.length; i++) plaintext[i] = i % 256;
    const encrypted = encryptFile(plaintext, key);
    const decrypted = decryptFile(encrypted, key);
    expect(Buffer.from(decrypted).equals(Buffer.from(plaintext))).toBe(true);
  });

  it('works with large data (100KB)', () => {
    const key = makeKey();
    const plaintext = new Uint8Array(100 * 1024);
    for (let i = 0; i < plaintext.length; i++) plaintext[i] = i % 256;
    const encrypted = encryptFile(plaintext, key);
    const decrypted = decryptFile(encrypted, key);
    expect(Buffer.from(decrypted).equals(Buffer.from(plaintext))).toBe(true);
  });

  it('works with empty data', () => {
    const key = makeKey();
    const plaintext = new Uint8Array(0);
    const encrypted = encryptFile(plaintext, key);
    const decrypted = decryptFile(encrypted, key);
    expect(decrypted.length).toBe(0);
  });
});

describe('decryption with wrong key', () => {
  it('throws error', () => {
    const key1 = makeKey();
    const key2 = makeKey();
    const plaintext = new Uint8Array([1, 2, 3, 4, 5]);
    const encrypted = encryptFile(plaintext, key1);
    expect(() => decryptFile(encrypted, key2)).toThrow();
  });
});

describe('encryptString / decryptString', () => {
  it('round-trips UTF-8 text', () => {
    const key = makeKey();
    const text = 'Hello, ContextMate! This is a test of UTF-8 encryption.';
    const encrypted = encryptString(text, key);
    const decrypted = decryptString(encrypted, key);
    expect(decrypted).toBe(text);
  });

  it('round-trips emoji and special characters', () => {
    const key = makeKey();
    const text = 'Emojis: \u{1F600}\u{1F680}\u{1F4A1} | Special: \u00E9\u00E8\u00EA\u00EB\u00FC\u00F1 | CJK: \u4F60\u597D\u4E16\u754C | Symbols: \u2603\u2764\u2620';
    const encrypted = encryptString(text, key);
    const decrypted = decryptString(encrypted, key);
    expect(decrypted).toBe(text);
  });
});

describe('nonce uniqueness', () => {
  it('same plaintext encrypted twice produces different ciphertexts', () => {
    const key = makeKey();
    const plaintext = new Uint8Array([10, 20, 30, 40, 50]);
    const enc1 = encryptFile(plaintext, key);
    const enc2 = encryptFile(plaintext, key);
    expect(Buffer.from(enc1).equals(Buffer.from(enc2))).toBe(false);
  });
});

describe('encrypted format', () => {
  it('first 4 bytes are version (1), next 12 bytes are nonce', () => {
    const key = makeKey();
    const plaintext = new Uint8Array([1, 2, 3]);
    const encrypted = encryptFile(plaintext, key);

    expect(encrypted.length).toBeGreaterThan(VERSION_LENGTH + NONCE_LENGTH);

    const view = new DataView(encrypted.buffer, encrypted.byteOffset, encrypted.byteLength);
    const version = view.getUint32(0, true);
    expect(version).toBe(ENCRYPTION_VERSION);

    const nonce = encrypted.slice(VERSION_LENGTH, VERSION_LENGTH + NONCE_LENGTH);
    expect(nonce.length).toBe(NONCE_LENGTH);
  });
});

describe('hashContent', () => {
  it('is deterministic', () => {
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const hash1 = hashContent(data);
    const hash2 = hashContent(data);
    expect(hash1).toBe(hash2);
  });

  it('produces different hashes for different content', () => {
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([4, 5, 6]);
    expect(hashContent(a)).not.toBe(hashContent(b));
  });

  it('returns hex string of expected length', () => {
    const data = new Uint8Array([0, 1, 2]);
    const hash = hashContent(data);
    // BLAKE3 output is 32 bytes = 64 hex characters
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
