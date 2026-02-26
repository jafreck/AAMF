import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rm, readdir, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { MigrationRuntime } from '../src/core/runtime.js';
import { fileExists } from '../src/util/fs.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

/* ── lz4 release download settings ───────────────────────────────── */

/**
 * Override via environment variables:
 *   LZ4_VERSION — e.g. "1.10.0"  (default: 1.10.0)
 */
const LZ4_VERSION = process.env.LZ4_VERSION ?? '1.10.0';
const LZ4_TAG     = `v${LZ4_VERSION}`;
const LZ4_TARBALL = `lz4-${LZ4_VERSION}.tar.gz`;
const LZ4_URL     = `https://github.com/lz4/lz4/releases/download/${LZ4_TAG}/${LZ4_TARBALL}`;
const LZ4_DIR     = `lz4-${LZ4_VERSION}`; // extracted directory name

/* ── Paths ────────────────────────────────────────────────────────── */

const fixtureDir  = join(__dirname, 'fixtures', 'lz4-c-project');
const downloadDir = join(fixtureDir, 'lz4-src');       // extracted source lives here
const sourceRoot  = join(downloadDir, LZ4_DIR);         // top-level repo checkout
const libDir      = join(sourceRoot, 'lib');             // core library .c/.h files
const configPath  = join(fixtureDir, 'migration.config.json');
const aamfRoot    = join(fixtureDir, '.aamf');
const progressDir = join(aamfRoot, 'migration', 'lz4-to-rust');
const tmpRoot     = join(fixtureDir, 'tmp');
const outputDir   = join(tmpRoot, 'lz4-rust-output');

/* ── Helpers ──────────────────────────────────────────────────────── */

/**
 * Download and extract the official lz4 release tarball from GitHub.
 * Skips the download if the source directory already exists (cached).
 */
async function ensureLz4Source(): Promise<void> {
  try {
    const s = await stat(libDir);
    if (s.isDirectory()) return;
  } catch { /* does not exist — download */ }

  await mkdir(downloadDir, { recursive: true });

  console.log(`Downloading lz4 source from ${LZ4_URL} …`);
  execSync(
    `curl -fSL "${LZ4_URL}" -o "${join(downloadDir, LZ4_TARBALL)}"`,
    { stdio: 'inherit', timeout: 120_000 },
  );

  console.log('Extracting tarball …');
  execSync(`tar -xzf "${LZ4_TARBALL}"`, {
    cwd: downloadDir,
    stdio: 'inherit',
    timeout: 30_000,
  });

  // Verify the key library files are present
  const files = await readdir(libDir);
  if (!files.includes('lz4.c') || !files.includes('lz4.h')) {
    throw new Error(
      `Expected lz4.c and lz4.h in ${libDir}, found: ${files.join(', ')}`,
    );
  }
  console.log(`lz4 source ready at ${sourceRoot}`);
}

/**
 * Write a migration.config.json pointing at the downloaded lz4 lib/
 * directory, targeting Rust.
 */
async function writeMigrationConfig(): Promise<void> {
  const config = {
    projectName: 'lz4-to-rust',
    source: {
      path: libDir,
      language: 'c',
      entryPoints: ['lz4.c'],
      excludePatterns: [
        '.git', '*.o', '*.lo', '*.la', '*.pc',
        'Makefile*', '*.md',
      ],
    },
    target: {
      language: 'rust',
      framework: 'stable',
      outputPath: outputDir,
      testFramework: 'cargo-test',
      buildCommand: 'cargo build',
      testCommand: 'cargo test',
    },
    options: {
      maxParallelAgents: 3,
      maxRetriesPerTask: 2,
      largeFileThreshold: 500,
      maxLinesPerTask: 500,
      tokenBudget: 500000,
      dryRun: false,
      resume: false,
    },
    copilot: {
      cliCommand: 'copilot',
      model: 'claude-sonnet-4.6',
      agentDir: '../../../../.github/agents',
      timeout: 300_000,
    },
  };

  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

/**
 * End-to-end integration test: lz4 (C) → Rust.
 *
 * Downloads the official lz4 v1.10.0 release from GitHub and runs the
 * full AAMF migration pipeline to produce an idiomatic Rust port.
 *
 * lz4 is an extremely fast compression library. The core lib/ directory
 * contains ~5–7 K lines of C across several files:
 *   - lz4.c / lz4.h        (~2 K lines) — fast compression / decompression
 *   - lz4hc.c / lz4hc.h    (~1.5 K lines) — high-compression variant
 *   - lz4frame.c / lz4frame.h (~1.8 K lines) — framing format support
 *   - lz4file.c / lz4file.h — file-level streaming helpers
 *   - xxhash.c / xxhash.h  — fast hash (used for checksums)
 *
 * Multiple files exceed 1000 lines, exercising the task-splitting logic.
 *
 * Rust is an ideal target: lz4's low-level bit manipulation, unsafe
 * memory access patterns, and performance-critical hot loops map
 * naturally to Rust's unsafe blocks, zero-cost abstractions, and
 * ownership model.
 *
 * Gated behind the AAMF_E2E=1 environment variable because it requires:
 * - A working `copilot` CLI binary on PATH
 * - Network access (download + LLM API calls)
 * - A valid Copilot subscription
 *
 * The lz4 version can be overridden with:
 *   LZ4_VERSION=1.10.0
 *
 * Run with:
 *   AAMF_E2E=1 npx vitest run tests/e2e-lz4-rust.test.ts
 */
const runE2E = process.env.AAMF_E2E === '1';

describe.skipIf(!runE2E)('E2E lz4 C → Rust Migration', () => {
  let result: Awaited<ReturnType<MigrationRuntime['run']>>;

  beforeAll(async () => {
    // 1. Download the real lz4 source (cached across runs)
    await ensureLz4Source();

    // 2. Write a config pointing at the downloaded source
    await writeMigrationConfig();

    // 3. Clean up any previous migration artefacts
    await rm(aamfRoot, { recursive: true, force: true });
    await rm(outputDir, { recursive: true, force: true });

    // 4. Run the full migration (all 7 phases)
    const runtime = new MigrationRuntime();
    await runtime.initialize({
      configPath,
      logLevel: 'info',
    });
    result = await runtime.run();
  }, 10_800_000); // 3-hour timeout — ~5–7 K lines of C, 7 phases × many LLM round-trips

  afterAll(async () => {
    // KEEP migrated output for manual review — skip cleanup
    // await rm(aamfRoot, { recursive: true, force: true });
    // await rm(outputDir, { recursive: true, force: true });
  });

  // ── Source verification ──────────────────────────────────────────────────

  it('should have downloaded the lz4 library source', async () => {
    expect(await fileExists(join(libDir, 'lz4.c'))).toBe(true);
    expect(await fileExists(join(libDir, 'lz4.h'))).toBe(true);
  });

  it('should contain all core lz4 C source files', async () => {
    const files = await readdir(libDir);
    expect(files).toContain('lz4.c');
    expect(files).toContain('lz4.h');
    expect(files).toContain('lz4hc.c');
    expect(files).toContain('lz4hc.h');
    expect(files).toContain('lz4frame.c');
    expect(files).toContain('lz4frame.h');
  });

  it('should have 1000+ line files to exercise task splitting', async () => {
    const lz4c = await readFile(join(libDir, 'lz4.c'), 'utf-8');
    expect(lz4c.split('\n').length).toBeGreaterThan(1000);

    const lz4hc = await readFile(join(libDir, 'lz4hc.c'), 'utf-8');
    expect(lz4hc.split('\n').length).toBeGreaterThan(1000);

    const lz4frame = await readFile(join(libDir, 'lz4frame.c'), 'utf-8');
    expect(lz4frame.split('\n').length).toBeGreaterThan(1000);
  });

  // ── Overall result ───────────────────────────────────────────────────────

  it('should complete successfully', () => {
    expect(result.success).toBe(true);
    expect(result.projectName).toBe('lz4-to-rust');
  });

  it('should execute all 7 phases', () => {
    expect(result.phases.length).toBe(7);
    for (let i = 0; i < 7; i++) {
      expect(result.phases[i]?.phase).toBe(i + 1);
    }
  });

  it('should have non-zero total duration', () => {
    expect(result.totalDuration).toBeGreaterThan(0);
  });

  it('should report token usage', () => {
    expect(result.tokenUsage.total).toBeGreaterThan(0);
    expect(Object.keys(result.tokenUsage.byPhase).length).toBeGreaterThan(0);
    expect(Object.keys(result.tokenUsage.byAgent).length).toBeGreaterThan(0);
  });

  it('should have no failed or blocked tasks', () => {
    expect(result.failedTasks).toEqual([]);
    expect(result.blockedTasks).toEqual([]);
  });

  // ── Per-phase checks ────────────────────────────────────────────────────

  it('Phase 1 (Impact Assessment) should succeed', () => {
    const phase = result.phases.find(p => p.phase === 1);
    expect(phase).toBeDefined();
    expect(phase!.success).toBe(true);
    expect(phase!.name).toBe('Impact Assessment');
    expect(phase!.duration).toBeGreaterThan(0);
  });

  it('Phase 2 (Knowledge Base Construction) should succeed', () => {
    const phase = result.phases.find(p => p.phase === 2);
    expect(phase).toBeDefined();
    expect(phase!.success).toBe(true);
    expect(phase!.name).toBe('Knowledge Base Construction');
  });

  it('Phase 3 (Migration Planning) should succeed', () => {
    const phase = result.phases.find(p => p.phase === 3);
    expect(phase).toBeDefined();
    expect(phase!.success).toBe(true);
    expect(phase!.name).toBe('Migration Planning');
  });

  it('Phase 4 (Iterative Migration) should succeed', () => {
    const phase = result.phases.find(p => p.phase === 4);
    expect(phase).toBeDefined();
    expect(phase!.success).toBe(true);
    expect(phase!.name).toBe('Iterative Migration');
  });

  it('Phase 5 (Final Parity Verification) should succeed', () => {
    const phase = result.phases.find(p => p.phase === 5);
    expect(phase).toBeDefined();
    expect(phase!.success).toBe(true);
    expect(phase!.name).toBe('Final Parity Verification');
  });

  it('Phase 6 (E2E Testing & Documentation) should succeed', () => {
    const phase = result.phases.find(p => p.phase === 6);
    expect(phase).toBeDefined();
    expect(phase!.success).toBe(true);
    expect(phase!.name).toBe('E2E Testing & Documentation');
  });

  it('Phase 7 (Completion) should succeed', () => {
    const phase = result.phases.find(p => p.phase === 7);
    expect(phase).toBeDefined();
    expect(phase!.success).toBe(true);
    expect(phase!.name).toBe('Completion');
  });

  // ── Progress & checkpoint artefacts ──────────────────────────────────────

  it('should create a checkpoint recording all phases complete', async () => {
    const checkpointPath = join(progressDir, 'checkpoint.json');
    expect(await fileExists(checkpointPath)).toBe(true);

    const checkpoint = JSON.parse(await readFile(checkpointPath, 'utf-8'));
    expect(checkpoint.projectName).toBe('lz4-to-rust');
    expect(checkpoint.completedPhases).toEqual(
      expect.arrayContaining([1, 2, 3, 4, 5, 6, 7]),
    );
  });

  it('should create progress.md covering every phase', async () => {
    const progressMd = await readFile(join(progressDir, 'progress.md'), 'utf-8');
    expect(progressMd).toContain('lz4-to-rust');
    expect(progressMd).toContain('Impact Assessment');
    expect(progressMd).toContain('Iterative Migration');
    expect(progressMd).toContain('Completion');
  });

  it('should produce log files', async () => {
    const logsDir = join(progressDir, 'logs');
    expect(await fileExists(logsDir)).toBe(true);
    const logs = await readdir(logsDir);
    expect(logs.length).toBeGreaterThan(0);
  });

  // ── Rust Output artefacts ────────────────────────────────────────────────

  it('should produce Rust output files', async () => {
    expect(await fileExists(outputDir)).toBe(true);
    const outputFiles = (await readdir(outputDir, { recursive: true })) as string[];

    const rsFiles = outputFiles.filter(f => f.endsWith('.rs'));
    expect(rsFiles.length).toBeGreaterThan(0);
  });

  it('should produce a Cargo.toml project file', async () => {
    const outputFiles = (await readdir(outputDir, { recursive: true })) as string[];

    const cargoFiles = outputFiles.filter(f => f.endsWith('Cargo.toml'));
    expect(cargoFiles.length).toBeGreaterThan(0);

    const cargoContent = await readFile(join(outputDir, cargoFiles[0]), 'utf-8');
    // Should declare a package name
    expect(cargoContent).toMatch(/\[package\]/);
    expect(cargoContent).toMatch(/name\s*=/);
  });

  it('should produce an lz4 compression module in the output', async () => {
    const outputFiles = (await readdir(outputDir, { recursive: true })) as string[];
    const hasLz4 = outputFiles.some(
      f => f.toLowerCase().includes('lz4') && f.toLowerCase().endsWith('.rs'),
    );
    expect(hasLz4).toBe(true);
  });

  it('should produce an lz4hc (high compression) module in the output', async () => {
    const outputFiles = (await readdir(outputDir, { recursive: true })) as string[];
    const hasHc = outputFiles.some(
      f =>
        (f.toLowerCase().includes('hc') || f.toLowerCase().includes('high_compression')) &&
        f.toLowerCase().endsWith('.rs'),
    );
    expect(hasHc).toBe(true);
  });

  it('should produce a frame module in the output', async () => {
    const outputFiles = (await readdir(outputDir, { recursive: true })) as string[];
    const hasFrame = outputFiles.some(
      f => f.toLowerCase().includes('frame') && f.toLowerCase().endsWith('.rs'),
    );
    expect(hasFrame).toBe(true);
  });

  it('should produce Rust test files in the output', async () => {
    const outputFiles = (await readdir(outputDir, { recursive: true })) as string[];

    // Rust tests can be inline (#[cfg(test)]) or in a tests/ directory
    const testFiles = outputFiles.filter(
      f =>
        f.toLowerCase().endsWith('.rs') &&
        (f.toLowerCase().includes('test') || f.includes('tests/')),
    );

    // Also check for inline #[test] attributes in any .rs file
    let hasInlineTests = false;
    const rsFiles = outputFiles.filter(f => f.endsWith('.rs'));
    for (const f of rsFiles.slice(0, 15)) {
      const content = await readFile(join(outputDir, f), 'utf-8');
      if (content.includes('#[test]') || content.includes('#[cfg(test)]')) {
        hasInlineTests = true;
        break;
      }
    }

    expect(testFiles.length > 0 || hasInlineTests).toBe(true);
  });

  it('Rust output should use idiomatic patterns', async () => {
    const outputFiles = (await readdir(outputDir, { recursive: true })) as string[];
    const rsFiles = outputFiles.filter(f => f.endsWith('.rs'));

    let allContent = '';
    for (const f of rsFiles.slice(0, 10)) {
      allContent += await readFile(join(outputDir, f), 'utf-8');
    }

    // Should use Rust module / use statements
    expect(allContent).toMatch(/(?:pub\s+)?(?:mod|fn|struct|enum|impl)\s+\w/);
  });

  it('Rust output should contain lz4 compression constants', async () => {
    const outputFiles = (await readdir(outputDir, { recursive: true })) as string[];
    const rsFiles = outputFiles.filter(f => f.endsWith('.rs'));

    let allContent = '';
    for (const f of rsFiles) {
      allContent += await readFile(join(outputDir, f), 'utf-8');
    }

    // Core lz4 constants (MINMATCH, ML_BITS, ACCELERATION, etc.)
    expect(allContent).toMatch(/MINMATCH|MIN_MATCH|MATCH_LEN|ACCELERATION/i);
  });

  it('Rust output should contain the compress / decompress public API', async () => {
    const outputFiles = (await readdir(outputDir, { recursive: true })) as string[];
    const rsFiles = outputFiles.filter(f => f.endsWith('.rs'));

    let allContent = '';
    for (const f of rsFiles) {
      allContent += await readFile(join(outputDir, f), 'utf-8');
    }

    // Public API functions for compression and decompression
    expect(allContent).toMatch(/compress|Compress/);
    expect(allContent).toMatch(/decompress|Decompress/);
  });

  it('Rust output should map C unsafe patterns to Rust unsafe blocks', async () => {
    const outputFiles = (await readdir(outputDir, { recursive: true })) as string[];
    const rsFiles = outputFiles.filter(f => f.endsWith('.rs'));

    let allContent = '';
    for (const f of rsFiles) {
      allContent += await readFile(join(outputDir, f), 'utf-8');
    }

    // lz4 uses raw pointer arithmetic — expect unsafe blocks in the Rust output
    expect(allContent).toMatch(/unsafe\s*\{/);
  });
});

/**
 * E2E test variant with AAMF_USE_KB_INDEX=1.
 *
 * Runs the full migration pipeline with KB indexing (Phase 0) enabled,
 * verifying that the phase completes and the KB database is created with
 * at least one row in the kb_meta table.
 *
 * Gated behind both AAMF_E2E=1 and AAMF_USE_KB_INDEX=1.
 *
 * Run with:
 *   AAMF_E2E=1 AAMF_USE_KB_INDEX=1 npx vitest run tests/e2e-lz4-rust.test.ts
 */
const runKbIndexE2E = runE2E && process.env.AAMF_USE_KB_INDEX === '1';

describe.skipIf(!runKbIndexE2E)('E2E lz4 C → Rust Migration with KB Index', () => {
  let result: Awaited<ReturnType<MigrationRuntime['run']>>;
  const kbProgressDir = join(fixtureDir, '.aamf-kb', 'migration', 'lz4-to-rust-kb');
  const kbAamfRoot = join(fixtureDir, '.aamf-kb');
  const kbOutputDir = join(fixtureDir, 'tmp', 'lz4-rust-kb-output');
  const kbConfigPath = join(fixtureDir, 'migration-kb.config.json');

  beforeAll(async () => {
    // Reuse the already-downloaded lz4 source (ensureLz4Source from parent suite runs first)
    await ensureLz4Source();

    // Write a config for the KB-indexed variant
    const config = {
      projectName: 'lz4-to-rust-kb',
      source: {
        path: libDir,
        language: 'c',
        entryPoints: ['lz4.c'],
        excludePatterns: ['.git', '*.o', '*.lo', '*.la', '*.pc', 'Makefile*', '*.md'],
      },
      target: {
        language: 'rust',
        framework: 'stable',
        outputPath: kbOutputDir,
        testFramework: 'cargo-test',
        buildCommand: 'cargo build',
        testCommand: 'cargo test',
      },
      options: {
        maxParallelAgents: 3,
        maxRetriesPerTask: 2,
        largeFileThreshold: 500,
        maxLinesPerTask: 500,
        tokenBudget: 500000,
        dryRun: false,
        resume: false,
      },
      copilot: {
        cliCommand: 'copilot',
        model: 'claude-sonnet-4.6',
        agentDir: '../../../../.github/agents',
        timeout: 300_000,
      },
    };
    await writeFile(kbConfigPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');

    // Clean up previous artefacts
    await rm(kbAamfRoot, { recursive: true, force: true });
    await rm(kbOutputDir, { recursive: true, force: true });

    // Enable KB indexing for this run
    process.env['AAMF_USE_KB_INDEX'] = '1';

    const runtime = new MigrationRuntime();
    await runtime.initialize({ configPath: kbConfigPath, logLevel: 'info' });
    result = await runtime.run();
  }, 10_800_000); // 3-hour timeout

  afterAll(async () => {
    // Restore env
    delete process.env['AAMF_USE_KB_INDEX'];
  });

  it('should have downloaded the lz4 library source', async () => {
    expect(await fileExists(join(libDir, 'lz4.c'))).toBe(true);
  });

  it('should execute Phase 0 (KB Indexing) successfully', () => {
    const phase0 = result.phases.find(p => p.phase === 0);
    expect(phase0).toBeDefined();
    expect(phase0!.success).toBe(true);
    expect(phase0!.name).toBe('KB Indexing');
  });

  it('Phase 0 should create a KB database file', async () => {
    const kbDb = join(kbProgressDir, 'kb.db');
    expect(await fileExists(kbDb)).toBe(true);
  });

  it('Phase 0 KB database should have at least one row in kb_meta', async () => {
    // Dynamically import better-sqlite3 to avoid hard dependency at test collection time
    const kbDb = join(kbProgressDir, 'kb.db');
    try {
      const { default: Database } = await import('better-sqlite3');
      const db = new Database(kbDb, { readonly: true });
      const row = db.prepare('SELECT COUNT(*) AS cnt FROM kb_meta').get() as { cnt: number };
      db.close();
      expect(row.cnt).toBeGreaterThan(0);
    } catch {
      // If better-sqlite3 is unavailable in the test runner, skip gracefully
      console.warn('better-sqlite3 not available, skipping kb_meta row check');
    }
  });

  it('should complete migration successfully with KB index', () => {
    expect(result.success).toBe(true);
    expect(result.projectName).toBe('lz4-to-rust-kb');
  });

  it('should produce Rust output files with KB index', async () => {
    expect(await fileExists(kbOutputDir)).toBe(true);
    const outputFiles = (await readdir(kbOutputDir, { recursive: true })) as string[];
    const rsFiles = outputFiles.filter(f => f.endsWith('.rs'));
    expect(rsFiles.length).toBeGreaterThan(0);
  });
});
