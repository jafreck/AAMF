/**
 * @module indexer/ensure-python-deps
 *
 * Validates that the Python environment has the packages required for
 * embedding generation (`sentence-transformers`, `torch`).  If missing,
 * attempts an automatic `pip install` before the first embedding run.
 *
 * This is only used when `kbIndex.embeddings.enabled` is `true` in the
 * migration config.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Python packages required by the sentence-transformers embedding provider. */
const REQUIRED_PACKAGES = ['sentence_transformers', 'torch'];

/**
 * Checks whether each of `REQUIRED_PACKAGES` is importable by the given Python
 * binary.  For any missing package, runs `pip install sentence-transformers`
 * (which pulls in `torch` as a transitive dependency).
 *
 * Throws if the Python binary is not found or if `pip install` fails.
 *
 * @param pythonBin  Path to the Python 3 interpreter (default: `'python3'`).
 * @param timeout    Maximum milliseconds to wait for the install (default: 5 min).
 */
export async function ensurePythonDeps(
  pythonBin = 'python3',
  timeout = 5 * 60_000,
): Promise<void> {
  // Probe which packages are already available.
  const missing: string[] = [];
  for (const pkg of REQUIRED_PACKAGES) {
    try {
      await execFileAsync(pythonBin, ['-c', `import ${pkg}`], { timeout: 10_000 });
    } catch {
      missing.push(pkg);
    }
  }

  if (missing.length === 0) return;

  // `sentence-transformers` transitively installs torch, so a single pip
  // install call is sufficient.
  await execFileAsync(
    pythonBin,
    ['-m', 'pip', 'install', '--quiet', 'sentence-transformers'],
    { timeout },
  );

  // Verify the install succeeded.
  for (const pkg of REQUIRED_PACKAGES) {
    await execFileAsync(pythonBin, ['-c', `import ${pkg}`], { timeout: 10_000 });
  }
}
