import fs from 'node:fs';
import path from 'node:path';

function blobPath(dataDir: string, userId: string, filePath: string): string {
  const blobsDir = path.resolve(dataDir, 'blobs', userId);
  const resolved = path.resolve(blobsDir, filePath);
  if (!resolved.startsWith(blobsDir + path.sep) && resolved !== blobsDir) {
    throw new Error('Invalid file path: directory traversal detected');
  }
  return resolved;
}

export async function storeBlob(dataDir: string, userId: string, filePath: string, data: Buffer): Promise<void> {
  const dest = blobPath(dataDir, userId, filePath);
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  await fs.promises.writeFile(dest, data);
}

export async function loadBlob(dataDir: string, userId: string, filePath: string): Promise<Buffer> {
  const dest = blobPath(dataDir, userId, filePath);
  return fs.promises.readFile(dest);
}

export async function deleteBlob(dataDir: string, userId: string, filePath: string): Promise<void> {
  const dest = blobPath(dataDir, userId, filePath);
  await fs.promises.unlink(dest);
}

export async function blobExists(dataDir: string, userId: string, filePath: string): Promise<boolean> {
  const dest = blobPath(dataDir, userId, filePath);
  try {
    await fs.promises.access(dest);
    return true;
  } catch {
    return false;
  }
}
