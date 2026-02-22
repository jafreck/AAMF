import { mkdir, readFile, writeFile, rename, stat, readdir, copyFile as fsCopyFile } from 'node:fs/promises';
import { dirname, join, extname } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Write content to a file atomically by writing to a temp file first,
 * then renaming it into place.
 */
export async function atomicWrite(filePath: string, content: string): Promise<void> {
  const dir = dirname(filePath);
  await ensureDir(dir);
  const tmpPath = join(dir, `.tmp-${randomUUID()}`);
  await writeFile(tmpPath, content, 'utf-8');
  await rename(tmpPath, filePath);
}

/**
 * Recursively create a directory (like mkdir -p).
 */
export async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}

/**
 * Check whether a file exists at the given path.
 */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read and parse a JSON file, returning the parsed value typed as T.
 */
export async function readJson<T>(filePath: string): Promise<T> {
  const raw = await readFile(filePath, 'utf-8');
  return JSON.parse(raw) as T;
}

/**
 * Atomically write a value as pretty-printed JSON (2-space indent).
 */
export async function writeJson(filePath: string, data: unknown): Promise<void> {
  const content = JSON.stringify(data, null, 2) + '\n';
  await atomicWrite(filePath, content);
}

/**
 * List files in a directory, optionally filtering by a simple suffix pattern
 * (e.g. ".json", ".ts").
 */
export async function listFiles(dirPath: string, pattern?: string): Promise<string[]> {
  const entries = await readdir(dirPath, { withFileTypes: true });
  let files = entries.filter((e) => e.isFile()).map((e) => e.name);
  if (pattern) {
    const suffix = pattern.startsWith('.') ? pattern : `.${pattern}`;
    files = files.filter((f) => extname(f) === suffix);
  }
  return files;
}

/**
 * Copy a file from src to dest, creating the destination directory if needed.
 */
export async function copyFile(src: string, dest: string): Promise<void> {
  await ensureDir(dirname(dest));
  await fsCopyFile(src, dest);
}
