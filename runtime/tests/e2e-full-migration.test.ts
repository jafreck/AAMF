import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rm, readdir, readFile } from 'node:fs/promises';
import { MigrationRuntime } from '../src/core/runtime.js';
import { fileExists } from '../src/util/fs.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const fixtureDir = join(__dirname, 'fixtures', 'tiny-python-project');
const configPath = join(fixtureDir, 'migration.config.json');
const aamfRoot = join(fixtureDir, '.aamf');
const progressDir = join(aamfRoot, 'migration', 'tiny-calc-migration');
const tmpRoot = join(fixtureDir, 'tmp');
const outputDir = join(tmpRoot, 'e2e-output');

/**
 * Full end-to-end migration test that runs ALL 7 phases against the
 * tiny-python-project fixture, producing a complete TypeScript output.
 *
 * Gated behind the AAMF_E2E=1 environment variable because it requires:
 * - A working `copilot` CLI binary on PATH
 * - Network access for LLM API calls
 * - A valid Copilot subscription
 *
 * Run with:
 *   AAMF_E2E=1 npx vitest run tests/e2e-full-migration.test.ts
 */
const runE2E = process.env.AAMF_E2E === '1';

describe.skipIf(!runE2E)('E2E Full Migration', () => {
  let result: Awaited<ReturnType<MigrationRuntime['run']>>;

  beforeAll(async () => {
    // Clean up any previous run artefacts
    await rm(aamfRoot, { recursive: true, force: true });
    await rm(tmpRoot, { recursive: true, force: true });

    // Run the full migration (all phases, no phase filter)
    const runtime = new MigrationRuntime();
    await runtime.initialize({
      configPath,
      logLevel: 'info',
    });
    result = await runtime.run();
  }, 1_800_000); // 30-minute timeout for a full migration

  afterAll(async () => {
    // Clean up artefacts created during the test (even after failures)
    await rm(aamfRoot, { recursive: true, force: true });
    await rm(tmpRoot, { recursive: true, force: true });
  });

  // ── Overall result ───────────────────────────────────────────────────────

  it('should complete successfully', () => {
    expect(result.success).toBe(true);
    expect(result.projectName).toBe('tiny-calc-migration');
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
    expect(checkpoint.projectName).toBe('tiny-calc-migration');
    expect(checkpoint.completedPhases).toEqual(expect.arrayContaining([1, 2, 3, 4, 5, 6, 7]));
  });

  it('should create progress.md covering every phase', async () => {
    const progressMd = await readFile(join(progressDir, 'progress.md'), 'utf-8');
    expect(progressMd).toContain('tiny-calc-migration');
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

  // ── Output artefacts ─────────────────────────────────────────────────────

  it('should produce TypeScript output files', async () => {
    expect(await fileExists(outputDir)).toBe(true);
    const outputFiles = (await readdir(outputDir, { recursive: true })) as string[];

    // At minimum, we expect .ts files corresponding to the source modules
    const tsFiles = outputFiles.filter(f => f.endsWith('.ts'));
    expect(tsFiles.length).toBeGreaterThan(0);
  });

  it('should produce a calculator module in the output', async () => {
    // The migrator should create some TypeScript equivalent of calculator.py
    const outputFiles = (await readdir(outputDir, { recursive: true })) as string[];
    const fileNames = outputFiles.map(f => f.toLowerCase());

    const hasCalculator = fileNames.some(
      f => f.includes('calculator') && f.endsWith('.ts'),
    );
    expect(hasCalculator).toBe(true);

    // Read it and verify it contains class/function definitions
    const calcFile = fileNames.find(
      f => f.includes('calculator') && f.endsWith('.ts'),
    )!;
    const calcContent = await readFile(join(outputDir, calcFile), 'utf-8');
    expect(calcContent.length).toBeGreaterThan(0);
    // Should contain TypeScript constructs
    expect(calcContent).toMatch(/class|function|export/);
  });

  it('should produce test files in the output', async () => {
    const outputFiles = (await readdir(outputDir, { recursive: true })) as string[];
    const testFiles = outputFiles.filter(f => f.includes('.test.') || f.includes('.spec.'));
    expect(testFiles.length).toBeGreaterThan(0);
  });
});
