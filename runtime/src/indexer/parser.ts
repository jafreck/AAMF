/**
 * @module indexer/parser
 *
 * Provides a `ParserPool` that lazily creates one tree-sitter `Parser` per
 * language and caches it for reuse.  Grammar packages that are not installed
 * are silently skipped — `parse()` returns `null` for those languages.
 */

import Parser from 'tree-sitter';

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

    return parser.parse(source);
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private initParser(language: string): void {
    const pkg = LANG_PACKAGES[language];
    if (!pkg) {
      this.unavailable.add(language);
      return;
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      let grammar = require(pkg);

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
