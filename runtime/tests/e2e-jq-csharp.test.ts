import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rm, readdir, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { MigrationRuntime } from '../src/core/runtime.js';
import { fileExists } from '../src/util/fs.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

/* ── jq release download settings ────────────────────────────────── */

/**
 * Override via environment variables:
 *   JQ_VERSION — e.g. "1.8.1"  (default: 1.8.1)
 */
const JQ_VERSION  = process.env.JQ_VERSION ?? '1.8.1';
const JQ_TAG      = `jq-${JQ_VERSION}`;
const JQ_TARBALL  = `${JQ_TAG}.tar.gz`;
const JQ_URL      = `https://github.com/jqlang/jq/releases/download/${JQ_TAG}/${JQ_TARBALL}`;
const JQ_DIR      = JQ_TAG; // extracted directory name: jq-1.8.1

/* ── Paths ────────────────────────────────────────────────────────── */

const fixtureDir  = join(__dirname, 'fixtures', 'jq-c-project');
const downloadDir = join(fixtureDir, 'jq-src');        // extracted source lives here
const sourceDir   = join(downloadDir, JQ_DIR);          // actual C source tree
const configPath  = join(fixtureDir, 'migration.config.json');
const aamfRoot    = join(fixtureDir, '.aamf');
const progressDir = join(aamfRoot, 'migration', 'jq-to-csharp-net9');
const tmpRoot     = join(fixtureDir, 'tmp');
const outputDir   = join(tmpRoot, 'jq-csharp-output');

/* ── Helpers ──────────────────────────────────────────────────────── */

/**
 * Download and extract the official jq release tarball from GitHub.
 * Skips the download if the source directory already exists (cached).
 */
async function ensureJqSource(): Promise<void> {
  // If we already have the extracted source, skip download
  try {
    const s = await stat(sourceDir);
    if (s.isDirectory()) return;
  } catch { /* does not exist — download */ }

  await mkdir(downloadDir, { recursive: true });

  console.log(`Downloading jq source from ${JQ_URL} …`);
  execSync(
    `curl -fSL "${JQ_URL}" -o "${join(downloadDir, JQ_TARBALL)}"`,
    { stdio: 'inherit', timeout: 120_000 },
  );

  console.log('Extracting tarball …');
  execSync(`tar -xzf "${JQ_TARBALL}"`, {
    cwd: downloadDir,
    stdio: 'inherit',
    timeout: 30_000,
  });

  // Verify key source files are present
  const srcDir = join(sourceDir, 'src');
  const files = await readdir(srcDir);
  if (!files.includes('main.c') || !files.includes('execute.c')) {
    throw new Error(
      `Expected main.c and execute.c in ${srcDir}, found: ${files.join(', ')}`,
    );
  }
  console.log(`jq source ready at ${sourceDir}`);
}

/**
 * Write a migration.config.json pointing at the downloaded jq source,
 * targeting C# on .NET 9.
 */
async function writeMigrationConfig(): Promise<void> {
  const config = {
    projectName: 'jq-to-csharp-net9',
    source: {
      path: sourceDir,
      language: 'c',
      entryPoints: ['src/main.c'],
      excludePatterns: [
        '.git', '*.o', '*.lo', '*.la', '*.pc', '*.m4',
        'Makefile*', 'config.*', 'configure*', 'libtool',
        'stamp-*', 'aclocal*', 'autom4te*', 'compile',
        'depcomp', 'install-sh', 'missing', 'ltmain.sh',
        'test-driver', 'docs/**', 'tests/**', 'm4/**',
      ],
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
 * End-to-end integration test: jq (C) → C# (.NET 9).
 *
 * Downloads the official jq release tarball (~20–30 K lines of C) from
 * GitHub and runs the full AAMF migration pipeline to produce an
 * idiomatic C# port targeting .NET 9.
 *
 * jq is a lightweight command-line JSON processor. Its core modules
 * include a lexer, parser, bytecode compiler, stack-based VM (execute),
 * JSON value system (jv), and a rich set of built-in functions.
 *
 * Gated behind the AAMF_E2E=1 environment variable because it requires:
 * - A working `copilot` CLI binary on PATH
 * - Network access (download + LLM API calls)
 * - A valid Copilot subscription
 *
 * The jq version can be overridden with:
 *   JQ_VERSION=1.8.1
 *
 * Run with:
 *   AAMF_E2E=1 npx vitest run tests/e2e-jq-csharp.test.ts
 */
const runE2E = process.env.AAMF_E2E === '1';
const keepArtifacts = process.env.AAMF_KEEP_ARTIFACTS === '1';

describe.skipIf(!runE2E)('E2E jq C → C# (.NET 9) Migration', () => {
  let result: Awaited<ReturnType<MigrationRuntime['run']>>;

  beforeAll(async () => {
    // 1. Download the real jq source (cached across runs)
    await ensureJqSource();

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
  }, 21_600_000); // 6-hour timeout — ~25 K lines of C, 7 phases × many LLM round-trips

  afterAll(async () => {
    if (keepArtifacts) return;
    // Clean up migration artefacts (keep downloaded source for cache)
    await rm(aamfRoot, { recursive: true, force: true });
    await rm(outputDir, { recursive: true, force: true });
  });

  // ── Source verification ──────────────────────────────────────────────────

  it('should have downloaded the jq source tree', async () => {
    const mainC = join(sourceDir, 'src', 'main.c');
    expect(await fileExists(mainC)).toBe(true);
  });

  it('should contain core jq C source files', async () => {
    const srcDir = join(sourceDir, 'src');
    const files = await readdir(srcDir);

    // Core modules that make up jq
    expect(files).toContain('execute.c');
    expect(files).toContain('compile.c');
    expect(files).toContain('builtin.c');
    expect(files).toContain('jv.c');
    expect(files).toContain('jv_parse.c');
    expect(files).toContain('jv_print.c');
    expect(files).toContain('bytecode.c');
    expect(files).toContain('main.c');
  });

  it('should have jq header files', async () => {
    const srcDir = join(sourceDir, 'src');
    const files = await readdir(srcDir);
    const headers = files.filter(f => f.endsWith('.h'));
    expect(headers.length).toBeGreaterThan(0);

    // Key public header
    expect(files).toContain('jq.h');
  });

  // ── Overall result ───────────────────────────────────────────────────────

  it('should complete successfully', () => {
    expect(result.success).toBe(true);
    expect(result.projectName).toBe('jq-to-csharp-net9');
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
    expect(checkpoint.projectName).toBe('jq-to-csharp-net9');
    expect(checkpoint.completedPhases).toEqual(
      expect.arrayContaining([1, 2, 3, 4, 5, 6, 7]),
    );
  });

  it('should create progress.md covering every phase', async () => {
    const progressMd = await readFile(join(progressDir, 'progress.md'), 'utf-8');
    expect(progressMd).toContain('jq-to-csharp-net9');
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
    // jq is a substantial C project — expect multiple C# output files
    expect(csFiles.length).toBeGreaterThan(0);
  });

  it('should produce a .NET 9 project file', async () => {
    const outputFiles = (await readdir(outputDir, { recursive: true })) as string[];

    const projFiles = outputFiles.filter(f => f.endsWith('.csproj'));
    expect(projFiles.length).toBeGreaterThan(0);

    const projContent = await readFile(join(outputDir, projFiles[0]), 'utf-8');
    expect(projContent).toContain('net9.0');
  });

  it('should produce an Execute / VM module in the output', async () => {
    const outputFiles = (await readdir(outputDir, { recursive: true })) as string[];
    const hasExecute = outputFiles.some(
      f => f.toLowerCase().includes('execut') && f.toLowerCase().endsWith('.cs'),
    );
    expect(hasExecute).toBe(true);
  });

  it('should produce a Compiler module in the output', async () => {
    const outputFiles = (await readdir(outputDir, { recursive: true })) as string[];
    const hasCompile = outputFiles.some(
      f => f.toLowerCase().includes('compil') && f.toLowerCase().endsWith('.cs'),
    );
    expect(hasCompile).toBe(true);
  });

  it('should produce a Builtin functions module in the output', async () => {
    const outputFiles = (await readdir(outputDir, { recursive: true })) as string[];
    const hasBuiltin = outputFiles.some(
      f => f.toLowerCase().includes('builtin') && f.toLowerCase().endsWith('.cs'),
    );
    expect(hasBuiltin).toBe(true);
  });

  it('should produce a JSON value (jv) module in the output', async () => {
    const outputFiles = (await readdir(outputDir, { recursive: true })) as string[];
    const hasJv = outputFiles.some(
      f =>
        (f.toLowerCase().includes('jv') ||
          f.toLowerCase().includes('jsonvalue') ||
          f.toLowerCase().includes('json_value')) &&
        f.toLowerCase().endsWith('.cs'),
    );
    expect(hasJv).toBe(true);
  });

  it('should produce a Parser module in the output', async () => {
    const outputFiles = (await readdir(outputDir, { recursive: true })) as string[];
    const hasParser = outputFiles.some(
      f => f.toLowerCase().includes('pars') && f.toLowerCase().endsWith('.cs'),
    );
    expect(hasParser).toBe(true);
  });

  it('should produce a Lexer / Scanner module in the output', async () => {
    const outputFiles = (await readdir(outputDir, { recursive: true })) as string[];
    const hasLexer = outputFiles.some(
      f =>
        (f.toLowerCase().includes('lexer') || f.toLowerCase().includes('scanner')) &&
        f.toLowerCase().endsWith('.cs'),
    );
    expect(hasLexer).toBe(true);
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

  it('C# output should contain jq opcode / bytecode concepts', async () => {
    const outputFiles = (await readdir(outputDir, { recursive: true })) as string[];
    const csFiles = outputFiles.filter(f => f.endsWith('.cs'));

    let allContent = '';
    for (const f of csFiles) {
      allContent += await readFile(join(outputDir, f), 'utf-8');
    }

    // jq has a bytecode VM — expect opcode-like constructs in the output
    expect(allContent).toMatch(/opcode|Opcode|OpCode|instruction|Instruction/i);
  });

  it('C# output should contain JSON value type abstractions', async () => {
    const outputFiles = (await readdir(outputDir, { recursive: true })) as string[];
    const csFiles = outputFiles.filter(f => f.endsWith('.cs'));

    let allContent = '';
    for (const f of csFiles) {
      allContent += await readFile(join(outputDir, f), 'utf-8');
    }

    // jq's jv type system maps to C# enum / class hierarchy
    expect(allContent).toMatch(/JvKind|JsonKind|ValueKind|JvType|JsonType/i);
  });

  it('C# output should contain the public jq API surface', async () => {
    const outputFiles = (await readdir(outputDir, { recursive: true })) as string[];
    const csFiles = outputFiles.filter(f => f.endsWith('.cs'));

    let allContent = '';
    for (const f of csFiles) {
      allContent += await readFile(join(outputDir, f), 'utf-8');
    }

    // Core jq operations should be present in some form
    expect(allContent).toMatch(/[Cc]ompile|[Cc]ompiler/);
    expect(allContent).toMatch(/[Ee]xecut/);
    expect(allContent).toMatch(/[Pp]arse|[Pp]arser/);
    expect(allContent).toMatch(/[Ff]ilter|[Pp]rogram/);
  });
});
