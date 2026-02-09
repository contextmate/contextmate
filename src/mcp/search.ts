import Database from 'better-sqlite3';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

export interface SearchResult {
  path: string;
  snippet: string;
  score: number;
}

export class SearchIndex {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
        path,
        content,
        tokenize='porter unicode61'
      );
      CREATE TABLE IF NOT EXISTS memory_files (
        path TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        last_indexed INTEGER NOT NULL
      );
    `);
  }

  indexFile(path: string, content: string): void {
    const now = Date.now();
    const txn = this.db.transaction(() => {
      this.db.prepare('DELETE FROM memory_fts WHERE path = ?').run(path);
      this.db.prepare('INSERT INTO memory_fts (path, content) VALUES (?, ?)').run(path, content);
      this.db.prepare(
        'INSERT OR REPLACE INTO memory_files (path, content, last_indexed) VALUES (?, ?, ?)',
      ).run(path, content, now);
    });
    txn();
  }

  removeFromIndex(path: string): void {
    const txn = this.db.transaction(() => {
      this.db.prepare('DELETE FROM memory_fts WHERE path = ?').run(path);
      this.db.prepare('DELETE FROM memory_files WHERE path = ?').run(path);
    });
    txn();
  }

  search(query: string, limit: number = 10): SearchResult[] {
    const sanitized = this.sanitizeQuery(query);
    if (!sanitized) return [];

    const stmt = this.db.prepare(`
      SELECT
        path,
        snippet(memory_fts, 1, '>>>', '<<<', '...', 64) as snippet,
        bm25(memory_fts) as score
      FROM memory_fts
      WHERE memory_fts MATCH ?
      ORDER BY bm25(memory_fts)
      LIMIT ?
    `);

    const rows = stmt.all(sanitized, limit) as Array<{
      path: string;
      snippet: string;
      score: number;
    }>;

    return rows.map((row) => ({
      path: row.path,
      snippet: row.snippet,
      score: row.score,
    }));
  }

  async rebuildIndex(vaultPath: string): Promise<void> {
    this.db.exec('DELETE FROM memory_fts');
    this.db.exec('DELETE FROM memory_files');

    const mdFiles = await this.collectMdFiles(vaultPath, vaultPath);
    for (const filePath of mdFiles) {
      const content = await readFile(join(vaultPath, filePath), 'utf-8');
      this.indexFile(filePath, content);
    }
  }

  getIndexedFiles(): string[] {
    const rows = this.db.prepare('SELECT path FROM memory_files ORDER BY path').all() as Array<{
      path: string;
    }>;
    return rows.map((r) => r.path);
  }

  close(): void {
    this.db.close();
  }

  private sanitizeQuery(query: string): string {
    // Remove FTS5 special characters that could break the query
    const cleaned = query.replace(/[":*^~(){}[\]\\]/g, ' ').trim();
    if (!cleaned) return '';
    // Wrap individual terms in quotes to avoid syntax issues
    const terms = cleaned.split(/\s+/).filter(Boolean);
    if (terms.length === 0) return '';
    return terms.map((t) => `"${t}"`).join(' ');
  }

  private async collectMdFiles(dir: string, basePath: string): Promise<string[]> {
    const results: string[] = [];
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return results;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.')) continue;
        const sub = await this.collectMdFiles(fullPath, basePath);
        results.push(...sub);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push(relative(basePath, fullPath));
      }
    }
    return results;
  }
}
