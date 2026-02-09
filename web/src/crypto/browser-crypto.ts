// Browser-side encryption using Web Crypto API + hash-wasm (Argon2id, BLAKE3)
// Matches CLI crypto for full interoperability

import { argon2id, blake3 } from 'hash-wasm';

const VERSION = 1;
const IV_LENGTH = 12;
const VERSION_LENGTH = 4;

// Argon2id parameters matching CLI (src/crypto/keys.ts)
const ARGON2_TIME_COST = 3;
const ARGON2_MEMORY_COST = 65536; // 64MB in KB
const ARGON2_PARALLELISM = 4;
const ARGON2_HASH_LENGTH = 32;

export async function deriveKeyFromPassphrase(
  passphrase: string,
  salt: Uint8Array
): Promise<{ masterKey: CryptoKey; rawKey: Uint8Array }> {
  // Use Argon2id via hash-wasm WASM (matches CLI)
  const rawKeyHex = await argon2id({
    password: passphrase,
    salt,
    parallelism: ARGON2_PARALLELISM,
    iterations: ARGON2_TIME_COST,
    memorySize: ARGON2_MEMORY_COST,
    hashLength: ARGON2_HASH_LENGTH,
    outputType: 'hex',
  });

  const rawKey = hexToBytes(rawKeyHex);

  const masterKey = await crypto.subtle.importKey(
    'raw',
    toBuffer(rawKey),
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  );

  return { masterKey, rawKey };
}

export async function deriveSubKey(
  masterKeyBytes: Uint8Array,
  info: string
): Promise<{ key: CryptoKey; rawKey: Uint8Array }> {
  const enc = new TextEncoder();
  const hkdfKey = await crypto.subtle.importKey(
    'raw',
    toBuffer(masterKeyBytes),
    'HKDF',
    false,
    ['deriveBits']
  );

  const rawKey = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: toBuffer(new Uint8Array(32)),
        info: toBuffer(enc.encode(info)),
      },
      hkdfKey,
      256
    )
  );

  const key = await crypto.subtle.importKey(
    'raw',
    toBuffer(rawKey),
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  );

  return { key, rawKey };
}

export async function encryptData(
  plaintext: Uint8Array,
  key: CryptoKey
): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: toBuffer(iv) }, key, toBuffer(plaintext))
  );

  const result = new Uint8Array(VERSION_LENGTH + IV_LENGTH + ciphertext.byteLength);
  const view = new DataView(result.buffer as ArrayBuffer);
  // Little-endian to match CLI (src/crypto/encrypt.ts)
  view.setUint32(0, VERSION, true);
  result.set(iv, VERSION_LENGTH);
  result.set(ciphertext, VERSION_LENGTH + IV_LENGTH);
  return result;
}

export async function decryptData(
  encrypted: Uint8Array,
  key: CryptoKey
): Promise<Uint8Array> {
  const view = new DataView(encrypted.buffer as ArrayBuffer, encrypted.byteOffset, encrypted.byteLength);
  // Little-endian to match CLI (src/crypto/encrypt.ts)
  const version = view.getUint32(0, true);
  if (version !== VERSION) {
    throw new Error(`Unsupported encryption version: ${version}`);
  }

  const iv = encrypted.slice(VERSION_LENGTH, VERSION_LENGTH + IV_LENGTH);
  const ciphertext = encrypted.slice(VERSION_LENGTH + IV_LENGTH);

  return new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: toBuffer(iv) }, key, toBuffer(ciphertext))
  );
}

export async function deriveKeyForPath(
  vaultKeyRaw: Uint8Array,
  filePath: string
): Promise<CryptoKey> {
  const segments = filePath.split('/');
  const folder = segments[0]!;
  const rest = segments.slice(1).join('/');

  // Derive folder key: HKDF(vaultKey, 'contextmate-folder-' + folder)
  const folderKeyRaw = await hkdfDerive(vaultKeyRaw, 'contextmate-folder-' + folder);

  // Derive file key: HKDF(folderKey, 'contextmate-file-' + rest)
  const fileKeyRaw = await hkdfDerive(folderKeyRaw, 'contextmate-file-' + rest);

  return crypto.subtle.importKey(
    'raw',
    toBuffer(fileKeyRaw),
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  );
}

async function hkdfDerive(ikm: Uint8Array, info: string): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const hkdfKey = await crypto.subtle.importKey(
    'raw',
    toBuffer(ikm),
    'HKDF',
    false,
    ['deriveBits']
  );
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: toBuffer(new Uint8Array(32)),
        info: toBuffer(enc.encode(info)),
      },
      hkdfKey,
      256
    )
  );
}

export async function hashForAuth(authKeyBytes: Uint8Array): Promise<string> {
  // BLAKE3 hash for server auth (matches CLI)
  return await blake3(authKeyBytes);
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

// Helper: extract ArrayBuffer from Uint8Array to satisfy TypeScript 5.7+ BufferSource constraints
function toBuffer(arr: Uint8Array): ArrayBuffer {
  return arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength) as ArrayBuffer;
}
