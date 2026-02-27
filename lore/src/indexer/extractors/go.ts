/**
 * @module indexer/extractors/go
 *
 * P2/P3 Go language extractor.  Extracts function declarations, method
 * declarations, type declarations (struct/interface), and import declarations.
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

// ─── GoExtractor ──────────────────────────────────────────────────────────────

export class GoExtractor implements SymbolExtractor {
  extract(tree: Parser.Tree, _source: string, _filePath: string): ExtractionResult {
    const result = emptyResult();

    for (const node of walk(tree.rootNode)) {
      switch (node.type) {
        case 'function_declaration':
          result.symbols.push(extractFunction(node, 'function'));
          break;
        case 'method_declaration':
          result.symbols.push(extractMethod(node));
          break;
        case 'type_declaration':
          result.symbols.push(...extractTypeDecl(node));
          break;
        case 'import_declaration':
          result.imports.push(...extractImportDecl(node));
          break;
      }
    }

    return result;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractFunction(node: Parser.SyntaxNode, kind: string): RawSymbol {
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
  const receiverNode = node.childForFieldName('receiver');
  // Build a qualified name: (ReceiverType).MethodName
  let name = nameNode?.text ?? '';
  if (receiverNode) {
    const receiverType =
      findFirst(receiverNode, 'type_identifier')?.text ??
      findFirst(receiverNode, 'pointer_type')?.text;
    if (receiverType) name = `${receiverType}.${name}`;
  }
  return {
    name,
    kind: 'method',
    startLine: node.startPosition.row,
    endLine: node.endPosition.row,
    signature: nodeSignature(node),
  };
}

/**
 * A `type_declaration` may contain one or more `type_spec` children.
 * Each spec has a `name` field and a `type` field (struct_type, interface_type, etc.).
 */
function extractTypeDecl(node: Parser.SyntaxNode): RawSymbol[] {
  const symbols: RawSymbol[] = [];
  for (const child of node.namedChildren) {
    if (child.type !== 'type_spec') continue;
    const nameNode = child.childForFieldName('name');
    const typeNode = child.childForFieldName('type');
    let kind = 'type';
    if (typeNode?.type === 'struct_type') kind = 'struct';
    else if (typeNode?.type === 'interface_type') kind = 'interface';
    symbols.push({
      name: nameNode?.text ?? '',
      kind,
      startLine: child.startPosition.row,
      endLine: child.endPosition.row,
      signature: nodeSignature(child),
    });
  }
  return symbols;
}

/**
 * Handles both single imports and grouped imports:
 *   import "fmt"
 *   import ( "fmt"; alias "os" )
 */
function extractImportDecl(node: Parser.SyntaxNode): RawImport[] {
  const imports: RawImport[] = [];

  for (const child of node.namedChildren) {
    if (child.type === 'import_spec') {
      imports.push(extractImportSpec(child));
    } else if (child.type === 'import_spec_list') {
      for (const spec of child.namedChildren) {
        if (spec.type === 'import_spec') {
          imports.push(extractImportSpec(spec));
        }
      }
    }
  }

  return imports;
}

function extractImportSpec(spec: Parser.SyntaxNode): RawImport {
  const pathNode = spec.childForFieldName('path');
  // Strip surrounding quotes from the path string literal
  const raw = pathNode?.text ?? '';
  const source = raw.replace(/^"|"$/g, '');
  const aliasNode = spec.childForFieldName('name');
  const importedNames = aliasNode ? [aliasNode.text] : [];
  return { source, importedNames };
}
