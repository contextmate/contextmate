import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '../context/AuthContext.tsx';
import type { AuditEntry } from '../api/client.ts';

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

function getActionIcon(action: string): string {
  if (action.includes('upload') || action.includes('put')) return '\u2191';
  if (action.includes('download') || action.includes('get')) return '\u2193';
  if (action.includes('delete')) return '\u2715';
  return '\u2022';
}

function getActionColor(action: string): string {
  if (action.includes('upload') || action.includes('put')) return '#66bb6a';
  if (action.includes('download') || action.includes('get')) return '#4fc3f7';
  if (action.includes('delete')) return '#ff6b6b';
  return '#aaa';
}

interface ActivityLogProps {
  visible: boolean;
}

export function ActivityLog({ visible }: ActivityLogProps) {
  const { apiClient } = useAuth();
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionFilter, setActionFilter] = useState('');

  const fetchLog = useCallback(async () => {
    if (!apiClient) return;
    try {
      setLoading(true);
      const params = actionFilter ? { action: actionFilter } : {};
      const result = await apiClient.getAuditLog(params);
      setEntries(result);
    } catch {
      // silently handle errors
    } finally {
      setLoading(false);
    }
  }, [apiClient, actionFilter]);

  useEffect(() => {
    if (!visible) return;
    fetchLog();
    const interval = setInterval(fetchLog, 30000);
    return () => clearInterval(interval);
  }, [visible, fetchLog]);

  const filtered = actionFilter
    ? entries.filter((e) => e.action.includes(actionFilter))
    : entries;

  if (!visible) return null;

  return (
    <div className="activity-log">
      <div className="activity-log-header">
        <span className="activity-log-title">Activity</span>
        <select
          className="activity-log-filter"
          value={actionFilter}
          onChange={(e) => setActionFilter(e.target.value)}
        >
          <option value="">All</option>
          <option value="upload">Uploads</option>
          <option value="download">Downloads</option>
          <option value="delete">Deletes</option>
        </select>
      </div>
      <div className="activity-log-list">
        {loading && <div className="activity-log-status">Loading...</div>}
        {!loading && filtered.length === 0 && (
          <div className="activity-log-status">No activity yet</div>
        )}
        {!loading &&
          filtered.map((entry) => (
            <div key={entry.id} className="activity-log-entry">
              <span
                className="activity-log-icon"
                style={{ color: getActionColor(entry.action) }}
              >
                {getActionIcon(entry.action)}
              </span>
              <span className="activity-log-path" title={entry.path}>
                {entry.path}
              </span>
              <span className="activity-log-time">
                {formatRelativeTime(entry.timestamp)}
              </span>
            </div>
          ))}
      </div>
    </div>
  );
}
