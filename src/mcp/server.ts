import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFile, writeFile, readdir, stat, mkdir } from 'node:fs/promises';
import { join, normalize, resolve, dirname } from 'node:path';
import { SearchIndex } from './search.js';
import { VectorIndex } from './embeddings.js';
import { hybridSearch } from './rerank.js';
import { matchesScope, hasPermission, requiredPermission, extractFilePath } from './scope.js';
import type { ApiPermission } from '../types.js';

export interface McpServerOptions {
  vaultPath: string;
  searchDbPath: string;
  scope?: string;
  permission?: ApiPermission;
}

function isPathSafe(vaultPath: string, filePath: string): boolean {
  const resolved = resolve(vaultPath, filePath);
  const normalizedVault = normalize(vaultPath);
  return resolved.startsWith(normalizedVault + '/') || resolved === normalizedVault;
}

function todayDateString(): string {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

async function collectFiles(
  dir: string,
  basePath: string,
  predicate: (name: string) => boolean,
): Promise<string[]> {
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
      const sub = await collectFiles(fullPath, basePath, predicate);
      results.push(...sub);
    } else if (entry.isFile() && predicate(entry.name)) {
      const rel = fullPath.slice(basePath.length + 1);
      results.push(rel);
    }
  }
  return results;
}

export function createMcpServer(options: McpServerOptions): McpServer;
export function createMcpServer(vaultPath: string, searchDbPath: string): McpServer;
export function createMcpServer(
  vaultPathOrOptions: string | McpServerOptions,
  searchDbPathArg?: string,
): McpServer {
  const opts: McpServerOptions =
    typeof vaultPathOrOptions === 'string'
      ? { vaultPath: vaultPathOrOptions, searchDbPath: searchDbPathArg! }
      : vaultPathOrOptions;

  const vault = resolve(opts.vaultPath);
  const searchIndex = new SearchIndex(opts.searchDbPath);

  // Derive vector DB path from search DB path (sibling file)
  const vectorDbPath = opts.searchDbPath.replace(/\.db$/, '-vectors.db');
  const vectorIndex = new VectorIndex(vectorDbPath !== opts.searchDbPath ? vectorDbPath : opts.searchDbPath + '-vectors.db');

  // Build initial index (fire and forget, errors logged)
  Promise.all([
    searchIndex.rebuildIndex(vault),
    vectorIndex.rebuildIndex(vault),
  ]).catch((err) => {
    process.stderr.write(`[contextmate] Failed to build search index: ${err}\n`);
  });

  /**
   * Check scope and permission enforcement for a tool call.
   * Returns an error message string if access is denied, or null if allowed.
   */
  function checkAccess(toolName: string, args: Record<string, unknown>): string | null {
    // No scope configured = unrestricted local access
    if (!opts.scope || !opts.permission) return null;

    // Check permission level
    const required = requiredPermission(toolName);
    if (!hasPermission(opts.permission, required)) {
      return `Permission denied: "${toolName}" requires "${required}" permission, but key only has "${opts.permission}".`;
    }

    // Check scope for tools that target specific files
    const filePath = extractFilePath(toolName, args);
    if (filePath && !matchesScope(filePath, opts.scope)) {
      return `Scope denied: file "${filePath}" is outside the allowed scope "${opts.scope}".`;
    }

    return null;
  }

  const server = new McpServer({
    name: 'contextmate',
    version: '0.1.0',
  });

  // --- search-memory ---
  server.tool(
    'search-memory',
    'Search through memories using keyword, semantic, or hybrid search. Returns ranked results.',
    {
      query: z.string().describe('Search query'),
      limit: z.number().optional().default(10).describe('Maximum number of results'),
      mode: z
        .enum(['keyword', 'semantic', 'hybrid'])
        .optional()
        .default('hybrid')
        .describe('Search mode: keyword (BM25), semantic (vector), or hybrid (both merged via RRF)'),
    },
    async ({ query, limit, mode }) => {
      const denied = checkAccess('search-memory', { query });
      if (denied) {
        return { content: [{ type: 'text', text: denied }], isError: true };
      }
      try {
        if (mode === 'keyword') {
          const results = searchIndex.search(query, limit);
          if (results.length === 0) {
            return { content: [{ type: 'text', text: 'No results found.' }] };
          }
          const formatted = results
            .map(
              (r, i) =>
                `${i + 1}. **${r.path}** (score: ${r.score.toFixed(4)})\n   ${r.snippet}`,
            )
            .join('\n\n');
          return { content: [{ type: 'text', text: formatted }] };
        }

        if (mode === 'semantic') {
          const results = vectorIndex.search(query, limit);
          if (results.length === 0) {
            return { content: [{ type: 'text', text: 'No results found.' }] };
          }
          const formatted = results
            .map(
              (r, i) =>
                `${i + 1}. **${r.path}** (similarity: ${r.score.toFixed(4)})`,
            )
            .join('\n\n');
          return { content: [{ type: 'text', text: formatted }] };
        }

        // hybrid mode
        const bm25Results = searchIndex.search(query, limit);
        const vectorResults = vectorIndex.search(query, limit);
        const merged = hybridSearch(bm25Results, vectorResults);
        const topResults = merged.slice(0, limit);

        if (topResults.length === 0) {
          return { content: [{ type: 'text', text: 'No results found.' }] };
        }
        const formatted = topResults
          .map((r, i) => {
            const sources = r.sources.join('+');
            const snippetLine = r.snippet ? `\n   ${r.snippet}` : '';
            return `${i + 1}. **${r.path}** (score: ${r.score.toFixed(4)}, via: ${sources})${snippetLine}`;
          })
          .join('\n\n');
        return { content: [{ type: 'text', text: formatted }] };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Search error: ${String(err)}` }],
          isError: true,
        };
      }
    },
  );

  // --- read-memory ---
  server.tool(
    'read-memory',
    'Read the contents of a specific memory file.',
    {
      file: z
        .string()
        .describe('Relative path within vault, e.g. "openclaw/MEMORY.md"'),
    },
    async ({ file }) => {
      const denied = checkAccess('read-memory', { file });
      if (denied) {
        return { content: [{ type: 'text', text: denied }], isError: true };
      }
      try {
        if (!isPathSafe(vault, file)) {
          return {
            content: [{ type: 'text', text: 'Error: Invalid file path.' }],
            isError: true,
          };
        }
        const fullPath = resolve(vault, file);
        const content = await readFile(fullPath, 'utf-8');
        return { content: [{ type: 'text', text: content }] };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error reading file: ${String(err)}` }],
          isError: true,
        };
      }
    },
  );

  // --- write-memory ---
  server.tool(
    'write-memory',
    "Write or append content to a memory file. Defaults to today's daily log.",
    {
      content: z.string().describe('Content to write'),
      file: z
        .string()
        .optional()
        .describe('Relative path within vault. Defaults to daily log.'),
    },
    async ({ content, file }) => {
      const relPath = file ?? `openclaw/memory/${todayDateString()}.md`;
      const denied = checkAccess('write-memory', { file: relPath });
      if (denied) {
        return { content: [{ type: 'text', text: denied }], isError: true };
      }
      try {
        if (!isPathSafe(vault, relPath)) {
          return {
            content: [{ type: 'text', text: 'Error: Invalid file path.' }],
            isError: true,
          };
        }
        const fullPath = resolve(vault, relPath);
        await mkdir(dirname(fullPath), { recursive: true });

        let existing = '';
        try {
          existing = await readFile(fullPath, 'utf-8');
        } catch {
          // File doesn't exist, will be created
        }

        const newContent = existing ? existing + '\n\n' + content : content;
        await writeFile(fullPath, newContent, 'utf-8');

        // Re-index the file in both indexes
        searchIndex.indexFile(relPath, newContent);
        vectorIndex.indexFile(relPath, newContent);
        vectorIndex.recomputeIdf();

        return {
          content: [
            {
              type: 'text',
              text: `Written to ${relPath}${existing ? ' (appended)' : ' (created)'}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error writing file: ${String(err)}` }],
          isError: true,
        };
      }
    },
  );

  // --- read-skill ---
  server.tool(
    'read-skill',
    'Read the contents of a specific skill file.',
    {
      skill: z.string().describe('Skill name, e.g. "my-skill"'),
    },
    async ({ skill }) => {
      const denied = checkAccess('read-skill', { skill });
      if (denied) {
        return { content: [{ type: 'text', text: denied }], isError: true };
      }
      try {
        // Validate skill name (no path traversal)
        if (skill.includes('..') || skill.includes('/') || skill.includes('\\')) {
          return {
            content: [{ type: 'text', text: 'Error: Invalid skill name.' }],
            isError: true,
          };
        }

        // Try multiple possible locations
        const candidates = [
          join(vault, 'skills', skill, 'SKILL.md'),
          join(vault, 'openclaw', 'skills', skill, 'SKILL.md'),
        ];

        for (const candidate of candidates) {
          try {
            const content = await readFile(candidate, 'utf-8');
            return { content: [{ type: 'text', text: content }] };
          } catch {
            continue;
          }
        }

        return {
          content: [{ type: 'text', text: `Skill "${skill}" not found.` }],
          isError: true,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error reading skill: ${String(err)}` }],
          isError: true,
        };
      }
    },
  );

  // --- list-skills ---
  server.tool(
    'list-skills',
    'List all available skills.',
    {},
    async () => {
      const denied = checkAccess('list-skills', {});
      if (denied) {
        return { content: [{ type: 'text', text: denied }], isError: true };
      }
      try {
        const skillFiles = await collectFiles(vault, vault, (name) => name === 'SKILL.md');
        if (skillFiles.length === 0) {
          return { content: [{ type: 'text', text: 'No skills found.' }] };
        }

        const entries: string[] = [];
        for (const relPath of skillFiles) {
          const fullPath = join(vault, relPath);
          const content = await readFile(fullPath, 'utf-8');
          const firstLines = content.split('\n').slice(0, 3).join('\n').trim();
          // Extract skill name from path: e.g. "skills/my-skill/SKILL.md" -> "my-skill"
          const parts = relPath.split('/');
          const skillIdx = parts.indexOf('SKILL.md');
          const skillName = skillIdx > 0 ? parts[skillIdx - 1] : relPath;
          entries.push(`- **${skillName}** (${relPath})\n  ${firstLines}`);
        }

        return { content: [{ type: 'text', text: entries.join('\n\n') }] };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error listing skills: ${String(err)}` }],
          isError: true,
        };
      }
    },
  );

  // --- list-memories ---
  server.tool(
    'list-memories',
    'List all memory files.',
    {},
    async () => {
      const denied = checkAccess('list-memories', {});
      if (denied) {
        return { content: [{ type: 'text', text: denied }], isError: true };
      }
      try {
        const mdFiles = await collectFiles(vault, vault, (name) => name.endsWith('.md'));
        // Filter to memory-related files
        const memoryFiles = mdFiles.filter(
          (f) => f.includes('memory/') || f.includes('memory\\') || f.endsWith('MEMORY.md'),
        );

        if (memoryFiles.length === 0) {
          return { content: [{ type: 'text', text: 'No memory files found.' }] };
        }

        const entries: string[] = [];
        for (const relPath of memoryFiles) {
          const fullPath = join(vault, relPath);
          try {
            const info = await stat(fullPath);
            const modified = new Date(info.mtimeMs).toISOString().slice(0, 19).replace('T', ' ');
            entries.push(`- ${relPath} (modified: ${modified})`);
          } catch {
            entries.push(`- ${relPath}`);
          }
        }

        return { content: [{ type: 'text', text: entries.join('\n') }] };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error listing memories: ${String(err)}` }],
          isError: true,
        };
      }
    },
  );

  return server;
}

export async function startMcpServer(
  vaultPath: string,
  searchDbPath: string,
  scopeOptions?: { scope: string; permission: ApiPermission },
): Promise<void> {
  const server = scopeOptions
    ? createMcpServer({ vaultPath, searchDbPath, scope: scopeOptions.scope, permission: scopeOptions.permission })
    : createMcpServer(vaultPath, searchDbPath);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
