export { BaseAdapter, type AdapterOptions, type ImportResult, type SymlinkResult } from './base.js';
export { OpenClawAdapter } from './openclaw.js';
export { ClaudeCodeAdapter } from './claude.js';
export { MirrorAdapter } from './mirror.js';

import type { AdapterOptions } from './base.js';
import type { BaseAdapter } from './base.js';
import { OpenClawAdapter } from './openclaw.js';
import { ClaudeCodeAdapter } from './claude.js';
import { MirrorAdapter } from './mirror.js';

export function getAdapter(name: string, options: AdapterOptions): BaseAdapter {
  switch (name) {
    case 'openclaw':
      return new OpenClawAdapter(options);
    case 'claude':
      return new ClaudeCodeAdapter(options);
    case 'mirror':
      return new MirrorAdapter(options);
    default:
      throw new Error(`Unknown adapter: ${name}`);
  }
}
