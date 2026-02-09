import argon2 from 'argon2';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { randomBytes } from 'node:crypto';

const KEY_LENGTH = 32;

export function generateSalt(): Uint8Array {
  return new Uint8Array(randomBytes(KEY_LENGTH));
}

export async function deriveMasterKey(
  passphrase: string,
  salt: Uint8Array,
): Promise<Uint8Array> {
  const hash = await argon2.hash(passphrase, {
    type: argon2.argon2id,
    salt: Buffer.from(salt),
    timeCost: 3,
    memoryCost: 65536,
    parallelism: 4,
    hashLength: KEY_LENGTH,
    raw: true,
  });
  return new Uint8Array(hash);
}

export function deriveVaultKey(masterKey: Uint8Array): Uint8Array {
  return hkdf(sha256, masterKey, undefined, 'contextmate-vault-enc', KEY_LENGTH);
}

export function deriveFolderKey(
  vaultKey: Uint8Array,
  folderId: string,
): Uint8Array {
  return hkdf(sha256, vaultKey, undefined, 'contextmate-folder-' + folderId, KEY_LENGTH);
}

export function deriveFileKey(
  folderKey: Uint8Array,
  fileId: string,
): Uint8Array {
  return hkdf(sha256, folderKey, undefined, 'contextmate-file-' + fileId, KEY_LENGTH);
}

export function deriveAuthKey(masterKey: Uint8Array): Uint8Array {
  return hkdf(sha256, masterKey, undefined, 'contextmate-auth', KEY_LENGTH);
}

export function deriveSharingKey(masterKey: Uint8Array): Uint8Array {
  return hkdf(sha256, masterKey, undefined, 'contextmate-sharing', KEY_LENGTH);
}

export function deriveKeyForPath(
  vaultKey: Uint8Array,
  filePath: string,
): Uint8Array {
  const segments = filePath.split('/');
  const folder = segments[0]!;
  const rest = segments.slice(1).join('/');
  const folderKey = deriveFolderKey(vaultKey, folder);
  return deriveFileKey(folderKey, rest);
}
