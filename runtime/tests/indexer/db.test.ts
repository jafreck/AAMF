import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { openDb, setKbMeta, getKbMeta, createVec0Tables, computeSourceFingerprint, getKbFingerprint, setKbFingerprint } from '../../src/indexer/db.js';

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

describe('setKbMeta / getKbMeta', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'aamf-meta-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should write and read a key-value pair', () => {
    const db = openDb(join(tempDir, 'meta.db'));
    setKbMeta(db, 'version', '42');
    expect(getKbMeta(db, 'version')).toBe('42');
    db.close();
  });

  it('should return undefined for a missing key', () => {
    const db = openDb(join(tempDir, 'meta.db'));
    expect(getKbMeta(db, 'nonexistent')).toBeUndefined();
    db.close();
  });

  it('should overwrite an existing key with INSERT OR REPLACE', () => {
    const db = openDb(join(tempDir, 'meta.db'));
    setKbMeta(db, 'model', 'modelA');
    setKbMeta(db, 'model', 'modelB');
    expect(getKbMeta(db, 'model')).toBe('modelB');
    db.close();
  });

  it('should store multiple independent keys', () => {
    const db = openDb(join(tempDir, 'meta.db'));
    setKbMeta(db, 'key1', 'val1');
    setKbMeta(db, 'key2', 'val2');
    expect(getKbMeta(db, 'key1')).toBe('val1');
    expect(getKbMeta(db, 'key2')).toBe('val2');
    db.close();
  });
});

describe('computeSourceFingerprint', () => {
  it('should return a 64-character hex string (SHA-256)', () => {
    const fp = computeSourceFingerprint('/root', { includeGlobs: ['**/*.ts'], excludeGlobs: [] });
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  it('should be deterministic for the same inputs', () => {
    const a = computeSourceFingerprint('/root', { includeGlobs: ['*.py'], excludeGlobs: ['test_*'] });
    const b = computeSourceFingerprint('/root', { includeGlobs: ['*.py'], excludeGlobs: ['test_*'] });
    expect(a).toBe(b);
  });

  it('should differ when rootDir changes', () => {
    const a = computeSourceFingerprint('/rootA', {});
    const b = computeSourceFingerprint('/rootB', {});
    expect(a).not.toBe(b);
  });

  it('should differ when includeGlobs change', () => {
    const a = computeSourceFingerprint('/root', { includeGlobs: ['*.ts'] });
    const b = computeSourceFingerprint('/root', { includeGlobs: ['*.py'] });
    expect(a).not.toBe(b);
  });

  it('should differ when excludeGlobs change', () => {
    const a = computeSourceFingerprint('/root', { excludeGlobs: ['node_modules'] });
    const b = computeSourceFingerprint('/root', { excludeGlobs: ['dist'] });
    expect(a).not.toBe(b);
  });

  it('should differ when embeddingModel changes', () => {
    const a = computeSourceFingerprint('/root', {}, 'modelA');
    const b = computeSourceFingerprint('/root', {}, 'modelB');
    expect(a).not.toBe(b);
  });

  it('should treat missing globs as empty arrays', () => {
    const a = computeSourceFingerprint('/root', {});
    const b = computeSourceFingerprint('/root', { includeGlobs: [], excludeGlobs: [] });
    expect(a).toBe(b);
  });

  it('should treat missing embeddingModel as empty string', () => {
    const a = computeSourceFingerprint('/root', {});
    const b = computeSourceFingerprint('/root', {}, undefined);
    expect(a).toBe(b);
  });
});

describe('getKbFingerprint / setKbFingerprint', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'aamf-fp-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should return undefined when no fingerprint is stored', () => {
    const db = openDb(join(tempDir, 'fp.db'));
    expect(getKbFingerprint(db)).toBeUndefined();
    db.close();
  });

  it('should store and retrieve a fingerprint', () => {
    const db = openDb(join(tempDir, 'fp.db'));
    const fp = computeSourceFingerprint('/root', { includeGlobs: ['**/*.ts'] });
    setKbFingerprint(db, fp);
    expect(getKbFingerprint(db)).toBe(fp);
    db.close();
  });

  it('should overwrite an existing fingerprint', () => {
    const db = openDb(join(tempDir, 'fp.db'));
    setKbFingerprint(db, 'first');
    setKbFingerprint(db, 'second');
    expect(getKbFingerprint(db)).toBe('second');
    db.close();
  });

  it('should store fingerprint under source_fingerprint key in kb_meta', () => {
    const db = openDb(join(tempDir, 'fp.db'));
    setKbFingerprint(db, 'abc123');
    expect(getKbMeta(db, 'source_fingerprint')).toBe('abc123');
    db.close();
  });
});

describe('createVec0Tables', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'aamf-vec0-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should create symbol_embeddings and symbol_semantic_embeddings tables', () => {
    const db = openDb(join(tempDir, 'vec.db'));
    createVec0Tables(db, 1024);

    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all()
      .map((r: any) => r.name as string);

    expect(tables).toContain('symbol_embeddings');
    expect(tables).toContain('symbol_semantic_embeddings');
    db.close();
  });

  it('should store embedding_dims in kb_meta', () => {
    const db = openDb(join(tempDir, 'vec.db'));
    createVec0Tables(db, 2560);
    expect(getKbMeta(db, 'embedding_dims')).toBe('2560');
    db.close();
  });

  it('should be idempotent — calling twice does not throw', () => {
    const db = openDb(join(tempDir, 'vec.db'));
    createVec0Tables(db, 1024);
    expect(() => createVec0Tables(db, 1024)).not.toThrow();
    db.close();
  });
});
