import { useEffect, useState, useCallback, useRef } from 'react';
import { useAuth } from '../context/AuthContext.tsx';
import { decryptData, encryptData, bytesToHex, deriveKeyForPath } from '../crypto/browser-crypto.ts';

function simpleMarkdownToHtml(md: string): string {
  let html = md
    // Escape HTML
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    // Headers
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    // Bold & italic
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    // Inline code
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    // Links (only allow http/https URLs to prevent javascript: XSS)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, text, url) => {
      const trimmed = url.trim().toLowerCase();
      if (trimmed.startsWith('http://') || trimmed.startsWith('https://') || trimmed.startsWith('/') || trimmed.startsWith('#')) {
        return `<a href="${url}" rel="noopener noreferrer">${text}</a>`;
      }
      return text; // Strip links with dangerous protocols
    })
    // Unordered lists
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    // Paragraphs (double newline)
    .replace(/\n\n/g, '</p><p>')
    // Single newlines
    .replace(/\n/g, '<br/>');

  // Wrap list items
  html = html.replace(/(<li>.*<\/li>)/gs, '<ul>$1</ul>');
  // Remove nested ul tags
  html = html.replace(/<\/ul>\s*<ul>/g, '');

  return `<p>${html}</p>`;
}

interface FileViewerProps {
  filePath: string;
  onDirtyChange?: (dirty: boolean) => void;
}

export function FileViewer({ filePath, onDirtyChange }: FileViewerProps) {
  const { apiClient, vaultKeyRaw } = useAuth();
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [version, setVersion] = useState(1);
  const dirtyRef = useRef(false);

  // Track dirty state for beforeunload and parent notification
  const isDirty = editing && editContent !== content;
  dirtyRef.current = isDirty;

  useEffect(() => {
    onDirtyChange?.(isDirty);
  }, [isDirty, onDirtyChange]);

  useEffect(() => {
    if (!isDirty) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDirty]);

  useEffect(() => {
    if (!apiClient || !vaultKeyRaw) return;
    let cancelled = false;

    async function load() {
      try {
        setLoading(true);
        setError(null);
        setEditing(false);

        const { data, version: fileVersion } = await apiClient!.downloadFile(filePath);
        const encrypted = new Uint8Array(data);
        const fileKey = await deriveKeyForPath(vaultKeyRaw!, filePath);
        const decrypted = await decryptData(encrypted, fileKey);
        const text = new TextDecoder().decode(decrypted);

        if (!cancelled) {
          setContent(text);
          setEditContent(text);
          setVersion(fileVersion);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load file');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [filePath, apiClient, vaultKeyRaw]);

  const handleSave = useCallback(async () => {
    if (!apiClient || !vaultKeyRaw) return;

    try {
      setSaving(true);
      setError(null);

      const fileKey = await deriveKeyForPath(vaultKeyRaw, filePath);
      const plaintext = new TextEncoder().encode(editContent);
      const encrypted = await encryptData(plaintext, fileKey);

      // Compute hash of encrypted data for integrity
      const hashBuffer = await crypto.subtle.digest('SHA-256', encrypted as BufferSource);
      const hash = bytesToHex(new Uint8Array(hashBuffer));

      try {
        await apiClient.uploadFile(filePath, encrypted.buffer as ArrayBuffer, version, hash);
        setContent(editContent);
        setVersion(version + 1);
        setEditing(false);
      } catch (err) {
        // On version conflict, reload latest version and retry once
        if (err instanceof Error && err.message.includes('modified elsewhere')) {
          const { version: latestVersion } = await apiClient.downloadFile(filePath);
          // Retry save with latest version
          const retryEncrypted = await encryptData(plaintext, fileKey);
          const retryHashBuffer = await crypto.subtle.digest('SHA-256', retryEncrypted as BufferSource);
          const retryHash = bytesToHex(new Uint8Array(retryHashBuffer));
          await apiClient.uploadFile(filePath, retryEncrypted.buffer as ArrayBuffer, latestVersion, retryHash);

          setContent(editContent);
          setVersion(latestVersion + 1);
          setEditing(false);
        } else {
          throw err;
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save file');
    } finally {
      setSaving(false);
    }
  }, [apiClient, vaultKeyRaw, filePath, editContent, version]);

  if (loading) {
    return (
      <div className="file-viewer">
        <div className="file-viewer-loading">Decrypting file...</div>
      </div>
    );
  }

  return (
    <div className="file-viewer">
      {error && <div className="file-viewer-error">{error}</div>}
      <div className="file-viewer-header">
        <span className="file-viewer-path">{filePath}</span>
        <span className="file-viewer-meta">v{version}</span>
        <div className="file-viewer-actions">
          {editing ? (
            <>
              <button
                className="btn btn-secondary"
                onClick={() => {
                  if (editContent !== content && !window.confirm('Discard unsaved changes?')) return;
                  setEditing(false);
                  setEditContent(content);
                }}
                disabled={saving}
              >
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={handleSave}
                disabled={saving}
              >
                {saving ? 'Encrypting...' : 'Save'}
              </button>
            </>
          ) : (
            <button className="btn btn-secondary" onClick={() => setEditing(true)}>
              Edit
            </button>
          )}
        </div>
      </div>
      <div className="file-viewer-body">
        {editing ? (
          <textarea
            className="file-viewer-editor"
            value={editContent}
            onChange={(e) => setEditContent(e.target.value)}
            spellCheck={false}
          />
        ) : (
          <div
            className="file-viewer-content"
            dangerouslySetInnerHTML={{ __html: simpleMarkdownToHtml(content) }}
          />
        )}
      </div>
    </div>
  );
}
