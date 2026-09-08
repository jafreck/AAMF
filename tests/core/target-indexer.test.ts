import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TargetIndexer } from '../../src/core/target-indexer.js';
import { createSilentLogger } from '../helpers/mocks.js';

describe('TargetIndexer', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'aamf-target-indexer-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('starts with isBuilt = false', () => {
    const logger = createSilentLogger(tempDir);
    const dbPath = join(tempDir, 'target.db');
    const indexer = new TargetIndexer(dbPath, tempDir, logger);
    expect(indexer.isBuilt).toBe(false);
  });

  it('markBuilt sets isBuilt without building', () => {
    const logger = createSilentLogger(tempDir);
    const dbPath = join(tempDir, 'target.db');
    const indexer = new TargetIndexer(dbPath, tempDir, logger);
    indexer.markBuilt();
    expect(indexer.isBuilt).toBe(true);
  });

  it('build() creates DB and sets isBuilt', async () => {
    const logger = createSilentLogger(tempDir);
    const rootDir = join(tempDir, 'src');
    await mkdir(rootDir, { recursive: true });
    await writeFile(join(rootDir, 'main.rs'), 'fn main() { println!("hello"); }\n');

    const dbPath = join(tempDir, 'target.db');
    const indexer = new TargetIndexer(dbPath, rootDir, logger);
    await indexer.build();
    expect(indexer.isBuilt).toBe(true);

    // Verify DB exists and has content
    const { openReadOnly, listFiles } = await import('@jafreck/lore');
    const db = openReadOnly(dbPath);
    try {
      const files = listFiles(db);
      expect(files.length).toBeGreaterThanOrEqual(1);
    } finally {
      db.close();
    }
  });

  it('updateForFiles() triggers full build on first call', async () => {
    const logger = createSilentLogger(tempDir);
    const rootDir = join(tempDir, 'src');
    await mkdir(rootDir, { recursive: true });
    await writeFile(join(rootDir, 'lib.rs'), 'pub fn add(a: i32, b: i32) -> i32 { a + b }\n');

    const dbPath = join(tempDir, 'target.db');
    const indexer = new TargetIndexer(dbPath, rootDir, logger);

    await indexer.updateForFiles([join(rootDir, 'lib.rs')]);
    expect(indexer.isBuilt).toBe(true);
  });

  it('updateForFiles() incrementally updates after first build', async () => {
    const logger = createSilentLogger(tempDir);
    const rootDir = join(tempDir, 'src');
    await mkdir(rootDir, { recursive: true });
    await writeFile(join(rootDir, 'lib.rs'), 'pub fn add(a: i32, b: i32) -> i32 { a + b }\n');

    const dbPath = join(tempDir, 'target.db');
    const indexer = new TargetIndexer(dbPath, rootDir, logger);

    // First update — full build
    await indexer.updateForFiles([join(rootDir, 'lib.rs')]);

    // Add a new file
    await writeFile(join(rootDir, 'util.rs'), 'pub fn double(x: i32) -> i32 { x * 2 }\n');

    // Incremental update
    await indexer.updateForFiles([join(rootDir, 'util.rs')]);

    const { openReadOnly, listFiles } = await import('@jafreck/lore');
    const db = openReadOnly(dbPath);
    try {
      const files = listFiles(db);
      expect(files.length).toBeGreaterThanOrEqual(2);
    } finally {
      db.close();
    }
  });

  it('updateForFiles() with empty array is a no-op', async () => {
    const logger = createSilentLogger(tempDir);
    const dbPath = join(tempDir, 'target.db');
    const indexer = new TargetIndexer(dbPath, tempDir, logger);

    await indexer.updateForFiles([]);
    expect(indexer.isBuilt).toBe(false);
  });

  it('onFirstBuild callback fires after first build', async () => {
    const logger = createSilentLogger(tempDir);
    const rootDir = join(tempDir, 'src');
    await mkdir(rootDir, { recursive: true });
    await writeFile(join(rootDir, 'main.rs'), 'fn main() {}\n');

    const dbPath = join(tempDir, 'target.db');
    const indexer = new TargetIndexer(dbPath, rootDir, logger);

    let callbackFired = false;
    indexer.setOnFirstBuild(async () => { callbackFired = true; });

    await indexer.updateForFiles([join(rootDir, 'main.rs')]);
    expect(callbackFired).toBe(true);
  });

  it('onFirstBuild callback fires only once', async () => {
    const logger = createSilentLogger(tempDir);
    const rootDir = join(tempDir, 'src');
    await mkdir(rootDir, { recursive: true });
    await writeFile(join(rootDir, 'main.rs'), 'fn main() {}\n');

    const dbPath = join(tempDir, 'target.db');
    const indexer = new TargetIndexer(dbPath, rootDir, logger);

    let callCount = 0;
    indexer.setOnFirstBuild(async () => { callCount++; });

    await indexer.updateForFiles([join(rootDir, 'main.rs')]);
    await writeFile(join(rootDir, 'lib.rs'), 'pub fn foo() {}\n');
    await indexer.updateForFiles([join(rootDir, 'lib.rs')]);

    expect(callCount).toBe(1);
  });

  it('serializes overlapping initial and incremental updates without dropping files', async () => {
    const logger = createSilentLogger(tempDir);
    let releaseBuild!: () => void;
    const buildBarrier = new Promise<void>(resolve => { releaseBuild = resolve; });
    let buildStarted!: () => void;
    const started = new Promise<void>(resolve => { buildStarted = resolve; });
    let active = 0;
    let peak = 0;
    const build = vi.fn(async () => {
      active++;
      peak = Math.max(peak, active);
      buildStarted();
      await buildBarrier;
      active--;
    });
    const update = vi.fn(async () => {
      active++;
      peak = Math.max(peak, active);
      active--;
    });
    const factory = vi.fn().mockResolvedValue({ build, update });
    const indexer = new TargetIndexer(join(tempDir, 'target.db'), tempDir, logger, factory);

    const first = indexer.updateForFiles(['a.ts']);
    await started;
    let secondResolved = false;
    const second = indexer.updateForFiles(['b.ts']).then(() => { secondResolved = true; });
    expect(secondResolved).toBe(false);
    releaseBuild();
    await Promise.all([first, second]);

    expect(build).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(['b.ts']);
    expect(peak).toBe(1);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('is retryable after a failed first build', async () => {
    const logger = createSilentLogger(tempDir);
    const firstBuilder = { build: vi.fn().mockRejectedValue(new Error('build failed')), update: vi.fn() };
    const secondBuilder = { build: vi.fn().mockResolvedValue(undefined), update: vi.fn() };
    const factory = vi.fn()
      .mockResolvedValueOnce(firstBuilder)
      .mockResolvedValueOnce(secondBuilder);
    const indexer = new TargetIndexer(join(tempDir, 'target.db'), tempDir, logger, factory);

    await expect(indexer.updateForFiles(['a.ts'])).rejects.toThrow('build failed');
    expect(indexer.isBuilt).toBe(false);
    await expect(indexer.updateForFiles(['b.ts'])).resolves.toBeUndefined();

    expect(indexer.isBuilt).toBe(true);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(secondBuilder.build).toHaveBeenCalledTimes(1);
  });

  it('invokes the first-build callback once even when the callback fails', async () => {
    const logger = createSilentLogger(tempDir);
    const builder = { build: vi.fn().mockResolvedValue(undefined), update: vi.fn().mockResolvedValue(undefined) };
    const indexer = new TargetIndexer(
      join(tempDir, 'target.db'), tempDir, logger, vi.fn().mockResolvedValue(builder),
    );
    const callback = vi.fn().mockRejectedValue(new Error('callback failed'));
    indexer.setOnFirstBuild(callback);

    await expect(indexer.updateForFiles(['a.ts'])).rejects.toThrow('callback failed');
    expect(indexer.isBuilt).toBe(true);
    await expect(indexer.updateForFiles(['b.ts'])).resolves.toBeUndefined();

    expect(callback).toHaveBeenCalledTimes(1);
    expect(builder.build).toHaveBeenCalledTimes(1);
    expect(builder.update).toHaveBeenCalledWith(['b.ts']);
  });
});
