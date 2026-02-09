import { useState, useCallback, useRef, useMemo } from 'react';
import { FileTree } from './FileTree.tsx';
import { FileViewer } from './FileViewer.tsx';
import { StatusBar } from './StatusBar.tsx';
import { ActivityLog } from './ActivityLog.tsx';
import { useAuth } from '../context/AuthContext.tsx';
import type { FileMetadata } from '../api/client.ts';

export function Layout() {
  const { logout, serverUrl } = useAuth();
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileCount, setFileCount] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth >= 768);
  const [sidebarTab, setSidebarTab] = useState<'files' | 'activity'>('files');
  const [files, setFiles] = useState<FileMetadata[]>([]);
  const viewerDirtyRef = useRef(false);

  const handleFilesLoaded = useCallback((loadedFiles: FileMetadata[]) => {
    setFiles(loadedFiles);
  }, []);

  const totalSize = useMemo(() => {
    return files.reduce((sum, f) => sum + f.size, 0);
  }, [files]);

  const agentCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const f of files) {
      const agent = f.path.split('/')[0];
      if (agent) {
        counts[agent] = (counts[agent] || 0) + 1;
      }
    }
    return counts;
  }, [files]);

  const handleFileSelect = useCallback((path: string | null) => {
    if (viewerDirtyRef.current && !window.confirm('Discard unsaved changes?')) return;
    setSelectedFile(path);
    if (window.innerWidth < 768) {
      setSidebarOpen(false);
    }
  }, []);

  return (
    <div className="layout">
      <header className="topbar">
        <div className="topbar-left">
          <button
            className="sidebar-toggle"
            onClick={() => setSidebarOpen((o) => !o)}
            aria-label={sidebarOpen ? 'Close sidebar' : 'Open sidebar'}
          >
            {sidebarOpen ? '\u2715' : '\u2630'}
          </button>
          <span className="topbar-title">ContextMate</span>
        </div>
        <div className="topbar-right">
          <span className="topbar-server">{serverUrl}</span>
          <button className="topbar-logout" onClick={logout}>
            Logout
          </button>
        </div>
      </header>
      <div className={`layout-body ${sidebarOpen ? 'sidebar-open' : 'sidebar-closed'}`}>
        <aside className="sidebar">
          <div className="sidebar-tabs">
            <button
              className={`sidebar-tab ${sidebarTab === 'files' ? 'sidebar-tab-active' : ''}`}
              onClick={() => setSidebarTab('files')}
            >
              Files
            </button>
            <button
              className={`sidebar-tab ${sidebarTab === 'activity' ? 'sidebar-tab-active' : ''}`}
              onClick={() => setSidebarTab('activity')}
            >
              Activity
            </button>
          </div>
          {sidebarTab === 'files' ? (
            <FileTree
              onSelect={handleFileSelect}
              selectedFile={selectedFile}
              onFileCountChange={setFileCount}
              onFilesLoaded={handleFilesLoaded}
            />
          ) : (
            <ActivityLog visible={sidebarTab === 'activity'} />
          )}
        </aside>
        <main className="main-content">
          {selectedFile ? (
            <FileViewer filePath={selectedFile} onDirtyChange={(d) => { viewerDirtyRef.current = d; }} />
          ) : (
            <div className="empty-state">
              <p>Select a file from the sidebar to view its contents.</p>
            </div>
          )}
        </main>
      </div>
      {sidebarOpen && window.innerWidth < 768 && (
        <div className="sidebar-overlay" onClick={() => setSidebarOpen(false)} />
      )}
      <StatusBar fileCount={fileCount} totalSize={totalSize} agentCounts={agentCounts} />
    </div>
  );
}
