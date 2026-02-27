/**
 * @module indexer/extractors/javascript
 *
 * P1 JavaScript language extractor.  Extracts function declarations, class
 * declarations, arrow/function expressions assigned to variables, and
 * import statements and require() calls.
 */

import type Parser from 'tree-sitter';
import {
  type ExtractionResult,
  type RawImport,
  type RawSymbol,
  type SymbolExtractor,
  emptyResult,
  nodeSignature,
  walk,
} from './types.js';

// ─── JavaScriptExtractor ──────────────────────────────────────────────────────

export class JavaScriptExtractor implements SymbolExtractor {
  extract(tree: Parser.Tree, _source: string, _filePath: string): ExtractionResult {
    const result = emptyResult();

    for (const node of walk(tree.rootNode)) {
      switch (node.type) {
        case 'function_declaration':
        case 'generator_function_declaration':
          result.symbols.push(extractNamedDecl(node, 'function'));
          break;
        case 'class_declaration':
          result.symbols.push(extractNamedDecl(node, 'class'));
          break;
        case 'lexical_declaration':
        case 'variable_declaration': {
          const sym = maybeExtractArrowOrFunctionExpr(node);
          if (sym) result.symbols.push(sym);
          break;
        }
        case 'import_statement':
          result.imports.push(extractImport(node));
          break;
        case 'call_expression': {
          const imp = maybeExtractRequire(node);
          if (imp) result.imports.push(imp);
          break;
        }
      }
    }

    return result;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractNamedDecl(node: Parser.SyntaxNode, kind: string): RawSymbol {
  const nameNode = node.childForFieldName('name');
  return {
    name: nameNode?.text ?? '',
    kind,
    startLine: node.startPosition.row,
    endLine: node.endPosition.row,
    signature: nodeSignature(node),
  };
}

function maybeExtractArrowOrFunctionExpr(
  node: Parser.SyntaxNode,
): RawSymbol | null {
  for (const declarator of node.namedChildren) {
    if (declarator.type !== 'variable_declarator') continue;
    const nameNode = declarator.childForFieldName('name');
    const valueNode = declarator.childForFieldName('value');
    if (!nameNode || !valueNode) continue;
    if (
      valueNode.type === 'arrow_function' ||
      valueNode.type === 'function_expression' ||
      valueNode.type === 'generator_function'
    ) {
      return {
        name: nameNode.text,
        kind: 'function',
        startLine: node.startPosition.row,
        endLine: node.endPosition.row,
        signature: nodeSignature(node),
      };
    }
  }
  return null;
}

function extractImport(node: Parser.SyntaxNode): RawImport {
  const sourceNode = node.childForFieldName('source');
  const source = stripQuotes(sourceNode?.text ?? '');
  const importedNames: string[] = [];

  const clauseNode = node.childForFieldName('import_clause') ?? null;
  if (clauseNode) {
    collectImportNames(clauseNode, importedNames);
  }

  return { source, importedNames };
}

function collectImportNames(node: Parser.SyntaxNode, out: string[]): void {
  switch (node.type) {
    case 'identifier':
      out.push(node.text);
      break;
    case 'namespace_import': {
      const alias = node.namedChildren[0];
      if (alias) out.push(`* as ${alias.text}`);
      break;
    }
    case 'named_imports':
      for (const spec of node.namedChildren) {
        if (spec.type === 'import_specifier') {
          const name = spec.childForFieldName('name');
          if (name) out.push(name.text);
        }
      }
      break;
    default:
      for (const child of node.namedChildren) {
        collectImportNames(child, out);
      }
  }
}

/**
 * Detects `require('...')` and `require("...")` call expressions.
 */
function maybeExtractRequire(node: Parser.SyntaxNode): RawImport | null {
  const fnNode = node.childForFieldName('function');
  if (fnNode?.type !== 'identifier' || fnNode.text !== 'require') return null;

  const argsNode = node.childForFieldName('arguments');
  if (!argsNode) return null;

  const firstArg = argsNode.namedChildren[0];
  if (
    !firstArg ||
    (firstArg.type !== 'string' && firstArg.type !== 'template_string')
  ) {
    return null;
  }

  const source = stripQuotes(firstArg.text);
  return { source, importedNames: [] };
}

function stripQuotes(s: string): string {
  return s.replace(/^['"`]|['"`]$/g, '');
}
