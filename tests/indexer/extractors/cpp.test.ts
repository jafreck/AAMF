import { describe, it, expect } from 'vitest';
import { ParserPool, CppExtractor } from '@jafreck/lore';

function parse(source: string) {
  const pool = new ParserPool();
  return pool.parse('cpp', source);
}

describe('CppExtractor', () => {
  const extractor = new CppExtractor();

  it('should return empty result for an empty source', () => {
    const tree = parse('');
    if (!tree) return;
    const result = extractor.extract(tree, '', 'test.cpp');
    expect(result.symbols).toEqual([]);
    expect(result.imports).toEqual([]);
    expect(result.callRefs).toEqual([]);
  });

  it('should extract a simple function definition', () => {
    const source = 'int add(int a, int b) { return a + b; }';
    const tree = parse(source);
    if (!tree) return;

    const result = extractor.extract(tree, source, 'test.cpp');
    const funcs = result.symbols.filter(s => s.kind === 'function');
    expect(funcs.length).toBeGreaterThan(0);
    expect(funcs[0]?.name).toBe('add');
  });

  it('should extract a class', () => {
    const source = 'class Foo { public: int x; };';
    const tree = parse(source);
    if (!tree) return;

    const result = extractor.extract(tree, source, 'test.cpp');
    const classes = result.symbols.filter(s => s.kind === 'class');
    expect(classes.length).toBeGreaterThan(0);
    expect(classes[0]?.name).toBe('Foo');
  });

  it('should extract a named struct', () => {
    const source = 'struct Point { int x; int y; };';
    const tree = parse(source);
    if (!tree) return;

    const result = extractor.extract(tree, source, 'test.cpp');
    const structs = result.symbols.filter(s => s.kind === 'struct');
    expect(structs.length).toBeGreaterThan(0);
    expect(structs[0]?.name).toBe('Point');
  });

  it('should extract a system #include', () => {
    const source = '#include <iostream>';
    const tree = parse(source);
    if (!tree) return;

    const result = extractor.extract(tree, source, 'test.cpp');
    expect(result.imports).toHaveLength(1);
    expect(result.imports[0]?.source).toBe('iostream');
  });

  it('should extract a local #include', () => {
    const source = '#include "myheader.h"';
    const tree = parse(source);
    if (!tree) return;

    const result = extractor.extract(tree, source, 'test.cpp');
    expect(result.imports).toHaveLength(1);
    expect(result.imports[0]?.source).toBe('myheader.h');
  });

  it('should extract multiple symbols from a more complex file', () => {
    const source = [
      '#include <iostream>',
      'class Animal { public: virtual void speak(); };',
      'void Animal::speak() { }',
    ].join('\n');
    const tree = parse(source);
    if (!tree) return;

    const result = extractor.extract(tree, source, 'test.cpp');
    expect(result.imports).toHaveLength(1);
    expect(result.symbols.some(s => s.kind === 'class')).toBe(true);
  });

  it('should include a non-empty signature for functions', () => {
    const source = 'void greet(const char* name) { }';
    const tree = parse(source);
    if (!tree) return;

    const result = extractor.extract(tree, source, 'test.cpp');
    expect(result.symbols[0]?.signature).toContain('greet');
  });
});
