/**
 * @module indexer/extractors/types
 *
 * Shared types and the `SymbolExtractor` interface implemented by every
 * language-specific extractor.
 */

import type Parser from 'tree-sitter';

// ─── Raw data types ───────────────────────────────────────────────────────────

/** A symbol (function, class, struct, etc.) extracted from a source file. */
export interface RawSymbol {
  /** Simple name of the symbol (e.g. `myFunc`, `MyStruct`). */
  name: string;
  /** Kind of symbol (e.g. `'function'`, `'class'`, `'struct'`, `'enum'`, `'trait'`, `'impl'`, `'interface'`, `'type'`). */
  kind: string;
  /** 0-indexed start line in the source file. */
  startLine: number;
  /** 0-indexed end line in the source file. */
  endLine: number;
  /** Textual signature of the symbol (declaration without body). */
  signature: string;
}

/** An import or include directive extracted from a source file. */
export interface RawImport {
  /** The raw import source string (module path, header name, etc.). */
  source: string;
  /** Resolved absolute or relative file path, if determinable at extraction time. */
  resolvedPath?: string;
  /** Named symbols imported from the source (empty for wildcard / side-effect imports). */
  importedNames: string[];
}

/** A call-site reference found in a source file. */
export interface RawCallRef {
  /** Name of the enclosing symbol that contains the call (empty string if top-level). */
  callerSymbol: string;
  /** Raw callee expression text as it appears in source. */
  calleeRaw: string;
  /** 0-indexed line of the call expression. */
  line: number;
}

/** The full extraction result returned by a `SymbolExtractor`. */
export interface ExtractionResult {
  symbols: RawSymbol[];
  imports: RawImport[];
  callRefs: RawCallRef[];
}

// ─── SymbolExtractor interface ────────────────────────────────────────────────

/**
 * Implemented by each language extractor to pull symbols, imports, and call
 * references out of a parsed tree-sitter AST.
 */
export interface SymbolExtractor {
  /**
   * @param tree      Parsed tree-sitter syntax tree for the file.
   * @param source    Raw source text of the file.
   * @param filePath  Absolute path to the file (for context / error messages).
   */
  extract(tree: Parser.Tree, source: string, filePath: string): ExtractionResult;
}

// ─── Shared utilities ─────────────────────────────────────────────────────────

/**
 * Iterates every node in the subtree rooted at `node` in depth-first order.
 */
export function* walk(node: Parser.SyntaxNode): Generator<Parser.SyntaxNode> {
  yield node;
  for (const child of node.children) {
    yield* walk(child);
  }
}

/**
 * Returns the first descendant with the given `type`, or `null`.
 */
export function findFirst(
  node: Parser.SyntaxNode,
  type: string,
): Parser.SyntaxNode | null {
  for (const n of walk(node)) {
    if (n.type === type) return n;
  }
  return null;
}

/**
 * Extracts a signature from a node by returning everything before the first
 * opening brace `{` (or the first line if there is no brace).
 */
export function nodeSignature(node: Parser.SyntaxNode): string {
  const text = node.text;
  const braceIdx = text.indexOf('{');
  if (braceIdx !== -1) {
    return text.slice(0, braceIdx).trim();
  }
  return (text.split('\n')[0] ?? text).trim();
}

/** Returns an empty `ExtractionResult`. */
export function emptyResult(): ExtractionResult {
  return { symbols: [], imports: [], callRefs: [] };
}
