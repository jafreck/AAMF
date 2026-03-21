import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SymbolMapper } from '../../src/core/symbol-mapper.js';
import { TargetIndexer } from '../../src/core/target-indexer.js';
import { createSilentLogger } from '../helpers/mocks.js';

describe('SymbolMapper', () => {
  let tempDir: string;
  let rootDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'aamf-symbol-mapper-'));
    rootDir = join(tempDir, 'target');
    dbPath = join(tempDir, 'kb-target.db');
    await mkdir(rootDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function buildTargetIndex(files: Record<string, string>): Promise<void> {
    for (const [name, content] of Object.entries(files)) {
      const dir = join(rootDir, ...name.split('/').slice(0, -1));
      await mkdir(dir, { recursive: true });
      await writeFile(join(rootDir, name), content);
    }
    const logger = createSilentLogger(tempDir);
    const indexer = new TargetIndexer(dbPath, rootDir, logger);
    await indexer.build();
  }

  it('ensureSchema creates the symbol_mapping table', async () => {
    // Need to first create a Lore DB at this path.
    await buildTargetIndex({ 'main.rs': 'fn main() {}\n' });

    const logger = createSilentLogger(tempDir);
    const mapper = new SymbolMapper(dbPath, logger);
    await mapper.ensureSchema();

    // Verify table exists
    const lore = await import('@jafreck/lore');
    const db = lore.openDb(dbPath);
    try {
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='symbol_mapping'",
      ).all();
      expect(tables).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it('updateMappingsForTask maps matching symbols', async () => {
    // Create target with a function that matches a source symbol.
    await buildTargetIndex({
      'lib/common/zstd_deps.rs': [
        'pub fn zstd_memcpy(dst: &mut [u8], src: &[u8]) {',
        '    dst.copy_from_slice(src);',
        '}',
        'pub fn zstd_free(ptr: *mut u8) {',
        '    // no-op in Rust',
        '}',
        '',
      ].join('\n'),
    });

    const logger = createSilentLogger(tempDir);
    const mapper = new SymbolMapper(dbPath, logger);

    const result = await mapper.updateMappingsForTask(
      'task-156-0',
      [
        { name: 'ZSTD_memcpy', kind: 'macro', file: '/src/zstd_deps.h', startLine: 43, endLine: 44 },
        { name: 'ZSTD_free', kind: 'macro', file: '/src/zstd_deps.h', startLine: 67, endLine: 68 },
        { name: 'ZSTD_UNMATCHED_SYMBOL', kind: 'macro', file: '/src/zstd_deps.h', startLine: 100, endLine: 101 },
      ],
      [join(rootDir, 'lib/common/zstd_deps.rs')],
    );

    expect(result.mapped).toBeGreaterThanOrEqual(2);
    expect(result.unmapped).toBeGreaterThanOrEqual(0);
    expect(result.mapped + result.unmapped).toBe(3);
  });

  it('updateMappingsForTask is idempotent on retry', async () => {
    await buildTargetIndex({
      'main.rs': 'pub fn add(a: i32, b: i32) -> i32 { a + b }\n',
    });

    const logger = createSilentLogger(tempDir);
    const mapper = new SymbolMapper(dbPath, logger);

    const symbols = [
      { name: 'add', kind: 'function', file: '/src/math.c', startLine: 1, endLine: 5 },
    ];
    const targets = [join(rootDir, 'main.rs')];

    await mapper.updateMappingsForTask('task-1', symbols, targets);
    await mapper.updateMappingsForTask('task-1', symbols, targets);

    const rows = await mapper.lookupByTask('task-1');
    expect(rows).toHaveLength(1);
  });

  it('updateTaskStatus changes status for all task mappings', async () => {
    await buildTargetIndex({
      'main.rs': 'pub fn foo() {}\npub fn bar() {}\n',
    });

    const logger = createSilentLogger(tempDir);
    const mapper = new SymbolMapper(dbPath, logger);

    await mapper.updateMappingsForTask('task-1', [
      { name: 'foo', kind: 'function', file: '/src/a.c', startLine: 1, endLine: 5 },
      { name: 'bar', kind: 'function', file: '/src/a.c', startLine: 6, endLine: 10 },
    ], [join(rootDir, 'main.rs')]);

    await mapper.updateTaskStatus('task-1', 'parity-failed');

    const rows = await mapper.lookupByTask('task-1');
    expect(rows.every(r => r.status === 'parity-failed')).toBe(true);
  });

  it('lookupBySource returns matching rows', async () => {
    await buildTargetIndex({
      'main.rs': 'pub fn my_func() {}\n',
    });

    const logger = createSilentLogger(tempDir);
    const mapper = new SymbolMapper(dbPath, logger);

    await mapper.updateMappingsForTask('task-1', [
      { name: 'my_func', kind: 'function', file: '/src/a.c', startLine: 1, endLine: 5 },
    ], [join(rootDir, 'main.rs')]);

    const rows = await mapper.lookupBySource('my_func');
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].task_id).toBe('task-1');
  });

  it('lookupDependencyMappings returns mappings for specified tasks', async () => {
    await buildTargetIndex({
      'a.rs': 'pub fn alpha() {}\n',
      'b.rs': 'pub fn beta() {}\n',
    });

    const logger = createSilentLogger(tempDir);
    const mapper = new SymbolMapper(dbPath, logger);

    await mapper.updateMappingsForTask('dep-1', [
      { name: 'alpha', kind: 'function', file: '/src/a.c', startLine: 1, endLine: 5 },
    ], [join(rootDir, 'a.rs')]);

    await mapper.updateMappingsForTask('dep-2', [
      { name: 'beta', kind: 'function', file: '/src/b.c', startLine: 1, endLine: 5 },
    ], [join(rootDir, 'b.rs')]);

    await mapper.updateMappingsForTask('unrelated', [
      { name: 'gamma', kind: 'function', file: '/src/c.c', startLine: 1, endLine: 5 },
    ], []);

    const rows = await mapper.lookupDependencyMappings(['dep-1', 'dep-2']);
    const taskIds = rows.map(r => r.task_id);
    expect(taskIds).toContain('dep-1');
    expect(taskIds).toContain('dep-2');
    expect(taskIds).not.toContain('unrelated');
  });

  it('handles empty sourceSymbols array gracefully', async () => {
    await buildTargetIndex({ 'main.rs': 'fn main() {}\n' });

    const logger = createSilentLogger(tempDir);
    const mapper = new SymbolMapper(dbPath, logger);

    const result = await mapper.updateMappingsForTask('task-empty', [], []);
    expect(result.mapped).toBe(0);
    expect(result.unmapped).toBe(0);
  });

  it('handles empty dependency list gracefully', async () => {
    await buildTargetIndex({ 'main.rs': 'fn main() {}\n' });

    const logger = createSilentLogger(tempDir);
    const mapper = new SymbolMapper(dbPath, logger);

    const rows = await mapper.lookupDependencyMappings([]);
    expect(rows).toHaveLength(0);
  });

  it('toSnakeCase matching: UPPER_SNAKE maps to lower_snake in target', async () => {
    await buildTargetIndex({
      'funcs.rs': 'pub fn huf_blocksize_max() -> usize { 128 * 1024 }\n',
    });

    const logger = createSilentLogger(tempDir);
    const mapper = new SymbolMapper(dbPath, logger);

    const result = await mapper.updateMappingsForTask('task-snake', [
      { name: 'HUF_BLOCKSIZE_MAX', kind: 'macro', file: '/src/huf.h', startLine: 24, endLine: 25 },
    ], [join(rootDir, 'funcs.rs')]);

    expect(result.mapped).toBe(1);
  });
});
