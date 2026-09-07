import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildRuntimePaths } from '../../src/core/runtime-paths.js';
import { CheckpointManager } from '../../src/core/checkpoint.js';
import { ProgressWriter } from '../../src/core/progress.js';
import { fileExists } from '../../src/util/fs.js';
import { createMockConfig, createSilentLogger } from '../helpers/mocks.js';

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe('buildRuntimePaths', () => {
  it('defines the canonical state, report, metric, and KB layout', () => {
    const paths = buildRuntimePaths('/workspace/project', 'demo');
    const root = join('/workspace/project', '.aamf', 'migration', 'demo');
    expect(paths.root).toBe(root);
    expect(paths.checkpointFile).toBe(join(root, 'state', 'checkpoint.json'));
    expect(paths.checkpointBackupFile).toBe(join(root, 'state', 'checkpoint.backup.json'));
    expect(paths.progressReportFile).toBe(join(root, 'reports', 'progress.md'));
    expect(paths.metricsSummaryFile).toBe(join(root, 'metrics', 'summary.json'));
    expect(paths.kbDbFile).toBe(join(root, 'kb.db'));
  });

  it('matches the artifact locations used by checkpoint and progress writers', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'aamf-runtime-paths-'));
    const paths = buildRuntimePaths(tempDir, 'layout-test');
    const logger = createSilentLogger(tempDir);
    const checkpoint = new CheckpointManager(paths.root, logger);
    const progress = new ProgressWriter(paths.progressReportFile, 'layout-test');

    await checkpoint.load('layout-test');
    await progress.initialize(createMockConfig({ projectName: 'layout-test' }));

    expect(await fileExists(paths.checkpointFile)).toBe(true);
    expect(await fileExists(paths.progressReportFile)).toBe(true);
    expect(await fileExists(join(paths.root, 'checkpoint.json'))).toBe(false);
    expect(await fileExists(join(paths.root, 'progress.md'))).toBe(false);
  });
});
