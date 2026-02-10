export interface FileMetadata {
  path: string;
  version: number;
  encryptedHash: string;
  size: number;
  updatedAt: number;
}

export interface AuditEntry {
  id: number;
  action: string;
  path: string;
  version: number | null;
  size: number | null;
  timestamp: number;
  details: string | null;
}

export interface AuditQueryParams {
  action?: string;
  path?: string;
  since?: number;
  limit?: number;
  offset?: number;
}

export interface Device {
  id: string;
  name: string;
  lastSeen: number;
  encryptedSettings: string | null;
}

export interface ApiKey {
  id: string;
  name: string;
  scope: string;
  permissions: string;
  createdAt: number;
  revokedAt: number | null;
}

export interface CreateApiKeyResponse {
  id: string;
  key: string;
  scope: string;
  permissions: string;
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export class ApiClient {
  private baseUrl: string;
  private token: string | null = null;
  onUnauthorized: (() => void) | null = null;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  private checkUnauthorized(status: number): void {
    if (status === 401 && this.onUnauthorized) {
      this.onUnauthorized();
    }
  }

  async getSalt(userId: string): Promise<string> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/auth/salt/${encodeURIComponent(userId)}`);
    } catch {
      throw new Error('Could not connect to server. Check the URL and try again.');
    }
    if (!res.ok) {
      if (res.status === 404) {
        throw new ApiError('User ID not found. Check your User ID and try again.', 404);
      }
      if (res.status === 429) {
        throw new ApiError('Too many attempts. Please wait and try again.', 429);
      }
      throw new ApiError(`Failed to retrieve salt (${res.status})`, res.status);
    }
    const data = await res.json();
    return data.salt;
  }

  async login(authKeyHash: string): Promise<{ userId: string; token: string }> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ authKeyHash }),
      });
    } catch {
      throw new Error('Could not connect to server. Check the URL and try again.');
    }
    if (!res.ok) {
      if (res.status === 401) {
        throw new ApiError('Invalid passphrase.', 401);
      }
      if (res.status === 429) {
        throw new ApiError('Too many login attempts. Please wait and try again.', 429);
      }
      throw new ApiError(`Login failed (${res.status})`, res.status);
    }
    const data = await res.json();
    this.token = data.token;
    return data;
  }

  setToken(token: string): void {
    this.token = token;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {};
    if (this.token) {
      h['Authorization'] = `Bearer ${this.token}`;
    }
    return h;
  }

  async listFiles(): Promise<FileMetadata[]> {
    const res = await fetch(`${this.baseUrl}/api/files`, {
      headers: this.headers(),
    });
    if (!res.ok) {
      this.checkUnauthorized(res.status);
      throw new ApiError(`Failed to list files (${res.status})`, res.status);
    }
    const data = await res.json();
    return data.files;
  }

  async getAuditLog(params: AuditQueryParams = {}): Promise<AuditEntry[]> {
    const searchParams = new URLSearchParams();
    if (params.action !== undefined) searchParams.set('action', params.action);
    if (params.path !== undefined) searchParams.set('path', params.path);
    if (params.since !== undefined) searchParams.set('since', String(params.since));
    if (params.limit !== undefined) searchParams.set('limit', String(params.limit));
    if (params.offset !== undefined) searchParams.set('offset', String(params.offset));

    const qs = searchParams.toString();
    const url = `${this.baseUrl}/api/audit-log${qs ? `?${qs}` : ''}`;
    const res = await fetch(url, {
      headers: this.headers(),
    });
    if (!res.ok) {
      this.checkUnauthorized(res.status);
      throw new ApiError(`Failed to fetch audit log (${res.status})`, res.status);
    }
    const data = await res.json();
    return data.entries;
  }

  async downloadFile(path: string): Promise<{ data: ArrayBuffer; version: number }> {
    const encoded = encodeURIComponent(path);
    const res = await fetch(`${this.baseUrl}/api/files/${encoded}`, {
      headers: this.headers(),
    });
    if (!res.ok) {
      this.checkUnauthorized(res.status);
      throw new ApiError(`Failed to download file (${res.status})`, res.status);
    }
    const version = parseInt(res.headers.get('X-Version') || '1', 10);
    const data = await res.arrayBuffer();
    return { data, version };
  }

  async uploadFile(
    path: string,
    data: ArrayBuffer,
    version: number,
    hash: string
  ): Promise<void> {
    const encoded = encodeURIComponent(path);
    const res = await fetch(`${this.baseUrl}/api/files/${encoded}`, {
      method: 'PUT',
      headers: {
        ...this.headers(),
        'Content-Type': 'application/octet-stream',
        'X-Version': String(version),
        'X-Content-Hash': hash,
      },
      body: data,
    });
    if (!res.ok) {
      this.checkUnauthorized(res.status);
      if (res.status === 409) {
        throw new ApiError('This file was modified elsewhere. Reload to see the latest version.', 409);
      }
      if (res.status === 413) {
        throw new ApiError('File is too large to upload.', 413);
      }
      throw new ApiError(`Failed to upload file (${res.status})`, res.status);
    }
  }

  async deleteFile(path: string): Promise<void> {
    const encoded = encodeURIComponent(path);
    const res = await fetch(`${this.baseUrl}/api/files/${encoded}`, {
      method: 'DELETE',
      headers: this.headers(),
    });
    if (!res.ok) {
      this.checkUnauthorized(res.status);
      throw new ApiError(`Failed to delete file (${res.status})`, res.status);
    }
  }

  async listDevices(): Promise<Device[]> {
    const res = await fetch(`${this.baseUrl}/api/auth/devices`, {
      headers: this.headers(),
    });
    if (!res.ok) {
      this.checkUnauthorized(res.status);
      throw new ApiError(`Failed to list devices (${res.status})`, res.status);
    }
    const data = await res.json();
    return data.devices;
  }

  async deleteDevice(id: string): Promise<void> {
    const encoded = encodeURIComponent(id);
    const res = await fetch(`${this.baseUrl}/api/auth/devices/${encoded}`, {
      method: 'DELETE',
      headers: this.headers(),
    });
    if (!res.ok) {
      this.checkUnauthorized(res.status);
      throw new ApiError(`Failed to delete device (${res.status})`, res.status);
    }
  }

  async getDeviceSettings(id: string): Promise<{ encryptedSettings: string | null }> {
    const encoded = encodeURIComponent(id);
    const res = await fetch(`${this.baseUrl}/api/auth/devices/${encoded}/settings`, {
      headers: this.headers(),
    });
    if (!res.ok) {
      this.checkUnauthorized(res.status);
      throw new ApiError(`Failed to get device settings (${res.status})`, res.status);
    }
    const data = await res.json();
    return data;
  }

  async updateDeviceSettings(id: string, encryptedSettings: string): Promise<void> {
    const encoded = encodeURIComponent(id);
    const res = await fetch(`${this.baseUrl}/api/auth/devices/${encoded}/settings`, {
      method: 'PUT',
      headers: {
        ...this.headers(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ encryptedSettings }),
    });
    if (!res.ok) {
      this.checkUnauthorized(res.status);
      throw new ApiError(`Failed to update device settings (${res.status})`, res.status);
    }
  }

  async listApiKeys(): Promise<ApiKey[]> {
    const res = await fetch(`${this.baseUrl}/api/keys`, {
      headers: this.headers(),
    });
    if (!res.ok) {
      this.checkUnauthorized(res.status);
      throw new ApiError(`Failed to list API keys (${res.status})`, res.status);
    }
    const data = await res.json();
    return data.keys;
  }

  async createApiKey(name: string, scope: string, permissions: string): Promise<CreateApiKeyResponse> {
    const res = await fetch(`${this.baseUrl}/api/keys`, {
      method: 'POST',
      headers: {
        ...this.headers(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name, scope, permissions }),
    });
    if (!res.ok) {
      this.checkUnauthorized(res.status);
      throw new ApiError(`Failed to create API key (${res.status})`, res.status);
    }
    const data = await res.json();
    return data;
  }

  async revokeApiKey(id: string): Promise<void> {
    const encoded = encodeURIComponent(id);
    const res = await fetch(`${this.baseUrl}/api/keys/${encoded}`, {
      method: 'DELETE',
      headers: this.headers(),
    });
    if (!res.ok) {
      this.checkUnauthorized(res.status);
      throw new ApiError(`Failed to revoke API key (${res.status})`, res.status);
    }
  }
}
