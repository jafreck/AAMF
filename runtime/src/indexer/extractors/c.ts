/**
 * @module indexer/extractors/c
 *
 * P0 C language extractor.  Extracts function definitions,
 * struct/enum/typedef declarations, and #include directives.
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

// ─── CExtractor ───────────────────────────────────────────────────────────────

export class CExtractor implements SymbolExtractor {
  extract(tree: Parser.Tree, _source: string, _filePath: string): ExtractionResult {
    const result = emptyResult();

    for (const node of walk(tree.rootNode)) {
      switch (node.type) {
        case 'function_definition':
          result.symbols.push(extractFunction(node));
          break;
        case 'struct_specifier':
          // Only capture named structs at file scope (skip anonymous inner structs)
          if (node.childForFieldName('name')) {
            result.symbols.push(extractNamedSpecifier(node, 'struct'));
          }
          break;
        case 'enum_specifier':
          if (node.childForFieldName('name')) {
            result.symbols.push(extractNamedSpecifier(node, 'enum'));
          }
          break;
        case 'typedef_declaration':
          result.symbols.push(extractTypedef(node));
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

/**
 * Walks down pointer/array declarators to find the function_declarator, then
 * extracts the innermost identifier.
 */
function extractDeclaratorName(declarator: Parser.SyntaxNode): string {
  // Peel off pointer/array wrappers
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
      return findFirst(inner, 'identifier')?.text ?? '';
    }
  }
  return findFirst(declarator, 'identifier')?.text ?? '';
}

function extractNamedSpecifier(node: Parser.SyntaxNode, kind: string): RawSymbol {
  const nameNode = node.childForFieldName('name');
  return {
    name: nameNode?.text ?? '',
    kind,
    startLine: node.startPosition.row,
    endLine: node.endPosition.row,
    signature: nodeSignature(node),
  };
}

function extractTypedef(node: Parser.SyntaxNode): RawSymbol {
  // The typedef name is the last named child (the identifier after the type)
  const children = node.namedChildren;
  const nameNode = children[children.length - 1] ?? null;
  return {
    name: nameNode?.text ?? '',
    kind: 'typedef',
    startLine: node.startPosition.row,
    endLine: node.endPosition.row,
    signature: nodeSignature(node),
  };
}

function extractInclude(node: Parser.SyntaxNode): RawImport {
  // path child is either string_literal or system_lib_string
  const pathNode =
    node.childForFieldName('path') ??
    node.namedChildren[0] ??
    null;
  const raw = pathNode?.text ?? '';
  // Strip surrounding quotes or angle brackets
  const source = raw.replace(/^["<]|[">]$/g, '');
  return { source, importedNames: [] };
}
