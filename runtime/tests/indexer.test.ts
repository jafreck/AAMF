/**
 * Tests for IndexBuilder.
 *
 * Uses the `tiny-python-project` fixture which has real Python source files,
 * allowing the indexer to walk, parse, extract, and persist rows without
 * external network access.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join, resolve } from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { IndexBuilder } from '../src/indexer/index.js';
import { openDb } from '../src/indexer/db.js';

const FIXTURE_DIR = resolve(
  import.meta.dirname ?? new URL('.', import.meta.url).pathname,
  'fixtures/tiny-python-project',
);

describe('IndexBuilder', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'aamf-indexer-test-'));
    dbPath = join(tempDir, 'kb.db');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // ─── Constructor ──────────────────────────────────────────────────────────

  it('should instantiate without error', () => {
    const builder = new IndexBuilder(dbPath, { rootDir: FIXTURE_DIR });
    expect(builder).toBeDefined();
  });

  // ─── build() ──────────────────────────────────────────────────────────────

  it('build() populates the files table', async () => {
    const builder = new IndexBuilder(dbPath, { rootDir: FIXTURE_DIR });
    await builder.build();

    const db = openDb(dbPath);
    try {
      const count = (
        db.prepare('SELECT COUNT(*) as c FROM files').get() as { c: number }
      ).c;
      expect(count).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it('build() populates the symbols table with at least one row', async () => {
    const builder = new IndexBuilder(dbPath, { rootDir: FIXTURE_DIR });
    await builder.build();

    const db = openDb(dbPath);
    try {
      const count = (
        db.prepare('SELECT COUNT(*) as c FROM symbols').get() as { c: number }
      ).c;
      expect(count).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it('build() satisfies import edge consistency: all target_file_id values exist in files', async () => {
    const builder = new IndexBuilder(dbPath, { rootDir: FIXTURE_DIR });
    await builder.build();

    const db = openDb(dbPath);
    try {
      // Find any file_imports row where resolved_id points to a non-existent file
      const broken = db
        .prepare(
          `SELECT COUNT(*) as c
           FROM file_imports fi
           WHERE fi.resolved_id IS NOT NULL
             AND NOT EXISTS (
               SELECT 1 FROM files f WHERE f.id = fi.resolved_id
             )`,
        )
        .get() as { c: number };

      expect(broken.c).toBe(0);
    } finally {
      db.close();
    }
  });

  it('build() is idempotent — running twice does not duplicate rows', async () => {
    const builder = new IndexBuilder(dbPath, { rootDir: FIXTURE_DIR });
    await builder.build();

    const db = openDb(dbPath);
    const countAfterFirst = (
      db.prepare('SELECT COUNT(*) as c FROM symbols').get() as { c: number }
    ).c;
    db.close();

    await builder.build();

    const db2 = openDb(dbPath);
    try {
      const countAfterSecond = (
        db2.prepare('SELECT COUNT(*) as c FROM symbols').get() as { c: number }
      ).c;
      expect(countAfterSecond).toBe(countAfterFirst);
    } finally {
      db2.close();
    }
  });

  // ─── update() ─────────────────────────────────────────────────────────────

  it('update() re-processes a changed file', async () => {
    const builder = new IndexBuilder(dbPath, { rootDir: FIXTURE_DIR });
    await builder.build();

    const db = openDb(dbPath);
    const symbolsBefore = (
      db.prepare('SELECT COUNT(*) as c FROM symbols').get() as { c: number }
    ).c;
    db.close();

    // Modify one of the fixture files to add a new function (in temp copy)
    const tempSrc = join(tempDir, 'src');
    await rm(tempSrc, { recursive: true, force: true }).catch(() => undefined);

    // Build in a temp directory copy so we can mutate safely
    const { cp } = await import('node:fs/promises');
    await cp(FIXTURE_DIR, tempSrc, { recursive: true });

    const tempDbPath = join(tempDir, 'kb2.db');
    const builder2 = new IndexBuilder(tempDbPath, { rootDir: tempSrc });
    await builder2.build();

    // Add a new function to calculator.py
    const calcPath = join(tempSrc, 'calculator.py');
    const { readFile } = await import('node:fs/promises');
    const original = await readFile(calcPath, 'utf8');
    await writeFile(calcPath, original + '\ndef extra_function():\n    pass\n');

    await builder2.update([calcPath]);

    const db2 = openDb(tempDbPath);
    try {
      const symbolsAfter = (
        db2.prepare('SELECT COUNT(*) as c FROM symbols').get() as { c: number }
      ).c;
      // Should have more symbols now (the new function was added)
      expect(symbolsAfter).toBeGreaterThan(symbolsBefore);
    } finally {
      db2.close();
    }
  });

  it('update() with a non-existent file removes it from the DB', async () => {
    // Build from a temp dir copy so we can delete files
    const tempSrc = join(tempDir, 'src-del');
    const { cp } = await import('node:fs/promises');
    await cp(FIXTURE_DIR, tempSrc, { recursive: true });

    const tempDbPath = join(tempDir, 'kb-del.db');
    const builder = new IndexBuilder(tempDbPath, { rootDir: tempSrc });
    await builder.build();

    const db = openDb(tempDbPath);
    const row = db.prepare("SELECT id FROM files WHERE path LIKE '%constants.py'").get() as
      | { id: number }
      | undefined;
    db.close();

    if (!row) return; // Grammar not available — skip

    const constantsPath = join(tempSrc, 'constants.py');
    await rm(constantsPath);

    await builder.update([constantsPath]);

    const db2 = openDb(tempDbPath);
    try {
      const stillExists = db2
        .prepare('SELECT id FROM files WHERE id = ?')
        .get(row.id) as undefined;
      expect(stillExists).toBeUndefined();
    } finally {
      db2.close();
    }
  });

  // ─── ingestSummary() ──────────────────────────────────────────────────────

  it('ingestSummary() writes a summary row to symbol_summaries', async () => {
    const builder = new IndexBuilder(dbPath, { rootDir: FIXTURE_DIR });
    await builder.build();

    // Find a symbol to annotate
    const db = openDb(dbPath);
    const sym = db.prepare('SELECT id FROM symbols LIMIT 1').get() as
      | { id: number }
      | undefined;
    db.close();

    if (!sym) return; // No symbols extracted — grammar unavailable

    await builder.ingestSummary(sym.id, 'A test summary', 'test-model');

    const db2 = openDb(dbPath);
    try {
      const row = db2
        .prepare('SELECT summary, model FROM symbol_summaries WHERE symbol_id = ?')
        .get(sym.id) as { summary: string; model: string } | undefined;

      expect(row?.summary).toBe('A test summary');
      expect(row?.model).toBe('test-model');
    } finally {
      db2.close();
    }
  });
});
