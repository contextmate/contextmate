import { gcm } from '@noble/ciphers/aes';
import { randomBytes } from '@noble/ciphers/webcrypto';
import { blake3 } from '@noble/hashes/blake3';
import { bytesToHex } from '@noble/hashes/utils';

export const ENCRYPTION_VERSION = 1;
export const NONCE_LENGTH = 12;
export const VERSION_LENGTH = 4;

export function encryptFile(plaintext: Uint8Array, key: Uint8Array): Uint8Array {
  const nonce = randomBytes(NONCE_LENGTH);
  const cipher = gcm(key, nonce);
  const ciphertext = cipher.encrypt(plaintext);

  const result = new Uint8Array(VERSION_LENGTH + NONCE_LENGTH + ciphertext.length);
  const view = new DataView(result.buffer, result.byteOffset, result.byteLength);
  view.setUint32(0, ENCRYPTION_VERSION, true);
  result.set(nonce, VERSION_LENGTH);
  result.set(ciphertext, VERSION_LENGTH + NONCE_LENGTH);

  return result;
}

export function decryptFile(encrypted: Uint8Array, key: Uint8Array): Uint8Array {
  const view = new DataView(encrypted.buffer, encrypted.byteOffset, encrypted.byteLength);
  const version = view.getUint32(0, true);

  if (version !== ENCRYPTION_VERSION) {
    throw new Error(`Unsupported encryption version: ${version}`);
  }

  const nonce = encrypted.slice(VERSION_LENGTH, VERSION_LENGTH + NONCE_LENGTH);
  const ciphertext = encrypted.slice(VERSION_LENGTH + NONCE_LENGTH);

  const cipher = gcm(key, nonce);
  return cipher.decrypt(ciphertext);
}

export function hashContent(content: Uint8Array): string {
  return bytesToHex(blake3(content));
}

export function encryptString(plaintext: string, key: Uint8Array): Uint8Array {
  return encryptFile(new TextEncoder().encode(plaintext), key);
}

export function decryptString(encrypted: Uint8Array, key: Uint8Array): string {
  return new TextDecoder().decode(decryptFile(encrypted, key));
}
