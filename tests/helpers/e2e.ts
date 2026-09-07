import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { loadConfig } from '../../src/config/loader.js';
import { validateSourceAvailability } from '../../src/core/runtime.js';
import { buildRuntimePaths, type RuntimePaths } from '../../src/core/runtime-paths.js';
import type { MigrationConfig } from '../../src/config/schema.js';
import { resolveLoginPath } from '../../src/util/process.js';

export const keepE2eArtifacts = process.env.AAMF_E2E_KEEP_ARTIFACTS === '1';

export function e2eRuntimePaths(projectRoot: string, projectName: string): RuntimePaths {
  return buildRuntimePaths(projectRoot, projectName);
}

export async function validateE2ePreflight(options: {
  configPath: string;
  fixtureRoot: string;
  expectedProjectName: string;
  checkAgentCli?: boolean;
}): Promise<MigrationConfig> {
  const config = await loadConfig(options.configPath);
  const configRoot = dirname(resolve(options.configPath));
  if (configRoot !== resolve(options.fixtureRoot)) {
    throw new Error(`E2E fixture root must match the configuration directory: ${configRoot}`);
  }
  if (config.projectName !== options.expectedProjectName) {
    throw new Error(
      `E2E project mismatch: expected ${options.expectedProjectName}, received ${config.projectName}`,
    );
  }

  await validateSourceAvailability(config);

  const fixtureRoot = resolve(options.fixtureRoot);
  const outputPath = resolve(config.target.outputPath);
  const outputRelative = relative(fixtureRoot, outputPath);
  if (!outputRelative || outputRelative === '..' || outputRelative.startsWith(`..${sep}`) || isAbsolute(outputRelative)) {
    throw new Error(`E2E target.outputPath must be inside the fixture root: ${outputPath}`);
  }

  if (options.checkAgentCli !== false) {
    const path = config.environment.inheritShellPath
      ? await resolveLoginPath({
          shell: config.environment.shell,
          extraPath: config.environment.extraPath,
        })
      : [
          ...(config.environment.extraPath ?? []).map(entry => entry.replace(/^~(?=\/|$)/, homedir())),
          process.env.PATH ?? '',
        ].filter(Boolean).join(delimiter);
    await assertExecutableOnPath(config.agentBackend.cliCommand, path);
  }
  return config;
}

async function assertExecutableOnPath(command: string, path: string): Promise<void> {
  const candidates = command.includes('/')
    ? [resolve(command)]
    : path.split(delimiter).filter(Boolean).map(directory => resolve(directory, command));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return;
    } catch {
      // Try the next PATH entry.
    }
  }
  throw new Error(`Configured agent CLI is not executable on PATH: ${command}`);
}
