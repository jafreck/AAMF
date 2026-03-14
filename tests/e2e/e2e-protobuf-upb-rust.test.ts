import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rm, readdir, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { MigrationRuntime } from '../../src/core/runtime.js';
import { fileExists } from '../../src/util/fs.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

/* -- protobuf upb release download settings -- */

/**
 * upb is Google's canonical pure-C protobuf runtime, backing Python/Ruby/PHP.
 * The core source lives in upb/upb/ inside the protocolbuffers/protobuf repo.
 *
 * Override via env:  PROTOBUF_VERSION (default: 33.5)
 */
const PROTOBUF_VERSION = process.env.PROTOBUF_VERSION ?? '33.5';
const PROTOBUF_TAG     = `v${PROTOBUF_VERSION}`;
const PROTOBUF_TARBALL = `protobuf-${PROTOBUF_VERSION}.tar.gz`;
const PROTOBUF_URL     = `https://github.com/protocolbuffers/protobuf/releases/download/${PROTOBUF_TAG}/${PROTOBUF_TARBALL}`;
const PROTOBUF_DIR     = `protobuf-${PROTOBUF_VERSION}`;

/* -- Paths -- */

const fixtureDir  = join(__dirname, '..', 'fixtures', 'protobuf-upb-project');
const downloadDir = join(fixtureDir, 'protobuf-src');
const sourceRoot  = join(downloadDir, PROTOBUF_DIR);
const upbDir      = join(sourceRoot, 'upb', 'upb');
const configPath  = join(fixtureDir, 'migration.config.json');
const aamfRoot    = join(fixtureDir, '.aamf');
const progressDir = join(aamfRoot, 'migration', 'protobuf-upb-to-rust');
const tmpRoot     = join(fixtureDir, 'tmp');
const outputDir   = join(tmpRoot, 'protobuf-upb-rust-output');

/* -- Helpers -- */

async function ensureUpbSource(): Promise<void> {
  try {
    const s = await stat(upbDir);
    if (s.isDirectory()) return;
  } catch { /* does not exist — download */ }

  await mkdir(downloadDir, { recursive: true });
  console.log(`Downloading protobuf source from ${PROTOBUF_URL} ...`);
  execSync(
    `curl -fSL "${PROTOBUF_URL}" -o "${join(downloadDir, PROTOBUF_TARBALL)}"`,
    { stdio: 'inherit', timeout: 300_000 },
  );
  console.log('Extracting tarball ...');
  execSync(`tar -xzf "${PROTOBUF_TARBALL}"`, { cwd: downloadDir, stdio: 'inherit', timeout: 120_000 });

  const files = await readdir(upbDir);
  if (!files.includes('decode.c') || !files.includes('encode.c')) {
    throw new Error(`Expected decode.c and encode.c in ${upbDir}, found: ${files.join(', ')}`);
  }
  console.log(`upb source ready at ${upbDir}`);
}

async function writeMigrationConfig(): Promise<void> {
  const config = {
    projectName: 'protobuf-upb-to-rust',
    source: {
      path: upbDir,
      language: 'c',
      entryPoints: ['decode.c', 'encode.c'],
      excludePatterns: ['.git', '*.o', '*.lo', '*.la', '*.pc', 'Makefile*', '*.md', '*_test.c', 'fuzz'],
    },
    target: {
      language: 'rust',
      framework: 'stable',
      outputPath: outputDir,
      buildCommand: 'cargo build',
      testCommand: 'cargo test',
    },
    options: {
      maxParallelAgents: 3,
      maxRetriesPerTask: 2,
      maxLinesPerTask: 500,
      tokenBudget: 3_000_000,
      dryRun: false,
      resume: false,
    },
    agentBackend: {
      runtime: 'copilot',
      cliCommand: 'copilot',
      model: 'claude-sonnet-4.6',
      agentDir: '../../../../.github/agents',
      timeout: 900_000,
    },
  };
  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

/**
 * E2E test: protobuf upb (C) -> Rust.
 *
 * Downloads protobuf v33.5 and migrates upb/upb/ (~40-50 K lines of C99):
 *   - decode.c / encode.c    wire format pack/unpack
 *   - arena.c / alloc.h      arena allocator
 *   - message.c / message.h  UpbMessage lifecycle
 *   - mini_table/            descriptor tables (MiniTable)
 *   - collections/           map, array, extension sets
 *   - hash/                  internal hash table
 *   - lex/                   text-format / JSON lexer helpers
 *   - wire/                  low-level varint / fixed-width I/O
 *
 * Correctness is objectively verifiable: the protobuf binary wire format is
 * fully deterministic for proto3.  The conformance test suite in the same
 * repo provides a ready-made harness for cross-implementation validation.
 *
 * Gated behind AAMF_E2E=1.  Override version with PROTOBUF_VERSION=33.5.
 *
 * Run:  AAMF_E2E=1 npx vitest run tests/e2e-protobuf-upb-rust.test.ts
 */
const runE2E = process.env.AAMF_E2E === '1';
const keepArtifacts = process.env.AAMF_KEEP_ARTIFACTS === '1';

describe.skipIf(!runE2E)('E2E protobuf upb C -> Rust Migration', () => {
  let result: Awaited<ReturnType<MigrationRuntime['run']>>;

  beforeAll(async () => {
    await ensureUpbSource();
    await writeMigrationConfig();
    await rm(aamfRoot, { recursive: true, force: true });
    await rm(outputDir, { recursive: true, force: true });

    const runtime = new MigrationRuntime();
    await runtime.initialize({ configPath, logLevel: 'info' });
    result = await runtime.run();
  }, 43_200_000); // 12-hour timeout -- ~40-50 K lines of C with complex interdependencies

  afterAll(async () => {
    if (keepArtifacts) return;
    await rm(aamfRoot, { recursive: true, force: true });
    await rm(outputDir, { recursive: true, force: true });
  });

  // -- Source verification --

  it('should have downloaded the upb source', async () => {
    expect(await fileExists(join(upbDir, 'decode.c'))).toBe(true);
    expect(await fileExists(join(upbDir, 'encode.c'))).toBe(true);
    expect(await fileExists(join(upbDir, 'arena.c'))).toBe(true);
  });

  it('should contain the core upb C source files', async () => {
    const files = await readdir(upbDir);
    expect(files).toContain('decode.c');
    expect(files).toContain('encode.c');
    expect(files).toContain('arena.c');
  });

  it('should contain upb subdirectories', async () => {
    const files = await readdir(upbDir);
    const knownDirs = ['mini_table', 'collections', 'hash', 'wire', 'lex'];
    const present = knownDirs.filter(d => files.includes(d));
    expect(present.length).toBeGreaterThan(0);
  });

  it('should have large files to exercise task splitting', async () => {
    const decode = await readFile(join(upbDir, 'decode.c'), 'utf-8');
    expect(decode.split('\n').length).toBeGreaterThan(500);
  });

  // -- Overall result --

  it('should complete successfully', () => {
    expect(result.success).toBe(true);
    expect(result.projectName).toBe('protobuf-upb-to-rust');
  });

  it('should execute all 7 phases', () => {
    expect(result.phases.length).toBe(7);
    for (let i = 0; i < 7; i++) expect(result.phases[i]?.phase).toBe(i + 1);
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

  // -- Per-phase checks --

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

  // -- Progress and checkpoint artefacts --

  it('should create a checkpoint recording all phases complete', async () => {
    const checkpointPath = join(progressDir, 'checkpoint.json');
    expect(await fileExists(checkpointPath)).toBe(true);
    const checkpoint = JSON.parse(await readFile(checkpointPath, 'utf-8'));
    expect(checkpoint.projectName).toBe('protobuf-upb-to-rust');
    expect(checkpoint.completedPhases).toEqual(expect.arrayContaining([1, 2, 3, 4, 5, 6, 7]));
  });

  it('should create progress.md covering every phase', async () => {
    const progressMd = await readFile(join(progressDir, 'progress.md'), 'utf-8');
    expect(progressMd).toContain('protobuf-upb-to-rust');
    expect(progressMd).toContain('Iterative Migration');
    expect(progressMd).toContain('Completion');
  });

  it('should produce log files', async () => {
    const logsDir = join(progressDir, 'logs');
    expect(await fileExists(logsDir)).toBe(true);
    const logs = await readdir(logsDir);
    expect(logs.length).toBeGreaterThan(0);
  });

  // -- Rust output artefacts --

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

  it('should produce Rust test files in the output', async () => {
    const outputFiles = (await readdir(outputDir, { recursive: true })) as string[];
    const testFiles = outputFiles.filter(
      f => f.toLowerCase().endsWith('.rs') &&
        (f.toLowerCase().includes('test') || f.includes('tests/')),
    );
    let hasInlineTests = false;
    for (const f of outputFiles.filter(f => f.endsWith('.rs')).slice(0, 15)) {
      const content = await readFile(join(outputDir, f), 'utf-8');
      if (content.includes('#[test]') || content.includes('#[cfg(test)]')) { hasInlineTests = true; break; }
    }
    expect(testFiles.length > 0 || hasInlineTests).toBe(true);
  });

  it('Rust output should use idiomatic patterns', async () => {
    const outputFiles = (await readdir(outputDir, { recursive: true })) as string[];
    let allContent = '';
    for (const f of outputFiles.filter(f => f.endsWith('.rs')).slice(0, 10)) {
      allContent += await readFile(join(outputDir, f), 'utf-8');
    }
    expect(allContent).toMatch(/(?:pub\s+)?(?:mod|fn|struct|enum|impl)\s+\w/);
  });

  it('Rust output should contain decode and encode API', async () => {
    const outputFiles = (await readdir(outputDir, { recursive: true })) as string[];
    let allContent = '';
    for (const f of outputFiles.filter(f => f.endsWith('.rs'))) {
      allContent += await readFile(join(outputDir, f), 'utf-8');
    }
    expect(allContent).toMatch(/decode|Decode|unpack|deserialize/i);
    expect(allContent).toMatch(/encode|Encode|pack|serialize/i);
  });

  it('Rust output should model the upb Arena allocator', async () => {
    const outputFiles = (await readdir(outputDir, { recursive: true })) as string[];
    let allContent = '';
    for (const f of outputFiles.filter(f => f.endsWith('.rs'))) {
      allContent += await readFile(join(outputDir, f), 'utf-8');
    }
    expect(allContent).toMatch(/Arena|arena|lifetime|alloc|Alloc/i);
  });

  it('Rust output should model protobuf wire types', async () => {
    const outputFiles = (await readdir(outputDir, { recursive: true })) as string[];
    let allContent = '';
    for (const f of outputFiles.filter(f => f.endsWith('.rs'))) {
      allContent += await readFile(join(outputDir, f), 'utf-8');
    }
    expect(allContent).toMatch(/varint|wire_type|WireType|zigzag|fixed32|fixed64/i);
  });

  it('Rust output should use unsafe for low-level pointer operations', async () => {
    const outputFiles = (await readdir(outputDir, { recursive: true })) as string[];
    let allContent = '';
    for (const f of outputFiles.filter(f => f.endsWith('.rs'))) {
      allContent += await readFile(join(outputDir, f), 'utf-8');
    }
    expect(allContent).toMatch(/unsafe\s*\{/);
  });
});
