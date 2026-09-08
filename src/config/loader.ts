import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { MigrationConfigSchema, type MigrationConfig } from './schema.js';

/**
 * Load and validate a migration.config.json file.
 *
 * Relative paths in `source.path` and `target.outputPath` are resolved to
 * absolute paths using the config file's directory as the base.
 *
 * @param configPath — path to the migration.config.json file
 * @returns a deeply-frozen {@link MigrationConfig} object
 */
export async function loadConfig(configPath: string): Promise<MigrationConfig> {
  const absoluteConfigPath = resolve(configPath);
  const baseDir = dirname(absoluteConfigPath);

  // ---------- read ----------
  let raw: string;
  try {
    raw = await readFile(absoluteConfigPath, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new Error(`Configuration file not found: ${absoluteConfigPath}`);
    }
    throw new Error(
      `Failed to read configuration file ${absoluteConfigPath}: ${(err as Error).message}`,
    );
  }

  // ---------- parse JSON ----------
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(
      `Configuration file contains invalid JSON: ${absoluteConfigPath}`,
    );
  }

  // ---------- validate ----------
  const result = MigrationConfigSchema.safeParse(json);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  • ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(
      `Invalid configuration in ${absoluteConfigPath}:\n${issues}`,
    );
  }

    const config: MigrationConfig = {
      ...result.data,
      source: {
        ...result.data.source,
        path: resolve(baseDir, result.data.source.path),
      },
      target: {
        ...result.data.target,
        outputPath: resolve(baseDir, result.data.target.outputPath),
      },
    };

    return deepFreeze(config);
}

/**
 * Create a mutable shallow-ish clone of a config, merging CLI overrides
 * into `options` without mutating the original.
 */
export function applyOverrides(
  config: MigrationConfig,
  overrides: { dryRun?: boolean; resume?: boolean },
): MigrationConfig {
    return deepFreeze({
    ...config,
    options: {
      ...config.options,
      ...(overrides.dryRun !== undefined && { dryRun: overrides.dryRun }),
      ...(overrides.resume !== undefined && { resume: overrides.resume }),
    },
  });
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}
