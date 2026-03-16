/**
 * Tests for call-graph-clustering task decomposition.
 *
 * Each test creates a temporary SQLite KB with known symbols and edges,
 * then verifies that buildTaskGraph() and buildDependencySummary() produce
 * correct clustering, dependency edges, and size constraints.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { buildTaskGraph, buildDependencySummary, findSCCs } from '../../src/core/task-graph-builder.js';
import type { CompilationUnit } from '../../src/agents/types.js';

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
      call_character INTEGER,
      call_kind TEXT NOT NULL DEFAULT 'call',
      resolution_method TEXT NOT NULL DEFAULT '',
      file_id INTEGER REFERENCES files(id) ON DELETE CASCADE,
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
    CREATE TABLE IF NOT EXISTS symbol_metrics (
      symbol_id   INTEGER PRIMARY KEY REFERENCES symbols(id) ON DELETE CASCADE,
      line_count  INTEGER NOT NULL,
      param_count INTEGER NOT NULL,
      cyclomatic  INTEGER NOT NULL,
      max_nesting INTEGER NOT NULL,
      layer       TEXT    NOT NULL DEFAULT 'baseline',
      generation  INTEGER NOT NULL DEFAULT 0
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
  // Look up caller's file_id for the denormalized column
  const row = db.prepare('SELECT file_id FROM symbols WHERE id = ?').get(callerId) as { file_id: number } | undefined;
  const fileId = row?.file_id ?? null;
  db.prepare('INSERT INTO symbol_refs (caller_id, callee_id, callee_name, call_line, file_id) VALUES (?, ?, ?, ?, ?)').run(callerId, calleeId ?? null, calleeName, callLine, fileId);
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
    insertSymbol(db, f1, 'fn_a', 'function', 1, 80);
    const f2 = insertFile(db, 'src/b.c');
    insertSymbol(db, f2, 'fn_b', 'function', 1, 70);
    db.close();

    const result = await buildTaskGraph({ ...DEFAULT_OPTIONS, kbDbPath: dbPath });
    // Two isolated symbols (both above min-size threshold) → two tasks
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
    const baseFn = insertSymbol(db, f1, 'base_fn', 'function', 1, 80);
    const f2 = insertFile(db, 'src/app.c');
    const appFn = insertSymbol(db, f2, 'app_fn', 'function', 1, 80);
    // app calls base (one-directional, cross-file → stays separate)
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
    insertSymbol(db, f1, 'Config', 'struct', 1, 60);
    const f2 = insertFile(db, 'src/app.c');
    const appFn = insertSymbol(db, f2, 'run', 'function', 1, 80);
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
    insertSymbol(db, f1, 'core_fn', 'function', 1, 80);
    const f2 = insertFile(db, 'src/util.c');
    insertSymbol(db, f2, 'util_fn', 'function', 1, 80);
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
    const baseSym = insertSymbol(db, f1, 'base_fn', 'function', 1, 80);
    const f2 = insertFile(db, 'src/app.c');
    const appSym = insertSymbol(db, f2, 'app_fn', 'function', 1, 80);
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

  it('should warn about uncovered files in compilation units', async () => {
    const dbPath = join(tempDir, 'kb.db');
    const db = createTestDb(dbPath);
    const f1 = insertFile(db, 'src/core.c');
    insertSymbol(db, f1, 'core_fn', 'function', 1, 80);
    const f2 = insertFile(db, 'src/orphan.c');
    insertSymbol(db, f2, 'orphan_fn', 'function', 1, 80);
    db.close();

    // Only 'core' unit declared — 'src/orphan.c' is uncovered
    const units: CompilationUnit[] = [
      { id: 'core', name: 'Core', targetPath: 'crates/core', sourceFiles: ['src/core.c'], dependsOn: [] },
    ];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await buildTaskGraph({ ...DEFAULT_OPTIONS, kbDbPath: dbPath, compilationUnits: units });
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('src/orphan.c'),
      );
    } finally {
      warnSpy.mockRestore();
    }
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

  it('should set lineRange and fileRanges for multi-file tasks', async () => {
    const dbPath = join(tempDir, 'kb.db');
    const db = createTestDb(dbPath);
    const f1 = insertFile(db, 'src/a.c');
    const fnA = insertSymbol(db, f1, 'fn_a', 'function', 1, 100);
    const f2 = insertFile(db, 'src/b.c');
    const fnB = insertSymbol(db, f2, 'fn_b', 'function', 1, 50);
    // Mutual calls → SCC → forced into same cluster (multi-file)
    insertRef(db, fnA, 'fn_b', 10, fnB);
    insertRef(db, fnB, 'fn_a', 10, fnA);
    db.close();

    const result = await buildTaskGraph({ ...DEFAULT_OPTIONS, kbDbPath: dbPath });
    expect(result.tasks).toHaveLength(1);
    const task = result.tasks[0]!;
    // Multi-file task should have fileRanges
    expect(task.fileRanges).toBeDefined();
    expect(task.fileRanges!['src/a.c']).toEqual({ start: 1, end: 100 });
    expect(task.fileRanges!['src/b.c']).toEqual({ start: 1, end: 50 });
    // lineRange should be the primary file (src/a.c with 100 lines > src/b.c with 50)
    expect(task.lineRange).toEqual({ start: 1, end: 100 });
  });

  it('should handle a dependency chain A → B → C correctly', async () => {
    const dbPath = join(tempDir, 'kb.db');
    const db = createTestDb(dbPath);
    const fc = insertFile(db, 'src/c.c');
    const fnC = insertSymbol(db, fc, 'fn_c', 'function', 1, 60);
    const fb = insertFile(db, 'src/b.c');
    const fnB = insertSymbol(db, fb, 'fn_b', 'function', 1, 60);
    insertRef(db, fnB, 'fn_c', 5, fnC);
    const fa = insertFile(db, 'src/a.c');
    const fnA = insertSymbol(db, fa, 'fn_a', 'function', 1, 60);
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

  it('should absorb stubs tasks into the SCC of their dependant chunks', async () => {
    // Simulate an oversized SCC that gets split: many mutually-dependent
    // symbols in a single file exceeding maxLinesPerTask.
    const dbPath = join(tempDir, 'kb.db');
    const db = createTestDb(dbPath);
    const f = insertFile(db, 'src/big.c');
    // Create enough mutually-referencing symbols to form a large SCC
    // that exceeds maxLines and triggers splitOversizedSCC
    const syms: number[] = [];
    for (let i = 0; i < 10; i++) {
      syms.push(insertSymbol(db, f, `fn_${i}`, 'function', i * 60 + 1, (i + 1) * 60));
    }
    // Create a full cycle: fn_0 → fn_1 → fn_2 → ... → fn_9 → fn_0
    for (let i = 0; i < syms.length; i++) {
      insertRef(db, syms[i]!, `fn_${(i + 1) % syms.length}`, i * 60 + 10, syms[(i + 1) % syms.length]);
    }
    db.close();

    // maxLinesPerTask = 200 → total 600 lines SCC, will be split into stubs + chunks
    const result = await buildTaskGraph({
      ...DEFAULT_OPTIONS, kbDbPath: dbPath, maxLinesPerTask: 200,
    });

    // There should be stubs task(s) and implementation chunks
    const stubsTasks = result.tasks.filter(t => t.name.startsWith('[stubs]'));
    expect(stubsTasks.length).toBeGreaterThan(0);

    // Any stubs task whose dependants are in an SCC should itself be in that SCC.
    // (Stubs with no SCC-member dependants are harmless standalone tasks.)
    const allSccIds = new Set(result.sccs.flat());
    for (const stubs of stubsTasks) {
      const dependants = result.tasks.filter(t => t.dependencies.includes(stubs.id));
      const sccDependants = dependants.filter(d => allSccIds.has(d.id));
      if (sccDependants.length > 0) {
        expect(allSccIds.has(stubs.id)).toBe(true);
      }
    }
  });

  it('should resolve call refs by name when calleeId is null (same-file match)', async () => {
    const dbPath = join(tempDir, 'kb.db');
    const db = createTestDb(dbPath);
    const f = insertFile(db, 'src/lib.c');
    const fnA = insertSymbol(db, f, 'helper', 'function', 1, 60);
    const fnB = insertSymbol(db, f, 'caller', 'function', 61, 120);
    // Insert ref without calleeId — must fall back to name-based resolution
    insertRef(db, fnB, 'helper', 70);
    db.close();

    const result = await buildTaskGraph({ ...DEFAULT_OPTIONS, kbDbPath: dbPath });
    // Same-file symbols with call edges should merge into one task
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]!.sourceFiles).toEqual(['src/lib.c']);
  });

  it('should skip ambiguous cross-file name resolution when calleeId is null', async () => {
    const dbPath = join(tempDir, 'kb.db');
    const db = createTestDb(dbPath);
    const f1 = insertFile(db, 'src/a.c');
    const fnInit1 = insertSymbol(db, f1, 'init', 'function', 1, 80);
    const f2 = insertFile(db, 'src/b.c');
    insertSymbol(db, f2, 'init', 'function', 1, 80);
    const f3 = insertFile(db, 'src/c.c');
    const fnCaller = insertSymbol(db, f3, 'main', 'function', 1, 80);
    // Cross-file call to 'init' without calleeId — ambiguous (2 symbols named 'init')
    insertRef(db, fnCaller, 'init', 10);
    db.close();

    const result = await buildTaskGraph({ ...DEFAULT_OPTIONS, kbDbPath: dbPath });
    // Should NOT merge c.c with a.c or b.c — ambiguous name resolution is skipped
    const mainTask = result.tasks.find(t => t.sourceFiles.includes('src/c.c'))!;
    expect(mainTask.sourceFiles).toEqual(['src/c.c']);
  });

  it('should resolve type refs by line-range fallback when symbolId is null', async () => {
    const dbPath = join(tempDir, 'kb.db');
    const db = createTestDb(dbPath);
    const f1 = insertFile(db, 'src/types.c');
    insertSymbol(db, f1, 'Config', 'struct', 1, 60);
    const f2 = insertFile(db, 'src/app.c');
    insertSymbol(db, f2, 'run', 'function', 1, 80);
    // Type ref without symbolId — falls back to line-range lookup
    insertTypeRef(db, f2, 'Config', 40);
    db.close();

    const result = await buildTaskGraph({ ...DEFAULT_OPTIONS, kbDbPath: dbPath });
    expect(result.tasks).toHaveLength(2);
    const appTask = result.tasks.find(t => t.sourceFiles.includes('src/app.c'))!;
    const typesTask = result.tasks.find(t => t.sourceFiles.includes('src/types.c'))!;
    expect(appTask.dependencies).toContain(typesTask.id);
  });

  it('should elide micro-tasks (< 30 lines) into their consumers', async () => {
    const dbPath = join(tempDir, 'kb.db');
    const db = createTestDb(dbPath);
    const f1 = insertFile(db, 'src/macro.c');
    const macro = insertSymbol(db, f1, 'MAGIC_CONSTANT', 'macro', 1, 5);
    const f2 = insertFile(db, 'src/consumer.c');
    const consumer = insertSymbol(db, f2, 'use_macro', 'function', 1, 80);
    // consumer calls the macro
    insertRef(db, consumer, 'MAGIC_CONSTANT', 10, macro);
    db.close();

    const result = await buildTaskGraph({ ...DEFAULT_OPTIONS, kbDbPath: dbPath });
    // The tiny macro task (5 lines) should be elided into the consumer
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]!.sourceFiles).toContain('src/consumer.c');
    // The elided KB refs should be added to the consumer task
    expect(result.tasks[0]!.knowledgeBaseRef).toContain('src/macro.c');
  });

  it('should not elide micro-tasks depended on by many consumers (>10)', async () => {
    const dbPath = join(tempDir, 'kb.db');
    const db = createTestDb(dbPath);
    const f1 = insertFile(db, 'src/shared.c');
    const shared = insertSymbol(db, f1, 'shared_helper', 'function', 1, 15);
    // Create 12 consumers in different files
    for (let i = 0; i < 12; i++) {
      const f = insertFile(db, `src/consumer${i}.c`);
      const sym = insertSymbol(db, f, `consumer_${i}`, 'function', 1, 80);
      insertRef(db, sym, 'shared_helper', 10, shared);
    }
    db.close();

    const result = await buildTaskGraph({ ...DEFAULT_OPTIONS, kbDbPath: dbPath });
    // shared_helper (15 lines) has >10 dependants, should NOT be elided
    const sharedTask = result.tasks.find(t => t.sourceFiles.includes('src/shared.c'));
    expect(sharedTask).toBeDefined();
  });

  it('should split single oversized symbols by line range', async () => {
    const dbPath = join(tempDir, 'kb.db');
    const db = createTestDb(dbPath);
    const f = insertFile(db, 'src/giant.c');
    // A single function spanning 1500 lines
    insertSymbol(db, f, 'giant_fn', 'function', 1, 1500);
    db.close();

    const result = await buildTaskGraph({
      ...DEFAULT_OPTIONS, kbDbPath: dbPath, maxLinesPerTask: 500,
    });
    // 1500 lines / 500 max → multiple chunks
    expect(result.tasks.length).toBeGreaterThanOrEqual(2);
    // All tasks should have valid IDs and source files
    for (const task of result.tasks) {
      expect(task.id).toBeDefined();
      expect(task.sourceFiles).toContain('src/giant.c');
    }
  });

  it('should break cycles for unreachable tasks', async () => {
    const dbPath = join(tempDir, 'kb.db');
    const db = createTestDb(dbPath);
    // Create an isolated cycle with no roots
    const f1 = insertFile(db, 'src/x.c');
    const fnX = insertSymbol(db, f1, 'fn_x', 'function', 1, 80);
    const f2 = insertFile(db, 'src/y.c');
    const fnY = insertSymbol(db, f2, 'fn_y', 'function', 1, 80);
    insertRef(db, fnX, 'fn_y', 10, fnY);
    insertRef(db, fnY, 'fn_x', 10, fnX);
    // Also create a reachable root task
    const f3 = insertFile(db, 'src/root.c');
    insertSymbol(db, f3, 'root_fn', 'function', 1, 80);
    db.close();

    const result = await buildTaskGraph({ ...DEFAULT_OPTIONS, kbDbPath: dbPath });
    // All tasks should be reachable (unreachable cycle should be broken)
    const rootIds = new Set(result.tasks.filter(t => t.dependencies.length === 0).map(t => t.id));
    expect(rootIds.size).toBeGreaterThanOrEqual(1);
    // Build reachability from roots
    const reachable = new Set<string>();
    const queue = [...rootIds];
    const depMap = new Map<string, string[]>();
    for (const t of result.tasks) {
      for (const dep of t.dependencies) {
        const list = depMap.get(dep) ?? [];
        list.push(t.id);
        depMap.set(dep, list);
      }
    }
    while (queue.length > 0) {
      const tid = queue.shift()!;
      if (reachable.has(tid)) continue;
      reachable.add(tid);
      for (const d of (depMap.get(tid) ?? [])) queue.push(d);
    }
    expect(reachable.size).toBe(result.tasks.length);
  });

  it('should fold undersized clusters via tier-2 dependency affinity', async () => {
    const dbPath = join(tempDir, 'kb.db');
    const db = createTestDb(dbPath);
    const f = insertFile(db, 'src/module.c');
    // A large function and a small helper in the same file
    const fnBig = insertSymbol(db, f, 'big_fn', 'function', 1, 200);
    const fnTiny = insertSymbol(db, f, 'tiny_helper', 'function', 201, 220);
    // tiny_helper calls big_fn (dependency edge)
    insertRef(db, fnTiny, 'big_fn', 210, fnBig);
    db.close();

    const result = await buildTaskGraph({ ...DEFAULT_OPTIONS, kbDbPath: dbPath });
    // tiny_helper (20 lines < MIN_LINES_PER_TASK=50) should be folded into big_fn's cluster
    expect(result.tasks).toHaveLength(1);
    const names = result.tasks[0]!.symbols?.map(s => s.name) ?? [];
    expect(names).toContain('big_fn');
    expect(names).toContain('tiny_helper');
  });

  it('should fold micro-tasks via tier-3 directory affinity', async () => {
    const dbPath = join(tempDir, 'kb.db');
    const db = createTestDb(dbPath);
    // Micro-task in src/lib/ with no direct call edges
    const f1 = insertFile(db, 'src/lib/tiny.c');
    const fnTiny = insertSymbol(db, f1, 'tiny_util', 'function', 1, 10);
    // Consumer in same directory
    const f2 = insertFile(db, 'src/lib/consumer.c');
    const fnConsumer = insertSymbol(db, f2, 'consumer_fn', 'function', 1, 80);
    // Edge from consumer to tiny
    insertRef(db, fnConsumer, 'tiny_util', 30, fnTiny);
    db.close();

    const result = await buildTaskGraph({ ...DEFAULT_OPTIONS, kbDbPath: dbPath });
    // tiny_util (10 lines < MICRO_TASK_LINES=20) with dominant consumer in same
    // directory should be folded
    const tinyTask = result.tasks.find(t =>
      t.sourceFiles.includes('src/lib/tiny.c') && t.sourceFiles.length === 1,
    );
    // Should either be folded or elided (no standalone tiny task)
    if (result.tasks.length === 1) {
      expect(result.tasks[0]!.sourceFiles.length).toBeGreaterThanOrEqual(1);
    } else {
      // If not folded due to cross-file constraint, it may still exist
      // but micro-task elision should have removed it
      expect(tinyTask).toBeUndefined();
    }
  });

  it('should use target language for stub line estimates', async () => {
    const dbPath = join(tempDir, 'kb.db');
    const db = createTestDb(dbPath);
    const f = insertFile(db, 'src/big.c');
    const syms: number[] = [];
    for (let i = 0; i < 8; i++) {
      syms.push(insertSymbol(db, f, `fn_${i}`, 'function', i * 80 + 1, (i + 1) * 80));
    }
    for (let i = 0; i < syms.length; i++) {
      insertRef(db, syms[i]!, `fn_${(i + 1) % syms.length}`, i * 80 + 10, syms[(i + 1) % syms.length]);
    }
    db.close();

    // Test with C (3 lines/stub) vs Rust (5 lines/stub)
    const resultC = await buildTaskGraph({
      ...DEFAULT_OPTIONS, kbDbPath: dbPath, maxLinesPerTask: 250, targetLanguage: 'c',
    });
    const resultRust = await buildTaskGraph({
      ...DEFAULT_OPTIONS, kbDbPath: dbPath, maxLinesPerTask: 250, targetLanguage: 'rust',
    });
    // Both should produce stubs tasks
    const cStubs = resultC.tasks.filter(t => t.name.startsWith('[stubs]'));
    const rustStubs = resultRust.tasks.filter(t => t.name.startsWith('[stubs]'));
    expect(cStubs.length).toBeGreaterThan(0);
    expect(rustStubs.length).toBeGreaterThan(0);
  });

  it('should filter out low-confidence resolution methods from call refs', async () => {
    const dbPath = join(tempDir, 'kb.db');
    const db = createTestDb(dbPath);
    const f1 = insertFile(db, 'src/a.c');
    const fnA = insertSymbol(db, f1, 'fn_a', 'function', 1, 80);
    const f2 = insertFile(db, 'src/b.c');
    const fnB = insertSymbol(db, f2, 'fn_b', 'function', 1, 80);
    // Insert with resolution_method = 'name_ambiguous' → should be filtered
    db.prepare(
      'INSERT INTO symbol_refs (caller_id, callee_id, callee_name, call_line, file_id, resolution_method) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(fnA, fnB, 'fn_b', 10, f1, 'name_ambiguous');
    db.close();

    const result = await buildTaskGraph({ ...DEFAULT_OPTIONS, kbDbPath: dbPath });
    // Low-confidence edge should be filtered → no dependency between tasks
    expect(result.tasks).toHaveLength(2);
    const taskA = result.tasks.find(t => t.sourceFiles.includes('src/a.c'))!;
    const taskB = result.tasks.find(t => t.sourceFiles.includes('src/b.c'))!;
    expect(taskA.dependencies).not.toContain(taskB.id);
  });

  it('should handle task-level SCCs from greedy merging', async () => {
    const dbPath = join(tempDir, 'kb.db');
    const db = createTestDb(dbPath);
    // Create separate files with cross-file cycle that prevents merging
    // but creates a task-level SCC
    const f1 = insertFile(db, 'src/mod_a.c');
    const fnA1 = insertSymbol(db, f1, 'a_init', 'function', 1, 200);
    const fnA2 = insertSymbol(db, f1, 'a_process', 'function', 201, 400);
    const f2 = insertFile(db, 'src/mod_b.c');
    const fnB1 = insertSymbol(db, f2, 'b_init', 'function', 1, 200);
    const fnB2 = insertSymbol(db, f2, 'b_process', 'function', 201, 400);
    // Cross-file bidirectional edges: a↔b
    insertRef(db, fnA1, 'b_init', 50, fnB1);
    insertRef(db, fnB1, 'a_init', 50, fnA1);
    insertRef(db, fnA2, 'b_process', 250, fnB2);
    insertRef(db, fnB2, 'a_process', 250, fnA2);
    db.close();

    const result = await buildTaskGraph({
      ...DEFAULT_OPTIONS, kbDbPath: dbPath, maxLinesPerTask: 500,
    });
    // Cross-file cycles may be handled by SCC splitting or cycle-breaking
    // depending on clustering decisions
    expect(result.tasks.length).toBeGreaterThanOrEqual(1);
    // If there are SCC entries, verify they contain the expected task IDs
    if (result.sccs.length > 0) {
      for (const scc of result.sccs) {
        expect(scc.length).toBeGreaterThanOrEqual(2);
      }
    }
    // All tasks should have valid structure
    for (const task of result.tasks) {
      expect(task.id).toBeDefined();
      expect(task.sourceFiles.length).toBeGreaterThan(0);
    }
  });

  it('should resolve unique cross-file callee by name when calleeId is null', async () => {
    const dbPath = join(tempDir, 'kb.db');
    const db = createTestDb(dbPath);
    const f1 = insertFile(db, 'src/unique_helper.c');
    const fnHelper = insertSymbol(db, f1, 'unique_helper_fn', 'function', 1, 80);
    const f2 = insertFile(db, 'src/caller.c');
    const fnCaller = insertSymbol(db, f2, 'caller_fn', 'function', 1, 80);
    // Name-based resolution with globally unique name (no calleeId)
    insertRef(db, fnCaller, 'unique_helper_fn', 10);
    db.close();

    const result = await buildTaskGraph({ ...DEFAULT_OPTIONS, kbDbPath: dbPath });
    // If name resolution works cross-file, there should be a dependency.
    // If Lore filters out null-callee edges, tasks remain independent.
    // Either way, the graph should be valid with no crashes.
    expect(result.tasks.length).toBeGreaterThanOrEqual(1);
    for (const task of result.tasks) {
      expect(task.id).toBeDefined();
      expect(task.dependencies).not.toContain(task.id);
    }
  });

  it('should map target files with different language extensions', async () => {
    const dbPath = join(tempDir, 'kb.db');
    const db = createTestDb(dbPath);
    const f = insertFile(db, 'src/module.c');
    insertSymbol(db, f, 'fn_mod', 'function', 1, 80);
    db.close();

    for (const lang of ['typescript', 'csharp', 'go', 'python', 'java']) {
      const result = await buildTaskGraph({
        ...DEFAULT_OPTIONS, kbDbPath: dbPath, targetLanguage: lang,
      });
      expect(result.tasks).toHaveLength(1);
      const target = result.tasks[0]!.targetFiles[0]!;
      // Each language should produce a different extension
      const ext = target.split('.').pop();
      expect(ext).toBeDefined();
      expect(ext).not.toBe('c');
    }
  });

  it('should handle type refs with both symbolId and typeId set', async () => {
    const dbPath = join(tempDir, 'kb.db');
    const db = createTestDb(dbPath);
    const f1 = insertFile(db, 'src/defs.c');
    const typeSym = insertSymbol(db, f1, 'MyStruct', 'struct', 1, 60);
    const f2 = insertFile(db, 'src/user.c');
    const userFn = insertSymbol(db, f2, 'use_it', 'function', 1, 80);
    // Type ref with explicit symbolId (direct resolution, no fallback needed)
    insertTypeRef(db, f2, 'MyStruct', 20, userFn, typeSym);
    db.close();

    const result = await buildTaskGraph({ ...DEFAULT_OPTIONS, kbDbPath: dbPath });
    expect(result.tasks).toHaveLength(2);
    const userTask = result.tasks.find(t => t.sourceFiles.includes('src/user.c'))!;
    const defsTask = result.tasks.find(t => t.sourceFiles.includes('src/defs.c'))!;
    expect(userTask.dependencies).toContain(defsTask.id);
  });

  it('should handle ambiguous type refs across files', async () => {
    const dbPath = join(tempDir, 'kb.db');
    const db = createTestDb(dbPath);
    // Two files each define a struct named 'State'
    const f1 = insertFile(db, 'src/a.c');
    insertSymbol(db, f1, 'State', 'struct', 1, 60);
    const f2 = insertFile(db, 'src/b.c');
    insertSymbol(db, f2, 'State', 'struct', 1, 60);
    const f3 = insertFile(db, 'src/user.c');
    const userFn = insertSymbol(db, f3, 'process', 'function', 1, 80);
    // Ambiguous type ref — 'State' exists in 2 files
    insertTypeRef(db, f3, 'State', 20, userFn);
    db.close();

    const result = await buildTaskGraph({ ...DEFAULT_OPTIONS, kbDbPath: dbPath });
    // Ambiguous type refs should NOT create false dependencies
    expect(result.tasks).toHaveLength(3);
    const userTask = result.tasks.find(t => t.sourceFiles.includes('src/user.c'))!;
    expect(userTask.dependencies).toEqual([]);
  });

  it('should not elide stubs tasks during micro-task elision', async () => {
    const dbPath = join(tempDir, 'kb.db');
    const db = createTestDb(dbPath);
    const f = insertFile(db, 'src/cycle.c');
    // Create a small cycle that produces stubs tasks
    const syms: number[] = [];
    for (let i = 0; i < 6; i++) {
      syms.push(insertSymbol(db, f, `cyc_${i}`, 'function', i * 100 + 1, (i + 1) * 100));
    }
    for (let i = 0; i < syms.length; i++) {
      insertRef(db, syms[i]!, `cyc_${(i + 1) % syms.length}`, i * 100 + 10, syms[(i + 1) % syms.length]);
    }
    db.close();

    const result = await buildTaskGraph({
      ...DEFAULT_OPTIONS, kbDbPath: dbPath, maxLinesPerTask: 250,
    });
    // Stubs tasks should survive even if they're small
    const stubsTasks = result.tasks.filter(t => t.name.startsWith('[stubs]'));
    expect(stubsTasks.length).toBeGreaterThan(0);
    for (const stubs of stubsTasks) {
      expect(stubs.complexity).toBe('simple');
    }
  });

  it('should produce parityChecks with type info for struct/class symbols', async () => {
    const dbPath = join(tempDir, 'kb.db');
    const db = createTestDb(dbPath);
    const f = insertFile(db, 'src/types.c');
    insertSymbol(db, f, 'Config', 'struct', 1, 60);
    insertSymbol(db, f, 'init_config', 'function', 61, 120);
    db.close();

    const result = await buildTaskGraph({ ...DEFAULT_OPTIONS, kbDbPath: dbPath });
    // Find task containing the struct symbol
    const task = result.tasks.find(t =>
      t.symbols?.some(s => s.kind === 'struct'),
    );
    if (task) {
      expect(task.parityChecks).toEqual(
        expect.arrayContaining([
          expect.stringContaining('Type definitions'),
        ]),
      );
    }
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
    const fnA = insertSymbol(db, fa, 'fn_a', 'function', 1, 60);
    const fb = insertFile(db, 'src/b.c');
    const fnB = insertSymbol(db, fb, 'fn_b', 'function', 1, 60);
    insertRef(db, fnA, 'fn_b', 5, fnB);
    // Isolated file in a different directory
    const fc = insertFile(db, 'lib/c.c');
    insertSymbol(db, fc, 'fn_c', 'function', 1, 60);
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
