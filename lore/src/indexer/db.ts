/**
 * @module indexer/db
 *
 * Opens (or creates) a SQLite knowledge-base database and ensures all
 * required tables exist.  Vector embedding tables (vec0 virtual tables)
 * are created separately via `createVec0Tables()` once the embedding
 * dimensions are known.
 */

import Database from 'better-sqlite3';
import * as crypto from 'node:crypto';
import { createRequire } from 'node:module';

const esmRequire = createRequire(import.meta.url);

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
  version     TEXT,
  UNIQUE(file_id, package)
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

-- Full-text search index over symbol names, signatures, and kinds (BM25 via FTS5).
CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(
  name, signature, kind
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

// ─── kb_meta helpers ──────────────────────────────────────────────────────────

/** Write (or overwrite) a key-value pair in `kb_meta`. */
export function setKbMeta(db: Database.Database, key: string, value: string): void {
  db.prepare('INSERT OR REPLACE INTO kb_meta (key, value) VALUES (?, ?)').run(key, value);
}

/** Read a value from `kb_meta`; returns `undefined` if the key is absent. */
export function getKbMeta(db: Database.Database, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM kb_meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

// ─── Source fingerprint helpers ───────────────────────────────────────────────

/**
 * Computes a SHA-256 fingerprint from the source root, walker globs, and
 * optional embedding model name.  Used to detect whether a KB was built from
 * the same configuration as the current run.
 */
export function computeSourceFingerprint(
  rootDir: string,
  walkerConfig: { includeGlobs?: string[]; excludeGlobs?: string[] },
  embeddingModel?: string,
): string {
  const data = JSON.stringify({
    rootDir,
    includeGlobs: walkerConfig.includeGlobs ?? [],
    excludeGlobs: walkerConfig.excludeGlobs ?? [],
    embeddingModel: embeddingModel ?? '',
  });
  return crypto.createHash('sha256').update(data).digest('hex');
}

const SOURCE_FINGERPRINT_KEY = 'source_fingerprint';

/** Read the stored source fingerprint from `kb_meta`, or `undefined` if absent. */
export function getKbFingerprint(db: Database.Database): string | undefined {
  return getKbMeta(db, SOURCE_FINGERPRINT_KEY);
}

/** Write (or overwrite) the source fingerprint in `kb_meta`. */
export function setKbFingerprint(db: Database.Database, fingerprint: string): void {
  setKbMeta(db, SOURCE_FINGERPRINT_KEY, fingerprint);
}

// ─── Vec0 virtual tables ──────────────────────────────────────────────────────

/**
 * Loads the sqlite-vec extension and creates the `symbol_embeddings` and
 * `symbol_semantic_embeddings` vec0 virtual tables with the given dimension.
 * Also stores `embedding_dims` in `kb_meta` for validation on reopen.
 *
 * This function is idempotent: it is safe to call multiple times with the
 * same `dims` value.
 *
 * @param db   An open better-sqlite3 database instance.
 * @param dims Embedding dimensionality (e.g. 1024 for Qwen3-Embedding-0.6B).
 */
export function createVec0Tables(db: Database.Database, dims: number): void {
  // Load the sqlite-vec native extension.
  // Use createRequire for ESM compatibility (native addons cannot be loaded via import()).
  const sqliteVec = esmRequire('sqlite-vec') as { load(db: Database.Database): void };
  sqliteVec.load(db);

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS symbol_embeddings USING vec0(
      embedding FLOAT[${dims}]
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS symbol_semantic_embeddings USING vec0(
      embedding FLOAT[${dims}]
    );
  `);

  setKbMeta(db, 'embedding_dims', String(dims));
}
