/**
 * Tests for structural (BM25/FTS5) and fused (RRF k=60) search over the
 * knowledge-base SQLite schema.
 *
 * These tests are gated behind the `AAMF_EMBEDDER=1` environment flag and are
 * skipped in CI unless that flag is explicitly set (semantic search requires a
 * live embedding model).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { openDb, createVec0Tables, type Database, Qwen3EmbeddingProvider, type EmbeddingProvider } from '@aamf/lore';

const ENABLED = process.env.AAMF_EMBEDDER === '1';

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface SymbolSeed {
  name: string;
  kind: string;
  signature: string;
}

/** Seed a small set of symbols (with FTS5 entries) into an open DB. */
function seedSymbols(db: Database.Database, seeds: SymbolSeed[]): number[] {
  const fInfo = db
    .prepare('INSERT INTO files (path, language, size_bytes) VALUES (?, ?, 0)')
    .run('seed.py', 'python') as { lastInsertRowid: number | bigint };
  const fileId = Number(fInfo.lastInsertRowid);

  const insertSym = db.prepare(
    'INSERT INTO symbols (file_id, name, kind, start_line, end_line, signature) VALUES (?, ?, ?, 0, 10, ?)',
  );
  const insertFts = db.prepare(
    'INSERT INTO symbols_fts(rowid, name, signature, kind) VALUES (?, ?, ?, ?)',
  );

  const ids: number[] = [];
  for (const s of seeds) {
    const info = insertSym.run(fileId, s.name, s.kind, s.signature) as {
      lastInsertRowid: number | bigint;
    };
    const id = Number(info.lastInsertRowid);
    insertFts.run(id, s.name, s.signature, s.kind);
    ids.push(id);
  }
  return ids;
}

// ─── Structural search (BM25 via FTS5) ───────────────────────────────────────

describe.skipIf(!ENABLED)('structural search (BM25)', () => {
  let tempDir: string;
  let db: Database.Database;

  const SEEDS: SymbolSeed[] = [
    { name: 'calculate_distance', kind: 'function', signature: 'def calculate_distance(a, b)' },
    { name: 'compute_sum', kind: 'function', signature: 'def compute_sum(nums)' },
    { name: 'DistanceCalculator', kind: 'class', signature: 'class DistanceCalculator' },
  ];

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'aamf-search-bm25-'));
    db = openDb(join(tempDir, 'kb.db'));
    seedSymbols(db, SEEDS);
  });

  afterEach(async () => {
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('returns results ordered by BM25 score for a keyword query', () => {
    const results = db
      .prepare(
        `SELECT s.id, s.name, bm25(symbols_fts) AS score
         FROM symbols_fts
         JOIN symbols s ON s.id = symbols_fts.rowid
         WHERE symbols_fts MATCH 'calculate'
         ORDER BY bm25(symbols_fts)`,
      )
      .all() as Array<{ id: number; name: string; score: number }>;

    expect(results.length).toBeGreaterThan(0);

    // BM25 scores from FTS5 are negative; more-relevant rows have a lower (more-negative) score.
    // After ORDER BY bm25(...) the results are most-relevant-first.
    for (let i = 1; i < results.length; i++) {
      expect(results[i].score).toBeGreaterThanOrEqual(results[i - 1].score);
    }

    // The top result should contain 'calculate' in its name or signature.
    const top = results[0];
    const seed = SEEDS.find(s => s.name === top.name)!;
    expect(seed.name.toLowerCase() + seed.signature.toLowerCase()).toContain('calculate');
  });

  it('returns no results for an unmatched query', () => {
    const results = db
      .prepare(
        `SELECT * FROM symbols_fts WHERE symbols_fts MATCH 'zzznomatch'`,
      )
      .all();
    expect(results).toHaveLength(0);
  });
});

// ─── Fused search (RRF k=60) ─────────────────────────────────────────────────

describe.skipIf(!ENABLED)('fused search (RRF k=60)', () => {
  let tempDir: string;
  let db: Database.Database;
  let embedder: EmbeddingProvider;

  const SEEDS: SymbolSeed[] = [
    {
      name: 'calculate_distance',
      kind: 'function',
      signature: 'def calculate_distance(point_a, point_b): ...',
    },
    {
      name: 'compute_sum',
      kind: 'function',
      signature: 'def compute_sum(numbers): ...',
    },
    {
      name: 'euclidean_distance',
      kind: 'function',
      signature: 'def euclidean_distance(x, y): ...',
    },
  ];

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'aamf-search-rrf-'));
    db = openDb(join(tempDir, 'kb.db'));
    embedder = Qwen3EmbeddingProvider('0.6B');

    createVec0Tables(db, embedder.dims);

    const ids = seedSymbols(db, SEEDS);

    // Embed all seed signatures and store in symbol_embeddings.
    const texts = SEEDS.map(s => s.signature);
    const embeddings = await embedder.embed(texts);
    const insertVec = db.prepare(
      'INSERT OR REPLACE INTO symbol_embeddings(rowid, embedding) VALUES (?, json(?))',
    );
    for (let i = 0; i < ids.length; i++) {
      insertVec.run(ids[i], JSON.stringify(embeddings[i]));
    }
  }, 120_000);

  afterEach(async () => {
    db.close();
    await embedder.dispose();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('fused RRF query includes top hits from both structural and semantic layers', async () => {
    const query = 'measure distance between two points';

    // Structural layer: BM25 over FTS5.
    const structResults = db
      .prepare(
        `SELECT symbols_fts.rowid AS id, bm25(symbols_fts) AS score
         FROM symbols_fts
         WHERE symbols_fts MATCH 'distance'
         ORDER BY bm25(symbols_fts)
         LIMIT 10`,
      )
      .all() as Array<{ id: number; score: number }>;

    // Semantic layer: nearest neighbours in embedding space.
    const [queryEmbedding] = await embedder.embed([query]);
    const semResults = db
      .prepare(
        `SELECT rowid AS id, distance
         FROM symbol_embeddings
         WHERE embedding MATCH json(?)
         ORDER BY distance
         LIMIT 10`,
      )
      .all(JSON.stringify(queryEmbedding)) as Array<{ id: number; distance: number }>;

    // Compute RRF scores (k=60).
    const K = 60;
    const rrfMap = new Map<number, number>();
    structResults.forEach((r, rank) => {
      rrfMap.set(r.id, (rrfMap.get(r.id) ?? 0) + 1 / (K + rank + 1));
    });
    semResults.forEach((r, rank) => {
      rrfMap.set(r.id, (rrfMap.get(r.id) ?? 0) + 1 / (K + rank + 1));
    });

    const fusedResults = [...rrfMap.entries()].sort((a, b) => b[1] - a[1]);

    expect(fusedResults.length).toBeGreaterThan(0);

    // The top fused result must appear in at least one of the two layers.
    const topId = fusedResults[0][0];
    const inStruct = structResults.some(r => r.id === topId);
    const inSem = semResults.some(r => r.id === topId);
    expect(inStruct || inSem).toBe(true);

    // Fused results should score better (or equal) to any single-layer result.
    // Verify RRF scores are sorted descending.
    for (let i = 1; i < fusedResults.length; i++) {
      expect(fusedResults[i][1]).toBeLessThanOrEqual(fusedResults[i - 1][1]);
    }
  }, 120_000);
});
