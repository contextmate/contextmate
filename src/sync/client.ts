import type { FileMetadata, DeviceInfo } from '../types.js';

export class SyncClient {
  private readonly baseUrl: string;
  private readonly authToken: string;
  private readonly maxRetries = 3;

  constructor(baseUrl: string, authToken: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.authToken = authToken;
  }

  async uploadFile(
    path: string,
    encryptedData: Uint8Array,
    encryptedHash: string,
    version: number,
  ): Promise<{ version: number }> {
    const response = await this.fetchWithRetry(
      `${this.baseUrl}/api/files/${encodeURIComponent(path)}`,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Content-Hash': encryptedHash,
          'X-Version': String(version),
        },
        body: encryptedData as any,
      },
    );

    if (response.status === 409) {
      throw new ConflictError(path);
    }

    if (!response.ok) {
      throw new Error(`Upload failed for ${path}: ${response.status} ${response.statusText}`);
    }

    const result = (await response.json()) as { version: number };
    return result;
  }

  async downloadFile(
    path: string,
  ): Promise<{ data: Uint8Array; version: number; encryptedHash: string }> {
    const response = await this.fetchWithRetry(
      `${this.baseUrl}/api/files/${encodeURIComponent(path)}`,
      { method: 'GET' },
    );

    if (!response.ok) {
      throw new Error(`Download failed for ${path}: ${response.status} ${response.statusText}`);
    }

    const data = new Uint8Array(await response.arrayBuffer());
    const version = Number(response.headers.get('X-Version') ?? '0');
    const encryptedHash = response.headers.get('X-Content-Hash') ?? '';

    return { data, version, encryptedHash };
  }

  async listRemoteFiles(): Promise<FileMetadata[]> {
    const response = await this.fetchWithRetry(
      `${this.baseUrl}/api/files`,
      { method: 'GET' },
    );

    if (!response.ok) {
      throw new Error(`List files failed: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as { files: FileMetadata[] };
    return data.files;
  }

  async registerDevice(name: string, publicKey: string): Promise<string> {
    const response = await this.fetchWithRetry(
      `${this.baseUrl}/api/auth/devices`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, publicKey }),
      },
    );

    if (!response.ok) {
      throw new Error(`Register device failed: ${response.status} ${response.statusText}`);
    }

    const result = (await response.json()) as { id: string };
    return result.id;
  }

  async listDevices(): Promise<DeviceInfo[]> {
    const response = await this.fetchWithRetry(
      `${this.baseUrl}/api/auth/devices`,
      { method: 'GET' },
    );

    if (!response.ok) {
      throw new Error(`List devices failed: ${response.status} ${response.statusText}`);
    }

    return (await response.json()) as DeviceInfo[];
  }

  private async fetchWithRetry(
    url: string,
    init: RequestInit,
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${this.authToken}`);

    const requestInit: RequestInit = {
      ...init,
      headers,
    };

    let lastError: Error | undefined;
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const response = await fetch(url, requestInit);
        // Don't retry client errors (4xx) except 429
        if (response.status >= 400 && response.status < 500 && response.status !== 429) {
          return response;
        }
        if (response.ok) {
          return response;
        }
        lastError = new Error(`HTTP ${response.status}: ${response.statusText}`);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
      }
      // Exponential backoff: 1s, 2s, 4s
      const delay = 1000 * Math.pow(2, attempt);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    throw lastError ?? new Error('Request failed after retries');
  }
}

export class ConflictError extends Error {
  public readonly filePath: string;

  constructor(filePath: string) {
    super(`Conflict detected for file: ${filePath}`);
    this.name = 'ConflictError';
    this.filePath = filePath;
  }
}
