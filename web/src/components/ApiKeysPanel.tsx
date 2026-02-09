import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '../context/AuthContext.tsx';
import type { ApiKey } from '../api/client.ts';

function formatRelativeTime(ts: number): string {
  const now = Date.now();
  const diff = Math.max(0, Math.floor((now - ts) / 1000));
  if (diff < 60) return `${diff}s ago`;
  const minutes = Math.floor(diff / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function ApiKeysPanel() {
  const { apiClient } = useAuth();
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Create form state
  const [name, setName] = useState('');
  const [scope, setScope] = useState('');
  const [permissions, setPermissions] = useState('read');
  const [creating, setCreating] = useState(false);

  // One-time key reveal
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const fetchKeys = useCallback(async () => {
    if (!apiClient) return;
    try {
      setLoading(true);
      setError(null);
      const result = await apiClient.listApiKeys();
      setKeys(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load API keys');
    } finally {
      setLoading(false);
    }
  }, [apiClient]);

  useEffect(() => {
    fetchKeys();
  }, [fetchKeys]);

  const handleCreate = useCallback(async () => {
    if (!apiClient || !name.trim()) return;
    try {
      setCreating(true);
      setError(null);
      const result = await apiClient.createApiKey(
        name.trim(),
        scope.trim() || '*',
        permissions
      );
      setRevealedKey(result.key);
      setCopied(false);
      setName('');
      setScope('');
      setPermissions('read');
      // Refresh the list to include the new key
      await fetchKeys();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create API key');
    } finally {
      setCreating(false);
    }
  }, [apiClient, name, scope, permissions, fetchKeys]);

  const handleRevoke = useCallback(async (id: string) => {
    if (!apiClient) return;
    if (!window.confirm('Are you sure you want to revoke this API key? This action cannot be undone.')) {
      return;
    }
    try {
      setError(null);
      await apiClient.revokeApiKey(id);
      await fetchKeys();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to revoke API key');
    }
  }, [apiClient, fetchKeys]);

  const handleCopyKey = useCallback(async () => {
    if (!revealedKey) return;
    try {
      await navigator.clipboard.writeText(revealedKey);
      setCopied(true);
    } catch {
      window.prompt('Copy this key manually:', revealedKey);
    }
  }, [revealedKey]);

  const activeKeys = keys.filter((k) => k.revokedAt === null);
  const revokedKeys = keys.filter((k) => k.revokedAt !== null);

  return (
    <div className="panel">
      <div className="panel-header">API Keys</div>

      {/* Create key form */}
      <div className="panel-section">
        <div className="form-row">
          <input
            className="form-input"
            type="text"
            placeholder="Key name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={creating}
          />
          <input
            className="form-input"
            type="text"
            placeholder="skills/* or *"
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            disabled={creating}
          />
          <select
            className="form-select"
            value={permissions}
            onChange={(e) => setPermissions(e.target.value)}
            disabled={creating}
          >
            <option value="read">read</option>
            <option value="write">write</option>
            <option value="readwrite">readwrite</option>
          </select>
          <button
            className="btn btn-primary"
            onClick={handleCreate}
            disabled={creating || !name.trim()}
          >
            {creating ? 'Creating...' : 'Create Key'}
          </button>
        </div>
      </div>

      {/* One-time key reveal */}
      {revealedKey && (
        <div className="panel-section">
          <div className="key-reveal">
            <strong>Save this key now — it will not be shown again.</strong>
            <div className="form-row">
              <code>{revealedKey}</code>
              <button className="copy-btn" onClick={handleCopyKey}>
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <button
              className="btn btn-secondary"
              onClick={() => setRevealedKey(null)}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Error display */}
      {error && (
        <div className="panel-section">
          <div style={{ color: '#ff6b6b', fontSize: '0.8125rem' }}>{error}</div>
        </div>
      )}

      {/* Loading state */}
      {loading && (
        <div className="panel-section" style={{ color: '#666', fontSize: '0.8125rem' }}>
          Loading API keys...
        </div>
      )}

      {/* Active keys table */}
      {!loading && (
        <div className="panel-section">
          <table className="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Scope</th>
                <th>Permissions</th>
                <th>Created</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {activeKeys.map((key) => (
                <tr key={key.id}>
                  <td>{key.name}</td>
                  <td><code>{key.scope}</code></td>
                  <td>{key.permissions}</td>
                  <td>{formatRelativeTime(key.createdAt)}</td>
                  <td><span className="badge badge-active">Active</span></td>
                  <td>
                    <button
                      className="btn btn-secondary"
                      onClick={() => handleRevoke(key.id)}
                    >
                      Revoke
                    </button>
                  </td>
                </tr>
              ))}
              {revokedKeys.map((key) => (
                <tr key={key.id} style={{ opacity: 0.5 }}>
                  <td>{key.name}</td>
                  <td><code>{key.scope}</code></td>
                  <td>{key.permissions}</td>
                  <td>{formatRelativeTime(key.createdAt)}</td>
                  <td><span className="badge badge-revoked">Revoked</span></td>
                  <td></td>
                </tr>
              ))}
              {keys.length === 0 && (
                <tr>
                  <td colSpan={6} style={{ textAlign: 'center', color: '#666' }}>
                    No API keys yet. Create one above.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
