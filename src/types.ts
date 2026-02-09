export type SyncState = 'synced' | 'modified' | 'conflict' | 'pending' | 'deleted';

export interface SyncFile {
  id: string;
  path: string;
  contentHash: string;
  encryptedHash: string;
  version: number;
  size: number;
  lastModified: number;
  syncState: SyncState;
}

export interface DeviceInfo {
  id: string;
  name: string;
  publicKey: string;
  lastSeen: number;
  current: boolean;
}

export interface EncryptedBlob {
  version: number;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
}

export interface FileMetadata {
  path: string;
  version: number;
  encryptedHash: string;
  size: number;
  updatedAt: number;
}

export interface ApiKeyInfo {
  id: string;
  name: string;
  scope: string;
  permissions: ApiPermission;
  createdAt: number;
  lastUsed: number | null;
}

export type ApiPermission = 'read' | 'read-write';

export interface RemoteChange {
  path: string;
  action: 'updated' | 'deleted';
  version: number;
  encryptedHash: string;
  timestamp: number;
}

export interface SyncResult {
  uploaded: string[];
  downloaded: string[];
  conflicts: string[];
  errors: Array<{ path: string; error: string }>;
}

export interface AdapterInfo {
  name: string;
  enabled: boolean;
  workspacePath: string;
  status: 'connected' | 'disconnected' | 'error';
  linkedFiles: number;
}
