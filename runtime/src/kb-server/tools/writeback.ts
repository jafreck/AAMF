/**
 * @module kb-server/tools/writeback
 *
 * MCP tool: write LLM-generated summaries back to the `symbol_summaries`
 * table.  Unlike other tools this handler opens a **read-write** DB
 * connection so it can INSERT/REPLACE rows.
 */

import Database from 'better-sqlite3';

// ─── Tool definition ──────────────────────────────────────────────────────────

export const toolDef = {
  name: 'kb_writeback',
  description:
    'Persist an LLM-generated natural-language summary for a symbol back into ' +
    'the knowledge-base `symbol_summaries` table.  The summary can be retrieved ' +
    'later via kb_lookup.',
  inputSchema: {
    type: 'object',
    properties: {
      symbol_id: {
        type: 'number',
        description: 'The id of the symbol row to attach the summary to.',
      },
      summary: {
        type: 'string',
        description: 'The natural-language summary text.',
      },
      model: {
        type: 'string',
        description: 'Identifier of the LLM model that produced the summary.',
      },
    },
    required: ['symbol_id', 'summary', 'model'],
  },
} as const;

// ─── Handler ──────────────────────────────────────────────────────────────────

export interface WritebackArgs {
  symbol_id: number;
  summary: string;
  model: string;
}

export interface WritebackResult {
  ok: boolean;
  symbol_id: number;
}

/**
 * Upsert a symbol summary.
 *
 * @param dbPath  Absolute path to the knowledge-base SQLite file.
 *                A **new** read-write connection is opened for each call so
 *                this function can safely be used alongside read-only handles.
 * @param args    Tool arguments.
 */
export function handler(dbPath: string, args: WritebackArgs): WritebackResult {
  // Open a fresh read-write connection (separate from any read-only handle).
  const db = new Database(dbPath);
  try {
    db.pragma('foreign_keys = ON');
    db
      .prepare(
        `INSERT OR REPLACE INTO symbol_summaries (symbol_id, summary, model, created_at)
         VALUES (?, ?, ?, unixepoch())`,
      )
      .run(args.symbol_id, args.summary, args.model);
    return { ok: true, symbol_id: args.symbol_id };
  } finally {
    db.close();
  }
}
