import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rm, readdir, readFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { MigrationRuntime } from '../src/core/runtime.js';
import { fileExists } from '../src/util/fs.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

/* ── zstd release download settings ──────────────────────────────── */

/**
 * Override via environment variables:
 *   ZSTD_VERSION — e.g. "1.5.7"  (default: 1.5.7)
 */
const ZSTD_VERSION = process.env.ZSTD_VERSION ?? '1.5.7';
const ZSTD_TAG     = `v${ZSTD_VERSION}`;
const ZSTD_TARBALL = `zstd-${ZSTD_VERSION}.tar.gz`;
const ZSTD_URL     = `https://github.com/facebook/zstd/releases/download/${ZSTD_TAG}/${ZSTD_TARBALL}`;
const ZSTD_DIR     = `zstd-${ZSTD_VERSION}`; // extracted directory name

/* ── Paths ────────────────────────────────────────────────────────── */

const fixtureDir   = join(__dirname, 'fixtures', 'zstd-c-project');
const downloadDir  = join(fixtureDir, 'zstd-src');        // extracted source lives here
const sourceRoot   = join(downloadDir, ZSTD_DIR);          // top-level repo checkout
const libDir       = join(sourceRoot, 'lib');               // core library C files
const configPath   = join(fixtureDir, 'migration.config.json');
const aamfRoot     = join(fixtureDir, '.aamf');
const progressDir  = join(aamfRoot, 'migration', 'zstd-to-rust');
const tmpRoot      = join(fixtureDir, 'tmp');
const outputDir    = join(tmpRoot, 'zstd-rust-output');

/* ── Helpers ──────────────────────────────────────────────────────── */

/**
 * Download and extract the official zstd release tarball from GitHub.
 * Skips the download if the source directory already exists (cached).
 */
async function ensureZstdSource(): Promise<void> {
  try {
    const s = await stat(join(libDir, 'compress'));
    if (s.isDirectory()) return;
  } catch { /* does not exist — download */ }

  await mkdir(downloadDir, { recursive: true });

  console.log(`Downloading zstd source from ${ZSTD_URL} …`);
  execSync(
    `curl -fSL "${ZSTD_URL}" -o "${join(downloadDir, ZSTD_TARBALL)}"`,
    { stdio: 'inherit', timeout: 120_000 },
  );

  console.log('Extracting tarball …');
  execSync(`tar -xzf "${ZSTD_TARBALL}"`, {
    cwd: downloadDir,
    stdio: 'inherit',
    timeout: 30_000,
  });

  // Verify both the library and the programs directory are present
  const libFiles = await readdir(libDir);
  if (!libFiles.includes('zstd.h')) {
    throw new Error(
      `Expected zstd.h in ${libDir}, found: ${libFiles.join(', ')}`,
    );
  }
  const progDir = join(sourceRoot, 'programs');
  const progFiles = await readdir(progDir);
  if (!progFiles.includes('zstdcli.c')) {
    throw new Error(
      `Expected zstdcli.c in ${progDir}, found: ${progFiles.join(', ')}`,
    );
  }
  console.log(`zstd source ready at ${sourceRoot}`);
}

/**
 * Write a migration.config.json pointing at the downloaded zstd lib/
 * directory, targeting Rust.
 */
async function writeMigrationConfig(): Promise<void> {
  const config = {
    projectName: 'zstd-to-rust',
    source: {
      path: sourceRoot,
      language: 'c',
      entryPoints: ['lib/compress/zstd_compress.c', 'programs/zstdcli.c'],
      excludePatterns: [
        '.git', '*.o', '*.lo', '*.la', '*.pc',
        'Makefile*', '*.md', 'legacy',
      ],
    },
    target: {
      language: 'rust',
      framework: 'stable',
      outputPath: outputDir,
      buildCommand: 'cargo build',
      testCommand: 'cargo test',
    },
    options: {
      maxParallelAgents: 5,
      maxRetriesPerTask: 3,
      maxLinesPerTask: 750,
      tokenBudget: 10_000_000,
      executionMode: 'wave-barrier',
      waveControl: {
        maxConvergenceIterations: 3,
      },
      dryRun: false,
      resume: true,
      keepArtifacts: true,
      kbIndex: {
        enabled: true,
        embeddings: {
          enabled: true,
        },
      },
    },
    agentBackend: {
      runtime: 'copilot',
      cliCommand: 'copilot',
      model: 'claude-sonnet-4.6',
      agentDir: '../../../../.github/agents',
      timeout: 3_600_000, // 1 hour/agent
    },
  };

  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

/**
 * End-to-end integration test: zstd (C) → Rust.
 *
 * Downloads the official zstd v1.5.7 release from GitHub and runs the
 * full AAMF migration pipeline to produce an idiomatic Rust port of the
 * entire zstd codebase — library and CLI.
 *
 * zstd (Zstandard) is Facebook's high-ratio, high-speed compression library.
 * The full repository is structured as:
 *   - lib/compress/        — compression engine (~15 K lines across ~10 files)
 *   - lib/decompress/      — decompression engine (~5 K lines)
 *   - lib/common/          — shared types, entropy coding, xxhash (~8 K lines)
 *   - lib/dictBuilder/     — dictionary builder (~3 K lines)
 *   - lib/zstd.h           — public API header
 *   - programs/            — zstd CLI tool (~8 K lines)
 *
 * Total: ~80 K lines of C, exercising AAMF's large-file decomposition,
 * multi-directory source traversal, and cross-module dependency resolution.
 * Correctness is objectively verifiable: compress a buffer in C, decompress
 * in Rust (and vice versa) — byte-for-byte identicality proves the port
 * is correct.
 *
 * Gated behind the AAMF_E2E=1 environment variable because it requires:
 * - A working `copilot` CLI binary on PATH
 * - Network access (download + LLM API calls)
 * - A valid Copilot subscription
 *
 * The zstd version can be overridden with:
 *   ZSTD_VERSION=1.5.7
 *
 * Run with:
 *   AAMF_E2E=1 npx vitest run tests/e2e-zstd-rust.test.ts
 */
const runE2E = process.env.AAMF_E2E === '1';
const keepArtifacts = process.env.AAMF_KEEP_ARTIFACTS === '1';

describe.skipIf(!runE2E)('E2E zstd C → Rust Migration', () => {
  let result: Awaited<ReturnType<MigrationRuntime['run']>>;

  beforeAll(async () => {
    // 1. Download the real zstd source (cached across runs)
    await ensureZstdSource();

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
  }, 57_600_000); // 16-hour timeout — ~50 K lines of C, larger than lz4

  afterAll(async () => {
    if (keepArtifacts) return;
    await rm(aamfRoot, { recursive: true, force: true });
    await rm(outputDir, { recursive: true, force: true });
  });

  // ── Source verification ──────────────────────────────────────────────────

  it('should have downloaded the full zstd source', async () => {
    // Library
    expect(await fileExists(join(libDir, 'zstd.h'))).toBe(true);
    expect(await fileExists(join(libDir, 'compress'))).toBe(true);
    expect(await fileExists(join(libDir, 'decompress'))).toBe(true);
    // CLI programs
    expect(await fileExists(join(sourceRoot, 'programs', 'zstdcli.c'))).toBe(true);
  });

  it('should contain all core zstd C source directories', async () => {
    const libFiles = await readdir(libDir);
    expect(libFiles).toContain('compress');
    expect(libFiles).toContain('decompress');
    expect(libFiles).toContain('common');
    expect(libFiles).toContain('zstd.h');

    const rootFiles = await readdir(sourceRoot);
    expect(rootFiles).toContain('lib');
    expect(rootFiles).toContain('programs');
  });

  it('should contain the main compression, decompression, and CLI source files', async () => {
    const compressFiles = await readdir(join(libDir, 'compress'));
    expect(compressFiles).toContain('zstd_compress.c');

    const decompressFiles = await readdir(join(libDir, 'decompress'));
    expect(decompressFiles).toContain('zstd_decompress.c');

    const programFiles = await readdir(join(sourceRoot, 'programs'));
    expect(programFiles).toContain('zstdcli.c');
  });

  it('should have large files to exercise task splitting', async () => {
    const compress = await readFile(join(libDir, 'compress', 'zstd_compress.c'), 'utf-8');
    expect(compress.split('\n').length).toBeGreaterThan(1000);

    const decompress = await readFile(join(libDir, 'decompress', 'zstd_decompress.c'), 'utf-8');
    expect(decompress.split('\n').length).toBeGreaterThan(1000);

    const cli = await readFile(join(sourceRoot, 'programs', 'zstdcli.c'), 'utf-8');
    expect(cli.split('\n').length).toBeGreaterThan(100);
  });

  // ── Overall result ───────────────────────────────────────────────────────

  it('should complete successfully', () => {
    expect(result.success).toBe(true);
    expect(result.projectName).toBe('zstd-to-rust');
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

  // ── Per-phase checks ─────────────────────────────────────────────────────

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
    expect(checkpoint.projectName).toBe('zstd-to-rust');
    expect(checkpoint.completedPhases).toEqual(
      expect.arrayContaining([1, 2, 3, 4, 5, 6, 7]),
    );
  });

  it('should create progress.md covering every phase', async () => {
    const progressMd = await readFile(join(progressDir, 'progress.md'), 'utf-8');
    expect(progressMd).toContain('zstd-to-rust');
    expect(progressMd).toContain('Iterative Migration');
    expect(progressMd).toContain('Completion');
  });

  it('should enforce wave barrier ordering in progress lifecycle output', async () => {
    const progressMd = await readFile(join(progressDir, 'progress.md'), 'utf-8');
    const section = progressMd.match(/## Wave Lifecycle\s+([\s\S]*?)(?:\n## |\n$)/);
    expect(section).toBeTruthy();

    const lines = (section?.[1] ?? '')
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.startsWith('|') && !line.includes('---') && !line.includes('Wave |'));
    expect(lines.length).toBeGreaterThan(0);

    const byWave = new Map<number, string[]>();
    for (const line of lines) {
      const match = line.match(/^\|\s*(\d+)\s*\|\s*([^|]+)\|/);
      if (!match) continue;
      const wave = Number(match[1]);
      const milestone = match[2]!.trim();
      const milestones = byWave.get(wave) ?? [];
      milestones.push(milestone);
      byWave.set(wave, milestones);
    }

    expect(byWave.size).toBeGreaterThan(0);
    for (const milestones of byWave.values()) {
      const started = milestones.indexOf('started');
      const completed = milestones.indexOf('completed');
      const barrierEntered = milestones.indexOf('barrier-entered');
      const barrierReleased = milestones.lastIndexOf('barrier-released');

      expect(started).toBeGreaterThanOrEqual(0);
      expect(completed).toBeGreaterThan(started);
      expect(barrierEntered).toBeGreaterThan(completed);
      expect(barrierReleased).toBeGreaterThan(barrierEntered);

      for (let i = 0; i < milestones.length; i++) {
        if (milestones[i] === 'convergence') {
          expect(i).toBeGreaterThan(barrierEntered);
          expect(i).toBeLessThan(barrierReleased);
        }
      }
    }
  });

  it('should record stable wave-mode completion and retry/block signals', async () => {
    const summaryPath = join(progressDir, 'metrics', 'summary.json');
    expect(await fileExists(summaryPath)).toBe(true);
    const summary = JSON.parse(await readFile(summaryPath, 'utf-8'));

    expect(summary.phase4ExecutionMode).toBe('wave-barrier');
    expect(summary.completedPhase4Tasks).toBeGreaterThan(0);
    expect(summary.waveCount).toBeGreaterThan(0);
    expect(summary.waveValidationRuns).toBeGreaterThan(0);
    expect(summary.waveConvergenceLimitHits).toBe(0);
    expect(summary.retryVolumePerCompletedTask).toBeGreaterThanOrEqual(0);
    expect(summary.commandRecoveryAttempts).toBeGreaterThanOrEqual(0);
  });

  it('should produce log files', async () => {
    const logsDir = join(progressDir, 'logs');
    expect(await fileExists(logsDir)).toBe(true);
    const logs = await readdir(logsDir);
    expect(logs.length).toBeGreaterThan(0);
  });

  // ── Rust output artefacts ────────────────────────────────────────────────

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
    expect(cargoContent).toMatch(/\[package\]/);
    expect(cargoContent).toMatch(/name\s*=/);
  });

  it('should produce a compress module in the output', async () => {
    const outputFiles = (await readdir(outputDir, { recursive: true })) as string[];
    const hasCompress = outputFiles.some(
      f => f.toLowerCase().includes('compress') && f.toLowerCase().endsWith('.rs'),
    );
    expect(hasCompress).toBe(true);
  });

  it('should produce a decompress module in the output', async () => {
    const outputFiles = (await readdir(outputDir, { recursive: true })) as string[];
    const hasDecompress = outputFiles.some(
      f => f.toLowerCase().includes('decompress') && f.toLowerCase().endsWith('.rs'),
    );
    expect(hasDecompress).toBe(true);
  });

  it('should produce a CLI / programs port in the output', async () => {
    const outputFiles = (await readdir(outputDir, { recursive: true })) as string[];
    const rsFiles = outputFiles.filter(f => f.endsWith('.rs'));

    // Expect either a dedicated programs/ directory or a main.rs / cli.rs
    const hasCli = outputFiles.some(f =>
      f.toLowerCase().includes('main') ||
      f.toLowerCase().includes('cli') ||
      f.toLowerCase().includes('program'),
    );

    // Or the CLI logic was folded into the library crate as a binary target
    let hasMainInContent = false;
    for (const f of rsFiles.slice(0, 20)) {
      const content = await readFile(join(outputDir, f), 'utf-8');
      if (content.includes('fn main(')) {
        hasMainInContent = true;
        break;
      }
    }

    expect(hasCli || hasMainInContent).toBe(true);
  });

  it('should produce Rust test files in the output', async () => {
    const outputFiles = (await readdir(outputDir, { recursive: true })) as string[];

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

    expect(allContent).toMatch(/(?:pub\s+)?(?:mod|fn|struct|enum|impl)\s+\w/);
  });

  it('Rust output should contain compress and decompress public API', async () => {
    const outputFiles = (await readdir(outputDir, { recursive: true })) as string[];
    const rsFiles = outputFiles.filter(f => f.endsWith('.rs'));

    let allContent = '';
    for (const f of rsFiles) {
      allContent += await readFile(join(outputDir, f), 'utf-8');
    }

    expect(allContent).toMatch(/compress|Compress/);
    expect(allContent).toMatch(/decompress|Decompress/);
  });

  it('Rust output should contain zstd-specific constants or magic numbers', async () => {
    const outputFiles = (await readdir(outputDir, { recursive: true })) as string[];
    const rsFiles = outputFiles.filter(f => f.endsWith('.rs'));

    let allContent = '';
    for (const f of rsFiles) {
      allContent += await readFile(join(outputDir, f), 'utf-8');
    }

    // zstd magic number (0xFD2FB528) or well-known constants
    expect(allContent).toMatch(/ZSTD|zstd|MAGIC|magic|0xFD2FB528/i);
  });

  it('Rust output should map C unsafe patterns to Rust unsafe blocks', async () => {
    const outputFiles = (await readdir(outputDir, { recursive: true })) as string[];
    const rsFiles = outputFiles.filter(f => f.endsWith('.rs'));

    let allContent = '';
    for (const f of rsFiles) {
      allContent += await readFile(join(outputDir, f), 'utf-8');
    }

    // zstd uses raw pointer arithmetic extensively
    expect(allContent).toMatch(/unsafe\s*\{/);
  });
});
