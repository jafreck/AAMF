import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rm, readdir, readFile, stat } from 'node:fs/promises';
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
 * End-to-end smoke test that exercises the full pipeline with a real
 * Copilot CLI installation.
 *
 * Gated behind the AAMF_E2E=1 environment variable because it requires:
 * - A working `copilot` CLI binary on PATH
 * - Network access for LLM API calls
 * - A valid Copilot subscription
 *
 * Run with:
 *   AAMF_E2E=1 npx vitest run tests/e2e-smoke.test.ts
 */
const runE2E = process.env.AAMF_E2E === '1';
const keepArtifacts = process.env.AAMF_KEEP_ARTIFACTS === '1';

describe.skipIf(!runE2E)('E2E Smoke Test', () => {
  beforeAll(async () => {
    // Clean up any previous run artefacts
    await rm(aamfRoot, { recursive: true, force: true });
    await rm(tmpRoot, { recursive: true, force: true });
  });

  afterAll(async () => {
    if (keepArtifacts) return;
    // Clean up artefacts created during the test (even after failures)
    await rm(aamfRoot, { recursive: true, force: true });
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('should initialize the runtime from the fixture config', async () => {
    const runtime = new MigrationRuntime();
    await runtime.initialize({
      configPath,
      logLevel: 'info',
    });

    // If we get here without throwing, initialization succeeded
    expect(true).toBe(true);
  });

  it('should run Phase 1 (Impact Assessment) and produce expected artefacts', async () => {
    const runtime = new MigrationRuntime();
    await runtime.initialize({
      configPath,
      phase: 1,
      logLevel: 'info',
    });

    const result = await runtime.run();

    // --- Verify a checkpoint was created ---
    const checkpointPath = join(progressDir, 'checkpoint.json');
    expect(await fileExists(checkpointPath)).toBe(true);

    const checkpoint = JSON.parse(await readFile(checkpointPath, 'utf-8'));
    expect(checkpoint.projectName).toBe('tiny-calc-migration');

    // --- Verify progress directory structure ---
    expect(await fileExists(progressDir)).toBe(true);
    const progressFiles = await readdir(progressDir);
    expect(progressFiles).toContain('progress.md');
    expect(progressFiles).toContain('checkpoint.json');
    expect(progressFiles).toContain('logs');

    // --- Verify progress.md was written ---
    const progressMd = await readFile(join(progressDir, 'progress.md'), 'utf-8');
    expect(progressMd).toContain('tiny-calc-migration');
    expect(progressMd).toContain('Impact Assessment');

    // --- Verify the logs directory has at least one log ---
    const logsDir = join(progressDir, 'logs');
    if (await fileExists(logsDir)) {
      const logs = await readdir(logsDir);
      expect(logs.length).toBeGreaterThan(0);
    }

    // --- Verify the result object ---
    expect(result.projectName).toBe('tiny-calc-migration');
    expect(result.phases.length).toBeGreaterThanOrEqual(1);
    expect(result.phases[0]?.phase).toBe(1);
  }, 180_000); // 3-minute timeout for real CLI call
});
