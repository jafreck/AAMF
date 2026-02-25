/**
 * @module indexer/db
 *
 * Opens (or creates) a SQLite knowledge-base database and ensures all
 * required tables exist.  Vector embedding tables (vec0 virtual tables)
 * are created in a later milestone once the embedding dimensions are known.
 */

import Database from 'better-sqlite3';

// Re-export the Database type so callers don't need to import better-sqlite3.
export type { Database };

// ─── DDL ─────────────────────────────────────────────────────────────────────

const DDL = `
-- Indexed source files.
CREATE TABLE IF NOT EXISTS files (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  path        TEXT    NOT NULL UNIQUE,
  language    TEXT    NOT NULL,
  size_bytes  INTEGER NOT NULL DEFAULT 0,
  last_hash   TEXT,
  indexed_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Named symbols extracted from source files.
CREATE TABLE IF NOT EXISTS symbols (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  name        TEXT    NOT NULL,
  kind        TEXT    NOT NULL,
  start_line  INTEGER NOT NULL,
  end_line    INTEGER NOT NULL,
  signature   TEXT,
  doc_comment TEXT
);

-- Import / use declarations found in source files.
CREATE TABLE IF NOT EXISTS file_imports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  raw_import  TEXT    NOT NULL,
  resolved_id INTEGER REFERENCES files(id)
);

-- Call-site references from one symbol to another.
CREATE TABLE IF NOT EXISTS symbol_refs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  caller_id   INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  callee_id   INTEGER REFERENCES symbols(id),
  callee_name TEXT    NOT NULL,
  call_line   INTEGER NOT NULL
);

-- External (third-party / stdlib) dependencies inferred from imports.
CREATE TABLE IF NOT EXISTS external_deps (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  package     TEXT    NOT NULL,
  version     TEXT
);

-- Logical modules grouping related files (e.g. Rust crates, Python packages).
CREATE TABLE IF NOT EXISTS modules (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL UNIQUE,
  kind        TEXT    NOT NULL,
  manifest    TEXT
);

-- Many-to-many mapping between files and modules.
CREATE TABLE IF NOT EXISTS file_modules (
  file_id   INTEGER NOT NULL REFERENCES files(id)   ON DELETE CASCADE,
  module_id INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  PRIMARY KEY (file_id, module_id)
);

-- LLM-generated natural-language summaries for symbols.
CREATE TABLE IF NOT EXISTS symbol_summaries (
  symbol_id INTEGER PRIMARY KEY REFERENCES symbols(id) ON DELETE CASCADE,
  summary   TEXT    NOT NULL,
  model     TEXT    NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Key-value store for knowledge-base metadata (schema version, embedding model, etc.).
CREATE TABLE IF NOT EXISTS kb_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Opens (or creates) the SQLite database at `path` and initialises the schema.
 *
 * The returned `Database` instance is opened with WAL mode enabled for
 * better concurrent read performance.
 */
export function openDb(path: string): Database.Database {
  const db = new Database(path);

  // WAL mode: readers don't block writers, writers don't block readers.
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Create all tables in a single transaction.
  db.exec(DDL);

  return db;
}
