import { describe, it, expect } from 'vitest';
import { ParserPool, GoExtractor } from '@jafreck/lore';

function parse(source: string) {
  const pool = new ParserPool();
  return pool.parse('go', source);
}

describe('GoExtractor', () => {
  const extractor = new GoExtractor();

  it('should return empty result for an empty source', () => {
    const tree = parse('');
    if (!tree) return;
    const result = extractor.extract(tree, '', 'main.go');
    expect(result.symbols).toEqual([]);
    expect(result.imports).toEqual([]);
    expect(result.callRefs).toEqual([]);
  });

  it('should extract a function declaration', () => {
    const source = 'package main\nfunc Add(a, b int) int { return a + b }';
    const tree = parse(source);
    if (!tree) return;

    const result = extractor.extract(tree, source, 'main.go');
    const funcs = result.symbols.filter(s => s.kind === 'function');
    expect(funcs.length).toBeGreaterThan(0);
    expect(funcs[0]?.name).toBe('Add');
  });

  it('should extract a method declaration with receiver', () => {
    const source = 'package main\ntype Point struct { X, Y float64 }\nfunc (p Point) String() string { return "" }';
    const tree = parse(source);
    if (!tree) return;

    const result = extractor.extract(tree, source, 'main.go');
    const methods = result.symbols.filter(s => s.kind === 'method');
    expect(methods.length).toBeGreaterThan(0);
    expect(methods[0]?.name).toBe('Point.String');
  });

  it('should extract a struct type declaration', () => {
    const source = 'package main\ntype Point struct { X float64; Y float64 }';
    const tree = parse(source);
    if (!tree) return;

    const result = extractor.extract(tree, source, 'main.go');
    const structs = result.symbols.filter(s => s.kind === 'struct');
    expect(structs.length).toBeGreaterThan(0);
    expect(structs[0]?.name).toBe('Point');
  });

  it('should extract an interface type declaration', () => {
    const source = 'package main\ntype Stringer interface { String() string }';
    const tree = parse(source);
    if (!tree) return;

    const result = extractor.extract(tree, source, 'main.go');
    const ifaces = result.symbols.filter(s => s.kind === 'interface');
    expect(ifaces.length).toBeGreaterThan(0);
    expect(ifaces[0]?.name).toBe('Stringer');
  });

  it('should extract a single import declaration', () => {
    const source = 'package main\nimport "fmt"';
    const tree = parse(source);
    if (!tree) return;

    const result = extractor.extract(tree, source, 'main.go');
    expect(result.imports.length).toBeGreaterThan(0);
    expect(result.imports[0]?.source).toBe('fmt');
  });

  it('should extract grouped import declarations', () => {
    const source = 'package main\nimport (\n\t"fmt"\n\t"os"\n)';
    const tree = parse(source);
    if (!tree) return;

    const result = extractor.extract(tree, source, 'main.go');
    const sources = result.imports.map(i => i.source);
    expect(sources).toContain('fmt');
    expect(sources).toContain('os');
  });

  it('should extract an aliased import', () => {
    const source = 'package main\nimport f "fmt"';
    const tree = parse(source);
    if (!tree) return;

    const result = extractor.extract(tree, source, 'main.go');
    expect(result.imports.length).toBeGreaterThan(0);
    expect(result.imports[0]?.source).toBe('fmt');
    expect(result.imports[0]?.importedNames).toContain('f');
  });

  it('should record correct start and end lines for a function', () => {
    const source = 'package main\nfunc foo() {\n\treturn\n}';
    const tree = parse(source);
    if (!tree) return;

    const result = extractor.extract(tree, source, 'main.go');
    const fn_ = result.symbols.find(s => s.name === 'foo');
    expect(fn_?.startLine).toBe(1);
    expect(fn_?.endLine).toBe(3);
  });
});
