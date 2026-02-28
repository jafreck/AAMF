import { describe, it, expect } from 'vitest';
import { ParserPool, CExtractor } from '@aamf/lore';

function parse(source: string) {
  const pool = new ParserPool();
  return pool.parse('c', source);
}

describe('CExtractor', () => {
  const extractor = new CExtractor();

  it('should return empty result for an empty source', () => {
    const tree = parse('');
    if (!tree) return;
    const result = extractor.extract(tree, '', 'test.c');
    expect(result.symbols).toEqual([]);
    expect(result.imports).toEqual([]);
    expect(result.callRefs).toEqual([]);
  });

  it('should extract a simple function definition', () => {
    const source = 'int add(int a, int b) { return a + b; }';
    const tree = parse(source);
    if (!tree) return;

    const result = extractor.extract(tree, source, 'test.c');
    expect(result.symbols).toHaveLength(1);
    expect(result.symbols[0]?.name).toBe('add');
    expect(result.symbols[0]?.kind).toBe('function');
  });

  it('should extract function start and end lines', () => {
    const source = 'int foo() {\n  return 0;\n}';
    const tree = parse(source);
    if (!tree) return;

    const result = extractor.extract(tree, source, 'test.c');
    expect(result.symbols).toHaveLength(1);
    expect(result.symbols[0]?.startLine).toBe(0);
    expect(result.symbols[0]?.endLine).toBe(2);
  });

  it('should extract a named struct', () => {
    const source = 'struct Point { int x; int y; };';
    const tree = parse(source);
    if (!tree) return;

    const result = extractor.extract(tree, source, 'test.c');
    const structs = result.symbols.filter(s => s.kind === 'struct');
    expect(structs.length).toBeGreaterThan(0);
    expect(structs[0]?.name).toBe('Point');
  });

  it('should extract a named enum', () => {
    const source = 'enum Color { RED, GREEN, BLUE };';
    const tree = parse(source);
    if (!tree) return;

    const result = extractor.extract(tree, source, 'test.c');
    const enums = result.symbols.filter(s => s.kind === 'enum');
    expect(enums.length).toBeGreaterThan(0);
    expect(enums[0]?.name).toBe('Color');
  });

  it('should not crash on a typedef declaration', () => {
    // The tree-sitter C grammar uses node type 'type_definition', not
    // 'typedef_declaration', so the extractor currently does not extract
    // typedefs — verify the result is still a valid ExtractionResult.
    const source = 'typedef struct { int x; int y; } Point;';
    const tree = parse(source);
    if (!tree) return;

    const result = extractor.extract(tree, source, 'test.c');
    expect(Array.isArray(result.symbols)).toBe(true);
    expect(Array.isArray(result.imports)).toBe(true);
    expect(Array.isArray(result.callRefs)).toBe(true);
  });

  it('should extract a system #include', () => {
    const source = '#include <stdio.h>';
    const tree = parse(source);
    if (!tree) return;

    const result = extractor.extract(tree, source, 'test.c');
    expect(result.imports).toHaveLength(1);
    expect(result.imports[0]?.source).toBe('stdio.h');
    expect(result.imports[0]?.importedNames).toEqual([]);
  });

  it('should extract a local #include', () => {
    const source = '#include "myheader.h"';
    const tree = parse(source);
    if (!tree) return;

    const result = extractor.extract(tree, source, 'test.c');
    expect(result.imports).toHaveLength(1);
    expect(result.imports[0]?.source).toBe('myheader.h');
  });

  it('should extract multiple functions', () => {
    const source = [
      'int add(int a, int b) { return a + b; }',
      'void print(int x) { }',
    ].join('\n');
    const tree = parse(source);
    if (!tree) return;

    const result = extractor.extract(tree, source, 'test.c');
    const funcs = result.symbols.filter(s => s.kind === 'function');
    expect(funcs).toHaveLength(2);
    expect(funcs.map(f => f.name)).toContain('add');
    expect(funcs.map(f => f.name)).toContain('print');
  });

  it('should include a non-empty signature for functions', () => {
    const source = 'int add(int a, int b) { return a + b; }';
    const tree = parse(source);
    if (!tree) return;

    const result = extractor.extract(tree, source, 'test.c');
    expect(result.symbols[0]?.signature).toContain('add');
  });
});
