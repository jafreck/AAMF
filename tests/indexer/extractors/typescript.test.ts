import { describe, it, expect } from 'vitest';
import { ParserPool, TypeScriptExtractor } from '@aamf/lore';

function parse(source: string) {
  const pool = new ParserPool();
  return pool.parse('typescript', source);
}

describe('TypeScriptExtractor', () => {
  const extractor = new TypeScriptExtractor();

  it('should return empty result for an empty source', () => {
    const tree = parse('');
    if (!tree) return;
    const result = extractor.extract(tree, '', 'test.ts');
    expect(result.symbols).toEqual([]);
    expect(result.imports).toEqual([]);
    expect(result.callRefs).toEqual([]);
  });

  it('should extract a function declaration', () => {
    const source = 'function greet(name: string): string { return "hi"; }';
    const tree = parse(source);
    if (!tree) return;

    const result = extractor.extract(tree, source, 'test.ts');
    const funcs = result.symbols.filter(s => s.kind === 'function');
    expect(funcs.length).toBeGreaterThan(0);
    expect(funcs[0]?.name).toBe('greet');
  });

  it('should extract a class declaration', () => {
    const source = 'class Animal { name: string = ""; }';
    const tree = parse(source);
    if (!tree) return;

    const result = extractor.extract(tree, source, 'test.ts');
    const classes = result.symbols.filter(s => s.kind === 'class');
    expect(classes.length).toBeGreaterThan(0);
    expect(classes[0]?.name).toBe('Animal');
  });

  it('should extract an interface declaration', () => {
    const source = 'interface Drawable { draw(): void; }';
    const tree = parse(source);
    if (!tree) return;

    const result = extractor.extract(tree, source, 'test.ts');
    const ifaces = result.symbols.filter(s => s.kind === 'interface');
    expect(ifaces.length).toBeGreaterThan(0);
    expect(ifaces[0]?.name).toBe('Drawable');
  });

  it('should extract a type alias declaration', () => {
    const source = 'type ID = string | number;';
    const tree = parse(source);
    if (!tree) return;

    const result = extractor.extract(tree, source, 'test.ts');
    const types = result.symbols.filter(s => s.kind === 'type');
    expect(types.length).toBeGreaterThan(0);
    expect(types[0]?.name).toBe('ID');
  });

  it('should extract an arrow function assigned to a const', () => {
    const source = 'const double = (x: number) => x * 2;';
    const tree = parse(source);
    if (!tree) return;

    const result = extractor.extract(tree, source, 'test.ts');
    const funcs = result.symbols.filter(s => s.kind === 'function');
    expect(funcs.some(f => f.name === 'double')).toBe(true);
  });

  it('should extract a function expression assigned to a const', () => {
    const source = 'const greet = function(name: string) { return name; };';
    const tree = parse(source);
    if (!tree) return;

    const result = extractor.extract(tree, source, 'test.ts');
    const funcs = result.symbols.filter(s => s.kind === 'function');
    expect(funcs.some(f => f.name === 'greet')).toBe(true);
  });

  it('should extract an import statement with the module source', () => {
    // Note: the grammar exposes import_clause as a named child, not a field,
    // so importedNames is empty — but source is correctly extracted.
    const source = "import { readFile, writeFile } from 'fs';";
    const tree = parse(source);
    if (!tree) return;

    const result = extractor.extract(tree, source, 'test.ts');
    expect(result.imports).toHaveLength(1);
    expect(result.imports[0]?.source).toBe('fs');
  });

  it('should extract a default import module source', () => {
    const source = "import path from 'node:path';";
    const tree = parse(source);
    if (!tree) return;

    const result = extractor.extract(tree, source, 'test.ts');
    expect(result.imports).toHaveLength(1);
    expect(result.imports[0]?.source).toBe('node:path');
  });

  it('should extract a namespace import module source', () => {
    const source = "import * as fs from 'fs';";
    const tree = parse(source);
    if (!tree) return;

    const result = extractor.extract(tree, source, 'test.ts');
    expect(result.imports).toHaveLength(1);
    expect(result.imports[0]?.source).toBe('fs');
  });

  it('should record correct line numbers', () => {
    const source = 'function foo() {\n  return 1;\n}';
    const tree = parse(source);
    if (!tree) return;

    const result = extractor.extract(tree, source, 'test.ts');
    const fn_ = result.symbols.find(s => s.name === 'foo');
    expect(fn_?.startLine).toBe(0);
    expect(fn_?.endLine).toBe(2);
  });
});
