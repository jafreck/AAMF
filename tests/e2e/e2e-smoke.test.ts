import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rm, readdir, readFile, stat } from 'node:fs/promises';
import { MigrationRuntime } from '../../src/core/runtime.js';
import { fileExists } from '../../src/util/fs.js';
import { e2eRuntimePaths, keepE2eArtifacts, validateE2ePreflight } from '../helpers/e2e.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const fixtureDir = join(__dirname, '..', 'fixtures', 'tiny-python-project');
const configPath = join(fixtureDir, 'migration.config.json');
const aamfRoot = join(fixtureDir, '.aamf');
const runtimePaths = e2eRuntimePaths(fixtureDir, 'tiny-calc-migration');
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

describe.skipIf(!runE2E)('E2E Smoke Test', () => {
  beforeAll(async () => {
    // Clean up any previous run artefacts
    await rm(aamfRoot, { recursive: true, force: true });
    await rm(tmpRoot, { recursive: true, force: true });
    await validateE2ePreflight({ configPath, fixtureRoot: fixtureDir, expectedProjectName: 'tiny-calc-migration' });
  });

  afterAll(async () => {
    if (keepE2eArtifacts) return;
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

  it('should run Phase 2 (Knowledge Base Construction) and produce expected artefacts', async () => {
    const runtime = new MigrationRuntime();
    await runtime.initialize({
      configPath,
      phase: 2,
      logLevel: 'info',
    });

    const result = await runtime.run();

    // --- Verify a checkpoint was created ---
    const checkpointPath = runtimePaths.checkpointFile;
    expect(await fileExists(checkpointPath)).toBe(true);

    const checkpoint = JSON.parse(await readFile(checkpointPath, 'utf-8'));
    expect(checkpoint.projectName).toBe('tiny-calc-migration');

    // --- Verify progress directory structure ---
    expect(await fileExists(runtimePaths.root)).toBe(true);
    expect(await fileExists(runtimePaths.progressReportFile)).toBe(true);
    expect(await fileExists(runtimePaths.checkpointFile)).toBe(true);
    expect(await fileExists(runtimePaths.logsRuntimeDir)).toBe(true);

    // --- Verify progress.md was written ---
    const progressMd = await readFile(runtimePaths.progressReportFile, 'utf-8');
    expect(progressMd).toContain('tiny-calc-migration');
    expect(progressMd).toContain('Knowledge Base Construction');

    // --- Verify the logs directory has at least one log ---
    const logsDir = runtimePaths.logsRuntimeDir;
    if (await fileExists(logsDir)) {
      const logs = await readdir(logsDir);
      expect(logs.length).toBeGreaterThan(0);
    }

    // --- Verify the result object ---
    expect(result.projectName).toBe('tiny-calc-migration');
    expect(result.phases.length).toBeGreaterThanOrEqual(1);
  }, 180_000); // 3-minute timeout for real CLI call
});
