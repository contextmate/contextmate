import { describe, it, expect } from 'vitest';
import {
  matchesScope,
  hasPermission,
  requiredPermission,
  extractFilePath,
} from '../../src/mcp/scope.js';

describe('matchesScope', () => {
  it('"*" matches everything', () => {
    expect(matchesScope('skills/my-skill/SKILL.md', '*')).toBe(true);
    expect(matchesScope('openclaw/MEMORY.md', '*')).toBe(true);
    expect(matchesScope('anything/at/all.md', '*')).toBe(true);
  });

  it('"skills/*" matches "skills/my-skill/SKILL.md"', () => {
    expect(matchesScope('skills/my-skill/SKILL.md', 'skills/*')).toBe(true);
  });

  it('"skills/*" matches paths containing "/skills/"', () => {
    expect(matchesScope('openclaw/skills/my-skill/SKILL.md', 'skills/*')).toBe(true);
  });

  it('"skills/*" does not match "openclaw/MEMORY.md"', () => {
    expect(matchesScope('openclaw/MEMORY.md', 'skills/*')).toBe(false);
  });

  it('"memories/*" matches paths with "memory/" in them', () => {
    expect(matchesScope('openclaw/memory/2026-01-01.md', 'memories/*')).toBe(true);
  });

  it('"memories/*" matches paths ending with "MEMORY.md"', () => {
    expect(matchesScope('openclaw/MEMORY.md', 'memories/*')).toBe(true);
  });

  it('comma-separated "skills/*,memories/*" matches both skill and memory paths', () => {
    expect(matchesScope('skills/my-skill/SKILL.md', 'skills/*,memories/*')).toBe(true);
    expect(matchesScope('openclaw/memory/2026-01-01.md', 'skills/*,memories/*')).toBe(true);
    expect(matchesScope('openclaw/MEMORY.md', 'skills/*,memories/*')).toBe(true);
  });

  it('comma-separated scope does not match unrelated paths', () => {
    expect(matchesScope('random/other-file.md', 'skills/*,memories/*')).toBe(false);
  });

  it('empty scope matches nothing', () => {
    expect(matchesScope('skills/my-skill/SKILL.md', '')).toBe(false);
    expect(matchesScope('anything.md', '')).toBe(false);
  });
});

describe('hasPermission', () => {
  it('"read-write" satisfies "read" requirement', () => {
    expect(hasPermission('read-write', 'read')).toBe(true);
  });

  it('"read" satisfies "read" requirement', () => {
    expect(hasPermission('read', 'read')).toBe(true);
  });

  it('"read" does not satisfy "read-write" requirement', () => {
    expect(hasPermission('read', 'read-write')).toBe(false);
  });

  it('"read-write" satisfies "read-write" requirement', () => {
    expect(hasPermission('read-write', 'read-write')).toBe(true);
  });
});

describe('requiredPermission', () => {
  it('"write-memory" requires "read-write"', () => {
    expect(requiredPermission('write-memory')).toBe('read-write');
  });

  it('"read-memory" requires "read"', () => {
    expect(requiredPermission('read-memory')).toBe('read');
  });

  it('"search-memory" requires "read"', () => {
    expect(requiredPermission('search-memory')).toBe('read');
  });

  it('"list-skills" requires "read"', () => {
    expect(requiredPermission('list-skills')).toBe('read');
  });

  it('"list-memories" requires "read"', () => {
    expect(requiredPermission('list-memories')).toBe('read');
  });

  it('"read-skill" requires "read"', () => {
    expect(requiredPermission('read-skill')).toBe('read');
  });
});

describe('extractFilePath', () => {
  it('read-memory returns file arg', () => {
    expect(extractFilePath('read-memory', { file: 'openclaw/MEMORY.md' })).toBe(
      'openclaw/MEMORY.md',
    );
  });

  it('read-memory returns null when no file arg', () => {
    expect(extractFilePath('read-memory', {})).toBeNull();
  });

  it('write-memory returns file arg', () => {
    expect(extractFilePath('write-memory', { file: 'openclaw/memory/2026-01-01.md' })).toBe(
      'openclaw/memory/2026-01-01.md',
    );
  });

  it('write-memory returns null when no file arg (daily log default)', () => {
    expect(extractFilePath('write-memory', {})).toBeNull();
  });

  it('read-skill returns constructed path', () => {
    expect(extractFilePath('read-skill', { skill: 'my-skill' })).toBe(
      'skills/my-skill/SKILL.md',
    );
  });

  it('read-skill returns null when no skill arg', () => {
    expect(extractFilePath('read-skill', {})).toBeNull();
  });

  it('list-skills returns null', () => {
    expect(extractFilePath('list-skills', {})).toBeNull();
  });

  it('search-memory returns null', () => {
    expect(extractFilePath('search-memory', { query: 'test' })).toBeNull();
  });

  it('list-memories returns null', () => {
    expect(extractFilePath('list-memories', {})).toBeNull();
  });
});
