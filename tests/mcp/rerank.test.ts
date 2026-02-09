import { describe, it, expect } from 'vitest';
import { hybridSearch } from '../../src/mcp/rerank.js';
import type { SearchResult } from '../../src/mcp/search.js';
import type { VectorSearchResult } from '../../src/mcp/embeddings.js';

describe('hybridSearch', () => {
  it('merges two result lists using RRF', () => {
    const bm25: SearchResult[] = [
      { path: 'a.md', snippet: 'snippet a', score: -5.0 },
      { path: 'b.md', snippet: 'snippet b', score: -3.0 },
    ];
    const vector: VectorSearchResult[] = [
      { path: 'b.md', score: 0.9 },
      { path: 'c.md', score: 0.7 },
    ];

    const results = hybridSearch(bm25, vector);
    expect(results.length).toBe(3);
    // b.md appears in both lists, so it should score highest
    expect(results[0]!.path).toBe('b.md');
  });

  it('results present in both lists score higher than single-list results', () => {
    const bm25: SearchResult[] = [
      { path: 'shared.md', snippet: 'shared snippet', score: -5.0 },
      { path: 'bm25only.md', snippet: 'bm25 snippet', score: -3.0 },
    ];
    const vector: VectorSearchResult[] = [
      { path: 'shared.md', score: 0.9 },
      { path: 'vectoronly.md', score: 0.8 },
    ];

    const results = hybridSearch(bm25, vector);
    const sharedResult = results.find((r) => r.path === 'shared.md');
    const bm25OnlyResult = results.find((r) => r.path === 'bm25only.md');
    const vectorOnlyResult = results.find((r) => r.path === 'vectoronly.md');

    expect(sharedResult).toBeDefined();
    expect(bm25OnlyResult).toBeDefined();
    expect(vectorOnlyResult).toBeDefined();
    expect(sharedResult!.score).toBeGreaterThan(bm25OnlyResult!.score);
    expect(sharedResult!.score).toBeGreaterThan(vectorOnlyResult!.score);
    expect(sharedResult!.sources).toContain('bm25');
    expect(sharedResult!.sources).toContain('vector');
  });

  it('weights affect ranking', () => {
    const bm25: SearchResult[] = [
      { path: 'bm25first.md', snippet: 'bm25', score: -5.0 },
    ];
    const vector: VectorSearchResult[] = [
      { path: 'vectorfirst.md', score: 0.9 },
    ];

    // Heavy BM25 weight
    const bm25Heavy = hybridSearch(bm25, vector, { bm25Weight: 10.0, vectorWeight: 1.0 });
    expect(bm25Heavy[0]!.path).toBe('bm25first.md');

    // Heavy vector weight
    const vectorHeavy = hybridSearch(bm25, vector, { bm25Weight: 1.0, vectorWeight: 10.0 });
    expect(vectorHeavy[0]!.path).toBe('vectorfirst.md');
  });

  it('empty inputs return empty results', () => {
    expect(hybridSearch([], [])).toEqual([]);
    expect(hybridSearch([], [{ path: 'a.md', score: 0.5 }])).toHaveLength(1);
    expect(hybridSearch([{ path: 'a.md', snippet: 's', score: -1 }], [])).toHaveLength(1);
  });

  it('deduplication by path works correctly', () => {
    const bm25: SearchResult[] = [
      { path: 'dup.md', snippet: 'snippet1', score: -5.0 },
    ];
    const vector: VectorSearchResult[] = [
      { path: 'dup.md', score: 0.9 },
    ];

    const results = hybridSearch(bm25, vector);
    const dupResults = results.filter((r) => r.path === 'dup.md');
    expect(dupResults).toHaveLength(1);
    // Score should be combined from both sources
    expect(dupResults[0]!.sources).toEqual(['bm25', 'vector']);
  });

  it('preserves snippet from BM25 results', () => {
    const bm25: SearchResult[] = [
      { path: 'a.md', snippet: 'relevant snippet', score: -5.0 },
    ];
    const vector: VectorSearchResult[] = [
      { path: 'a.md', score: 0.9 },
    ];

    const results = hybridSearch(bm25, vector);
    expect(results[0]!.snippet).toBe('relevant snippet');
  });

  it('custom k parameter changes RRF scoring', () => {
    const bm25: SearchResult[] = [
      { path: 'a.md', snippet: 's', score: -5.0 },
      { path: 'b.md', snippet: 's', score: -3.0 },
    ];
    const vector: VectorSearchResult[] = [];

    // With small k, rank difference matters more
    const smallK = hybridSearch(bm25, vector, { k: 1 });
    const scoreDiffSmallK = smallK[0]!.score - smallK[1]!.score;

    // With large k, rank difference matters less
    const largeK = hybridSearch(bm25, vector, { k: 1000 });
    const scoreDiffLargeK = largeK[0]!.score - largeK[1]!.score;

    expect(scoreDiffSmallK).toBeGreaterThan(scoreDiffLargeK);
  });
});
