import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { openDb } from '../../src/indexer/db.js';

describe('openDb', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'aamf-db-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should create a database file and return a Database instance', () => {
    const dbPath = join(tempDir, 'test.db');
    const db = openDb(dbPath);
    expect(db).toBeDefined();
    db.close();
  });

  it('should create all required tables', () => {
    const db = openDb(join(tempDir, 'schema.db'));

    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all()
      .map((r: any) => r.name as string);

    const expected = [
      'external_deps',
      'file_imports',
      'file_modules',
      'files',
      'kb_meta',
      'modules',
      'symbol_refs',
      'symbol_summaries',
      'symbols',
    ];

    for (const t of expected) {
      expect(tables).toContain(t);
    }

    db.close();
  });

  it('should enable WAL journal mode', () => {
    const db = openDb(join(tempDir, 'wal.db'));
    const row = db.pragma('journal_mode') as Array<{ journal_mode: string }>;
    expect(row[0]?.journal_mode).toBe('wal');
    db.close();
  });

  it('should enable foreign key enforcement', () => {
    const db = openDb(join(tempDir, 'fk.db'));
    const row = db.pragma('foreign_keys') as Array<{ foreign_keys: number }>;
    expect(row[0]?.foreign_keys).toBe(1);
    db.close();
  });

  it('should be idempotent — opening the same path twice does not throw', () => {
    const dbPath = join(tempDir, 'idempotent.db');
    const db1 = openDb(dbPath);
    db1.close();
    const db2 = openDb(dbPath);
    db2.close();
  });

  it('should allow inserting and querying kb_meta rows', () => {
    const db = openDb(join(tempDir, 'meta.db'));

    db.prepare(`INSERT INTO kb_meta (key, value) VALUES (?, ?)`).run('schema_version', '1');
    const row = db.prepare(`SELECT value FROM kb_meta WHERE key = ?`).get('schema_version') as
      | { value: string }
      | undefined;

    expect(row?.value).toBe('1');
    db.close();
  });

  it('should enforce the kb_meta PRIMARY KEY constraint', () => {
    const db = openDb(join(tempDir, 'pk.db'));

    db.prepare(`INSERT INTO kb_meta (key, value) VALUES (?, ?)`).run('k', 'v1');
    expect(() =>
      db.prepare(`INSERT INTO kb_meta (key, value) VALUES (?, ?)`).run('k', 'v2'),
    ).toThrow();

    db.close();
  });

  it('should cascade-delete symbols when a file is deleted', () => {
    const db = openDb(join(tempDir, 'cascade.db'));

    const fileId = (
      db
        .prepare(`INSERT INTO files (path, language, size_bytes) VALUES (?, ?, ?)`)
        .run('/a.ts', 'typescript', 0) as { lastInsertRowid: number | bigint }
    ).lastInsertRowid;

    db
      .prepare(
        `INSERT INTO symbols (file_id, name, kind, start_line, end_line) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(fileId, 'myFn', 'function', 1, 10);

    db.prepare(`DELETE FROM files WHERE id = ?`).run(fileId);

    const count = (
      db.prepare(`SELECT COUNT(*) as c FROM symbols WHERE file_id = ?`).get(fileId) as {
        c: number;
      }
    ).c;
    expect(count).toBe(0);
    db.close();
  });
});
