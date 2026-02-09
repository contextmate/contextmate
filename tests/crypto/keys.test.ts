import { describe, it, expect } from 'vitest';
import {
  generateSalt,
  deriveMasterKey,
  deriveVaultKey,
  deriveFolderKey,
  deriveFileKey,
  deriveAuthKey,
  deriveSharingKey,
  deriveKeyForPath,
} from '../../src/crypto/keys.js';

describe('generateSalt', () => {
  it('returns 32 bytes', () => {
    const salt = generateSalt();
    expect(salt).toBeInstanceOf(Uint8Array);
    expect(salt.length).toBe(32);
  });

  it('returns unique values each call', () => {
    const a = generateSalt();
    const b = generateSalt();
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });
});

describe('deriveMasterKey', () => {
  it('produces 32-byte key', async () => {
    const salt = generateSalt();
    const key = await deriveMasterKey('test-passphrase', salt);
    expect(key).toBeInstanceOf(Uint8Array);
    expect(key.length).toBe(32);
  });

  it('is deterministic (same passphrase + salt = same key)', async () => {
    const salt = generateSalt();
    const key1 = await deriveMasterKey('deterministic-test', salt);
    const key2 = await deriveMasterKey('deterministic-test', salt);
    expect(Buffer.from(key1).equals(Buffer.from(key2))).toBe(true);
  });

  it('produces different keys for different passphrases', async () => {
    const salt = generateSalt();
    const key1 = await deriveMasterKey('passphrase-a', salt);
    const key2 = await deriveMasterKey('passphrase-b', salt);
    expect(Buffer.from(key1).equals(Buffer.from(key2))).toBe(false);
  });

  it('produces different keys for different salts', async () => {
    const salt1 = generateSalt();
    const salt2 = generateSalt();
    const key1 = await deriveMasterKey('same-passphrase', salt1);
    const key2 = await deriveMasterKey('same-passphrase', salt2);
    expect(Buffer.from(key1).equals(Buffer.from(key2))).toBe(false);
  });
});

describe('deriveVaultKey', () => {
  it('produces 32-byte key different from master key', async () => {
    const salt = generateSalt();
    const masterKey = await deriveMasterKey('vault-test', salt);
    const vaultKey = deriveVaultKey(masterKey);
    expect(vaultKey).toBeInstanceOf(Uint8Array);
    expect(vaultKey.length).toBe(32);
    expect(Buffer.from(vaultKey).equals(Buffer.from(masterKey))).toBe(false);
  });
});

describe('deriveFolderKey', () => {
  it('produces different keys for different folder IDs', async () => {
    const salt = generateSalt();
    const masterKey = await deriveMasterKey('folder-test', salt);
    const vaultKey = deriveVaultKey(masterKey);
    const folderA = deriveFolderKey(vaultKey, 'folder-a');
    const folderB = deriveFolderKey(vaultKey, 'folder-b');
    expect(folderA.length).toBe(32);
    expect(Buffer.from(folderA).equals(Buffer.from(folderB))).toBe(false);
  });
});

describe('deriveFileKey', () => {
  it('produces different keys for different file IDs', async () => {
    const salt = generateSalt();
    const masterKey = await deriveMasterKey('file-test', salt);
    const vaultKey = deriveVaultKey(masterKey);
    const folderKey = deriveFolderKey(vaultKey, 'folder');
    const fileA = deriveFileKey(folderKey, 'file-a.md');
    const fileB = deriveFileKey(folderKey, 'file-b.md');
    expect(fileA.length).toBe(32);
    expect(Buffer.from(fileA).equals(Buffer.from(fileB))).toBe(false);
  });
});

describe('deriveAuthKey', () => {
  it('is different from vault key and sharing key', async () => {
    const salt = generateSalt();
    const masterKey = await deriveMasterKey('auth-test', salt);
    const authKey = deriveAuthKey(masterKey);
    const vaultKey = deriveVaultKey(masterKey);
    const sharingKey = deriveSharingKey(masterKey);
    expect(authKey.length).toBe(32);
    expect(Buffer.from(authKey).equals(Buffer.from(vaultKey))).toBe(false);
    expect(Buffer.from(authKey).equals(Buffer.from(sharingKey))).toBe(false);
  });
});

describe('deriveKeyForPath', () => {
  it('works with "skills/my-skill/SKILL.md" path', async () => {
    const salt = generateSalt();
    const masterKey = await deriveMasterKey('path-test', salt);
    const vaultKey = deriveVaultKey(masterKey);
    const key = deriveKeyForPath(vaultKey, 'skills/my-skill/SKILL.md');
    expect(key).toBeInstanceOf(Uint8Array);
    expect(key.length).toBe(32);
  });

  it('produces different keys for different paths', async () => {
    const salt = generateSalt();
    const masterKey = await deriveMasterKey('path-test-2', salt);
    const vaultKey = deriveVaultKey(masterKey);
    const keyA = deriveKeyForPath(vaultKey, 'skills/skill-a/SKILL.md');
    const keyB = deriveKeyForPath(vaultKey, 'memory/2026-02-07.md');
    expect(Buffer.from(keyA).equals(Buffer.from(keyB))).toBe(false);
  });
});

describe('full key hierarchy', () => {
  it('same passphrase + salt always produces the same full tree of keys', async () => {
    const salt = generateSalt();
    const passphrase = 'hierarchy-test';

    const masterKey1 = await deriveMasterKey(passphrase, salt);
    const vaultKey1 = deriveVaultKey(masterKey1);
    const authKey1 = deriveAuthKey(masterKey1);
    const sharingKey1 = deriveSharingKey(masterKey1);
    const folderKey1 = deriveFolderKey(vaultKey1, 'skills');
    const fileKey1 = deriveFileKey(folderKey1, 'my-skill/SKILL.md');
    const pathKey1 = deriveKeyForPath(vaultKey1, 'skills/my-skill/SKILL.md');

    const masterKey2 = await deriveMasterKey(passphrase, salt);
    const vaultKey2 = deriveVaultKey(masterKey2);
    const authKey2 = deriveAuthKey(masterKey2);
    const sharingKey2 = deriveSharingKey(masterKey2);
    const folderKey2 = deriveFolderKey(vaultKey2, 'skills');
    const fileKey2 = deriveFileKey(folderKey2, 'my-skill/SKILL.md');
    const pathKey2 = deriveKeyForPath(vaultKey2, 'skills/my-skill/SKILL.md');

    expect(Buffer.from(masterKey1).equals(Buffer.from(masterKey2))).toBe(true);
    expect(Buffer.from(vaultKey1).equals(Buffer.from(vaultKey2))).toBe(true);
    expect(Buffer.from(authKey1).equals(Buffer.from(authKey2))).toBe(true);
    expect(Buffer.from(sharingKey1).equals(Buffer.from(sharingKey2))).toBe(true);
    expect(Buffer.from(folderKey1).equals(Buffer.from(folderKey2))).toBe(true);
    expect(Buffer.from(fileKey1).equals(Buffer.from(fileKey2))).toBe(true);
    expect(Buffer.from(pathKey1).equals(Buffer.from(pathKey2))).toBe(true);

    // deriveKeyForPath('skills/my-skill/SKILL.md') should equal
    // deriveFileKey(deriveFolderKey(vaultKey, 'skills'), 'my-skill/SKILL.md')
    expect(Buffer.from(pathKey1).equals(Buffer.from(fileKey1))).toBe(true);
  });
});
