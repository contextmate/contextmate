export { SearchIndex } from './search.js';
export type { SearchResult } from './search.js';
export { VectorIndex } from './embeddings.js';
export type { VectorSearchResult } from './embeddings.js';
export { hybridSearch } from './rerank.js';
export type { MergedResult } from './rerank.js';
export { createMcpServer, startMcpServer } from './server.js';
export type { McpServerOptions } from './server.js';
export { matchesScope, hasPermission, requiredPermission, extractFilePath } from './scope.js';
