import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SearchIndex } from '../../src/mcp/search.js';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';

let tmpDir: string;
let index: SearchIndex;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'contextmate-search-test-'));
  index = new SearchIndex(join(tmpDir, 'search.db'));
});

afterEach(async () => {
  index.close();
  await rm(tmpDir, { recursive: true, force: true });
});

describe('SearchIndex', () => {
  it('indexes a file and searches for a word in it', () => {
    index.indexFile('memory/notes.md', 'The quick brown fox jumps over the lazy dog');
    const results = index.search('fox');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.path).toBe('memory/notes.md');
  });

  it('search returns results ranked by relevance', () => {
    index.indexFile('a.md', 'python programming language is great for python developers');
    index.indexFile('b.md', 'javascript is also a popular programming language');
    index.indexFile('c.md', 'python python python everywhere');

    const results = index.search('python');
    expect(results.length).toBeGreaterThan(0);
    // All results should contain python-related content
    const paths = results.map((r) => r.path);
    expect(paths).toContain('a.md');
    expect(paths).toContain('c.md');
  });

  it('search returns empty array for non-matching query', () => {
    index.indexFile('a.md', 'The quick brown fox');
    const results = index.search('nonexistentword');
    expect(results).toEqual([]);
  });

  it('indexFile updates existing entry', () => {
    index.indexFile('doc.md', 'original content about cats');
    index.indexFile('doc.md', 'updated content about dogs');

    const catResults = index.search('cats');
    expect(catResults.length).toBe(0);

    const dogResults = index.search('dogs');
    expect(dogResults.length).toBeGreaterThan(0);
    expect(dogResults[0]!.path).toBe('doc.md');
  });

  it('removeFromIndex makes content unsearchable', () => {
    index.indexFile('removeme.md', 'unique searchable content zebra');
    let results = index.search('zebra');
    expect(results.length).toBe(1);

    index.removeFromIndex('removeme.md');
    results = index.search('zebra');
    expect(results.length).toBe(0);
  });

  it('getIndexedFiles returns all indexed paths', () => {
    index.indexFile('file1.md', 'content one');
    index.indexFile('file2.md', 'content two');
    index.indexFile('dir/file3.md', 'content three');

    const files = index.getIndexedFiles();
    expect(files).toEqual(['dir/file3.md', 'file1.md', 'file2.md']);
  });

  it('multiple files: search returns results from correct files', () => {
    index.indexFile('alpha.md', 'alpha particles are helium nuclei');
    index.indexFile('beta.md', 'beta particles are electrons');
    index.indexFile('gamma.md', 'gamma rays are electromagnetic radiation');

    const results = index.search('electrons');
    expect(results.length).toBe(1);
    expect(results[0]!.path).toBe('beta.md');
  });

  it('special characters in content do not break indexing', () => {
    const content = 'Code: const x = { "key": [1, 2, 3] }; // comment\n```typescript\nfunction hello() {}\n```';
    index.indexFile('code.md', content);
    const results = index.search('hello');
    expect(results.length).toBeGreaterThan(0);
  });

  it('close works without error', () => {
    const tmpIndex = new SearchIndex(join(tmpDir, 'close-test.db'));
    expect(() => tmpIndex.close()).not.toThrow();
  });
});
