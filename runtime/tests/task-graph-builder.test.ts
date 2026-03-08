/**
 * Tests for deterministic symbol-graph task decomposition.
 *
 * Each test creates a temporary SQLite KB database with known schema
 * (files, symbols, symbol_refs) and verifies that `buildTaskGraph()`
 * produces the correct task structure, dependency edges, and SCCs.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { buildTaskGraph, findSCCs } from '../src/core/task-graph-builder.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Create a minimal Lore-compatible KB database with the required tables. */
function createTestDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      path        TEXT    NOT NULL,
      branch      TEXT    NOT NULL DEFAULT '',
      language    TEXT    NOT NULL,
      size_bytes  INTEGER NOT NULL DEFAULT 0,
      last_hash   TEXT,
      source      TEXT    NOT NULL DEFAULT '',
      indexed_at  INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(path, branch)
    );

    CREATE TABLE IF NOT EXISTS symbols (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      name        TEXT    NOT NULL,
      kind        TEXT    NOT NULL,
      start_line  INTEGER NOT NULL,
      end_line    INTEGER NOT NULL,
      signature   TEXT,
      doc_comment TEXT,
      resolved_type_signature TEXT,
      resolved_return_type TEXT,
      definition_uri TEXT,
      definition_path TEXT
    );

    CREATE TABLE IF NOT EXISTS symbol_refs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      caller_id   INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
      callee_id   INTEGER REFERENCES symbols(id),
      callee_name TEXT    NOT NULL,
      call_line   INTEGER NOT NULL,
      resolved_type_signature TEXT,
      resolved_return_type TEXT,
      definition_uri TEXT,
      definition_path TEXT
    );
  `);

  return db;
}

/** Insert a file into the KB. */
function insertFile(db: Database.Database, path: string, language = 'c'): number {
  const stmt = db.prepare('INSERT INTO files (path, language) VALUES (?, ?)');
  return Number(stmt.run(path, language).lastInsertRowid);
}

/** Insert a symbol into the KB. */
function insertSymbol(
  db: Database.Database,
  fileId: number,
  name: string,
  kind: string,
  startLine: number,
  endLine: number,
): number {
  const stmt = db.prepare(
    'INSERT INTO symbols (file_id, name, kind, start_line, end_line) VALUES (?, ?, ?, ?, ?)',
  );
  return Number(stmt.run(fileId, name, kind, startLine, endLine).lastInsertRowid);
}

/** Insert a symbol_ref (call edge). */
function insertRef(
  db: Database.Database,
  callerId: number,
  calleeName: string,
  callLine: number,
  calleeId?: number,
): void {
  const stmt = db.prepare(
    'INSERT INTO symbol_refs (caller_id, callee_id, callee_name, call_line) VALUES (?, ?, ?, ?)',
  );
  stmt.run(callerId, calleeId ?? null, calleeName, callLine);
}

const DEFAULT_OPTIONS = {
  sourceRoot: '/src',
  maxLinesPerTask: 500,
  targetLanguage: 'rust',
  outputPath: 'target/src',
} as const;

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('buildTaskGraph', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'aamf-task-graph-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should return empty tasks for an empty KB', async () => {
    const dbPath = join(tempDir, 'kb.db');
    const db = createTestDb(dbPath);
    db.close();

    const result = await buildTaskGraph({ ...DEFAULT_OPTIONS, kbDbPath: dbPath });

    expect(result.tasks).toEqual([]);
    expect(result.sccs).toEqual([]);
  });

  it('should create one task per file when files are under maxLinesPerTask', async () => {
    const dbPath = join(tempDir, 'kb.db');
    const db = createTestDb(dbPath);

    const f1 = insertFile(db, 'lib/utils.c');
    insertSymbol(db, f1, 'add', 'function', 1, 10);
    insertSymbol(db, f1, 'subtract', 'function', 12, 25);

    const f2 = insertFile(db, 'lib/math.c');
    insertSymbol(db, f2, 'multiply', 'function', 1, 15);

    db.close();

    const result = await buildTaskGraph({ ...DEFAULT_OPTIONS, kbDbPath: dbPath });

    expect(result.tasks).toHaveLength(2);
    expect(result.tasks[0]!.id).toBe('task-0-0');
    expect(result.tasks[0]!.sourceFiles).toEqual(['lib/utils.c']);
    expect(result.tasks[0]!.targetFiles).toEqual(['target/src/lib/utils.rs']);

    expect(result.tasks[1]!.id).toBe('task-1-0');
    expect(result.tasks[1]!.sourceFiles).toEqual(['lib/math.c']);
    expect(result.tasks[1]!.targetFiles).toEqual(['target/src/lib/math.rs']);
  });

  it('should generate globally unique task IDs with no collisions', async () => {
    const dbPath = join(tempDir, 'kb.db');
    const db = createTestDb(dbPath);

    // Create 5 files
    for (let i = 0; i < 5; i++) {
      const fid = insertFile(db, `src/module${i}.c`);
      insertSymbol(db, fid, `fn_${i}`, 'function', 1, 50);
    }

    db.close();

    const result = await buildTaskGraph({ ...DEFAULT_OPTIONS, kbDbPath: dbPath });

    const ids = result.tasks.map(t => t.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
    expect(ids).toEqual(['task-0-0', 'task-1-0', 'task-2-0', 'task-3-0', 'task-4-0']);
  });

  it('should split large files at symbol boundaries respecting maxLinesPerTask', async () => {
    const dbPath = join(tempDir, 'kb.db');
    const db = createTestDb(dbPath);

    const fid = insertFile(db, 'lib/big.c');
    // Create symbols that span 600 lines total (exceeds maxLinesPerTask=200)
    insertSymbol(db, fid, 'init', 'function', 1, 100);
    insertSymbol(db, fid, 'process', 'function', 101, 300);
    insertSymbol(db, fid, 'cleanup', 'function', 301, 500);
    insertSymbol(db, fid, 'finalize', 'function', 501, 600);

    db.close();

    const result = await buildTaskGraph({
      ...DEFAULT_OPTIONS,
      kbDbPath: dbPath,
      maxLinesPerTask: 200,
    });

    // Should split into multiple tasks
    expect(result.tasks.length).toBeGreaterThan(1);

    // All tasks should reference the same source file
    for (const task of result.tasks) {
      expect(task.sourceFiles).toEqual(['lib/big.c']);
    }

    // Each split task should have a lineRange
    const splitTasks = result.tasks.filter(t => t.lineRange);
    expect(splitTasks.length).toBeGreaterThan(0);

    // IDs should be unique: task-0-0, task-0-1, etc.
    const ids = result.tasks.map(t => t.id);
    expect(ids[0]).toBe('task-0-0');
    if (ids.length > 1) {
      expect(ids[1]).toBe('task-0-1');
    }

    // No symbol should be split across tasks
    // (each symbol appears in exactly one task's line range)
  });

  it('should compute symbol-level dependency edges from symbol_refs', async () => {
    const dbPath = join(tempDir, 'kb.db');
    const db = createTestDb(dbPath);

    // File A: defines "helper"
    const f1 = insertFile(db, 'src/helper.c');
    const helperSym = insertSymbol(db, f1, 'helper', 'function', 1, 30);

    // File B: defines "main_fn" which calls "helper"
    const f2 = insertFile(db, 'src/main.c');
    const mainSym = insertSymbol(db, f2, 'main_fn', 'function', 1, 50);
    insertRef(db, mainSym, 'helper', 10, helperSym);

    db.close();

    const result = await buildTaskGraph({ ...DEFAULT_OPTIONS, kbDbPath: dbPath });

    expect(result.tasks).toHaveLength(2);

    // Task for main.c should depend on task for helper.c
    const helperTask = result.tasks.find(t => t.sourceFiles[0] === 'src/helper.c')!;
    const mainTask = result.tasks.find(t => t.sourceFiles[0] === 'src/main.c')!;

    expect(mainTask.dependencies).toContain(helperTask.id);
    expect(helperTask.dependencies).toEqual([]); // no outbound deps
  });

  it('should produce empty dependencies for files with no external refs', async () => {
    const dbPath = join(tempDir, 'kb.db');
    const db = createTestDb(dbPath);

    const fid = insertFile(db, 'src/standalone.c');
    insertSymbol(db, fid, 'standalone_fn', 'function', 1, 20);
    // No symbol_refs entries

    db.close();

    const result = await buildTaskGraph({ ...DEFAULT_OPTIONS, kbDbPath: dbPath });

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]!.dependencies).toEqual([]);
  });

  it('should detect SCCs for mutual imports (cyclic dependencies)', async () => {
    const dbPath = join(tempDir, 'kb.db');
    const db = createTestDb(dbPath);

    // File A defines fn_a, calls fn_b
    const f1 = insertFile(db, 'src/a.c');
    const fnA = insertSymbol(db, f1, 'fn_a', 'function', 1, 20);

    // File B defines fn_b, calls fn_a
    const f2 = insertFile(db, 'src/b.c');
    const fnB = insertSymbol(db, f2, 'fn_b', 'function', 1, 20);

    // Mutual references
    insertRef(db, fnA, 'fn_b', 5, fnB);
    insertRef(db, fnB, 'fn_a', 5, fnA);

    db.close();

    const result = await buildTaskGraph({ ...DEFAULT_OPTIONS, kbDbPath: dbPath });

    expect(result.tasks).toHaveLength(2);
    expect(result.sccs).toHaveLength(1);

    const scc = result.sccs[0]!;
    expect(scc).toHaveLength(2);
    expect(scc).toContain(result.tasks[0]!.id);
    expect(scc).toContain(result.tasks[1]!.id);
  });

  it('should not include self-references in dependencies', async () => {
    const dbPath = join(tempDir, 'kb.db');
    const db = createTestDb(dbPath);

    const fid = insertFile(db, 'src/self.c');
    const fnA = insertSymbol(db, fid, 'fn_self', 'function', 1, 20);
    const fnB = insertSymbol(db, fid, 'fn_helper', 'function', 21, 40);

    // fn_self calls fn_helper — both in the same file → same task
    insertRef(db, fnA, 'fn_helper', 5, fnB);

    db.close();

    const result = await buildTaskGraph({ ...DEFAULT_OPTIONS, kbDbPath: dbPath });

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]!.dependencies).toEqual([]); // self-ref filtered
  });

  it('should map source paths to target paths with correct extension', async () => {
    const dbPath = join(tempDir, 'kb.db');
    const db = createTestDb(dbPath);

    const fid = insertFile(db, 'lib/codec.c');
    insertSymbol(db, fid, 'encode', 'function', 1, 30);

    db.close();

    // Rust target
    let result = await buildTaskGraph({
      ...DEFAULT_OPTIONS,
      kbDbPath: dbPath,
      targetLanguage: 'rust',
    });
    expect(result.tasks[0]!.targetFiles[0]).toBe('target/src/lib/codec.rs');

    // TypeScript target
    result = await buildTaskGraph({
      ...DEFAULT_OPTIONS,
      kbDbPath: dbPath,
      targetLanguage: 'typescript',
    });
    expect(result.tasks[0]!.targetFiles[0]).toBe('target/src/lib/codec.ts');

    // CSharp target
    result = await buildTaskGraph({
      ...DEFAULT_OPTIONS,
      kbDbPath: dbPath,
      targetLanguage: 'csharp',
    });
    expect(result.tasks[0]!.targetFiles[0]).toBe('target/src/lib/codec.cs');
  });

  it('should handle files with no symbols (single task, no lineRange)', async () => {
    const dbPath = join(tempDir, 'kb.db');
    const db = createTestDb(dbPath);

    insertFile(db, 'src/empty.c');
    // No symbols inserted

    db.close();

    const result = await buildTaskGraph({ ...DEFAULT_OPTIONS, kbDbPath: dbPath });

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]!.id).toBe('task-0-0');
    expect(result.tasks[0]!.lineRange).toBeUndefined();
  });

  it('should assign complexity based on line count', async () => {
    const dbPath = join(tempDir, 'kb.db');
    const db = createTestDb(dbPath);

    // Small file: 50 lines → simple
    const f1 = insertFile(db, 'src/small.c');
    insertSymbol(db, f1, 'small_fn', 'function', 1, 50);

    // Medium file: 200 lines → moderate
    const f2 = insertFile(db, 'src/medium.c');
    insertSymbol(db, f2, 'medium_fn', 'function', 1, 200);

    // Large file: 400 lines → complex
    const f3 = insertFile(db, 'src/large.c');
    insertSymbol(db, f3, 'large_fn', 'function', 1, 400);

    db.close();

    const result = await buildTaskGraph({ ...DEFAULT_OPTIONS, kbDbPath: dbPath });

    expect(result.tasks[0]!.complexity).toBe('simple');
    expect(result.tasks[1]!.complexity).toBe('moderate');
    expect(result.tasks[2]!.complexity).toBe('complex');
  });

  it('should handle a realistic dependency chain (A → B → C)', async () => {
    const dbPath = join(tempDir, 'kb.db');
    const db = createTestDb(dbPath);

    // C: no deps (leaf)
    const fc = insertFile(db, 'src/c.c');
    const fnC = insertSymbol(db, fc, 'fn_c', 'function', 1, 20);

    // B: calls C
    const fb = insertFile(db, 'src/b.c');
    const fnB = insertSymbol(db, fb, 'fn_b', 'function', 1, 20);
    insertRef(db, fnB, 'fn_c', 5, fnC);

    // A: calls B
    const fa = insertFile(db, 'src/a.c');
    const fnA = insertSymbol(db, fa, 'fn_a', 'function', 1, 20);
    insertRef(db, fnA, 'fn_b', 5, fnB);

    db.close();

    const result = await buildTaskGraph({ ...DEFAULT_OPTIONS, kbDbPath: dbPath });

    const taskA = result.tasks.find(t => t.sourceFiles[0] === 'src/a.c')!;
    const taskB = result.tasks.find(t => t.sourceFiles[0] === 'src/b.c')!;
    const taskC = result.tasks.find(t => t.sourceFiles[0] === 'src/c.c')!;

    // A depends on B, B depends on C
    expect(taskA.dependencies).toContain(taskB.id);
    expect(taskB.dependencies).toContain(taskC.id);
    expect(taskC.dependencies).toEqual([]);

    // No SCCs (linear chain)
    expect(result.sccs).toEqual([]);
  });
});

// ─── findSCCs unit tests ────────────────────────────────────────────────────

describe('findSCCs', () => {
  it('should return empty for a DAG (no cycles)', () => {
    const adjacency = new Map<string, string[]>([
      ['a', ['b']],
      ['b', ['c']],
      ['c', []],
    ]);
    const sccs = findSCCs(['a', 'b', 'c'], adjacency);
    expect(sccs).toEqual([]);
  });

  it('should detect a simple 2-node cycle', () => {
    const adjacency = new Map<string, string[]>([
      ['a', ['b']],
      ['b', ['a']],
    ]);
    const sccs = findSCCs(['a', 'b'], adjacency);
    expect(sccs).toHaveLength(1);
    expect(sccs[0]!.sort()).toEqual(['a', 'b']);
  });

  it('should detect a 3-node cycle', () => {
    const adjacency = new Map<string, string[]>([
      ['a', ['b']],
      ['b', ['c']],
      ['c', ['a']],
    ]);
    const sccs = findSCCs(['a', 'b', 'c'], adjacency);
    expect(sccs).toHaveLength(1);
    expect(sccs[0]!.sort()).toEqual(['a', 'b', 'c']);
  });

  it('should detect multiple independent SCCs', () => {
    const adjacency = new Map<string, string[]>([
      ['a', ['b']],
      ['b', ['a']],
      ['c', ['d']],
      ['d', ['c']],
      ['e', []],
    ]);
    const sccs = findSCCs(['a', 'b', 'c', 'd', 'e'], adjacency);
    expect(sccs).toHaveLength(2);
    const sorted = sccs.map(s => s.sort()).sort((x, y) => x[0]!.localeCompare(y[0]!));
    expect(sorted[0]).toEqual(['a', 'b']);
    expect(sorted[1]).toEqual(['c', 'd']);
  });

  it('should not return single-node SCCs (trivial)', () => {
    const adjacency = new Map<string, string[]>([
      ['a', []],
      ['b', []],
    ]);
    const sccs = findSCCs(['a', 'b'], adjacency);
    expect(sccs).toEqual([]);
  });
});
