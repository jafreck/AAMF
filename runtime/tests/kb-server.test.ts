/**
 * Tests for the KB MCP server tool handlers.
 *
 * Uses an in-memory SQLite database seeded via IndexBuilder so that the
 * tests are self-contained and don't require downloading external sources.
 *
 * All tool handler functions are exercised directly (without going through
 * the MCP stdio transport) to keep the tests fast and reliable.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join, resolve } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { IndexBuilder } from '../src/indexer/index.js';
import { openReadOnly } from '../src/kb-server/db.js';
import type { Database } from '../src/kb-server/db.js';
import { handler as lookupHandler } from '../src/kb-server/tools/lookup.js';
import { handler as graphHandler } from '../src/kb-server/tools/graph.js';
import { handler as searchHandler } from '../src/kb-server/tools/search.js';
import { handler as snippetHandler } from '../src/kb-server/tools/snippet.js';
import { handler as metricsHandler } from '../src/kb-server/tools/metrics.js';
import { handler as writebackHandler } from '../src/kb-server/tools/writeback.js';

// ─── Fixture setup ────────────────────────────────────────────────────────────

/**
 * Use the tiny-python-project fixture; it has real Python source files so
 * the indexer can populate the symbols_fts table (needed for structural search).
 */
const FIXTURE_DIR = resolve(
  import.meta.dirname ?? new URL('.', import.meta.url).pathname,
  'fixtures/tiny-python-project',
);

let tempDir: string;
let dbPath: string;
let db: Database.Database;

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'aamf-kb-server-test-'));
  dbPath = join(tempDir, 'kb.db');

  // Build the index from the fixture so all tables are populated.
  const builder = new IndexBuilder(dbPath, { rootDir: FIXTURE_DIR });
  await builder.build();

  db = openReadOnly(dbPath);
}, 60_000 /* allow up to 60 s for the build */);

afterAll(async () => {
  db?.close();
  await rm(tempDir, { recursive: true, force: true });
});

// ─── kb_lookup ────────────────────────────────────────────────────────────────

describe('lookup handler', () => {
  it('returns an array result for kind="symbol" with a known name', () => {
    const result = lookupHandler(db, { kind: 'symbol', query: 'Calculator' });
    expect(result).toHaveProperty('results');
    expect(Array.isArray(result.results)).toBe(true);
    expect(result.results.length).toBeGreaterThan(0);
  });

  it('returns an empty array for an unknown symbol', () => {
    const result = lookupHandler(db, { kind: 'symbol', query: '__nonexistent_xyz__' });
    expect(result.results).toHaveLength(0);
  });

  it('returns file rows for kind="file" with an empty query', () => {
    const result = lookupHandler(db, { kind: 'file', query: '' });
    expect(Array.isArray(result.results)).toBe(true);
    // Should have at least one file (the fixture has 5 .py files).
    expect(result.results.length).toBeGreaterThan(0);
  });
});

// ─── kb_graph ─────────────────────────────────────────────────────────────────

describe('graph handler', () => {
  it('returns an edges array for kind="import"', () => {
    const result = graphHandler(db, { kind: 'import' });
    expect(result).toHaveProperty('edges');
    expect(Array.isArray(result.edges)).toBe(true);
  });

  it('returns an edges array for kind="call"', () => {
    const result = graphHandler(db, { kind: 'call' });
    expect(result).toHaveProperty('edges');
    expect(Array.isArray(result.edges)).toBe(true);
  });

  it('respects the limit option', () => {
    const result = graphHandler(db, { kind: 'import', limit: 1 });
    expect(result.edges.length).toBeLessThanOrEqual(1);
  });
});

// ─── kb_search ────────────────────────────────────────────────────────────────

describe('search handler', () => {
  it('mode="structural" returns results for a known symbol name', () => {
    const result = searchHandler(db, { query: 'Calculator', mode: 'structural' });
    expect(result).toHaveProperty('results');
    expect(result).toHaveProperty('mode_used');
    expect(Array.isArray(result.results)).toBe(true);
    expect(result.results.length).toBeGreaterThan(0);
  });

  it('mode defaults to structural', () => {
    const result = searchHandler(db, { query: 'Calculator' });
    expect(result.mode_used).toContain('structural');
  });

  it('mode="semantic" falls back to structural when no embeddings exist', () => {
    const result = searchHandler(db, { query: 'Calculator', mode: 'semantic' });
    // Without embeddings the mode_used should mention the fallback.
    expect(result.mode_used).toContain('structural');
  });

  it('mode="fused" returns results', () => {
    const result = searchHandler(db, { query: 'Calculator', mode: 'fused' });
    expect(Array.isArray(result.results)).toBe(true);
  });
});

// ─── kb_snippet ───────────────────────────────────────────────────────────────

describe('snippet handler', () => {
  it('returns source text for an indexed file', () => {
    // Pick the first file from the DB.
    const files = db.prepare('SELECT path FROM files LIMIT 1').all() as { path: string }[];
    expect(files.length).toBeGreaterThan(0);
    const filePath = files[0]!.path;

    const result = snippetHandler(db, { path: filePath });
    expect(result).toHaveProperty('text');
    expect(typeof result.text).toBe('string');
    expect(result.text.length).toBeGreaterThan(0);
    expect(result.path).toBe(filePath);
  });

  it('respects start_line and end_line', () => {
    const files = db.prepare('SELECT path FROM files LIMIT 1').all() as { path: string }[];
    const filePath = files[0]!.path;

    const result = snippetHandler(db, { path: filePath, start_line: 1, end_line: 1 });
    // A single line should not contain a newline at the end.
    expect(result.start_line).toBe(1);
    expect(result.end_line).toBe(1);
  });

  it('throws for an unknown file path', () => {
    expect(() =>
      snippetHandler(db, { path: '/does/not/exist.py' }),
    ).toThrow();
  });
});

// ─── kb_metrics ───────────────────────────────────────────────────────────────

describe('metrics handler', () => {
  it('returns symbol_count, file_count, and import_edge_count', () => {
    const result = metricsHandler(db, {});
    expect(result).toHaveProperty('symbol_count');
    expect(result).toHaveProperty('file_count');
    expect(result).toHaveProperty('import_edge_count');
    expect(result.symbol_count).toBeGreaterThan(0);
    expect(result.file_count).toBeGreaterThan(0);
  });
});

// ─── kb_writeback ─────────────────────────────────────────────────────────────

describe('writeback handler', () => {
  it('persists a summary and returns ok=true', () => {
    // Pick a real symbol id from the DB.
    const sym = db.prepare('SELECT id FROM symbols LIMIT 1').get() as { id: number } | undefined;
    expect(sym).toBeDefined();

    const result = writebackHandler(dbPath, {
      symbol_id: sym!.id,
      summary: 'Test summary',
      model: 'test-model',
    });

    expect(result.ok).toBe(true);
    expect(result.symbol_id).toBe(sym!.id);
  });

  it('the written summary can be read back via the read-only handle', () => {
    const sym = db.prepare('SELECT id FROM symbols LIMIT 1').get() as { id: number } | undefined;
    expect(sym).toBeDefined();

    writebackHandler(dbPath, {
      symbol_id: sym!.id,
      summary: 'Persisted summary text',
      model: 'test-model-v2',
    });

    // Re-open the db to pick up the change (the read-only handle caches nothing).
    const row = db
      .prepare('SELECT summary FROM symbol_summaries WHERE symbol_id = ?')
      .get(sym!.id) as { summary: string } | undefined;

    expect(row).toBeDefined();
    expect(row!.summary).toBe('Persisted summary text');
  });
});
