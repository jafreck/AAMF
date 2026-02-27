/**
 * @module indexer/extractors/python
 *
 * P0 Python language extractor.  Extracts function definitions (sync and
 * async), class definitions, and import statements.
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

// ─── PythonExtractor ──────────────────────────────────────────────────────────

export class PythonExtractor implements SymbolExtractor {
  extract(tree: Parser.Tree, _source: string, _filePath: string): ExtractionResult {
    const result = emptyResult();

    for (const node of walk(tree.rootNode)) {
      switch (node.type) {
        case 'function_definition':
          result.symbols.push(extractFunction(node, false));
          break;
        case 'decorated_definition': {
          // async def shows up as decorated_definition → function_definition
          // or directly as a function_definition with an 'async' keyword child
          const inner = node.childForFieldName('definition');
          if (inner?.type === 'function_definition') {
            result.symbols.push(extractFunction(inner, isAsync(node)));
          } else if (inner?.type === 'class_definition') {
            result.symbols.push(extractClass(inner));
          }
          break;
        }
        case 'class_definition':
          result.symbols.push(extractClass(node));
          break;
        case 'import_statement':
          result.imports.push(...extractImport(node));
          break;
        case 'import_from_statement':
          result.imports.push(extractFromImport(node));
          break;
      }
    }

    return result;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isAsync(node: Parser.SyntaxNode): boolean {
  return node.children.some((c) => c.type === 'async');
}

function extractFunction(node: Parser.SyntaxNode, async_: boolean): RawSymbol {
  const nameNode = node.childForFieldName('name');
  const kind = async_ ? 'async_function' : 'function';
  return {
    name: nameNode?.text ?? '',
    kind,
    startLine: node.startPosition.row,
    endLine: node.endPosition.row,
    signature: nodeSignature(node),
  };
}

function extractClass(node: Parser.SyntaxNode): RawSymbol {
  const nameNode = node.childForFieldName('name');
  return {
    name: nameNode?.text ?? '',
    kind: 'class',
    startLine: node.startPosition.row,
    endLine: node.endPosition.row,
    signature: nodeSignature(node),
  };
}

/**
 * `import a, b, c` → one RawImport per name.
 */
function extractImport(node: Parser.SyntaxNode): RawImport[] {
  const imports: RawImport[] = [];
  for (const child of node.namedChildren) {
    if (child.type === 'dotted_name' || child.type === 'aliased_import') {
      const name = child.childForFieldName('name') ?? child;
      imports.push({ source: name.text, importedNames: [] });
    }
  }
  return imports;
}

/**
 * `from x.y import a, b` → one RawImport.
 */
function extractFromImport(node: Parser.SyntaxNode): RawImport {
  const moduleNode = node.childForFieldName('module_name');
  const source = moduleNode?.text ?? '';
  const importedNames: string[] = [];

  for (const child of node.namedChildren) {
    if (child === moduleNode) continue;
    if (child.type === 'dotted_name' || child.type === 'identifier') {
      importedNames.push(child.text);
    } else if (child.type === 'aliased_import') {
      const name = child.childForFieldName('name');
      if (name) importedNames.push(name.text);
    } else if (child.type === 'wildcard_import') {
      importedNames.push('*');
    }
  }

  return { source, importedNames };
}
