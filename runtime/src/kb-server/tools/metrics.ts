/**
 * @module kb-server/tools/metrics
 *
 * MCP tool: return high-level code metrics from the knowledge-base index.
 */

import type { Database } from '../db.js';

// ─── Tool definition ──────────────────────────────────────────────────────────

export const toolDef = {
  name: 'kb_metrics',
  description:
    'Return high-level code metrics from the knowledge-base index: ' +
    'total symbol count, total file count, and total import-edge count.',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
} as const;

// ─── Handler ──────────────────────────────────────────────────────────────────

// No meaningful args for this tool.
export type MetricsArgs = Record<string, never>;

export interface MetricsResult {
  symbol_count: number;
  file_count: number;
  import_edge_count: number;
}

/** Collect aggregate counts from the knowledge-base tables. */
export function handler(db: Database.Database, _args: MetricsArgs): MetricsResult {
  const symbolCount = (
    db.prepare('SELECT COUNT(*) AS c FROM symbols').get() as { c: number }
  ).c;

  const fileCount = (
    db.prepare('SELECT COUNT(*) AS c FROM files').get() as { c: number }
  ).c;

  const importEdgeCount = (
    db.prepare('SELECT COUNT(*) AS c FROM file_imports').get() as { c: number }
  ).c;

  return {
    symbol_count: symbolCount,
    file_count: fileCount,
    import_edge_count: importEdgeCount,
  };
}
