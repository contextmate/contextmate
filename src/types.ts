export type SyncState = 'pending_upload' | 'pending_download' | 'synced' | 'conflict' | 'pending_delete' | 'error' | 'pending' | 'modified' | 'deleted';

export type FileOrigin = 'local' | 'remote' | 'synced';

export interface SyncFile {
  id: string;
  path: string;
  contentHash: string;
  encryptedHash: string;
  version: number;
  size: number;
  lastModified: number;
  syncState: SyncState;
  origin?: FileOrigin;
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
  seq: number;
  path: string;
  action: 'updated' | 'deleted';
  version: number | null;
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
