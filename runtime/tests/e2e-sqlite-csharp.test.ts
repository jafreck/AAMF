import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rm, readdir, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { MigrationRuntime } from '../src/core/runtime.js';
import { fileExists } from '../src/util/fs.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

/* ── SQLite amalgamation download settings ────────────────────────── */

/**
 * Override via environment variables:
 *   SQLITE_VERSION    — e.g. "3510200"  (default: 3510200 = 3.51.2)
 *   SQLITE_YEAR       — e.g. "2025"     (default: 2025)
 */
const SQLITE_VERSION = process.env.SQLITE_VERSION ?? '3510200';
const SQLITE_YEAR    = process.env.SQLITE_YEAR ?? '2025';
const SQLITE_TARBALL = `sqlite-autoconf-${SQLITE_VERSION}.tar.gz`;
const SQLITE_URL     = `https://www.sqlite.org/${SQLITE_YEAR}/${SQLITE_TARBALL}`;
const SQLITE_DIR     = `sqlite-autoconf-${SQLITE_VERSION}`;

/* ── Paths ────────────────────────────────────────────────────────── */

const fixtureDir  = join(__dirname, 'fixtures', 'sqlite-c-project');
const downloadDir = join(fixtureDir, 'sqlite-src');   // extracted amalgamation lives here
const sourceDir   = join(downloadDir, SQLITE_DIR);     // actual .c/.h files
const configPath  = join(fixtureDir, 'migration.config.json');
const aamfRoot    = join(fixtureDir, '.aamf');
const progressDir = join(aamfRoot, 'migration', 'sqlite-to-csharp-net9');
const tmpRoot     = join(fixtureDir, 'tmp');
const outputDir   = join(tmpRoot, 'sqlite-csharp-output');

/* ── Helpers ──────────────────────────────────────────────────────── */

/**
 * Download and extract the official SQLite amalgamation tarball.
 * Skips the download if the source directory already exists (cached).
 */
async function ensureSqliteSource(): Promise<void> {
  // If we already have the extracted source, skip download
  try {
    const s = await stat(sourceDir);
    if (s.isDirectory()) return;
  } catch { /* does not exist — download */ }

  await mkdir(downloadDir, { recursive: true });

  console.log(`Downloading SQLite amalgamation from ${SQLITE_URL} …`);
  execSync(`curl -fSL "${SQLITE_URL}" -o "${join(downloadDir, SQLITE_TARBALL)}"`, {
    stdio: 'inherit',
    timeout: 120_000,
  });

  console.log('Extracting tarball …');
  execSync(`tar -xzf "${SQLITE_TARBALL}"`, {
    cwd: downloadDir,
    stdio: 'inherit',
    timeout: 30_000,
  });

  // Verify the key files are present
  const files = await readdir(sourceDir);
  if (!files.includes('sqlite3.c') || !files.includes('sqlite3.h')) {
    throw new Error(
      `Expected sqlite3.c and sqlite3.h in ${sourceDir}, found: ${files.join(', ')}`,
    );
  }
  console.log(`SQLite source ready at ${sourceDir}`);
}

/**
 * Write a migration.config.json pointing at the downloaded SQLite
 * amalgamation source, targeting C# on .NET 9.
 */
async function writeMigrationConfig(): Promise<void> {
  const config = {
    projectName: 'sqlite-to-csharp-net9',
    source: {
      path: sourceDir,
      language: 'c',
      entryPoints: ['sqlite3.c'],
      excludePatterns: ['.git', '*.o', '*.lo', '*.la', '*.pc', 'Makefile*', 'config.*', 'libtool', 'stamp-*'],
    },
    target: {
      language: 'csharp',
      framework: 'net9.0',
      outputPath: outputDir,
      testFramework: 'xunit',
      buildCommand: 'dotnet build',
      testCommand: 'dotnet test',
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
 * End-to-end integration test: SQLite (C) → C# (.NET 9).
 *
 * Downloads the official SQLite amalgamation (sqlite3.c + sqlite3.h,
 * ~250 K lines of C) from sqlite.org and runs the full AAMF migration
 * pipeline to produce an idiomatic C# port targeting .NET 9.
 *
 * Gated behind the AAMF_E2E=1 environment variable because it requires:
 * - A working `copilot` CLI binary on PATH
 * - Network access (download + LLM API calls)
 * - A valid Copilot subscription
 *
 * The SQLite version can be overridden with:
 *   SQLITE_VERSION=3510200 SQLITE_YEAR=2025
 *
 * Run with:
 *   AAMF_E2E=1 npx vitest run tests/e2e-sqlite-csharp.test.ts
 */
const runE2E = process.env.AAMF_E2E === '1';
const keepArtifacts = process.env.AAMF_KEEP_ARTIFACTS === '1';

describe.skipIf(!runE2E)('E2E SQLite C → C# (.NET 9) Migration', () => {
  let result: Awaited<ReturnType<MigrationRuntime['run']>>;

  beforeAll(async () => {
    // 1. Download the real SQLite amalgamation (cached across runs)
    await ensureSqliteSource();

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
  }, 43_200_000); // 12-hour timeout — ~250 K lines of C amalgamation, 7 phases × many LLM round-trips

  afterAll(async () => {
    if (keepArtifacts) return;
    // Clean up migration artefacts (keep downloaded source for cache)
    await rm(aamfRoot, { recursive: true, force: true });
    await rm(outputDir, { recursive: true, force: true });
  });

  // ── Source verification ──────────────────────────────────────────────────

  it('should have downloaded the full SQLite amalgamation', async () => {
    const sqlite3c = join(sourceDir, 'sqlite3.c');
    expect(await fileExists(sqlite3c)).toBe(true);

    const content = await readFile(sqlite3c, 'utf-8');
    // The real amalgamation is > 200K lines
    const lineCount = content.split('\n').length;
    expect(lineCount).toBeGreaterThan(200_000);
  });

  it('should have sqlite3.h header', async () => {
    const sqlite3h = join(sourceDir, 'sqlite3.h');
    expect(await fileExists(sqlite3h)).toBe(true);

    const content = await readFile(sqlite3h, 'utf-8');
    expect(content).toContain('SQLITE_OK');
    expect(content).toContain('sqlite3_open');
  });

  // ── Overall result ───────────────────────────────────────────────────────

  it('should complete successfully', () => {
    expect(result.success).toBe(true);
    expect(result.projectName).toBe('sqlite-to-csharp-net9');
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
    expect(checkpoint.projectName).toBe('sqlite-to-csharp-net9');
    expect(checkpoint.completedPhases).toEqual(
      expect.arrayContaining([1, 2, 3, 4, 5, 6, 7]),
    );
  });

  it('should create progress.md covering every phase', async () => {
    const progressMd = await readFile(join(progressDir, 'progress.md'), 'utf-8');
    expect(progressMd).toContain('sqlite-to-csharp-net9');
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

  // ── C# Output artefacts ──────────────────────────────────────────────────

  it('should produce C# output files', async () => {
    expect(await fileExists(outputDir)).toBe(true);
    const outputFiles = (await readdir(outputDir, { recursive: true })) as string[];

    const csFiles = outputFiles.filter(f => f.endsWith('.cs'));
    // The full SQLite amalgamation should produce many C# files
    expect(csFiles.length).toBeGreaterThan(0);
  });

  it('should produce a .NET 9 project file', async () => {
    const outputFiles = (await readdir(outputDir, { recursive: true })) as string[];

    const projFiles = outputFiles.filter(f => f.endsWith('.csproj'));
    expect(projFiles.length).toBeGreaterThan(0);

    const projContent = await readFile(join(outputDir, projFiles[0]), 'utf-8');
    expect(projContent).toContain('net9.0');
  });

  it('should produce a B-tree module in the output', async () => {
    const outputFiles = (await readdir(outputDir, { recursive: true })) as string[];
    const hasBtree = outputFiles.some(
      f => f.toLowerCase().includes('btree') && f.toLowerCase().endsWith('.cs'),
    );
    expect(hasBtree).toBe(true);
  });

  it('should produce a Pager module in the output', async () => {
    const outputFiles = (await readdir(outputDir, { recursive: true })) as string[];
    const hasPager = outputFiles.some(
      f => f.toLowerCase().includes('pager') && f.toLowerCase().endsWith('.cs'),
    );
    expect(hasPager).toBe(true);
  });

  it('should produce a VDBE module in the output', async () => {
    const outputFiles = (await readdir(outputDir, { recursive: true })) as string[];
    const hasVdbe = outputFiles.some(
      f => f.toLowerCase().includes('vdbe') && f.toLowerCase().endsWith('.cs'),
    );
    expect(hasVdbe).toBe(true);
  });

  it('should produce a Tokenizer module in the output', async () => {
    const outputFiles = (await readdir(outputDir, { recursive: true })) as string[];
    const hasTokenizer = outputFiles.some(
      f => f.toLowerCase().includes('tokenizer') && f.toLowerCase().endsWith('.cs'),
    );
    expect(hasTokenizer).toBe(true);
  });

  it('should produce an OS abstraction module in the output', async () => {
    const outputFiles = (await readdir(outputDir, { recursive: true })) as string[];
    const hasOs = outputFiles.some(
      f =>
        (f.toLowerCase().includes('os') || f.toLowerCase().includes('platform')) &&
        f.toLowerCase().endsWith('.cs'),
    );
    expect(hasOs).toBe(true);
  });

  it('should produce xUnit test files in the output', async () => {
    const outputFiles = (await readdir(outputDir, { recursive: true })) as string[];
    const testFiles = outputFiles.filter(
      f =>
        f.toLowerCase().endsWith('.cs') &&
        (f.toLowerCase().includes('test') || f.toLowerCase().includes('spec')),
    );
    expect(testFiles.length).toBeGreaterThan(0);
  });

  it('C# output should use idiomatic .NET patterns', async () => {
    const outputFiles = (await readdir(outputDir, { recursive: true })) as string[];
    const csFiles = outputFiles.filter(f => f.endsWith('.cs'));

    // Sample a few C# files and check for idiomatic patterns
    let allContent = '';
    for (const f of csFiles.slice(0, 10)) {
      allContent += await readFile(join(outputDir, f), 'utf-8');
    }

    // Should use C# namespace declarations
    expect(allContent).toMatch(/namespace\s+\w/);
    // Should use using directives
    expect(allContent).toMatch(/using\s+\w/);
  });

  it('C# output should contain SQLite result code constants', async () => {
    const outputFiles = (await readdir(outputDir, { recursive: true })) as string[];
    const csFiles = outputFiles.filter(f => f.endsWith('.cs'));

    let allContent = '';
    for (const f of csFiles) {
      allContent += await readFile(join(outputDir, f), 'utf-8');
    }

    // Core SQLite constants must be present somewhere in the output
    expect(allContent).toMatch(/SQLITE_OK|SqliteResult\.Ok|ResultCode\.Ok/i);
    expect(allContent).toMatch(/SQLITE_ERROR|SqliteResult\.Error|ResultCode\.Error/i);
  });

  it('C# output should contain the public API surface', async () => {
    const outputFiles = (await readdir(outputDir, { recursive: true })) as string[];
    const csFiles = outputFiles.filter(f => f.endsWith('.cs'));

    let allContent = '';
    for (const f of csFiles) {
      allContent += await readFile(join(outputDir, f), 'utf-8');
    }

    // Key public API methods should be migrated
    expect(allContent).toMatch(/Open|open/);
    expect(allContent).toMatch(/Close|close|Dispose/);
    expect(allContent).toMatch(/Exec|Execute|exec/);
    expect(allContent).toMatch(/Prepare|prepare/);
    expect(allContent).toMatch(/Step|step/);
    expect(allContent).toMatch(/Finalize|finalize|Dispose/);
  });
});
