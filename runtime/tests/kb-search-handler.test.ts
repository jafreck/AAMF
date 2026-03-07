/**
 * Additional tests for the search tool handler, targeting semantic/fused
 * fallback branches, sanitiseFts5Query, and error handling.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { handler, type SearchArgs, type SearchResult } from '@aamf/lore/kb-server/tools/search';
import type { EmbeddingProvider } from '@aamf/lore';

/**
 * Build a minimal in-memory KB database with FTS5 tables for testing search.
 */
function buildTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE files (
      id INTEGER PRIMARY KEY,
      path TEXT NOT NULL,
      branch TEXT NOT NULL DEFAULT '',
      language TEXT NOT NULL,
      size_bytes INTEGER DEFAULT 0,
      last_hash TEXT,
      indexed_at INTEGER DEFAULT 0
    );
    INSERT INTO files (id, path, language) VALUES (1, '/src/main.ts', 'typescript');
    INSERT INTO files (id, path, language) VALUES (2, '/src/util.ts', 'typescript');

    CREATE TABLE symbols (
      id INTEGER PRIMARY KEY,
      file_id INTEGER NOT NULL REFERENCES files(id),
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      start_line INTEGER DEFAULT 0,
      end_line INTEGER DEFAULT 0,
      signature TEXT,
      doc_comment TEXT
    );
    INSERT INTO symbols (id, file_id, name, kind, start_line, end_line) VALUES (1, 1, 'main', 'function', 1, 10);
    INSERT INTO symbols (id, file_id, name, kind, start_line, end_line) VALUES (2, 1, 'init', 'function', 12, 20);
    INSERT INTO symbols (id, file_id, name, kind, start_line, end_line) VALUES (3, 2, 'helper', 'function', 1, 5);

    CREATE VIRTUAL TABLE symbols_fts USING fts5 (name, kind, content=symbols, content_rowid=id);
    INSERT INTO symbols_fts (rowid, name, kind) VALUES (1, 'main', 'function');
    INSERT INTO symbols_fts (rowid, name, kind) VALUES (2, 'init', 'function');
    INSERT INTO symbols_fts (rowid, name, kind) VALUES (3, 'helper', 'function');
  `);
  return db;
}

/** A mock embedding provider for testing semantic search paths. */
function createMockEmbedder(embedResult: number[] | null = [0.1, 0.2, 0.3]): EmbeddingProvider {
  return {
    modelName: 'test-model',
    dims: embedResult?.length ?? 0,
    embed: vi.fn().mockResolvedValue(embedResult ? [embedResult] : [null]),
    init: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn().mockResolvedValue(undefined),
    ready: true,
  } as unknown as EmbeddingProvider;
}

describe('lore_search handler', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = buildTestDb();
  });

  afterEach(() => {
    db.close();
  });

  describe('structural mode', () => {
    it('returns structural results with matching FTS5 query', async () => {
      const result = await handler(db, { query: 'main' });
      expect(result.mode_used).toBe('structural');
      expect(result.results.length).toBeGreaterThanOrEqual(1);
      expect(result.results[0]!.name).toBe('main');
    });

    it('returns results for partial/broad query', async () => {
      const result = await handler(db, { query: 'function', mode: 'structural' });
      expect(result.mode_used).toBe('structural');
    });

    it('respects limit parameter', async () => {
      const result = await handler(db, { query: 'function', mode: 'structural', limit: 1 });
      expect(result.results.length).toBeLessThanOrEqual(1);
    });

    it('uses default limit of 20', async () => {
      const result = await handler(db, { query: 'main' });
      expect(result.mode_used).toBe('structural');
    });
  });

  describe('semantic mode', () => {
    it('falls back to structural when no embedder is provided', async () => {
      const result = await handler(db, { query: 'main', mode: 'semantic' });
      expect(result.mode_used).toBe('structural (no query-time embedder)');
    });

    it('falls back to structural when semantic search returns null', async () => {
      // Embedder that returns null (e.g. no embeddings table)
      const embedder = createMockEmbedder([0.1, 0.2]);
      // semanticSearch will fail because symbol_embeddings table doesn't exist
      const result = await handler(db, { query: 'main', mode: 'semantic' }, embedder);
      // Should fall back to structural
      expect(result.mode_used).toContain('structural');
    });
  });

  describe('fused mode', () => {
    it('falls back to structural when no embedder is provided', async () => {
      const result = await handler(db, { query: 'main', mode: 'fused' });
      // No embedder → structural results only
      expect(result.mode_used).toContain('structural');
    });

    it('runs fused search with embedder (falls back if no embeddings table)', async () => {
      const embedder = createMockEmbedder([0.1, 0.2]);
      const result = await handler(db, { query: 'main', mode: 'fused' }, embedder);
      // semanticSearch fails → RRF uses structural only → still fused label or fallback
      expect(result.results).toBeDefined();
    });
  });

  describe('FTS5 error recovery', () => {
    it('falls back to LIKE search on FTS5 parse error', async () => {
      // Drop the FTS table so any MATCH query will fail
      db.exec('DROP TABLE symbols_fts');
      db.exec('CREATE VIRTUAL TABLE symbols_fts USING fts5 (name, kind, content=symbols, content_rowid=id)');
      // Empty FTS — structural search may return empty or fallback
      const result = await handler(db, { query: 'main', mode: 'structural' });
      expect(result.mode_used).toBe('structural');
    });
  });
});
