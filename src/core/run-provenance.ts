import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { RuntimePaths } from './runtime-paths.js';

/**
 * Remove artifacts whose provenance cannot be established for a fresh run.
 * Logs are retained. A caller may preserve the source KB as a validation
 * candidate; every other executable artifact is removed. Fresh migration runs
 * preserve it even when reuse is disabled so a forced rebuild can replace it
 * atomically only after certification.
 */
export async function clearFreshRunArtifacts(
  paths: RuntimePaths,
  options: { preserveKb?: boolean } = {},
): Promise<void> {
  const candidates = [
    paths.artifactsDir,
    paths.knowledgeBaseDir,
    ...(!options.preserveKb ? [
      paths.kbDbFile,
      `${paths.kbDbFile}-wal`,
      `${paths.kbDbFile}-shm`,
    ] : []),
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
