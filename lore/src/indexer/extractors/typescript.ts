/**
 * @module indexer/extractors/typescript
 *
 * P1 TypeScript language extractor.  Extracts function declarations, class
 * declarations, interface declarations, type alias declarations, arrow
 * functions assigned to const variables, and import statements.
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

// ─── TypeScriptExtractor ──────────────────────────────────────────────────────

export class TypeScriptExtractor implements SymbolExtractor {
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
        case 'interface_declaration':
          result.symbols.push(extractNamedDecl(node, 'interface'));
          break;
        case 'type_alias_declaration':
          result.symbols.push(extractNamedDecl(node, 'type'));
          break;
        case 'lexical_declaration':
        case 'variable_declaration': {
          // Handle: const foo = () => {} or const foo = function() {}
          const sym = maybeExtractArrowOrFunctionExpr(node);
          if (sym) result.symbols.push(sym);
          break;
        }
        case 'import_statement':
          result.imports.push(extractImport(node));
          break;
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
  // Look for: const/let/var <name> = <arrow_function | function_expression>
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
  // import { a, b } from 'module'
  // import defaultExport from 'module'
  // import * as ns from 'module'
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
      // default import
      out.push(node.text);
      break;
    case 'namespace_import': {
      // import * as ns
      const alias = node.namedChildren[0];
      if (alias) out.push(`* as ${alias.text}`);
      break;
    }
    case 'named_imports':
      // { a, b as c }
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

function stripQuotes(s: string): string {
  return s.replace(/^['"`]|['"`]$/g, '');
}
