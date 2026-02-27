/**
 * @module indexer/extractors/csharp
 *
 * P2/P3 C# language extractor.  Extracts class declarations, interface
 * declarations, method declarations, and using directives.
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

// ─── CSharpExtractor ──────────────────────────────────────────────────────────

export class CSharpExtractor implements SymbolExtractor {
  extract(tree: Parser.Tree, _source: string, _filePath: string): ExtractionResult {
    const result = emptyResult();

    for (const node of walk(tree.rootNode)) {
      switch (node.type) {
        case 'class_declaration':
          result.symbols.push(extractNamedNode(node, 'class'));
          break;
        case 'interface_declaration':
          result.symbols.push(extractNamedNode(node, 'interface'));
          break;
        case 'struct_declaration':
          result.symbols.push(extractNamedNode(node, 'struct'));
          break;
        case 'enum_declaration':
          result.symbols.push(extractNamedNode(node, 'enum'));
          break;
        case 'method_declaration':
          result.symbols.push(extractMethod(node));
          break;
        case 'using_directive':
          result.imports.push(extractUsingDirective(node));
          break;
      }
    }

    return result;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractNamedNode(node: Parser.SyntaxNode, kind: string): RawSymbol {
  const nameNode = node.childForFieldName('name');
  return {
    name: nameNode?.text ?? '',
    kind,
    startLine: node.startPosition.row,
    endLine: node.endPosition.row,
    signature: nodeSignature(node),
  };
}

function extractMethod(node: Parser.SyntaxNode): RawSymbol {
  const nameNode = node.childForFieldName('name');
  return {
    name: nameNode?.text ?? '',
    kind: 'function',
    startLine: node.startPosition.row,
    endLine: node.endPosition.row,
    signature: nodeSignature(node),
  };
}

function extractUsingDirective(node: Parser.SyntaxNode): RawImport {
  // `using System.Collections.Generic;` or `using alias = Namespace;`
  const text = node.text
    .replace(/^using\s+(static\s+)?/, '')
    .replace(/\s*;?\s*$/, '')
    .trim();

  // If there is an alias (`alias = Namespace`), split on '='
  const eqIdx = text.indexOf('=');
  let source: string;
  let importedNames: string[];
  if (eqIdx !== -1) {
    source = text.slice(eqIdx + 1).trim();
    importedNames = [text.slice(0, eqIdx).trim()];
  } else {
    source = text;
    const parts = text.split('.');
    importedNames = [parts[parts.length - 1] ?? ''];
  }

  return { source, importedNames };
}
