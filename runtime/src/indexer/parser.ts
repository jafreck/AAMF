/**
 * @module indexer/parser
 *
 * Provides a `ParserPool` that lazily creates one tree-sitter `Parser` per
 * language and caches it for reuse.  Grammar packages that are not installed
 * are silently skipped — `parse()` returns `null` for those languages.
 */

import Parser from 'tree-sitter';
import { createRequire } from 'node:module';

const esmRequire = createRequire(import.meta.url);

/**
 * Size of chunks returned to tree-sitter when parsing source text.
 *
 * We intentionally stream source via callback input instead of passing a raw
 * string to avoid a tree-sitter binding bug that can throw `Invalid argument`
 * on large files when it chunks strings internally.
 */
const PARSER_CHUNK_SIZE = 4096;

// ─── Grammar package map ──────────────────────────────────────────────────────

/**
 * Maps a language identifier (as returned by the file walker) to the npm
 * package name that exports the corresponding tree-sitter grammar.
 */
const LANG_PACKAGES: Record<string, string> = {
  c:          'tree-sitter-c',
  rust:       'tree-sitter-rust',
  python:     'tree-sitter-python',
  cpp:        'tree-sitter-cpp',
  typescript: 'tree-sitter-typescript',
  javascript: 'tree-sitter-javascript',
  go:         'tree-sitter-go',
  java:       'tree-sitter-java',
  csharp:     'tree-sitter-c-sharp',
};

// ─── ParserPool ───────────────────────────────────────────────────────────────

/**
 * Maintains one `Parser` instance per language for efficient reuse.
 *
 * Grammar packages are loaded lazily on the first `parse()` call for a given
 * language.  If the package is not installed, `parse()` returns `null` and the
 * failed language is never retried.
 */
export class ParserPool {
  /** Cache of successfully initialised parsers, keyed by language. */
  private readonly parsers = new Map<string, Parser>();

  /** Languages whose grammar package could not be loaded. */
  private readonly unavailable = new Set<string>();

  /**
   * Parses `source` with the grammar for `language`.
   *
   * Returns `null` if the grammar package is not installed or `language` is
   * not recognised.  Each `Parser` instance is created once and reused.
   */
  parse(language: string, source: string): Parser.Tree | null {
    if (this.unavailable.has(language)) return null;

    if (!this.parsers.has(language)) {
      this.initParser(language);
    }

    const parser = this.parsers.get(language);
    if (!parser) return null;

    return parser.parse((offset) => source.slice(offset, offset + PARSER_CHUNK_SIZE));
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private initParser(language: string): void {
    const pkg = LANG_PACKAGES[language];
    if (!pkg) {
      this.unavailable.add(language);
      return;
    }

    try {
      // Native addons must be loaded via require(), not import().
      // Use createRequire to ensure it works in both CJS and ESM contexts.
      let grammar = esmRequire(pkg);

      // Some packages (e.g. tree-sitter-typescript) export sub-grammars.
      if (language === 'typescript' && grammar.typescript) {
        grammar = grammar.typescript;
      } else if (language === 'javascript' && grammar.javascript) {
        grammar = grammar.javascript;
      }

      const parser = new Parser();
      parser.setLanguage(grammar);
      this.parsers.set(language, parser);
    } catch {
      // Grammar not installed — mark as unavailable to avoid repeated attempts.
      this.unavailable.add(language);
    }
  }
}
