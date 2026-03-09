/**
 * Tests for deterministic symbol-graph task decomposition.
 *
 * Each test creates a temporary SQLite KB database with known schema
 * (files, symbols, symbol_refs, type_refs) and verifies that `buildTaskGraph()`
 * and `buildDependencySummary()` produce correct results.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { buildTaskGraph, buildDependencySummary, findSCCs } from '../src/core/task-graph-builder.js';
import type { CompilationUnit } from '../src/agents/types.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

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
    expect(result.compilationUnits).toEqual([]);
  });

  it('should create one task per file when files are under maxLinesPerTask', async () => {
    const dbPath = join(tempDir, 'kb.db');
    const db = createTestDb(dbPath);
    const f1 = insertFile(db, 'lib/utils.c');
    insertSymbol(db, f1, 'add', 'function', 1, 10);
    const f2 = insertFile(db, 'lib/math.c');
    insertSymbol(db, f2, 'multiply', 'function', 1, 15);
    db.close();

    const result = await buildTaskGraph({ ...DEFAULT_OPTIONS, kbDbPath: dbPath });
    expect(result.tasks).toHaveLength(2);
    expect(result.tasks[0]!.targetFiles).toEqual(['target/src/lib/utils.rs']);
    expect(result.tasks[1]!.targetFiles).toEqual(['target/src/lib/math.rs']);
  });

  it('should generate globally unique task IDs with no collisions', async () => {
    const dbPath = join(tempDir, 'kb.db');
    const db = createTestDb(dbPath);
    for (let i = 0; i < 5; i++) {
      const fid = insertFile(db, `src/module${i}.c`);
      insertSymbol(db, fid, `fn_${i}`, 'function', 1, 50);
    }
    db.close();

    const result = await buildTaskGraph({ ...DEFAULT_OPTIONS, kbDbPath: dbPath });
    const ids = result.tasks.map(t => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('should split large files at symbol boundaries', async () => {
    const dbPath = join(tempDir, 'kb.db');
    const db = createTestDb(dbPath);
    const fid = insertFile(db, 'lib/big.c');
    insertSymbol(db, fid, 'init', 'function', 1, 100);
    insertSymbol(db, fid, 'process', 'function', 101, 300);
    insertSymbol(db, fid, 'cleanup', 'function', 301, 500);
    insertSymbol(db, fid, 'finalize', 'function', 501, 600);
    db.close();

    const result = await buildTaskGraph({ ...DEFAULT_OPTIONS, kbDbPath: dbPath, maxLinesPerTask: 200 });
    expect(result.tasks.length).toBeGreaterThan(1);
    for (const task of result.tasks) expect(task.sourceFiles).toEqual(['lib/big.c']);
  });

  it('should compute dependency edges from symbol_refs', async () => {
    const dbPath = join(tempDir, 'kb.db');
    const db = createTestDb(dbPath);
    const f1 = insertFile(db, 'src/helper.c');
    const helperSym = insertSymbol(db, f1, 'helper', 'function', 1, 30);
    const f2 = insertFile(db, 'src/main.c');
    const mainSym = insertSymbol(db, f2, 'main_fn', 'function', 1, 50);
    insertRef(db, mainSym, 'helper', 10, helperSym);
    db.close();

    const result = await buildTaskGraph({ ...DEFAULT_OPTIONS, kbDbPath: dbPath });
    const helperTask = result.tasks.find(t => t.sourceFiles[0] === 'src/helper.c')!;
    const mainTask = result.tasks.find(t => t.sourceFiles[0] === 'src/main.c')!;
    expect(mainTask.dependencies).toContain(helperTask.id);
    expect(helperTask.dependencies).toEqual([]);
  });

  it('should compute dependency edges from type_refs', async () => {
    const dbPath = join(tempDir, 'kb.db');
    const db = createTestDb(dbPath);
    // File A defines struct Config
    const f1 = insertFile(db, 'src/config.c');
    const configSym = insertSymbol(db, f1, 'Config', 'struct', 1, 20);
    // File B uses Config (type reference, no function call)
    const f2 = insertFile(db, 'src/app.c');
    const appSym = insertSymbol(db, f2, 'run_app', 'function', 1, 50);
    insertTypeRef(db, f2, 'Config', 5, appSym.valueOf() as number, configSym);
    db.close();

    const result = await buildTaskGraph({ ...DEFAULT_OPTIONS, kbDbPath: dbPath });
    const configTask = result.tasks.find(t => t.sourceFiles[0] === 'src/config.c')!;
    const appTask = result.tasks.find(t => t.sourceFiles[0] === 'src/app.c')!;
    expect(appTask.dependencies).toContain(configTask.id);
  });

  it('should detect SCCs for mutual imports', async () => {
    const dbPath = join(tempDir, 'kb.db');
    const db = createTestDb(dbPath);
    const f1 = insertFile(db, 'src/a.c');
    const fnA = insertSymbol(db, f1, 'fn_a', 'function', 1, 20);
    const f2 = insertFile(db, 'src/b.c');
    const fnB = insertSymbol(db, f2, 'fn_b', 'function', 1, 20);
    insertRef(db, fnA, 'fn_b', 5, fnB);
    insertRef(db, fnB, 'fn_a', 5, fnA);
    db.close();

    const result = await buildTaskGraph({ ...DEFAULT_OPTIONS, kbDbPath: dbPath });
    expect(result.sccs).toHaveLength(1);
    expect(result.sccs[0]!).toHaveLength(2);
  });

  it('should not include self-references in dependencies', async () => {
    const dbPath = join(tempDir, 'kb.db');
    const db = createTestDb(dbPath);
    const fid = insertFile(db, 'src/self.c');
    const fnA = insertSymbol(db, fid, 'fn_self', 'function', 1, 20);
    const fnB = insertSymbol(db, fid, 'fn_helper', 'function', 21, 40);
    insertRef(db, fnA, 'fn_helper', 5, fnB);
    db.close();

    const result = await buildTaskGraph({ ...DEFAULT_OPTIONS, kbDbPath: dbPath });
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]!.dependencies).toEqual([]);
  });

  it('should annotate tasks with compilation unit IDs', async () => {
    const dbPath = join(tempDir, 'kb.db');
    const db = createTestDb(dbPath);
    insertFile(db, 'src/core.c');
    insertFile(db, 'src/util.c');
    db.close();

    const units: CompilationUnit[] = [
      { id: 'core', name: 'Core', targetPath: 'crates/core', sourceFiles: ['src/core.c'], dependsOn: [] },
      { id: 'util', name: 'Utils', targetPath: 'crates/util', sourceFiles: ['src/util.c'], dependsOn: [] },
    ];

    const result = await buildTaskGraph({ ...DEFAULT_OPTIONS, kbDbPath: dbPath, compilationUnits: units });
    const coreTask = result.tasks.find(t => t.sourceFiles[0] === 'src/core.c')!;
    const utilTask = result.tasks.find(t => t.sourceFiles[0] === 'src/util.c')!;
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

    // Agent declares no cross-unit deps — runtime should add them
    const units: CompilationUnit[] = [
      { id: 'base', name: 'Base', targetPath: 'crates/base', sourceFiles: ['src/base.c'], dependsOn: [] },
      { id: 'app', name: 'App', targetPath: 'crates/app', sourceFiles: ['src/app.c'], dependsOn: [] },
    ];

    const result = await buildTaskGraph({ ...DEFAULT_OPTIONS, kbDbPath: dbPath, compilationUnits: units });
    const appUnit = result.compilationUnits.find(u => u.id === 'app')!;
    expect(appUnit.dependsOn).toContain('base');
  });

  it('should handle a realistic A→B→C dependency chain', async () => {
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
    const taskA = result.tasks.find(t => t.sourceFiles[0] === 'src/a.c')!;
    const taskB = result.tasks.find(t => t.sourceFiles[0] === 'src/b.c')!;
    const taskC = result.tasks.find(t => t.sourceFiles[0] === 'src/c.c')!;
    expect(taskA.dependencies).toContain(taskB.id);
    expect(taskB.dependencies).toContain(taskC.id);
    expect(taskC.dependencies).toEqual([]);
    expect(result.sccs).toEqual([]);
  });

  it('should produce type-only dependency when no call edge exists', async () => {
    const dbPath = join(tempDir, 'kb.db');
    const db = createTestDb(dbPath);
    const f1 = insertFile(db, 'src/types.c');
    insertSymbol(db, f1, 'MyStruct', 'struct', 1, 15);
    const f2 = insertFile(db, 'src/user.c');
    insertSymbol(db, f2, 'use_it', 'function', 1, 30);
    // Only a type_ref, no symbol_ref
    insertTypeRef(db, f2, 'MyStruct', 5);
    db.close();

    const result = await buildTaskGraph({ ...DEFAULT_OPTIONS, kbDbPath: dbPath });
    const typesTask = result.tasks.find(t => t.sourceFiles[0] === 'src/types.c')!;
    const userTask = result.tasks.find(t => t.sourceFiles[0] === 'src/user.c')!;
    expect(userTask.dependencies).toContain(typesTask.id);
  });
});

// ─── buildDependencySummary Tests ───────────────────────────────────────────

describe('buildDependencySummary', () => {
  let tempDir: string;

  beforeEach(async () => { tempDir = await mkdtemp(join(tmpdir(), 'aamf-dep-')); });
  afterEach(async () => { await rm(tempDir, { recursive: true, force: true }); });

  it('should return file count and metrics', async () => {
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
    expect(summary.fileMetrics['src/a.c']!.complexity).toBe('simple');
    expect(summary.fileMetrics['src/b.c']!.lines).toBe(200);
    expect(summary.fileMetrics['src/b.c']!.complexity).toBe('moderate');
  });

  it('should include call and type dependencies', async () => {
    const dbPath = join(tempDir, 'kb.db');
    const db = createTestDb(dbPath);
    const f1 = insertFile(db, 'src/base.c');
    const baseSym = insertSymbol(db, f1, 'base_fn', 'function', 1, 20);
    insertSymbol(db, f1, 'BaseType', 'struct', 21, 30);
    const f2 = insertFile(db, 'src/user.c');
    const userSym = insertSymbol(db, f2, 'user_fn', 'function', 1, 30);
    insertRef(db, userSym, 'base_fn', 5, baseSym);
    insertTypeRef(db, f2, 'BaseType', 10);
    db.close();

    const summary = await buildDependencySummary(dbPath);
    expect(summary.fileDependencies['src/user.c']!.calls).toContain('src/base.c');
    expect(summary.fileDependencies['src/user.c']!.usesTypes).toContain('src/base.c');
    expect(summary.fileDependencies['src/base.c']!.calledBy).toContain('src/user.c');
    expect(summary.fileDependencies['src/base.c']!.typesUsedBy).toContain('src/user.c');
  });

  it('should compute connected components', async () => {
    const dbPath = join(tempDir, 'kb.db');
    const db = createTestDb(dbPath);
    // Component 1: a ↔ b
    const fa = insertFile(db, 'src/a.c');
    const fnA = insertSymbol(db, fa, 'fn_a', 'function', 1, 20);
    const fb = insertFile(db, 'src/b.c');
    const fnB = insertSymbol(db, fb, 'fn_b', 'function', 1, 20);
    insertRef(db, fnA, 'fn_b', 5, fnB);
    // Component 2: c (isolated)
    insertFile(db, 'src/c.c');
    db.close();

    const summary = await buildDependencySummary(dbPath);
    expect(summary.connectedComponents.length).toBeGreaterThanOrEqual(2);
    const sizes = summary.connectedComponents.map(cc => cc.files.length).sort();
    expect(sizes).toContain(1); // isolated c
    expect(sizes).toContain(2); // a + b
  });

  it('should detect file-level SCCs', async () => {
    const dbPath = join(tempDir, 'kb.db');
    const db = createTestDb(dbPath);
    const f1 = insertFile(db, 'src/x.c');
    const fnX = insertSymbol(db, f1, 'fn_x', 'function', 1, 20);
    const f2 = insertFile(db, 'src/y.c');
    const fnY = insertSymbol(db, f2, 'fn_y', 'function', 1, 20);
    insertRef(db, fnX, 'fn_y', 5, fnY);
    insertRef(db, fnY, 'fn_x', 5, fnX);
    db.close();

    const summary = await buildDependencySummary(dbPath);
    expect(summary.sccs).toHaveLength(1);
    expect(summary.sccs[0]!.sort()).toEqual(['src/x.c', 'src/y.c']);
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
