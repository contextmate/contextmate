import type { ApiPermission } from '../types.js';

/**
 * Check if a file path matches a scope pattern.
 * Scopes use glob-like patterns:
 * - "*" matches everything
 * - "skills/*" matches paths starting with "skills/" or containing "/skills/"
 * - "memories/*" matches paths containing "memory/" or ending with "MEMORY.md"
 * - Multiple scopes comma-separated: "skills/*,memories/*"
 */
export function matchesScope(filePath: string, scope: string): boolean {
  if (!scope || scope.trim() === '') return false;

  const patterns = scope.split(',').map((s) => s.trim()).filter(Boolean);

  for (const pattern of patterns) {
    if (pattern === '*') return true;

    // Strip trailing "/*" or "/" to get the prefix
    const prefix = pattern.replace(/\/\*$/, '').replace(/\/$/, '');

    if (prefix === 'memories') {
      // Special case: "memories/*" matches memory-related paths
      if (
        filePath.includes('memory/') ||
        filePath.includes('memory\\') ||
        filePath.endsWith('MEMORY.md')
      ) {
        return true;
      }
    }

    // Direct prefix match: "skills/*" matches "skills/my-skill/SKILL.md"
    if (filePath.startsWith(prefix + '/') || filePath === prefix) {
      return true;
    }

    // Also match nested paths: "openclaw/skills/..." matches "skills/*"
    if (filePath.includes('/' + prefix + '/')) {
      return true;
    }
  }

  return false;
}

/**
 * Check if a permission level satisfies a required permission.
 * "read-write" satisfies both "read" and "read-write" requirements.
 * "read" only satisfies "read" requirements.
 */
export function hasPermission(
  granted: ApiPermission,
  required: ApiPermission,
): boolean {
  if (required === 'read') return true; // both 'read' and 'read-write' satisfy 'read'
  return granted === 'read-write';
}

/**
 * Determine the required permission for a tool name.
 */
export function requiredPermission(toolName: string): ApiPermission {
  if (toolName === 'write-memory') return 'read-write';
  return 'read';
}

/**
 * Extract the file path that a tool invocation accesses.
 * Returns null if the tool doesn't access a specific file (e.g., list-skills, search-memory).
 */
export function extractFilePath(
  toolName: string,
  args: Record<string, unknown>,
): string | null {
  switch (toolName) {
    case 'read-memory':
      return (args.file as string) ?? null;
    case 'write-memory':
      return (args.file as string) ?? null;
    case 'read-skill':
      return args.skill ? `skills/${args.skill}/SKILL.md` : null;
    default:
      return null; // list/search tools don't target specific files
  }
}
