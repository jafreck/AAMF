/**
 * @module indexer/extractors/cpp
 *
 * P1 C++ language extractor.  Extracts function definitions, class/struct
 * declarations, and #include directives.
 */

import type Parser from 'tree-sitter';
import {
  type ExtractionResult,
  type RawImport,
  type RawSymbol,
  type SymbolExtractor,
  emptyResult,
  findFirst,
  nodeSignature,
  walk,
} from './types.js';

// ─── CppExtractor ─────────────────────────────────────────────────────────────

export class CppExtractor implements SymbolExtractor {
  extract(tree: Parser.Tree, _source: string, _filePath: string): ExtractionResult {
    const result = emptyResult();

    for (const node of walk(tree.rootNode)) {
      switch (node.type) {
        case 'function_definition':
          result.symbols.push(extractFunction(node));
          break;
        case 'class_specifier':
          if (node.childForFieldName('name')) {
            result.symbols.push(extractSpecifier(node, 'class'));
          }
          break;
        case 'struct_specifier':
          if (node.childForFieldName('name')) {
            result.symbols.push(extractSpecifier(node, 'struct'));
          }
          break;
        case 'preproc_include':
          result.imports.push(extractInclude(node));
          break;
      }
    }

    return result;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractFunction(node: Parser.SyntaxNode): RawSymbol {
  const declarator = node.childForFieldName('declarator');
  const name = declarator ? extractDeclaratorName(declarator) : '';
  return {
    name,
    kind: 'function',
    startLine: node.startPosition.row,
    endLine: node.endPosition.row,
    signature: nodeSignature(node),
  };
}

function extractDeclaratorName(declarator: Parser.SyntaxNode): string {
  let node: Parser.SyntaxNode | null = declarator;
  while (node && node.type !== 'function_declarator') {
    const inner: Parser.SyntaxNode | null =
      node.childForFieldName('declarator') ??
      node.namedChildren[0] ??
      null;
    if (!inner || inner === node) break;
    node = inner;
  }
  if (node?.type === 'function_declarator') {
    const inner = node.childForFieldName('declarator');
    if (inner) {
      // Prefer qualified identifier (e.g. Foo::bar) over plain identifier
      return (
        findFirst(inner, 'qualified_identifier')?.text ??
        findFirst(inner, 'identifier')?.text ??
        ''
      );
    }
  }
  return findFirst(declarator, 'identifier')?.text ?? '';
}

function extractSpecifier(node: Parser.SyntaxNode, kind: string): RawSymbol {
  const nameNode = node.childForFieldName('name');
  return {
    name: nameNode?.text ?? '',
    kind,
    startLine: node.startPosition.row,
    endLine: node.endPosition.row,
    signature: nodeSignature(node),
  };
}

function extractInclude(node: Parser.SyntaxNode): RawImport {
  const pathNode =
    node.childForFieldName('path') ?? node.namedChildren[0] ?? null;
  const raw = pathNode?.text ?? '';
  const source = raw.replace(/^["<]|[">]$/g, '');
  return { source, importedNames: [] };
}
