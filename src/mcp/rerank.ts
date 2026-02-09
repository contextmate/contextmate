import type { SearchResult } from './search.js';
import type { VectorSearchResult } from './embeddings.js';

export interface MergedResult {
  path: string;
  score: number;
  snippet?: string;
  sources: ('bm25' | 'vector')[];
}

export function hybridSearch(
  bm25Results: SearchResult[],
  vectorResults: VectorSearchResult[],
  opts?: { bm25Weight?: number; vectorWeight?: number; k?: number },
): MergedResult[] {
  const bm25Weight = opts?.bm25Weight ?? 1.0;
  const vectorWeight = opts?.vectorWeight ?? 1.0;
  const k = opts?.k ?? 60;

  const merged = new Map<string, MergedResult>();

  // Process BM25 results
  for (let rank = 0; rank < bm25Results.length; rank++) {
    const r = bm25Results[rank]!;
    const rrfScore = bm25Weight * (1 / (k + rank + 1));
    const existing = merged.get(r.path);
    if (existing) {
      existing.score += rrfScore;
      existing.snippet = existing.snippet ?? r.snippet;
      existing.sources.push('bm25');
    } else {
      merged.set(r.path, {
        path: r.path,
        score: rrfScore,
        snippet: r.snippet,
        sources: ['bm25'],
      });
    }
  }

  // Process vector results
  for (let rank = 0; rank < vectorResults.length; rank++) {
    const r = vectorResults[rank]!;
    const rrfScore = vectorWeight * (1 / (k + rank + 1));
    const existing = merged.get(r.path);
    if (existing) {
      existing.score += rrfScore;
      existing.sources.push('vector');
    } else {
      merged.set(r.path, {
        path: r.path,
        score: rrfScore,
        sources: ['vector'],
      });
    }
  }

  // Sort by combined score descending
  const results = Array.from(merged.values());
  results.sort((a, b) => b.score - a.score);
  return results;
}
