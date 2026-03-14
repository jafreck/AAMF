/**
 * Tests for call-graph utilities: resolveSymbolEdges(), topoSort(), detectCycles().
 *
 * Tests use an in-memory SQLite database (`:memory:`) seeded with controlled
 * data so they don't depend on grammar availability.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join, resolve } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { openDb, type Database, resolveSymbolEdges, topoSort, detectCycles, IndexBuilder } from '@aamf/lore';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Open an in-memory DB with the full schema. */
function memDb(): Database.Database {
  return openDb(':memory:');
}

/** Insert a file row and return its id. */
function insertFile(db: Database.Database, path: string, language = 'c'): number {
  const info = db
    .prepare(
      `INSERT INTO files (path, language, size_bytes) VALUES (?, ?, 0)`,
    )
    .run(path, language) as { lastInsertRowid: number | bigint };
  return Number(info.lastInsertRowid);
}

/** Insert a symbol row and return its id. */
function insertSymbol(db: Database.Database, fileId: number, name: string): number {
  const info = db
    .prepare(
      `INSERT INTO symbols (file_id, name, kind, start_line, end_line)
       VALUES (?, ?, 'function', 0, 10)`,
    )
    .run(fileId, name) as { lastInsertRowid: number | bigint };
  return Number(info.lastInsertRowid);
}

/** Insert an import edge (importer → dep) by file id. */
function insertImport(db: Database.Database, importerId: number, depId: number): void {
  db.prepare(
    `INSERT INTO file_imports (file_id, raw_import, resolved_id) VALUES (?, 'dep', ?)`,
  ).run(importerId, depId);
}

// ─── resolveSymbolEdges() ─────────────────────────────────────────────────────

describe('resolveSymbolEdges', () => {
  it('resolves callee names to symbol ids where possible', () => {
    const db = memDb();

    const fileId = insertFile(db, '/a.c');
    const callerId = insertSymbol(db, fileId, 'caller_fn');
    const calleeId = insertSymbol(db, fileId, 'callee_fn');

    // Insert an unresolved symbol_ref
    db.prepare(
      `INSERT INTO symbol_refs (caller_id, callee_name, call_line) VALUES (?, ?, 1)`,
    ).run(callerId, 'callee_fn');

    resolveSymbolEdges(db);

    const row = db
      .prepare('SELECT callee_id FROM symbol_refs WHERE caller_id = ?')
      .get(callerId) as { callee_id: number | null } | undefined;

    expect(row?.callee_id).toBe(calleeId);
    db.close();
  });

  it('leaves callee_id null when no matching symbol exists', () => {
    const db = memDb();

    const fileId = insertFile(db, '/b.c');
    const callerId = insertSymbol(db, fileId, 'some_fn');

    db.prepare(
      `INSERT INTO symbol_refs (caller_id, callee_name, call_line) VALUES (?, ?, 1)`,
    ).run(callerId, 'nonexistent_fn');

    resolveSymbolEdges(db);

    const row = db
      .prepare('SELECT callee_id FROM symbol_refs WHERE caller_id = ?')
      .get(callerId) as { callee_id: number | null } | undefined;

    expect(row?.callee_id).toBeNull();
    db.close();
  });

  it('does not throw on an empty database', () => {
    const db = memDb();
    expect(() => resolveSymbolEdges(db)).not.toThrow();
    db.close();
  });
});

// ─── topoSort() ───────────────────────────────────────────────────────────────

describe('topoSort', () => {
  it('returns an empty array for an empty files table', () => {
    const db = memDb();
    const result = topoSort(db);
    expect(result).toEqual([]);
    db.close();
  });

  it('returns all file ids when there are no imports', () => {
    const db = memDb();
    const id1 = insertFile(db, '/a.c');
    const id2 = insertFile(db, '/b.c');

    const result = topoSort(db);
    expect(result).toHaveLength(2);
    expect(result).toContain(String(id1));
    expect(result).toContain(String(id2));
    db.close();
  });

  it('places dependency before the importer', () => {
    const db = memDb();

    // a.c imports b.c → b.c should appear before a.c
    const aId = insertFile(db, '/a.c');
    const bId = insertFile(db, '/b.c');
    insertImport(db, aId, bId); // a imports b

    const result = topoSort(db);
    const aPos = result.indexOf(String(aId));
    const bPos = result.indexOf(String(bId));

    expect(bPos).toBeLessThan(aPos);
    db.close();
  });

  it('handles a chain: a → b → c', () => {
    const db = memDb();

    const aId = insertFile(db, '/a.c');
    const bId = insertFile(db, '/b.c');
    const cId = insertFile(db, '/c.c');
    insertImport(db, aId, bId); // a imports b
    insertImport(db, bId, cId); // b imports c

    const result = topoSort(db);
    const aPos = result.indexOf(String(aId));
    const bPos = result.indexOf(String(bId));
    const cPos = result.indexOf(String(cId));

    expect(cPos).toBeLessThan(bPos);
    expect(bPos).toBeLessThan(aPos);
    db.close();
  });

  it('every file appears after all files it imports (invariant)', () => {
    const db = memDb();

    // Diamond dependency: a → b, a → c, b → d, c → d
    const aId = insertFile(db, '/a.c');
    const bId = insertFile(db, '/b.c');
    const cId = insertFile(db, '/c.c');
    const dId = insertFile(db, '/d.c');

    insertImport(db, aId, bId);
    insertImport(db, aId, cId);
    insertImport(db, bId, dId);
    insertImport(db, cId, dId);

    const result = topoSort(db);

    // Build a position map
    const pos = new Map(result.map((id, i) => [id, i]));

    // Verify: for every import edge, dep comes before importer
    const edges = [
      [aId, bId], [aId, cId], [bId, dId], [cId, dId],
    ] as const;
    for (const [importer, dep] of edges) {
      expect(pos.get(String(dep))!).toBeLessThan(pos.get(String(importer))!);
    }
    db.close();
  });
});

// ─── detectCycles() ───────────────────────────────────────────────────────────

describe('detectCycles', () => {
  it('returns an empty array for an empty files table', () => {
    const db = memDb();
    expect(detectCycles(db)).toEqual([]);
    db.close();
  });

  it('returns an empty array when there are no cycles', () => {
    const db = memDb();

    const aId = insertFile(db, '/a.c');
    const bId = insertFile(db, '/b.c');
    insertImport(db, aId, bId); // a → b (no cycle)

    const cycles = detectCycles(db);
    expect(cycles).toEqual([]);
    db.close();
  });

  it('detects a direct two-node cycle (a → b → a)', () => {
    const db = memDb();

    const aId = insertFile(db, '/a.c');
    const bId = insertFile(db, '/b.c');
    insertImport(db, aId, bId); // a → b
    insertImport(db, bId, aId); // b → a  (cycle!)

    const cycles = detectCycles(db);
    expect(cycles.length).toBeGreaterThan(0);

    const allNodes = cycles.flat();
    expect(allNodes).toContain(String(aId));
    expect(allNodes).toContain(String(bId));
    db.close();
  });

  it('detects a three-node cycle (a → b → c → a)', () => {
    const db = memDb();

    const aId = insertFile(db, '/a.c');
    const bId = insertFile(db, '/b.c');
    const cId = insertFile(db, '/c.c');
    insertImport(db, aId, bId);
    insertImport(db, bId, cId);
    insertImport(db, cId, aId); // cycle!

    const cycles = detectCycles(db);
    expect(cycles.length).toBeGreaterThan(0);
    db.close();
  });

  it('does not report acyclic nodes as cycles', () => {
    const db = memDb();

    // Cycle: a ↔ b; standalone: c → a (no cycle back)
    const aId = insertFile(db, '/a.c');
    const bId = insertFile(db, '/b.c');
    const cId = insertFile(db, '/c.c');
    insertImport(db, aId, bId);
    insertImport(db, bId, aId); // cycle
    insertImport(db, cId, aId); // c feeds into cycle but is not in it

    const cycles = detectCycles(db);
    const cyclicNodes = cycles.flat();
    // c should NOT be in any cycle
    expect(cyclicNodes).not.toContain(String(cId));
    db.close();
  });
});

// ─── Integration: lz4 fixture (tiny-python-project) ──────────────────────────

describe('topoSort / detectCycles on tiny-python-project fixture', () => {
  let tempDir: string;
  let dbPath: string;

  const FIXTURE_DIR = resolve(
    import.meta.dirname ?? new URL('.', import.meta.url).pathname,
    '../fixtures/tiny-python-project',
  );

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'aamf-callgraph-test-'));
    dbPath = join(tempDir, 'kb.db');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('topoSort on indexed fixture returns an ordered array', async () => {
    const builder = new IndexBuilder(dbPath, { rootDir: FIXTURE_DIR });
    await builder.build();

    const db = openDb(dbPath);
    try {
      const sorted = topoSort(db);
      // Must be an array
      expect(Array.isArray(sorted)).toBe(true);

      // Every returned id must correspond to a real file row
      for (const id of sorted) {
        const row = db.prepare('SELECT id FROM files WHERE id = ?').get(id);
        expect(row).toBeDefined();
      }
    } finally {
      db.close();
    }
  });

  it('detectCycles on indexed fixture returns an empty array (no cycles expected)', async () => {
    const builder = new IndexBuilder(dbPath, { rootDir: FIXTURE_DIR });
    await builder.build();

    const db = openDb(dbPath);
    try {
      const cycles = detectCycles(db);
      expect(cycles).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('detectCycles returns a non-empty array when a cycle is inserted into file_imports', async () => {
    const builder = new IndexBuilder(dbPath, { rootDir: FIXTURE_DIR });
    await builder.build();

    const db = openDb(dbPath);
    try {
      const files = db.prepare('SELECT id FROM files LIMIT 2').all() as Array<{ id: number }>;

      if (files.length < 2) {
        // Not enough files indexed (grammar unavailable) — skip
        db.close();
        return;
      }

      const [f1, f2] = files as [{ id: number }, { id: number }];

      // Artificially inject a cycle: f1 → f2 → f1
      db.prepare(
        `INSERT INTO file_imports (file_id, raw_import, resolved_id) VALUES (?, 'cycle-edge', ?)`,
      ).run(f1.id, f2.id);
      db.prepare(
        `INSERT INTO file_imports (file_id, raw_import, resolved_id) VALUES (?, 'cycle-edge', ?)`,
      ).run(f2.id, f1.id);

      const cycles = detectCycles(db);
      expect(cycles.length).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });
});
