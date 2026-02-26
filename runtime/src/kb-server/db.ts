/**
 * @module kb-server/db
 *
 * Read-only SQLite connection wrapper for the KB MCP server.
 * All MCP tool files use `openReadOnly()` to open the knowledge-base database.
 */

import Database from 'better-sqlite3';

// Re-export the Database type so callers don't need to import better-sqlite3 directly.
export type { Database };

// ─── Connection helpers ───────────────────────────────────────────────────────

/**
 * Opens the knowledge-base database at `path` in read-only mode.
 * Foreign-key enforcement is enabled for consistency.
 */
export function openReadOnly(path: string): Database.Database {
  const db = new Database(path, { readonly: true });
  db.pragma('foreign_keys = ON');

  // Load sqlite-vec extension so vec0 virtual tables (symbol_embeddings) can
  // be queried for semantic / fused search.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sqliteVec = require('sqlite-vec');
    sqliteVec.load(db);
  } catch {
    // sqlite-vec not available — vec0 tables won't be queryable.
  }

  return db;
}

// ─── Symbol helpers ───────────────────────────────────────────────────────────

export interface SymbolRow {
  id: number;
  file_id: number;
  name: string;
  kind: string;
  start_line: number;
  end_line: number;
  signature: string | null;
  doc_comment: string | null;
}

/** Fetch a single symbol by primary key.  Returns `undefined` if not found. */
export function getSymbolById(db: Database.Database, id: number): SymbolRow | undefined {
  return db.prepare('SELECT * FROM symbols WHERE id = ?').get(id) as SymbolRow | undefined;
}

/** Fetch all symbols whose name matches the given string (case-insensitive). */
export function getSymbolsByName(db: Database.Database, name: string): SymbolRow[] {
  return db
    .prepare('SELECT * FROM symbols WHERE name = ? COLLATE NOCASE')
    .all(name) as SymbolRow[];
}

/** Return all symbols, optionally limited to `limit` rows. */
export function listSymbols(db: Database.Database, limit = 100): SymbolRow[] {
  return db.prepare('SELECT * FROM symbols LIMIT ?').all(limit) as SymbolRow[];
}

// ─── File helpers ─────────────────────────────────────────────────────────────

export interface FileRow {
  id: number;
  path: string;
  language: string;
  size_bytes: number;
  last_hash: string | null;
  indexed_at: number;
}

/** Fetch a single file row by primary key. */
export function getFileById(db: Database.Database, id: number): FileRow | undefined {
  return db.prepare('SELECT * FROM files WHERE id = ?').get(id) as FileRow | undefined;
}

/** Fetch a single file row by its path. */
export function getFileByPath(db: Database.Database, path: string): FileRow | undefined {
  return db.prepare('SELECT * FROM files WHERE path = ?').get(path) as FileRow | undefined;
}

/** Return all indexed files, optionally limited to `limit` rows. */
export function listFiles(db: Database.Database, limit = 100): FileRow[] {
  return db.prepare('SELECT * FROM files LIMIT ?').all(limit) as FileRow[];
}
