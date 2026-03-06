import { useEffect, useState, useMemo, useCallback } from 'react';
import { useAuth } from '../context/AuthContext.tsx';
import type { FileMetadata } from '../api/client.ts';

const COLLAPSED_KEY = 'contextmate-collapsed-folders';

function loadCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch {
    return new Set();
  }
}

function saveCollapsed(collapsed: Set<string>): void {
  localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]));
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString();
}

interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children: TreeNode[];
  meta?: FileMetadata;
}

function buildTree(files: FileMetadata[]): TreeNode[] {
  const root: TreeNode[] = [];
  const dirs = new Map<string, TreeNode>();

  for (const file of files) {
    const parts = file.path.split('/');
    let currentLevel = root;
    let currentPath = '';

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const isLast = i === parts.length - 1;

      if (isLast) {
        currentLevel.push({
          name: part,
          path: file.path,
          isDir: false,
          children: [],
          meta: file,
        });
      } else {
        let dir = dirs.get(currentPath);
        if (!dir) {
          dir = { name: part, path: currentPath, isDir: true, children: [] };
          dirs.set(currentPath, dir);
          currentLevel.push(dir);
        }
        currentLevel = dir.children;
      }
    }
  }

  return sortTree(root);
}

function sortTree(nodes: TreeNode[]): TreeNode[] {
  nodes.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const node of nodes) {
    if (node.isDir) sortTree(node.children);
  }
  return nodes;
}

function getFileIcon(name: string): string {
  if (name.includes('skill')) return '[S]';
  if (name.includes('memor')) return '[M]';
  if (name.includes('rule')) return '[R]';
  if (name.endsWith('.md')) return '[D]';
  if (name.endsWith('.json')) return '[J]';
  if (name.endsWith('.jsonl')) return '[J]';
  if (name.endsWith('.toml')) return '[T]';
  if (/\.(jpe?g|png|gif|webp|svg)$/i.test(name)) return '[I]';
  if (/\.(py|sh|js|ts)$/i.test(name)) return '[X]';
  return '[F]';
}

const FOLDER_LABELS: Record<string, string> = {
  'openclaw': 'OpenClaw',
  'claude': 'Claude Code',
  'skills': 'Shared Skills',
  'custom': 'Extra Paths',
};

const SUBFOLDER_LABELS: Record<string, string> = {
  'openclaw/config': 'Config & cron',
};

function getFolderLabel(path: string): string | null {
  // Check exact subfolder matches first
  if (SUBFOLDER_LABELS[path]) return SUBFOLDER_LABELS[path];

  // Check top-level folder
  const topLevel = path.split('/')[0];
  if (FOLDER_LABELS[topLevel]) {
    // For openclaw subfolders, add agent context
    if (topLevel === 'openclaw' && path.includes('/')) {
      const sub = path.split('/')[1];
      if (sub === 'config') return 'Config & cron';
      if (sub?.endsWith('-sessions')) return `${sub.replace('-sessions', '')} sessions`;
      return `${sub} workspace`;
    }
    return FOLDER_LABELS[topLevel];
  }

  return null;
}

function collectFilePaths(node: TreeNode): string[] {
  if (!node.isDir) return [node.path];
  return node.children.flatMap(collectFilePaths);
}

interface TreeItemProps {
  node: TreeNode;
  depth: number;
  selectedFile: string | null;
  onSelect: (path: string) => void;
  onDelete: (paths: string[], label: string) => void;
  collapsed: Set<string>;
  onToggle: (path: string) => void;
}

function TreeItem({ node, depth, selectedFile, onSelect, onDelete, collapsed, onToggle }: TreeItemProps) {
  if (node.isDir) {
    const expanded = !collapsed.has(node.path);
    const label = getFolderLabel(node.path);
    return (
      <div>
        <div
          className="tree-item tree-dir"
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
          onClick={() => onToggle(node.path)}
        >
          <span className="tree-arrow">{expanded ? 'v' : '>'}</span>
          <span className="tree-icon">[/]</span>
          <span className="tree-name">{node.name}</span>
          {label && <span className="tree-label">{label}</span>}
          <button
            className="tree-delete"
            onClick={(e) => {
              e.stopPropagation();
              const paths = collectFilePaths(node);
              onDelete(paths, `folder "${node.name}" (${paths.length} file${paths.length === 1 ? '' : 's'})`);
            }}
            title={`Delete folder ${node.name}`}
          >
            X
          </button>
        </div>
        {expanded &&
          node.children.map((child) => (
            <TreeItem
              key={child.path}
              node={child}
              depth={depth + 1}
              selectedFile={selectedFile}
              onSelect={onSelect}
              onDelete={onDelete}
              collapsed={collapsed}
              onToggle={onToggle}
            />
          ))}
      </div>
    );
  }

  const isSelected = selectedFile === node.path;
  return (
    <div
      className={`tree-item tree-file ${isSelected ? 'tree-selected' : ''}`}
      style={{ paddingLeft: `${depth * 16 + 8}px` }}
      onClick={() => onSelect(node.path)}
      title={node.meta ? `v${node.meta.version} | ${formatSize(node.meta.size)} | ${formatTime(node.meta.updatedAt)}` : ''}
    >
      <span className="tree-icon">{getFileIcon(node.name)}</span>
      <span className="tree-name">{node.name}</span>
      <button
        className="tree-delete"
        onClick={(e) => {
          e.stopPropagation();
          onDelete([node.path], `"${node.name}"`);
        }}
        title={`Delete ${node.name}`}
      >
        X
      </button>
    </div>
  );
}

interface FileTreeProps {
  onSelect: (path: string) => void;
  selectedFile: string | null;
  onFileCountChange: (count: number) => void;
  onFilesLoaded?: (files: FileMetadata[]) => void;
}

export function FileTree({ onSelect, selectedFile, onFileCountChange, onFilesLoaded }: FileTreeProps) {
  const { apiClient } = useAuth();
  const [files, setFiles] = useState<FileMetadata[]>([]);
  const [filter, setFilter] = useState('');
  const [agentFilter, setAgentFilter] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!apiClient) return;
    let cancelled = false;

    async function load() {
      try {
        setLoading(true);
        const list = await apiClient!.listFiles();
        if (!cancelled) {
          setFiles(list);
          onFileCountChange(list.length);
          onFilesLoaded?.(list);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load files');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [apiClient, onFileCountChange, onFilesLoaded]);

  const agents = useMemo(() => {
    const agentSet = new Set<string>();
    for (const f of files) {
      const firstSegment = f.path.split('/')[0];
      if (firstSegment) agentSet.add(firstSegment);
    }
    return Array.from(agentSet).sort();
  }, [files]);

  const filtered = useMemo(() => {
    let result = files;
    if (agentFilter) {
      result = result.filter((f) => f.path.split('/')[0] === agentFilter);
    }
    if (filter) {
      const lower = filter.toLowerCase();
      result = result.filter((f) => f.path.toLowerCase().includes(lower));
    }
    return result;
  }, [files, agentFilter, filter]);

  const tree = useMemo(() => buildTree(filtered), [filtered]);

  const handleDelete = useCallback(async (paths: string[], label: string) => {
    if (!apiClient) return;
    if (!window.confirm(`Delete ${label}? This cannot be undone.`)) return;

    try {
      for (const p of paths) {
        await apiClient.deleteFile(p);
      }
      setFiles((prev) => {
        const deleted = new Set(paths);
        const next = prev.filter((f) => !deleted.has(f.path));
        onFileCountChange(next.length);
        return next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete');
    }
  }, [apiClient, onFileCountChange]);

  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed);
  const handleToggle = useCallback((path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      saveCollapsed(next);
      return next;
    });
  }, []);

  return (
    <div className="file-tree">
      <div className="file-tree-header">
        <select
          className="file-tree-agent-filter"
          value={agentFilter}
          onChange={(e) => setAgentFilter(e.target.value)}
        >
          <option value="">All agents</option>
          {agents.map((agent) => (
            <option key={agent} value={agent}>{agent}</option>
          ))}
        </select>
        <input
          type="text"
          className="file-tree-search"
          placeholder="Filter files..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      <div className="file-tree-list">
        {loading && <div className="file-tree-status">Loading files...</div>}
        {error && <div className="file-tree-error">{error}</div>}
        {!loading && !error && tree.length === 0 && (
          <div className="file-tree-status">No files found</div>
        )}
        {tree.map((node) => (
          <TreeItem
            key={node.path}
            node={node}
            depth={0}
            selectedFile={selectedFile}
            onSelect={onSelect}
            onDelete={handleDelete}
            collapsed={collapsed}
            onToggle={handleToggle}
          />
        ))}
      </div>
    </div>
  );
}
