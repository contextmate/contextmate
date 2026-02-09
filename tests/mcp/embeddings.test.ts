import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { VectorIndex } from '../../src/mcp/embeddings.js';
import { tmpdir } from 'node:os';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

let tmpDir: string;
let index: VectorIndex;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'contextmate-vector-test-'));
  index = new VectorIndex(join(tmpDir, 'vectors.db'));
});

afterEach(async () => {
  index.close();
  await rm(tmpDir, { recursive: true, force: true });
});

describe('VectorIndex', () => {
  it('indexes documents and searches for relevant results', () => {
    index.indexFile('python.md', 'Python is a powerful programming language used for data science and machine learning');
    index.indexFile('javascript.md', 'JavaScript is used for web development and building interactive user interfaces');
    index.indexFile('cooking.md', 'The best recipe for chocolate cake requires cocoa powder and butter');
    index.recomputeIdf();

    const results = index.search('programming language');
    expect(results.length).toBeGreaterThan(0);
    // Programming-related docs should score higher than cooking
    const topPath = results[0]!.path;
    expect(['python.md', 'javascript.md']).toContain(topPath);
  });

  it('identical documents score close to 1.0 in cosine similarity', () => {
    const content = 'machine learning algorithms neural networks deep learning';
    index.indexFile('doc1.md', content);
    index.indexFile('doc2.md', content);
    index.recomputeIdf();

    const results = index.search('machine learning algorithms neural networks deep learning');
    expect(results.length).toBe(2);
    // Both should have the same high score
    expect(results[0]!.score).toBeCloseTo(results[1]!.score, 2);
    expect(results[0]!.score).toBeGreaterThan(0.9);
  });

  it('different documents have lower similarity', () => {
    index.indexFile('tech.md', 'software engineering algorithms data structures programming');
    index.indexFile('food.md', 'delicious pasta recipe tomato sauce garlic oregano');
    index.recomputeIdf();

    const results = index.search('software engineering programming');
    expect(results.length).toBeGreaterThan(0);
    const techResult = results.find((r) => r.path === 'tech.md');
    const foodResult = results.find((r) => r.path === 'food.md');
    expect(techResult).toBeDefined();
    // Food doc should either not appear or have much lower score
    if (foodResult) {
      expect(techResult!.score).toBeGreaterThan(foodResult.score);
    }
  });

  it('stopwords are filtered during tokenization', () => {
    // Document with mostly stopwords should have very few indexed terms
    index.indexFile('stopwords.md', 'the a an is are was were be been have has had');
    index.indexFile('content.md', 'quantum computing algorithms cryptography blockchain');
    index.recomputeIdf();

    const results = index.search('quantum computing');
    expect(results.length).toBe(1);
    expect(results[0]!.path).toBe('content.md');
  });

  it('removeFromIndex removes document from search results', () => {
    index.indexFile('keep.md', 'typescript development tools');
    index.indexFile('remove.md', 'typescript compiler settings');
    index.recomputeIdf();

    let results = index.search('typescript');
    expect(results.length).toBe(2);

    index.removeFromIndex('remove.md');
    index.recomputeIdf();

    results = index.search('typescript');
    expect(results.length).toBe(1);
    expect(results[0]!.path).toBe('keep.md');
  });

  it('rebuildIndex indexes all markdown files in vault', async () => {
    const vaultDir = join(tmpDir, 'vault');
    await mkdir(vaultDir, { recursive: true });
    await mkdir(join(vaultDir, 'subdir'), { recursive: true });

    await writeFile(join(vaultDir, 'file1.md'), 'neural network training');
    await writeFile(join(vaultDir, 'subdir', 'file2.md'), 'deep learning models');
    await writeFile(join(vaultDir, 'ignore.txt'), 'this should be ignored');

    await index.rebuildIndex(vaultDir);

    const results = index.search('learning');
    expect(results.length).toBeGreaterThan(0);
    const paths = results.map((r) => r.path);
    expect(paths).toContain('subdir/file2.md');
  });

  it('search returns empty array for non-matching query', () => {
    index.indexFile('doc.md', 'apple banana cherry');
    index.recomputeIdf();

    const results = index.search('xylophone');
    expect(results).toEqual([]);
  });

  it('search returns empty array for empty query', () => {
    index.indexFile('doc.md', 'some content here');
    index.recomputeIdf();

    const results = index.search('');
    expect(results).toEqual([]);
  });

  it('respects limit parameter', () => {
    for (let i = 0; i < 20; i++) {
      index.indexFile(`doc${i}.md`, `testing search functionality document number ${i}`);
    }
    index.recomputeIdf();

    const results = index.search('testing search', 5);
    expect(results.length).toBeLessThanOrEqual(5);
  });

  it('close works without error', () => {
    const tmpIndex = new VectorIndex(join(tmpDir, 'close-test.db'));
    expect(() => tmpIndex.close()).not.toThrow();
  });
});
