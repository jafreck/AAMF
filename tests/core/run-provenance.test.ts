import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearFreshRunArtifacts } from '../../src/core/run-provenance.js';
import { buildRuntimePaths } from '../../src/core/runtime-paths.js';
import { fileExists } from '../../src/util/fs.js';

describe('clearFreshRunArtifacts', () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryRoots.splice(0).map(root =>
      rm(root, { recursive: true, force: true })));
  });

  it('preserves only the source KB triplet as a reuse or forced-rebuild rollback baseline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aamf-provenance-'));
    temporaryRoots.push(root);
    const paths = buildRuntimePaths(root, 'test-project');
    await mkdir(paths.artifactsDir, { recursive: true });
    await writeFile(join(paths.artifactsDir, 'stale-task.json'), '{}');
    await mkdir(join(paths.kbDbFile, '..'), { recursive: true });
    await Promise.all([
      writeFile(paths.kbDbFile, 'db'),
      writeFile(`${paths.kbDbFile}-wal`, 'wal'),
      writeFile(`${paths.kbDbFile}-shm`, 'shm'),
    ]);

    await clearFreshRunArtifacts(paths, { preserveKb: true });

    expect(await fileExists(paths.artifactsDir)).toBe(false);
    expect(await fileExists(paths.kbDbFile)).toBe(true);
    expect(await fileExists(`${paths.kbDbFile}-wal`)).toBe(true);
    expect(await fileExists(`${paths.kbDbFile}-shm`)).toBe(true);
  });
});