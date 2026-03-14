import { describe, it, expect } from 'vitest';
import { ParserPool, PythonExtractor } from '@jafreck/lore';

function parse(source: string) {
  const pool = new ParserPool();
  return pool.parse('python', source);
}

describe('PythonExtractor', () => {
  const extractor = new PythonExtractor();

  it('should return empty result for an empty source', () => {
    const tree = parse('');
    if (!tree) return;
    const result = extractor.extract(tree, '', 'test.py');
    expect(result.symbols).toEqual([]);
    expect(result.imports).toEqual([]);
    expect(result.callRefs).toEqual([]);
  });

  it('should extract a function definition', () => {
    const source = 'def add(a, b):\n    return a + b\n';
    const tree = parse(source);
    if (!tree) return;

    const result = extractor.extract(tree, source, 'test.py');
    const funcs = result.symbols.filter(s => s.kind === 'function');
    expect(funcs.length).toBeGreaterThan(0);
    expect(funcs[0]?.name).toBe('add');
  });

  it('should extract a class definition', () => {
    const source = 'class MyClass:\n    pass\n';
    const tree = parse(source);
    if (!tree) return;

    const result = extractor.extract(tree, source, 'test.py');
    const classes = result.symbols.filter(s => s.kind === 'class');
    expect(classes.length).toBeGreaterThan(0);
    expect(classes[0]?.name).toBe('MyClass');
  });

  it('should extract an import_statement', () => {
    const source = 'import os\n';
    const tree = parse(source);
    if (!tree) return;

    const result = extractor.extract(tree, source, 'test.py');
    expect(result.imports.length).toBeGreaterThan(0);
    expect(result.imports[0]?.source).toBe('os');
  });

  it('should extract multiple names from import_statement', () => {
    const source = 'import os, sys\n';
    const tree = parse(source);
    if (!tree) return;

    const result = extractor.extract(tree, source, 'test.py');
    const sources = result.imports.map(i => i.source);
    expect(sources).toContain('os');
    expect(sources).toContain('sys');
  });

  it('should extract a from-import statement', () => {
    const source = 'from os.path import join, exists\n';
    const tree = parse(source);
    if (!tree) return;

    const result = extractor.extract(tree, source, 'test.py');
    const fromImp = result.imports.find(i => i.source.includes('os'));
    expect(fromImp).toBeDefined();
    expect(fromImp?.importedNames).toContain('join');
    expect(fromImp?.importedNames).toContain('exists');
  });

  it('should extract wildcard from-import', () => {
    const source = 'from os.path import *\n';
    const tree = parse(source);
    if (!tree) return;

    const result = extractor.extract(tree, source, 'test.py');
    const fromImp = result.imports.find(i => i.source.includes('os'));
    expect(fromImp?.importedNames).toContain('*');
  });

  it('should record correct startLine and endLine for functions', () => {
    const source = 'def foo():\n    pass\n';
    const tree = parse(source);
    if (!tree) return;

    const result = extractor.extract(tree, source, 'test.py');
    const fn_ = result.symbols.find(s => s.name === 'foo');
    expect(fn_?.startLine).toBe(0);
  });

  it('should extract multiple functions', () => {
    const source = 'def foo():\n    pass\ndef bar():\n    pass\n';
    const tree = parse(source);
    if (!tree) return;

    const result = extractor.extract(tree, source, 'test.py');
    const names = result.symbols.filter(s => s.kind === 'function').map(s => s.name);
    expect(names).toContain('foo');
    expect(names).toContain('bar');
  });
});
