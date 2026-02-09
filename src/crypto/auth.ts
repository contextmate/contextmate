import { blake3 } from '@noble/hashes/blake3';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';

export function createAuthHash(authKey: Uint8Array): string {
  return bytesToHex(blake3(authKey));
}

export function verifyAuthKey(authKey: Uint8Array, storedHash: string): boolean {
  const computed = blake3(authKey);
  const stored = hexToBytes(storedHash);
  return timingSafeEqual(computed, stored);
}

export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i]! ^ b[i]!;
  }
  return diff === 0;
}
