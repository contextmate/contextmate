import { useAuth } from '../context/AuthContext.tsx';

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface StatusBarProps {
  fileCount: number;
  totalSize?: number;
  agentCounts?: Record<string, number>;
}

export function StatusBar({ fileCount, totalSize, agentCounts }: StatusBarProps) {
  const { serverUrl, userId, isAuthenticated } = useAuth();

  const agentSummary = agentCounts
    ? Object.entries(agentCounts)
        .map(([agent, count]) => `${agent}: ${count}`)
        .join(', ')
    : '';

  return (
    <footer className="statusbar">
      <span className="statusbar-item">
        {isAuthenticated ? `Connected to ${serverUrl}` : 'Disconnected'}
      </span>
      <span className="statusbar-item">{fileCount} files in vault</span>
      {totalSize !== undefined && totalSize > 0 && (
        <span className="statusbar-item">{formatSize(totalSize)}</span>
      )}
      {agentSummary && <span className="statusbar-item">{agentSummary}</span>}
      {userId && <span className="statusbar-item">User: {userId.slice(0, 8)}...</span>}
    </footer>
  );
}
