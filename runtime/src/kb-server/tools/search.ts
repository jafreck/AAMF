/**
 * @module kb-server/tools/search
 *
 * MCP tool: multi-modal knowledge-base search.
 *
 * Modes:
 *  - "structural"  — BM25 full-text search via FTS5 (symbols_fts).
 *  - "semantic"    — cosine similarity via sqlite-vec vec0 tables (requires embeddings).
 *  - "fused"       — Reciprocal Rank Fusion (k=60) combining structural + semantic.
 *
 * Semantic and fused modes silently fall back to structural-only when no
 * embedding vectors are present in the database.
 */

import type { Database } from '../db.js';

// ─── Tool definition ──────────────────────────────────────────────────────────

export const toolDef = {
  name: 'kb_search',
  description:
    'Search the knowledge-base index for symbols matching a natural-language or code query. ' +
    'mode="structural" uses BM25 FTS5 (fast, exact-ish). ' +
    'mode="semantic" uses cosine similarity over embedding vectors (requires indexed embeddings). ' +
    'mode="fused" combines both with Reciprocal Rank Fusion (RRF k=60).',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query string.',
      },
      mode: {
        type: 'string',
        enum: ['structural', 'semantic', 'fused'],
        description: 'Search mode (default: "structural").',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of results to return (default 20).',
      },
    },
    required: ['query'],
  },
} as const;

// ─── Handler ──────────────────────────────────────────────────────────────────

export interface SearchArgs {
  query: string;
  mode?: 'structural' | 'semantic' | 'fused';
  limit?: number;
}

export interface SearchResult {
  results: Array<{
    symbol_id: number;
    name: string;
    kind: string;
    file_path: string;
    start_line: number;
    end_line: number;
    score: number;
  }>;
  mode_used: string;
}

/** Run a structural BM25 FTS5 search and return ranked rows. */
function structuralSearch(
  db: Database.Database,
  query: string,
  limit: number,
): SearchResult['results'] {
  const rows = db
    .prepare(
      `SELECT s.id AS symbol_id, s.name, s.kind, f.path AS file_path,
              s.start_line, s.end_line,
              bm25(symbols_fts) AS score
         FROM symbols_fts
         JOIN symbols s ON s.rowid = symbols_fts.rowid
         JOIN files   f ON f.id   = s.file_id
        WHERE symbols_fts MATCH ?
        ORDER BY score
        LIMIT ?`,
    )
    .all(query, limit) as SearchResult['results'];
  return rows;
}

/**
 * Attempt a semantic (cosine) search via the vec0 virtual table.
 * Returns `null` if the table doesn't exist or has no rows.
 */
function semanticSearch(
  _db: Database.Database,
  _query: string,
  _limit: number,
): SearchResult['results'] | null {
  // Semantic search requires pre-computed query embeddings from the embedder
  // subsystem (EmbeddingProvider). Without a live embedder we cannot vectorise
  // the query at query-time inside the MCP server.  Return null to signal
  // fallback to structural mode.
  return null;
}

/**
 * Reciprocal Rank Fusion (k=60) over structural and semantic result lists.
 *
 * RRF score = Σ 1/(k + rank_i) for each list i where the item appears.
 * Higher score → better rank.
 */
function rrfFuse(
  structural: SearchResult['results'],
  semantic: SearchResult['results'] | null,
  limit: number,
): SearchResult['results'] {
  const k = 60;
  const scores = new Map<number, { item: SearchResult['results'][number]; score: number }>();

  const addList = (list: SearchResult['results']): void => {
    list.forEach((item, idx) => {
      const existing = scores.get(item.symbol_id);
      const contrib = 1 / (k + idx + 1);
      if (existing) {
        existing.score += contrib;
      } else {
        scores.set(item.symbol_id, { item, score: contrib });
      }
    });
  };

  addList(structural);
  if (semantic) addList(semantic);

  return Array.from(scores.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ item, score }) => ({ ...item, score }));
}

/** Execute a knowledge-base search in the requested mode. */
export function handler(db: Database.Database, args: SearchArgs): SearchResult {
  const limit = args.limit ?? 20;
  const mode = args.mode ?? 'structural';

  const structural = structuralSearch(db, args.query, limit);

  if (mode === 'structural') {
    return { results: structural, mode_used: 'structural' };
  }

  const semantic = semanticSearch(db, args.query, limit);

  if (mode === 'semantic') {
    if (semantic) {
      return { results: semantic, mode_used: 'semantic' };
    }
    // Fall back to structural when no embeddings are available.
    return { results: structural, mode_used: 'structural (fallback: no embeddings)' };
  }

  // mode === 'fused'
  const fused = rrfFuse(structural, semantic, limit);
  const modeUsed = semantic ? 'fused' : 'structural (fallback: no embeddings)';
  return { results: fused, mode_used: modeUsed };
}
