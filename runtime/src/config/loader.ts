import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { MigrationConfigSchema, type MigrationConfig } from './schema.js';

/**
 * Load and validate a migration.config.json file.
 *
 * Relative paths in `source.path`, `target.outputPath`, and `copilot.agentDir`
 * are resolved to absolute paths using the config file's directory as the base.
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

  const config = result.data;

  // ---------- resolve relative paths ----------
  config.source.path = resolve(baseDir, config.source.path);
  config.target.outputPath = resolve(baseDir, config.target.outputPath);
  config.copilot.agentDir = resolve(baseDir, config.copilot.agentDir);

  // ---------- freeze & return ----------
  return deepFreeze(config);
}

/**
 * Recursively freeze an object and all nested objects / arrays.
 */
function deepFreeze<T extends object>(obj: T): Readonly<T> {
  for (const value of Object.values(obj)) {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
      deepFreeze(value as object);
    }
  }
  return Object.freeze(obj);
}
