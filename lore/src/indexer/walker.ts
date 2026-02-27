/**
 * @module indexer/walker
 *
 * Walks a directory tree using fast-glob and maps each file to a detected
 * programming language based on its extension.
 */

import fg from 'fast-glob';
import { extname } from 'node:path';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Configuration for a `walkFiles` call. */
export interface WalkerConfig {
  /** Absolute path to the directory to scan. */
  rootDir: string;

  /**
   * Glob patterns (relative to `rootDir`) for files to include.
   * Defaults to `['**\/*']` when empty or omitted.
   */
  includeGlobs?: string[];

  /**
   * Glob patterns (relative to `rootDir`) for paths to exclude.
   * Merged with the built-in default exclusion list.
   */
  excludeGlobs?: string[];

  /**
   * Explicit file extensions to accept (with leading dot, e.g. `'.ts'`).
   * When provided, files whose extension is not in this list are skipped.
   * When omitted, all extensions that map to a known language are accepted.
   */
  extensions?: string[];
}

/** A single file discovered by `walkFiles`. */
export interface FileEntry {
  /** Absolute path to the file. */
  path: string;

  /** Detected programming language (lower-case identifier). */
  language: string;
}

// ─── Extension → Language mapping ────────────────────────────────────────────

const EXT_TO_LANG: Record<string, string> = {
  '.c':    'c',
  '.h':    'c',
  '.rs':   'rust',
  '.py':   'python',
  '.cpp':  'cpp',
  '.cc':   'cpp',
  '.cxx':  'cpp',
  '.hpp':  'cpp',
  '.hxx':  'cpp',
  '.ts':   'typescript',
  '.tsx':  'typescript',
  '.js':   'javascript',
  '.jsx':  'javascript',
  '.mjs':  'javascript',
  '.cjs':  'javascript',
  '.go':   'go',
  '.java': 'java',
  '.cs':   'csharp',
};

// Paths always excluded unless the caller overrides them.
const DEFAULT_EXCLUDES = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/__pycache__/**',
  '**/target/**',
];

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Walks `config.rootDir` and returns every source file that can be mapped
 * to a known programming language.
 */
export async function walkFiles(config: WalkerConfig): Promise<FileEntry[]> {
  const {
    rootDir,
    includeGlobs = ['**/*'],
    excludeGlobs = [],
    extensions,
  } = config;

  const patterns = includeGlobs.length > 0 ? includeGlobs : ['**/*'];
  const ignore = [...DEFAULT_EXCLUDES, ...excludeGlobs];

  const paths = await fg(patterns, {
    cwd: rootDir,
    absolute: true,
    onlyFiles: true,
    ignore,
    dot: false,
  });

  const results: FileEntry[] = [];

  for (const filePath of paths) {
    const ext = extname(filePath).toLowerCase();

    // Skip if caller supplied an explicit extension filter.
    if (extensions && !extensions.includes(ext)) continue;

    const language = EXT_TO_LANG[ext];
    if (!language) continue;

    results.push({ path: filePath, language });
  }

  return results;
}
