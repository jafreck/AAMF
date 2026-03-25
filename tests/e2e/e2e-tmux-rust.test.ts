import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rm, readdir, readFile, mkdir, stat } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { MigrationRuntime } from '../../src/core/runtime.js';
import { fileExists } from '../../src/util/fs.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

/* ── tmux release download settings ──────────────────────────────── */

/**
 * Override via environment variables:
 *   TMUX_VERSION — e.g. "3.6a"  (default: 3.6a)
 */
const TMUX_VERSION = process.env.TMUX_VERSION ?? '3.6a';
const TMUX_TAG = TMUX_VERSION;
const TMUX_TARBALL = `tmux-${TMUX_VERSION}.tar.gz`;
const TMUX_URL = `https://github.com/tmux/tmux/releases/download/${TMUX_TAG}/${TMUX_TARBALL}`;
const TMUX_DIR = `tmux-${TMUX_VERSION}`;

/* ── Paths ────────────────────────────────────────────────────────── */

const fixtureDir = join(__dirname, '..', 'fixtures', 'tmux-c-project');
const downloadDir = join(fixtureDir, 'tmux-src');
const sourceRoot = join(downloadDir, TMUX_DIR);
const configPath = join(fixtureDir, 'migration.config.json');
const aamfRoot = join(fixtureDir, '.aamf');
const progressDir = join(aamfRoot, 'migration', 'tmux-to-rust');
const tmpRoot = join(fixtureDir, 'tmp');
const outputDir = join(tmpRoot, 'tmux-rust-output');

/* ── Helpers ──────────────────────────────────────────────────────── */

/**
 * Download and extract the official tmux release tarball from GitHub.
 * Skips the download if the source directory already exists (cached).
 */
async function ensureTmuxSource(): Promise<void> {
  try {
    const sourceStat = await stat(join(sourceRoot, 'tmux.c'));
    if (sourceStat.isFile()) return;
  } catch { /* does not exist — download */ }

  await mkdir(downloadDir, { recursive: true });

  console.log(`Downloading tmux source from ${TMUX_URL} ...`);
  execSync(
    `curl -fSL "${TMUX_URL}" -o "${join(downloadDir, TMUX_TARBALL)}"`,
    { stdio: 'inherit', timeout: 120_000 },
  );

  console.log('Extracting tarball ...');
  execSync(`tar -xzf "${TMUX_TARBALL}"`, {
    cwd: downloadDir,
    stdio: 'inherit',
    timeout: 30_000,
  });

  const files = await readdir(sourceRoot);
  const requiredFiles = ['tmux.c', 'server-client.c', 'cmd-queue.c', 'tty.c', 'window.c'];
  for (const requiredFile of requiredFiles) {
    if (!files.includes(requiredFile)) {
      throw new Error(
        `Expected ${requiredFile} in ${sourceRoot}, found: ${files.join(', ')}`,
      );
    }
  }

  console.log(`tmux source ready at ${sourceRoot}`);
}

/**
 * End-to-end integration test: tmux (C) → Rust.
 *
 * Downloads the official tmux 3.6a release from GitHub and runs the
 * full AAMF migration pipeline against the checked-in tmux fixture
 * config, which targets a pure native Rust port.
 *
 * tmux is a large event-driven terminal multiplexer with a client/server
 * architecture, PTY management, command parsing, layout logic, key tables,
 * screen diffing, and terminal protocol handling. This exercises AAMF's
 * large-task decomposition, wave-barrier execution mode, and multi-module
 * migration flow on a real-world C codebase.
 *
 * Gated behind the AAMF_E2E=1 environment variable because it requires:
 * - A working `copilot` CLI binary on PATH
 * - Network access (download + LLM API calls)
 * - A valid Copilot subscription
 *
 * The tmux version can be overridden with:
 *   TMUX_VERSION=3.6a
 *
 * Run with:
 *   AAMF_E2E=1 npx vitest run tests/e2e/e2e-tmux-rust.test.ts
 */
const runE2E = process.env.AAMF_E2E === '1';
const keepArtifacts = process.env.AAMF_KEEP_ARTIFACTS === '1';

describe.skipIf(!runE2E)('E2E tmux C → Rust Migration', () => {
  let result: Awaited<ReturnType<MigrationRuntime['run']>>;

  beforeAll(async () => {
    await ensureTmuxSource();

    await rm(aamfRoot, { recursive: true, force: true });
    await rm(outputDir, { recursive: true, force: true });

    const runtime = new MigrationRuntime();
    await runtime.initialize({
      configPath,
      logLevel: 'info',
    });
    result = await runtime.run();
  }, 86_400_000); // 24-hour timeout — tmux is a large multi-module C codebase

  afterAll(async () => {
    if (keepArtifacts) return;
    await rm(aamfRoot, { recursive: true, force: true });
    await rm(outputDir, { recursive: true, force: true });
  });

  // ── Source verification ──────────────────────────────────────────────────

  it('should have downloaded the tmux source tree', async () => {
    expect(await fileExists(join(sourceRoot, 'tmux.c'))).toBe(true);
    expect(await fileExists(join(sourceRoot, 'server-client.c'))).toBe(true);
    expect(await fileExists(join(sourceRoot, 'cmd-queue.c'))).toBe(true);
    expect(await fileExists(join(sourceRoot, 'tty.c'))).toBe(true);
    expect(await fileExists(join(sourceRoot, 'window.c'))).toBe(true);
  });

  it('should contain core tmux source files and support directories', async () => {
    const files = await readdir(sourceRoot);

    expect(files).toContain('tmux.c');
    expect(files).toContain('server-client.c');
    expect(files).toContain('cmd-queue.c');
    expect(files).toContain('tty.c');
    expect(files).toContain('window.c');
    expect(files).toContain('options.c');
    expect(files).toContain('screen.c');
    expect(files).toContain('compat');
  });

  it('should have non-trivial tmux source files to exercise task splitting', async () => {
    const tmuxMain = await readFile(join(sourceRoot, 'tmux.c'), 'utf-8');
    expect(tmuxMain.split('\n').length).toBeGreaterThan(100);

    const serverClient = await readFile(join(sourceRoot, 'server-client.c'), 'utf-8');
    expect(serverClient.split('\n').length).toBeGreaterThan(200);

    const tty = await readFile(join(sourceRoot, 'tty.c'), 'utf-8');
    expect(tty.split('\n').length).toBeGreaterThan(200);
  });

  // ── Overall result ───────────────────────────────────────────────────────

  it('should complete successfully', () => {
    expect(result.success).toBe(true);
    expect(result.projectName).toBe('tmux-to-rust');
  });

  it('should execute all 8 configured phases including KB indexing', () => {
    const phaseIds = result.phases
      .map(phase => phase.phase)
      .sort((left, right) => left - right);

    expect(phaseIds).toEqual([0, 2, 3, 4, 5, 6, 7, 8]);
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

  it('Phase 0 (KB Indexing) should succeed', () => {
    const phase = result.phases.find(p => p.phase === 0);
    expect(phase).toBeDefined();
    expect(phase!.success).toBe(true);
    expect(phase!.name).toBe('KB Indexing');
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

  it('Phase 7 (Idiomatic Refactor) should succeed', () => {
    const phase = result.phases.find(p => p.phase === 7);
    expect(phase).toBeDefined();
    expect(phase!.success).toBe(true);
    expect(phase!.name).toBe('Idiomatic Refactor');
  });

  it('Phase 8 (Completion) should succeed', () => {
    const phase = result.phases.find(p => p.phase === 8);
    expect(phase).toBeDefined();
    expect(phase!.success).toBe(true);
    expect(phase!.name).toBe('Completion');
  });

  // ── Progress & checkpoint artefacts ──────────────────────────────────────

  it('should create a checkpoint recording all phases complete', async () => {
    const checkpointPath = join(progressDir, 'checkpoint.json');
    expect(await fileExists(checkpointPath)).toBe(true);

    const checkpoint = JSON.parse(await readFile(checkpointPath, 'utf-8'));
    expect(checkpoint.projectName).toBe('tmux-to-rust');
    expect(checkpoint.completedPhases).toEqual(
      expect.arrayContaining([0, 1, 2, 3, 4, 5, 6, 7]),
    );
  });

  it('should create a KB database file for Phase 0', async () => {
    const kbDbPath = join(progressDir, 'kb.db');
    expect(await fileExists(kbDbPath)).toBe(true);
  });

  it('should create progress.md covering every phase', async () => {
    const progressMd = await readFile(join(progressDir, 'progress.md'), 'utf-8');
    expect(progressMd).toContain('tmux-to-rust');
    expect(progressMd).toContain('KB Indexing');
    expect(progressMd).toContain('Iterative Migration');
    expect(progressMd).toContain('Completion');
  });

  it('should record wave-barrier execution in metrics output', async () => {
    const summaryPath = join(progressDir, 'metrics', 'summary.json');
    expect(await fileExists(summaryPath)).toBe(true);

    const summary = JSON.parse(await readFile(summaryPath, 'utf-8'));
    expect(summary.phase4ExecutionMode).toBe('wave-barrier');
    expect(summary.completedPhase4Tasks).toBeGreaterThan(0);
    expect(summary.waveCount).toBeGreaterThan(0);
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

  it('should produce Rust test files in the output', async () => {
    const outputFiles = (await readdir(outputDir, { recursive: true })) as string[];
    const testFiles = outputFiles.filter(
      f =>
        f.toLowerCase().endsWith('.rs') &&
        (f.toLowerCase().includes('test') || f.includes('tests/')),
    );

    let hasInlineTests = false;
    const rsFiles = outputFiles.filter(f => f.endsWith('.rs'));
    for (const file of rsFiles.slice(0, 20)) {
      const content = await readFile(join(outputDir, file), 'utf-8');
      if (content.includes('#[test]') || content.includes('#[cfg(test)]')) {
        hasInlineTests = true;
        break;
      }
    }

    expect(testFiles.length > 0 || hasInlineTests).toBe(true);
  });

  it('Rust output should use idiomatic Rust constructs', async () => {
    const outputFiles = (await readdir(outputDir, { recursive: true })) as string[];
    const rsFiles = outputFiles.filter(f => f.endsWith('.rs'));

    let allContent = '';
    for (const file of rsFiles.slice(0, 15)) {
      allContent += await readFile(join(outputDir, file), 'utf-8');
    }

    expect(allContent).toMatch(/(?:pub\s+)?(?:mod|fn|struct|enum|impl)\s+\w/);
  });

  it('Rust output should model tmux core domains', async () => {
    const outputFiles = (await readdir(outputDir, { recursive: true })) as string[];
    const rsFiles = outputFiles.filter(f => f.endsWith('.rs'));

    let allContent = '';
    for (const file of rsFiles) {
      allContent += await readFile(join(outputDir, file), 'utf-8');
    }

    expect(allContent).toMatch(/session|window|pane|client|server|tty/i);
    expect(allContent).toMatch(/command|key|layout|screen/i);
  });

  it('Rust output should include an entrypoint or CLI surface', async () => {
    const outputFiles = (await readdir(outputDir, { recursive: true })) as string[];
    const rsFiles = outputFiles.filter(f => f.endsWith('.rs'));

    const hasCliLikePath = outputFiles.some(f =>
      /main|cli|command|client|server/i.test(f) && f.endsWith('.rs'),
    );

    let hasMainFunction = false;
    for (const file of rsFiles.slice(0, 20)) {
      const content = await readFile(join(outputDir, file), 'utf-8');
      if (content.includes('fn main(')) {
        hasMainFunction = true;
        break;
      }
    }

    expect(hasCliLikePath || hasMainFunction).toBe(true);
  });

  it('Rust output should use unsafe blocks for low-level OS integration', async () => {
    const outputFiles = (await readdir(outputDir, { recursive: true })) as string[];
    const rsFiles = outputFiles.filter(f => f.endsWith('.rs'));

    let allContent = '';
    for (const file of rsFiles) {
      allContent += await readFile(join(outputDir, file), 'utf-8');
    }

    expect(allContent).toMatch(/unsafe\s*\{/);
  });
});