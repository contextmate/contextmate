import { useState, useCallback } from 'react';
import { useAuth } from '../context/AuthContext.tsx';
import type { FileMetadata } from '../api/client.ts';

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(1)} MB`;
}

interface SettingsPanelProps {
  files: FileMetadata[];
  totalSize: number;
  agentCounts: Record<string, number>;
}

export function SettingsPanel({ files, totalSize, agentCounts }: SettingsPanelProps) {
  const { userId, serverUrl } = useAuth();
  const [copiedField, setCopiedField] = useState<string | null>(null);

  const handleCopy = useCallback(async (value: string, field: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedField(field);
      setTimeout(() => setCopiedField(null), 2000);
    } catch {
      // Fallback: ignore if clipboard API unavailable
    }
  }, []);

  return (
    <div className="panel">
      <div className="panel-header">Settings</div>

      {/* Account info */}
      <div className="panel-section">
        <h3>Account</h3>
        <table className="data-table">
          <tbody>
            <tr>
              <td>User ID</td>
              <td>
                <code>{userId}</code>
                <button
                  className="copy-btn"
                  onClick={() => handleCopy(userId || '', 'userId')}
                >
                  {copiedField === 'userId' ? 'Copied' : 'Copy'}
                </button>
              </td>
            </tr>
            <tr>
              <td>Server URL</td>
              <td>
                <code>{serverUrl}</code>
                <button
                  className="copy-btn"
                  onClick={() => handleCopy(serverUrl || '', 'serverUrl')}
                >
                  {copiedField === 'serverUrl' ? 'Copied' : 'Copy'}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Vault stats */}
      <div className="panel-section">
        <h3>Vault</h3>
        <table className="data-table">
          <tbody>
            <tr>
              <td>Total files</td>
              <td>{files.length}</td>
            </tr>
            <tr>
              <td>Total size</td>
              <td>{formatSize(totalSize)}</td>
            </tr>
          </tbody>
        </table>
        {Object.keys(agentCounts).length > 0 && (
          <>
            <h4>By folder</h4>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Folder</th>
                  <th>Files</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(agentCounts)
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([folder, count]) => (
                    <tr key={folder}>
                      <td><code>{folder}/</code></td>
                      <td>{count}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </>
        )}
      </div>

      {/* CLI quick-reference */}
      <div className="panel-section">
        <h3>CLI Quick Reference</h3>
        <table className="data-table">
          <thead>
            <tr>
              <th>Command</th>
              <th>Description</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code>contextmate init</code></td>
              <td>Create account or log in</td>
            </tr>
            <tr>
              <td><code>contextmate status</code></td>
              <td>Show sync status</td>
            </tr>
            <tr>
              <td><code>contextmate adapter claude init</code></td>
              <td>Connect Claude Code</td>
            </tr>
            <tr>
              <td><code>contextmate adapter openclaw init</code></td>
              <td>Connect OpenClaw</td>
            </tr>
            <tr>
              <td><code>contextmate daemon start</code></td>
              <td>Start syncing</td>
            </tr>
            <tr>
              <td><code>contextmate daemon stop</code></td>
              <td>Stop syncing</td>
            </tr>
            <tr>
              <td><code>contextmate reset</code></td>
              <td>Remove all data from this machine</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
