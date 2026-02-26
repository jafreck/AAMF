/**
 * @module kb-server/tools/lookup
 *
 * MCP tool: look up symbols by name or files by path.
 */

import type { Database } from '../db.js';
import { getSymbolsByName, getFileByPath, listSymbols, listFiles } from '../db.js';

// ─── Tool definition ──────────────────────────────────────────────────────────

export const toolDef = {
  name: 'kb_lookup',
  description:
    'Look up symbols by name or source files by path in the knowledge-base index. ' +
    'Set `kind` to "symbol" or "file". Returns an array of matching rows.',
  inputSchema: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        enum: ['symbol', 'file'],
        description: 'Whether to look up a symbol or a file.',
      },
      query: {
        type: 'string',
        description:
          'For kind="symbol": the symbol name to look up (case-insensitive). ' +
          'For kind="file": the exact file path stored in the index.',
      },
    },
    required: ['kind', 'query'],
  },
} as const;

// ─── Handler ──────────────────────────────────────────────────────────────────

export interface LookupArgs {
  kind: 'symbol' | 'file';
  query: string;
}

export interface LookupResult {
  results: unknown[];
}

/** Resolve a lookup request against the open read-only database. */
export function handler(db: Database.Database, args: LookupArgs): LookupResult {
  if (args.kind === 'symbol') {
    const rows = args.query.trim()
      ? getSymbolsByName(db, args.query)
      : listSymbols(db, 20);
    return { results: rows };
  } else {
    if (args.query.trim()) {
      const row = getFileByPath(db, args.query);
      return { results: row ? [row] : [] };
    }
    return { results: listFiles(db, 20) };
  }
}
