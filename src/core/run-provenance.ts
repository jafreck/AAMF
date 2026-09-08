import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { RuntimePaths } from './runtime-paths.js';

/**
 * Remove artifacts whose provenance cannot be established for a fresh run.
 * Logs are retained, but no executable checkpoint input, index, task graph,
 * target index, metric, or report is allowed to leak into the new run.
 */
export async function clearFreshRunArtifacts(paths: RuntimePaths): Promise<void> {
  const candidates = [
    paths.artifactsDir,
    paths.knowledgeBaseDir,
    paths.kbDbFile,
    `${paths.kbDbFile}-wal`,
    `${paths.kbDbFile}-shm`,
    paths.kbTargetDbFile,
    `${paths.kbTargetDbFile}-wal`,
    `${paths.kbTargetDbFile}-shm`,
    paths.metricsDir,
    paths.reportsDir,
    paths.runManifestFile,
    ...(paths.stateDir ? [join(paths.stateDir, 'target-change-sets')] : []),
  ].filter((path): path is string => typeof path === 'string' && path.length > 0);

  await Promise.all(candidates.map(path => rm(path, { recursive: true, force: true })));
}
