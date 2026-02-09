import Database from 'better-sqlite3';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

export interface VectorSearchResult {
  path: string;
  score: number; // cosine similarity, 0-1
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'have', 'has',
  'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may',
  'might', 'shall', 'can', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by',
  'from', 'or', 'and', 'not', 'but', 'if', 'then', 'as', 'it', 'its', 'this',
  'that', 'which', 'who', 'what', 'when', 'where', 'how', 'all', 'each',
  'every', 'both', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor',
  'too', 'very', 'just', 'also', 'than',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .filter((w) => w.length >= 2 && !STOPWORDS.has(w));
}

export class VectorIndex {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS vocabulary (
        term TEXT PRIMARY KEY,
        idf REAL NOT NULL DEFAULT 0,
        doc_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS documents (
        path TEXT PRIMARY KEY,
        tf_vector TEXT NOT NULL,
        magnitude REAL NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS stats (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  indexFile(path: string, content: string): void {
    const tokens = tokenize(content);
    if (tokens.length === 0) {
      this.removeFromIndex(path);
      return;
    }

    const totalWords = tokens.length;
    const termCounts = new Map<string, number>();
    for (const token of tokens) {
      termCounts.set(token, (termCounts.get(token) ?? 0) + 1);
    }

    // Build raw TF vector (count / total_words)
    const tfVector: Record<string, number> = {};
    for (const [term, count] of termCounts) {
      tfVector[term] = count / totalWords;
    }

    const now = Date.now();

    const txn = this.db.transaction(() => {
      // Check if document already exists — need to decrement old vocab counts
      const existing = this.db.prepare('SELECT tf_vector FROM documents WHERE path = ?').get(path) as
        | { tf_vector: string }
        | undefined;

      if (existing) {
        const oldVector = JSON.parse(existing.tf_vector) as Record<string, number>;
        for (const term of Object.keys(oldVector)) {
          this.db.prepare(
            'UPDATE vocabulary SET doc_count = MAX(doc_count - 1, 0) WHERE term = ?',
          ).run(term);
        }
      }

      // Update vocabulary with new term counts
      const upsertVocab = this.db.prepare(`
        INSERT INTO vocabulary (term, idf, doc_count) VALUES (?, 0, 1)
        ON CONFLICT(term) DO UPDATE SET doc_count = doc_count + 1
      `);
      for (const term of termCounts.keys()) {
        upsertVocab.run(term);
      }

      // Store document (magnitude will be recomputed during recomputeIdf)
      this.db.prepare(
        'INSERT OR REPLACE INTO documents (path, tf_vector, magnitude, updated_at) VALUES (?, ?, 0, ?)',
      ).run(path, JSON.stringify(tfVector), now);

      // Update total docs count
      const docCount = this.db.prepare('SELECT COUNT(*) as cnt FROM documents').get() as {
        cnt: number;
      };
      this.db.prepare(
        "INSERT OR REPLACE INTO stats (key, value) VALUES ('total_docs', ?)",
      ).run(String(docCount.cnt));
    });
    txn();
  }

  removeFromIndex(path: string): void {
    const txn = this.db.transaction(() => {
      const existing = this.db.prepare('SELECT tf_vector FROM documents WHERE path = ?').get(path) as
        | { tf_vector: string }
        | undefined;

      if (existing) {
        const oldVector = JSON.parse(existing.tf_vector) as Record<string, number>;
        for (const term of Object.keys(oldVector)) {
          this.db.prepare(
            'UPDATE vocabulary SET doc_count = MAX(doc_count - 1, 0) WHERE term = ?',
          ).run(term);
        }
        this.db.prepare('DELETE FROM documents WHERE path = ?').run(path);

        // Clean up zero-count vocabulary entries
        this.db.prepare('DELETE FROM vocabulary WHERE doc_count <= 0').run();

        // Update total docs count
        const docCount = this.db.prepare('SELECT COUNT(*) as cnt FROM documents').get() as {
          cnt: number;
        };
        this.db.prepare(
          "INSERT OR REPLACE INTO stats (key, value) VALUES ('total_docs', ?)",
        ).run(String(docCount.cnt));
      }
    });
    txn();
  }

  recomputeIdf(): void {
    const txn = this.db.transaction(() => {
      const statsRow = this.db.prepare("SELECT value FROM stats WHERE key = 'total_docs'").get() as
        | { value: string }
        | undefined;
      const totalDocs = statsRow ? parseInt(statsRow.value, 10) : 0;

      if (totalDocs === 0) return;

      // Update IDF for all terms: log(1 + N / (1 + df))
      this.db.prepare(
        'UPDATE vocabulary SET idf = ln(1.0 + CAST(? AS REAL) / (1.0 + doc_count))',
      ).run(totalDocs);

      // Load all IDF values into memory for vector recomputation
      const vocabRows = this.db.prepare('SELECT term, idf FROM vocabulary').all() as Array<{
        term: string;
        idf: number;
      }>;
      const idfMap = new Map<string, number>();
      for (const row of vocabRows) {
        idfMap.set(row.term, row.idf);
      }

      // Recompute TF-IDF vectors and magnitudes for all documents
      const docs = this.db.prepare('SELECT path, tf_vector FROM documents').all() as Array<{
        path: string;
        tf_vector: string;
      }>;

      const updateDoc = this.db.prepare(
        'UPDATE documents SET tf_vector = ?, magnitude = ? WHERE path = ?',
      );

      for (const doc of docs) {
        const rawTf = JSON.parse(doc.tf_vector) as Record<string, number>;
        const tfidfVector: Record<string, number> = {};
        let magnitudeSq = 0;

        for (const [term, tf] of Object.entries(rawTf)) {
          const idf = idfMap.get(term) ?? 0;
          const tfidf = tf * idf;
          if (tfidf > 0) {
            tfidfVector[term] = tfidf;
            magnitudeSq += tfidf * tfidf;
          }
        }

        const magnitude = Math.sqrt(magnitudeSq);
        updateDoc.run(JSON.stringify(tfidfVector), magnitude, doc.path);
      }
    });
    txn();
  }

  search(query: string, limit: number = 10): VectorSearchResult[] {
    const tokens = tokenize(query);
    if (tokens.length === 0) return [];

    // Build query term frequencies
    const totalWords = tokens.length;
    const termCounts = new Map<string, number>();
    for (const token of tokens) {
      termCounts.set(token, (termCounts.get(token) ?? 0) + 1);
    }

    // Load IDF values for query terms
    const placeholders = Array.from(termCounts.keys())
      .map(() => '?')
      .join(', ');
    const vocabRows = this.db
      .prepare(`SELECT term, idf FROM vocabulary WHERE term IN (${placeholders})`)
      .all(...termCounts.keys()) as Array<{ term: string; idf: number }>;

    const idfMap = new Map<string, number>();
    for (const row of vocabRows) {
      idfMap.set(row.term, row.idf);
    }

    // Build query TF-IDF vector
    const queryVector: Record<string, number> = {};
    let queryMagSq = 0;
    for (const [term, count] of termCounts) {
      const tf = count / totalWords;
      const idf = idfMap.get(term) ?? 0;
      const tfidf = tf * idf;
      if (tfidf > 0) {
        queryVector[term] = tfidf;
        queryMagSq += tfidf * tfidf;
      }
    }

    const queryMag = Math.sqrt(queryMagSq);
    if (queryMag === 0) return [];

    // Load all documents and compute cosine similarity
    const docs = this.db
      .prepare('SELECT path, tf_vector, magnitude FROM documents')
      .all() as Array<{
      path: string;
      tf_vector: string;
      magnitude: number;
    }>;

    const results: VectorSearchResult[] = [];

    for (const doc of docs) {
      if (doc.magnitude === 0) continue;

      const docVector = JSON.parse(doc.tf_vector) as Record<string, number>;

      // Compute dot product (only iterate over query terms since they're sparse)
      let dot = 0;
      for (const [term, qVal] of Object.entries(queryVector)) {
        const dVal = docVector[term];
        if (dVal !== undefined) {
          dot += qVal * dVal;
        }
      }

      if (dot > 0) {
        const similarity = dot / (queryMag * doc.magnitude);
        results.push({ path: doc.path, score: similarity });
      }
    }

    // Sort by score descending, take top-k
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  async rebuildIndex(vaultPath: string): Promise<void> {
    this.db.exec('DELETE FROM documents');
    this.db.exec('DELETE FROM vocabulary');
    this.db.exec('DELETE FROM stats');

    const mdFiles = await this.collectMdFiles(vaultPath, vaultPath);
    for (const filePath of mdFiles) {
      const content = await readFile(join(vaultPath, filePath), 'utf-8');
      this.indexFile(filePath, content);
    }

    this.recomputeIdf();
  }

  close(): void {
    this.db.close();
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
