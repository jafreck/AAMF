/**
 * Tests for the KB MCP server tool handlers.
 *
 * Uses a SQLite database seeded via IndexBuilder for the schema, then
 * manually injects symbols and FTS data so the tests are self-contained
 * and deterministic regardless of tree-sitter grammar availability.
 *
 * All tool handler functions are exercised directly (without going through
 * the MCP stdio transport) to keep the tests fast and reliable.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join, resolve } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { IndexBuilder, openDb, openReadOnly } from '@aamf/lore';
import type { Database } from '@aamf/lore';
import { handler as lookupHandler } from '@aamf/lore/lore-server/tools/lookup';
import { handler as graphHandler } from '@aamf/lore/lore-server/tools/graph';
import { handler as searchHandler } from '@aamf/lore/lore-server/tools/search';
import { handler as snippetHandler } from '@aamf/lore/lore-server/tools/snippet';
import { handler as metricsHandler } from '@aamf/lore/lore-server/tools/metrics';
import { handler as writebackHandler } from '@aamf/lore/lore-server/tools/writeback';

// ─── Fixture setup ────────────────────────────────────────────────────────────

/**
 * Use the tiny-python-project fixture for files and source text, then
 * ensure at least one symbol row exists so all handler tests are exercised.
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

  // Build the index from the fixture so files and schema are populated.
  const builder = new IndexBuilder(dbPath, { rootDir: FIXTURE_DIR });
  await builder.build();

  // Ensure at least one symbol exists — if tree-sitter grammars failed to
  // extract symbols (e.g. ABI mismatch on a non-standard Node version),
  // manually insert a synthetic symbol so handler tests are deterministic.
  const rwDb = openDb(dbPath);
  const symCount = (rwDb.prepare('SELECT COUNT(*) AS n FROM symbols').get() as { n: number }).n;
  if (symCount === 0) {
    const fileRow = rwDb.prepare('SELECT id FROM files LIMIT 1').get() as { id: number } | undefined;
    if (fileRow) {
      rwDb.prepare(
        `INSERT INTO symbols (file_id, name, kind, start_line, end_line)
         VALUES (?, 'Calculator', 'class', 1, 20)`,
      ).run(fileRow.id);
      // Populate FTS so structural search finds the symbol.
      const symId = (rwDb.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id;
      try {
        rwDb.prepare(
          `INSERT INTO symbols_fts (rowid, name, kind) VALUES (?, 'Calculator', 'class')`,
        ).run(symId);
      } catch {
        // FTS table may not exist in all Lore versions — non-fatal.
      }
    }
  }
  rwDb.close();

  db = openReadOnly(dbPath);
}, 60_000 /* allow up to 60 s for the build */);

afterAll(async () => {
  db?.close();
  await rm(tempDir, { recursive: true, force: true });
});

// ─── lore_lookup ────────────────────────────────────────────────────────────────

describe('lookup handler', () => {
  it('returns an array result for kind="symbol" with a known name', async () => {
    const result = await lookupHandler(db, { kind: 'symbol', query: 'Calculator' });
    expect(result).toHaveProperty('results');
    expect(Array.isArray(result.results)).toBe(true);
    expect(result.results.length).toBeGreaterThan(0);
  });

  it('returns an empty array for an unknown symbol', async () => {
    const result = await lookupHandler(db, { kind: 'symbol', query: '__nonexistent_xyz__' });
    expect(result.results).toHaveLength(0);
  });

  it('returns file rows for kind="file" with an empty query', async () => {
    const result = await lookupHandler(db, { kind: 'file', query: '' });
    expect(Array.isArray(result.results)).toBe(true);
    // Should have at least one file (the fixture has 5 .py files).
    expect(result.results.length).toBeGreaterThan(0);
  });
});

// ─── lore_graph ─────────────────────────────────────────────────────────────────

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

// ─── lore_search ────────────────────────────────────────────────────────────────

describe('search handler', () => {
  it('mode="structural" returns results for a known symbol name', async () => {
    const result = await searchHandler(db, { query: 'Calculator', mode: 'structural' });
    expect(result).toHaveProperty('results');
    expect(result).toHaveProperty('mode_used');
    expect(Array.isArray(result.results)).toBe(true);
    expect(result.results.length).toBeGreaterThan(0);
  });

  it('mode defaults to structural', async () => {
    const result = await searchHandler(db, { query: 'Calculator' });
    expect(result.mode_used).toContain('structural');
  });

  it('mode="semantic" falls back when no embedder is provided', async () => {
    const result = await searchHandler(db, { query: 'Calculator', mode: 'semantic' });
    // Without an embedder the mode_used should indicate the degradation.
    expect(result.mode_used).toContain('structural');
  });

  it('mode="fused" returns results', async () => {
    const result = await searchHandler(db, { query: 'Calculator', mode: 'fused' });
    expect(Array.isArray(result.results)).toBe(true);
  });
});

// ─── lore_snippet ───────────────────────────────────────────────────────────────

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

// ─── lore_metrics ───────────────────────────────────────────────────────────────

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

// ─── lore_writeback ─────────────────────────────────────────────────────────────

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
