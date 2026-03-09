/**
 * Tests for call-graph-clustering task decomposition.
 *
 * Each test creates a temporary SQLite KB with known symbols and edges,
 * then verifies that buildTaskGraph() and buildDependencySummary() produce
 * correct clustering, dependency edges, and size constraints.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { buildTaskGraph, buildDependencySummary, findSCCs } from '../src/core/task-graph-builder.js';
import type { CompilationUnit } from '../src/agents/types.js';

// ─── DB Helpers ─────────────────────────────────────────────────────────────

function createTestDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL, branch TEXT NOT NULL DEFAULT '',
      language TEXT NOT NULL, size_bytes INTEGER NOT NULL DEFAULT 0,
      last_hash TEXT, source TEXT NOT NULL DEFAULT '',
      indexed_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(path, branch)
    );
    CREATE TABLE IF NOT EXISTS symbols (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      name TEXT NOT NULL, kind TEXT NOT NULL,
      start_line INTEGER NOT NULL, end_line INTEGER NOT NULL,
      signature TEXT, doc_comment TEXT,
      resolved_type_signature TEXT, resolved_return_type TEXT,
      definition_uri TEXT, definition_path TEXT
    );
    CREATE TABLE IF NOT EXISTS symbol_refs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      caller_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
      callee_id INTEGER REFERENCES symbols(id),
      callee_name TEXT NOT NULL, call_line INTEGER NOT NULL,
      resolved_type_signature TEXT, resolved_return_type TEXT,
      definition_uri TEXT, definition_path TEXT
    );
    CREATE TABLE IF NOT EXISTS type_refs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      symbol_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
      type_id INTEGER REFERENCES symbols(id),
      type_name TEXT NOT NULL, type_name_bare TEXT NOT NULL,
      ref_kind TEXT NOT NULL DEFAULT 'other',
      ref_line INTEGER NOT NULL, ref_character INTEGER,
      resolved_type_signature TEXT, definition_uri TEXT, definition_path TEXT
    );
  `);
  return db;
}

function insertFile(db: Database.Database, path: string, language = 'c'): number {
  return Number(db.prepare('INSERT INTO files (path, language) VALUES (?, ?)').run(path, language).lastInsertRowid);
}

function insertSymbol(db: Database.Database, fileId: number, name: string, kind: string, startLine: number, endLine: number): number {
  return Number(db.prepare(
    'INSERT INTO symbols (file_id, name, kind, start_line, end_line) VALUES (?, ?, ?, ?, ?)',
  ).run(fileId, name, kind, startLine, endLine).lastInsertRowid);
}

function insertRef(db: Database.Database, callerId: number, calleeName: string, callLine: number, calleeId?: number): void {
  db.prepare('INSERT INTO symbol_refs (caller_id, callee_id, callee_name, call_line) VALUES (?, ?, ?, ?)').run(callerId, calleeId ?? null, calleeName, callLine);
}

function insertTypeRef(db: Database.Database, fileId: number, typeName: string, refLine: number, symbolId?: number, typeId?: number): void {
  db.prepare(
    'INSERT INTO type_refs (file_id, symbol_id, type_id, type_name, type_name_bare, ref_kind, ref_line) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(fileId, symbolId ?? null, typeId ?? null, typeName, typeName, 'usage', refLine);
}

const DEFAULT_OPTIONS = {
  sourceRoot: '/src',
  maxLinesPerTask: 500,
  targetLanguage: 'rust',
  outputPath: 'target/src',
} as const;

// ─── buildTaskGraph Tests ───────────────────────────────────────────────────

describe('buildTaskGraph', () => {
  let tempDir: string;
  beforeEach(async () => { tempDir = await mkdtemp(join(tmpdir(), 'aamf-tgb-')); });
  afterEach(async () => { await rm(tempDir, { recursive: true, force: true }); });

  it('should return empty tasks for an empty KB', async () => {
    const dbPath = join(tempDir, 'kb.db');
    createTestDb(dbPath).close();
    const result = await buildTaskGraph({ ...DEFAULT_OPTIONS, kbDbPath: dbPath });
    expect(result.tasks).toEqual([]);
    expect(result.sccs).toEqual([]);
  });

  it('should create one task per isolated symbol', async () => {
    const dbPath = join(tempDir, 'kb.db');
    const db = createTestDb(dbPath);
    const f1 = insertFile(db, 'src/a.c');
    insertSymbol(db, f1, 'fn_a', 'function', 1, 30);
    const f2 = insertFile(db, 'src/b.c');
    insertSymbol(db, f2, 'fn_b', 'function', 1, 20);
    db.close();

    const result = await buildTaskGraph({ ...DEFAULT_OPTIONS, kbDbPath: dbPath });
    // Two isolated symbols → two tasks (no edges to merge)
    expect(result.tasks).toHaveLength(2);
  });

  it('should merge mutually-calling symbols into one task (SCC)', async () => {
    const dbPath = join(tempDir, 'kb.db');
    const db = createTestDb(dbPath);
    const f1 = insertFile(db, 'src/a.c');
    const fnA = insertSymbol(db, f1, 'fn_a', 'function', 1, 50);
    const f2 = insertFile(db, 'src/b.c');
    const fnB = insertSymbol(db, f2, 'fn_b', 'function', 1, 50);
    // Mutual calls → SCC → forced into same cluster
    insertRef(db, fnA, 'fn_b', 10, fnB);
    insertRef(db, fnB, 'fn_a', 10, fnA);
    db.close();

    const result = await buildTaskGraph({ ...DEFAULT_OPTIONS, kbDbPath: dbPath });
    // Both symbols must be in the same task
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]!.sourceFiles).toHaveLength(2);
  });

  it('should merge tightly-coupled symbols via greedy merge', async () => {
    const dbPath = join(tempDir, 'kb.db');
    const db = createTestDb(dbPath);
    const f = insertFile(db, 'src/lib.c');
    const fnInit = insertSymbol(db, f, 'init', 'function', 1, 30);
    const fnProcess = insertSymbol(db, f, 'process', 'function', 31, 80);
    const fnCleanup = insertSymbol(db, f, 'cleanup', 'function', 81, 100);
    // init ↔ process (bidirectional, 2 edges → qualifies for merge)
    insertRef(db, fnInit, 'process', 10, fnProcess);
    insertRef(db, fnProcess, 'init', 40, fnInit);
    // cleanup is isolated — no mutual edges
    db.close();

    const result = await buildTaskGraph({ ...DEFAULT_OPTIONS, kbDbPath: dbPath });
    // init + process should merge (bidirectional edges); cleanup stays separate
    expect(result.tasks.length).toBeLessThanOrEqual(2);
    // Verify cleanup is not merged with the init/process cluster
    const cleanupTask = result.tasks.find(t =>
      t.description.includes('cleanup') || t.name.includes('cleanup'),
    );
    if (cleanupTask && result.tasks.length === 2) {
      expect(cleanupTask.sourceFiles).toEqual(['src/lib.c']);
    }
  });

  it('should not merge clusters that would exceed maxLinesPerTask', async () => {
    const dbPath = join(tempDir, 'kb.db');
    const db = createTestDb(dbPath);
    const f = insertFile(db, 'src/big.c');
    // Two large symbols with only one-directional edges (not an SCC)
    const fnA = insertSymbol(db, f, 'big_fn_a', 'function', 1, 300);
    const fnB = insertSymbol(db, f, 'big_fn_b', 'function', 301, 600);
    // A third small symbol with bidirectional edges to fnA
    const fnC = insertSymbol(db, f, 'small_fn_c', 'function', 601, 650);
    insertRef(db, fnA, 'small_fn_c', 100, fnC);
    insertRef(db, fnC, 'big_fn_a', 610, fnA);
    // fnB has a one-directional call to fnA
    insertRef(db, fnB, 'big_fn_a', 400, fnA);
    db.close();

    // maxLinesPerTask = 400 → fnA(300)+fnC(50)=350 OK, but can't add fnB(300) → 650 > 400
    const result = await buildTaskGraph({
      ...DEFAULT_OPTIONS, kbDbPath: dbPath, maxLinesPerTask: 400,
    });
    expect(result.tasks.length).toBeGreaterThanOrEqual(2);
  });

  it('should produce correct dependency edges between clusters', async () => {
    const dbPath = join(tempDir, 'kb.db');
    const db = createTestDb(dbPath);
    const f1 = insertFile(db, 'src/base.c');
    const baseFn = insertSymbol(db, f1, 'base_fn', 'function', 1, 20);
    const f2 = insertFile(db, 'src/app.c');
    const appFn = insertSymbol(db, f2, 'app_fn', 'function', 1, 20);
    // app calls base (one-directional → not enough for merge)
    insertRef(db, appFn, 'base_fn', 5, baseFn);
    db.close();

    const result = await buildTaskGraph({ ...DEFAULT_OPTIONS, kbDbPath: dbPath });
    expect(result.tasks).toHaveLength(2);
    const baseTask = result.tasks.find(t => t.sourceFiles.includes('src/base.c'))!;
    const appTask = result.tasks.find(t => t.sourceFiles.includes('src/app.c'))!;
    expect(appTask.dependencies).toContain(baseTask.id);
    expect(baseTask.dependencies).not.toContain(appTask.id);
  });

  it('should produce type-only dependency edges', async () => {
    const dbPath = join(tempDir, 'kb.db');
    const db = createTestDb(dbPath);
    const f1 = insertFile(db, 'src/types.c');
    insertSymbol(db, f1, 'Config', 'struct', 1, 15);
    const f2 = insertFile(db, 'src/app.c');
    const appFn = insertSymbol(db, f2, 'run', 'function', 1, 30);
    insertTypeRef(db, f2, 'Config', 5, appFn);
    db.close();

    const result = await buildTaskGraph({ ...DEFAULT_OPTIONS, kbDbPath: dbPath });
    expect(result.tasks).toHaveLength(2);
    const typesTask = result.tasks.find(t => t.sourceFiles.includes('src/types.c'))!;
    const appTask = result.tasks.find(t => t.sourceFiles.includes('src/app.c'))!;
    expect(appTask.dependencies).toContain(typesTask.id);
  });

  it('should not create self-dependencies', async () => {
    const dbPath = join(tempDir, 'kb.db');
    const db = createTestDb(dbPath);
    const f = insertFile(db, 'src/self.c');
    const fnA = insertSymbol(db, f, 'fn_self', 'function', 1, 20);
    const fnB = insertSymbol(db, f, 'fn_helper', 'function', 21, 40);
    // Call within the same file → same or different cluster, but no self-dep
    insertRef(db, fnA, 'fn_helper', 5, fnB);
    db.close();

    const result = await buildTaskGraph({ ...DEFAULT_OPTIONS, kbDbPath: dbPath });
    for (const task of result.tasks) {
      expect(task.dependencies).not.toContain(task.id);
    }
  });

  it('should handle files with no symbols', async () => {
    const dbPath = join(tempDir, 'kb.db');
    const db = createTestDb(dbPath);
    insertFile(db, 'src/empty.c');
    insertFile(db, 'src/also_empty.c');
    db.close();

    const result = await buildTaskGraph({ ...DEFAULT_OPTIONS, kbDbPath: dbPath });
    // No symbols → one task per file (fallback)
    expect(result.tasks).toHaveLength(2);
    expect(result.tasks[0]!.complexity).toBe('simple');
  });

  it('should annotate tasks with compilation unit IDs', async () => {
    const dbPath = join(tempDir, 'kb.db');
    const db = createTestDb(dbPath);
    const f1 = insertFile(db, 'src/core.c');
    insertSymbol(db, f1, 'core_fn', 'function', 1, 20);
    const f2 = insertFile(db, 'src/util.c');
    insertSymbol(db, f2, 'util_fn', 'function', 1, 20);
    db.close();

    const units: CompilationUnit[] = [
      { id: 'core', name: 'Core', targetPath: 'crates/core', sourceFiles: ['src/core.c'], dependsOn: [] },
      { id: 'util', name: 'Utils', targetPath: 'crates/util', sourceFiles: ['src/util.c'], dependsOn: [] },
    ];
    const result = await buildTaskGraph({ ...DEFAULT_OPTIONS, kbDbPath: dbPath, compilationUnits: units });
    const coreTask = result.tasks.find(t => t.sourceFiles.includes('src/core.c'))!;
    const utilTask = result.tasks.find(t => t.sourceFiles.includes('src/util.c'))!;
    expect(coreTask.compilationUnit).toBe('core');
    expect(utilTask.compilationUnit).toBe('util');
  });

  it('should validate and add missing cross-unit dependencies', async () => {
    const dbPath = join(tempDir, 'kb.db');
    const db = createTestDb(dbPath);
    const f1 = insertFile(db, 'src/base.c');
    const baseSym = insertSymbol(db, f1, 'base_fn', 'function', 1, 20);
    const f2 = insertFile(db, 'src/app.c');
    const appSym = insertSymbol(db, f2, 'app_fn', 'function', 1, 20);
    insertRef(db, appSym, 'base_fn', 5, baseSym);
    db.close();

    const units: CompilationUnit[] = [
      { id: 'base', name: 'Base', targetPath: 'crates/base', sourceFiles: ['src/base.c'], dependsOn: [] },
      { id: 'app', name: 'App', targetPath: 'crates/app', sourceFiles: ['src/app.c'], dependsOn: [] },
    ];
    const result = await buildTaskGraph({ ...DEFAULT_OPTIONS, kbDbPath: dbPath, compilationUnits: units });
    const appUnit = result.compilationUnits.find(u => u.id === 'app')!;
    expect(appUnit.dependsOn).toContain('base');
  });

  it('should produce unique task IDs', async () => {
    const dbPath = join(tempDir, 'kb.db');
    const db = createTestDb(dbPath);
    for (let i = 0; i < 10; i++) {
      const f = insertFile(db, `src/mod${i}.c`);
      insertSymbol(db, f, `fn_${i}`, 'function', 1, 30);
    }
    db.close();

    const result = await buildTaskGraph({ ...DEFAULT_OPTIONS, kbDbPath: dbPath });
    const ids = result.tasks.map(t => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('should set lineRange when cluster is within a single file', async () => {
    const dbPath = join(tempDir, 'kb.db');
    const db = createTestDb(dbPath);
    const f = insertFile(db, 'src/single.c');
    insertSymbol(db, f, 'fn_only', 'function', 10, 50);
    db.close();

    const result = await buildTaskGraph({ ...DEFAULT_OPTIONS, kbDbPath: dbPath });
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]!.lineRange).toEqual({ start: 10, end: 50 });
  });

  it('should handle a dependency chain A → B → C correctly', async () => {
    const dbPath = join(tempDir, 'kb.db');
    const db = createTestDb(dbPath);
    const fc = insertFile(db, 'src/c.c');
    const fnC = insertSymbol(db, fc, 'fn_c', 'function', 1, 20);
    const fb = insertFile(db, 'src/b.c');
    const fnB = insertSymbol(db, fb, 'fn_b', 'function', 1, 20);
    insertRef(db, fnB, 'fn_c', 5, fnC);
    const fa = insertFile(db, 'src/a.c');
    const fnA = insertSymbol(db, fa, 'fn_a', 'function', 1, 20);
    insertRef(db, fnA, 'fn_b', 5, fnB);
    db.close();

    const result = await buildTaskGraph({ ...DEFAULT_OPTIONS, kbDbPath: dbPath });
    const taskA = result.tasks.find(t => t.sourceFiles.includes('src/a.c'))!;
    const taskB = result.tasks.find(t => t.sourceFiles.includes('src/b.c'))!;
    const taskC = result.tasks.find(t => t.sourceFiles.includes('src/c.c'))!;
    expect(taskA.dependencies).toContain(taskB.id);
    expect(taskB.dependencies).toContain(taskC.id);
    expect(taskC.dependencies).toEqual([]);
    expect(result.sccs).toEqual([]);
  });
});

// ─── buildDependencySummary Tests ───────────────────────────────────────────

describe('buildDependencySummary', () => {
  let tempDir: string;
  beforeEach(async () => { tempDir = await mkdtemp(join(tmpdir(), 'aamf-dep-')); });
  afterEach(async () => { await rm(tempDir, { recursive: true, force: true }); });

  it('should return file count and per-file metrics', async () => {
    const dbPath = join(tempDir, 'kb.db');
    const db = createTestDb(dbPath);
    const f1 = insertFile(db, 'src/a.c');
    insertSymbol(db, f1, 'fn_a', 'function', 1, 50);
    const f2 = insertFile(db, 'src/b.c');
    insertSymbol(db, f2, 'fn_b', 'function', 1, 200);
    db.close();

    const summary = await buildDependencySummary(dbPath);
    expect(summary.fileCount).toBe(2);
    expect(summary.fileMetrics['src/a.c']!.lines).toBe(50);
    expect(summary.fileMetrics['src/b.c']!.lines).toBe(200);
  });

  it('should produce condensed modules from clustering', async () => {
    const dbPath = join(tempDir, 'kb.db');
    const db = createTestDb(dbPath);
    const f1 = insertFile(db, 'src/core.c');
    const fnA = insertSymbol(db, f1, 'core_init', 'function', 1, 50);
    const fnB = insertSymbol(db, f1, 'core_run', 'function', 51, 100);
    // Bidirectional → merge into one module
    insertRef(db, fnA, 'core_run', 10, fnB);
    insertRef(db, fnB, 'core_init', 60, fnA);
    db.close();

    const summary = await buildDependencySummary(dbPath);
    // Tightly coupled symbols should merge into one module
    expect(summary.modules.length).toBeGreaterThanOrEqual(1);
    // Total lines should be preserved
    expect(summary.totalLines).toBe(100);
  });

  it('should compute connected components on the module graph', async () => {
    const dbPath = join(tempDir, 'kb.db');
    const db = createTestDb(dbPath);
    const fa = insertFile(db, 'src/a.c');
    const fnA = insertSymbol(db, fa, 'fn_a', 'function', 1, 20);
    const fb = insertFile(db, 'src/b.c');
    const fnB = insertSymbol(db, fb, 'fn_b', 'function', 1, 20);
    insertRef(db, fnA, 'fn_b', 5, fnB);
    // Isolated file
    const fc = insertFile(db, 'src/c.c');
    insertSymbol(db, fc, 'fn_c', 'function', 1, 20);
    db.close();

    const summary = await buildDependencySummary(dbPath);
    // At least 2 connected components (a+b cluster and c alone)
    expect(summary.connectedComponents.length).toBeGreaterThanOrEqual(2);
  });

  it('should detect module-level SCCs', async () => {
    const dbPath = join(tempDir, 'kb.db');
    const db = createTestDb(dbPath);
    // Create 4 symbols in 4 files, with cycle between file 1 and file 2
    // but non-SCC (one-directional within each pair only)
    const f1 = insertFile(db, 'src/x.c');
    const fnX = insertSymbol(db, f1, 'fn_x', 'function', 1, 300);
    const f2 = insertFile(db, 'src/y.c');
    const fnY = insertSymbol(db, f2, 'fn_y', 'function', 1, 300);
    insertRef(db, fnX, 'fn_y', 5, fnY);
    insertRef(db, fnY, 'fn_x', 5, fnX);
    db.close();

    // With maxLines=400, they can't merge (300+300=600 > 400)
    // but they form an SCC at the task level
    const summary = await buildDependencySummary(dbPath, 400);
    // If they couldn't be merged, they should appear as separate modules with an SCC
    if (summary.modules.length >= 2) {
      expect(summary.sccs.length).toBeGreaterThanOrEqual(1);
    }
  });
});

// ─── findSCCs Tests ─────────────────────────────────────────────────────────

describe('findSCCs', () => {
  it('should return empty for a DAG', () => {
    const adj = new Map([['a', ['b']], ['b', ['c']], ['c', [] as string[]]]);
    expect(findSCCs(['a', 'b', 'c'], adj)).toEqual([]);
  });

  it('should detect a 2-node cycle', () => {
    const adj = new Map([['a', ['b']], ['b', ['a']]]);
    const sccs = findSCCs(['a', 'b'], adj);
    expect(sccs).toHaveLength(1);
    expect(sccs[0]!.sort()).toEqual(['a', 'b']);
  });

  it('should detect a 3-node cycle', () => {
    const adj = new Map([['a', ['b']], ['b', ['c']], ['c', ['a']]]);
    const sccs = findSCCs(['a', 'b', 'c'], adj);
    expect(sccs).toHaveLength(1);
    expect(sccs[0]!.sort()).toEqual(['a', 'b', 'c']);
  });

  it('should detect multiple independent SCCs', () => {
    const adj = new Map([['a', ['b']], ['b', ['a']], ['c', ['d']], ['d', ['c']], ['e', [] as string[]]]);
    const sccs = findSCCs(['a', 'b', 'c', 'd', 'e'], adj);
    expect(sccs).toHaveLength(2);
  });

  it('should not return single-node SCCs', () => {
    const adj = new Map([['a', [] as string[]], ['b', [] as string[]]]);
    expect(findSCCs(['a', 'b'], adj)).toEqual([]);
  });
});
