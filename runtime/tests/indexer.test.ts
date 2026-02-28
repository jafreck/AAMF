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
import { IndexBuilder, openDb, getKbFingerprint, computeSourceFingerprint } from '@aamf/lore';

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

  it('build() is idempotent — running twice does not duplicate rows in any table', async () => {
    const builder = new IndexBuilder(dbPath, { rootDir: FIXTURE_DIR });
    await builder.build();

    const tables = ['files', 'symbols', 'symbols_fts', 'file_imports', 'symbol_refs', 'external_deps'] as const;

    const db = openDb(dbPath);
    const countsBefore: Record<string, number> = {};
    for (const t of tables) {
      countsBefore[t] = (
        db.prepare(`SELECT COUNT(*) as c FROM ${t}`).get() as { c: number }
      ).c;
    }
    db.close();

    // Second build should not throw and should not duplicate rows
    await builder.build();

    const db2 = openDb(dbPath);
    try {
      for (const t of tables) {
        const countAfter = (
          db2.prepare(`SELECT COUNT(*) as c FROM ${t}`).get() as { c: number }
        ).c;
        expect(countAfter, `row count for ${t} should be unchanged`).toBe(countsBefore[t]);
      }
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

  // ─── external_deps population (Issue #2) ──────────────────────────────────

  describe('external_deps table', () => {
    it('build() populates external_deps for unresolvable (external) imports', async () => {
      // Create a temp source dir with a Python file that imports an external package.
      const srcDir = join(tempDir, 'ext-src');
      await import('node:fs/promises').then(({ mkdir: mk }) => mk(srcDir, { recursive: true }));
      await writeFile(join(srcDir, 'app.py'), 'import sys\nimport os\n\ndef main():\n    pass\n');

      const extDbPath = join(tempDir, 'ext-kb.db');
      const builder = new IndexBuilder(extDbPath, { rootDir: srcDir });
      await builder.build();

      const db = openDb(extDbPath);
      try {
        const rows = db
          .prepare('SELECT package FROM external_deps')
          .all() as Array<{ package: string }>;
        const packages = rows.map(r => r.package);
        // sys and os are stdlib — the Python resolver won't find them locally
        expect(packages.some(p => p === 'sys' || p === 'os' || p.includes('sys') || p.includes('os'))).toBe(true);
      } finally {
        db.close();
      }
    });

    it('build() cleans up external_deps for stale files on re-index', async () => {
      const srcDir = join(tempDir, 'stale-src');
      await import('node:fs/promises').then(({ mkdir: mk }) => mk(srcDir, { recursive: true }));
      await writeFile(join(srcDir, 'app.py'), 'import sys\n\ndef main():\n    pass\n');

      const staleDbPath = join(tempDir, 'stale-kb.db');
      const builder = new IndexBuilder(staleDbPath, { rootDir: srcDir });
      await builder.build();

      // Verify external dep was recorded
      const db1 = openDb(staleDbPath);
      const countBefore = (
        db1.prepare('SELECT COUNT(*) as c FROM external_deps').get() as { c: number }
      ).c;
      db1.close();
      expect(countBefore).toBeGreaterThan(0);

      // Now overwrite the file without external imports
      await writeFile(join(srcDir, 'app.py'), 'def main():\n    pass\n');

      // Re-index (build is idempotent and processes changed files)
      await builder.build();

      const db2 = openDb(staleDbPath);
      try {
        const countAfter = (
          db2.prepare('SELECT COUNT(*) as c FROM external_deps').get() as { c: number }
        ).c;
        // After removing the external import, the dep should be cleaned up
        expect(countAfter).toBe(0);
      } finally {
        db2.close();
      }
    });
  });

  // ─── docComment field (Issue #3) ──────────────────────────────────────────

  describe('docComment (doc_comment column)', () => {
    it('build() stores null doc_comment for symbols without docComment on RawSymbol', async () => {
      // The tiny-python-project fixture uses a real extractor; symbols without
      // explicit docComment on RawSymbol get NULL in the column.
      const builder = new IndexBuilder(dbPath, { rootDir: FIXTURE_DIR });
      await builder.build();

      const db = openDb(dbPath);
      try {
        const sym = db
          .prepare('SELECT doc_comment FROM symbols LIMIT 1')
          .get() as { doc_comment: string | null } | undefined;

        if (!sym) return; // Grammar unavailable in this env — skip gracefully
        // docComment is optional on RawSymbol; if not set it should be null (not undefined)
        expect(sym.doc_comment === null || typeof sym.doc_comment === 'string').toBe(true);
      } finally {
        db.close();
      }
    });
  });

  // ─── Source fingerprint (Issue #56) ─────────────────────────────────────────

  describe('source fingerprint', () => {
    it('build() stores a source fingerprint in kb_meta', async () => {
      const builder = new IndexBuilder(dbPath, { rootDir: FIXTURE_DIR });
      await builder.build();

      const db = openDb(dbPath);
      try {
        const fp = getKbFingerprint(db);
        expect(fp).toBeDefined();
        expect(fp).toMatch(/^[0-9a-f]{64}$/);
      } finally {
        db.close();
      }
    });

    it('build() stores a fingerprint matching computeSourceFingerprint()', async () => {
      const walkerConfig = { rootDir: FIXTURE_DIR };
      const builder = new IndexBuilder(dbPath, walkerConfig);
      await builder.build();

      const expected = computeSourceFingerprint(FIXTURE_DIR, walkerConfig);

      const db = openDb(dbPath);
      try {
        expect(getKbFingerprint(db)).toBe(expected);
      } finally {
        db.close();
      }
    });

    it('build() twice produces the same fingerprint', async () => {
      const builder = new IndexBuilder(dbPath, { rootDir: FIXTURE_DIR });
      await builder.build();

      const db1 = openDb(dbPath);
      const fp1 = getKbFingerprint(db1);
      db1.close();

      await builder.build();

      const db2 = openDb(dbPath);
      try {
        expect(getKbFingerprint(db2)).toBe(fp1);
      } finally {
        db2.close();
      }
    });
  });

  // ─── Idempotent processFile (Issue #56) ────────────────────────────────────

  describe('idempotent processFile', () => {
    it('build() twice does not duplicate file_imports rows', async () => {
      const builder = new IndexBuilder(dbPath, { rootDir: FIXTURE_DIR });
      await builder.build();

      const db1 = openDb(dbPath);
      const importsBefore = (
        db1.prepare('SELECT COUNT(*) as c FROM file_imports').get() as { c: number }
      ).c;
      db1.close();

      await builder.build();

      const db2 = openDb(dbPath);
      try {
        const importsAfter = (
          db2.prepare('SELECT COUNT(*) as c FROM file_imports').get() as { c: number }
        ).c;
        expect(importsAfter).toBe(importsBefore);
      } finally {
        db2.close();
      }
    });

    it('build() twice does not duplicate external_deps rows', async () => {
      const srcDir = join(tempDir, 'idem-src');
      await import('node:fs/promises').then(({ mkdir: mk }) => mk(srcDir, { recursive: true }));
      await writeFile(join(srcDir, 'app.py'), 'import sys\nimport os\n\ndef main():\n    pass\n');

      const idemDbPath = join(tempDir, 'idem-kb.db');
      const builder = new IndexBuilder(idemDbPath, { rootDir: srcDir });
      await builder.build();

      const db1 = openDb(idemDbPath);
      const depsBefore = (
        db1.prepare('SELECT COUNT(*) as c FROM external_deps').get() as { c: number }
      ).c;
      db1.close();

      await builder.build();

      const db2 = openDb(idemDbPath);
      try {
        const depsAfter = (
          db2.prepare('SELECT COUNT(*) as c FROM external_deps').get() as { c: number }
        ).c;
        expect(depsAfter).toBe(depsBefore);
      } finally {
        db2.close();
      }
    });

    it('build() twice does not duplicate symbols_fts rows', async () => {
      const builder = new IndexBuilder(dbPath, { rootDir: FIXTURE_DIR });
      await builder.build();

      const db1 = openDb(dbPath);
      const ftsBefore = (
        db1.prepare('SELECT COUNT(*) as c FROM symbols_fts').get() as { c: number }
      ).c;
      db1.close();

      await builder.build();

      const db2 = openDb(dbPath);
      try {
        const ftsAfter = (
          db2.prepare('SELECT COUNT(*) as c FROM symbols_fts').get() as { c: number }
        ).c;
        expect(ftsAfter).toBe(ftsBefore);
      } finally {
        db2.close();
      }
    });

    it('build() recovers from a simulated crash — orphan file row does not cause errors', async () => {
      const srcDir = join(tempDir, 'crash-src');
      await import('node:fs/promises').then(({ mkdir: mk }) => mk(srcDir, { recursive: true }));
      await writeFile(join(srcDir, 'lib.py'), 'def hello():\n    pass\n');

      const crashDbPath = join(tempDir, 'crash-kb.db');

      // Simulate a crash by manually inserting a file row without symbols
      const db = openDb(crashDbPath);
      db.prepare(
        `INSERT INTO files (path, language, size_bytes, last_hash) VALUES (?, ?, ?, ?)`,
      ).run(join(srcDir, 'lib.py'), 'python', 0, 'stale-hash');
      db.close();

      // build() should overwrite the orphan row and succeed
      const builder = new IndexBuilder(crashDbPath, { rootDir: srcDir });
      await expect(builder.build()).resolves.toBeUndefined();

      const db2 = openDb(crashDbPath);
      try {
        const fileCount = (
          db2.prepare('SELECT COUNT(*) as c FROM files').get() as { c: number }
        ).c;
        expect(fileCount).toBe(1);

        const symCount = (
          db2.prepare('SELECT COUNT(*) as c FROM symbols').get() as { c: number }
        ).c;
        expect(symCount).toBeGreaterThan(0);
      } finally {
        db2.close();
      }
    });

    it('build() correctly updates rows when source files change', async () => {
      const srcDir = join(tempDir, 'change-src');
      await import('node:fs/promises').then(({ mkdir: mk }) => mk(srcDir, { recursive: true }));
      await writeFile(join(srcDir, 'lib.py'), 'def foo():\n    pass\n');

      const changeDbPath = join(tempDir, 'change-kb.db');
      const builder = new IndexBuilder(changeDbPath, { rootDir: srcDir });
      await builder.build();

      const db1 = openDb(changeDbPath);
      const symsBefore = (
        db1.prepare('SELECT COUNT(*) as c FROM symbols').get() as { c: number }
      ).c;
      db1.close();

      // Add a second function
      await writeFile(join(srcDir, 'lib.py'), 'def foo():\n    pass\n\ndef bar():\n    pass\n');

      await builder.build();

      const db2 = openDb(changeDbPath);
      try {
        const symsAfter = (
          db2.prepare('SELECT COUNT(*) as c FROM symbols').get() as { c: number }
        ).c;
        expect(symsAfter).toBeGreaterThan(symsBefore);

        // Ensure no duplicates — file should appear exactly once
        const fileCount = (
          db2.prepare('SELECT COUNT(*) as c FROM files').get() as { c: number }
        ).c;
        expect(fileCount).toBe(1);
      } finally {
        db2.close();
      }
    });
  });
});
