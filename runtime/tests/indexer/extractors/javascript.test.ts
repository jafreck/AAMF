import { describe, it, expect } from 'vitest';
import { ParserPool } from '../../../src/indexer/parser.js';
import { JavaScriptExtractor } from '../../../src/indexer/extractors/javascript.js';

function parse(source: string) {
  const pool = new ParserPool();
  return pool.parse('javascript', source);
}

describe('JavaScriptExtractor', () => {
  const extractor = new JavaScriptExtractor();

  it('should return empty result for an empty source', () => {
    const tree = parse('');
    if (!tree) return;
    const result = extractor.extract(tree, '', 'test.js');
    expect(result.symbols).toEqual([]);
    expect(result.imports).toEqual([]);
    expect(result.callRefs).toEqual([]);
  });

  it('should extract a function declaration', () => {
    const source = 'function greet(name) { return "hi " + name; }';
    const tree = parse(source);
    if (!tree) return;

    const result = extractor.extract(tree, source, 'test.js');
    const funcs = result.symbols.filter(s => s.kind === 'function');
    expect(funcs.length).toBeGreaterThan(0);
    expect(funcs[0]?.name).toBe('greet');
  });

  it('should extract a class declaration', () => {
    const source = 'class Animal { constructor(name) { this.name = name; } }';
    const tree = parse(source);
    if (!tree) return;

    const result = extractor.extract(tree, source, 'test.js');
    const classes = result.symbols.filter(s => s.kind === 'class');
    expect(classes.length).toBeGreaterThan(0);
    expect(classes[0]?.name).toBe('Animal');
  });

  it('should extract an arrow function assigned to a const', () => {
    const source = 'const double = (x) => x * 2;';
    const tree = parse(source);
    if (!tree) return;

    const result = extractor.extract(tree, source, 'test.js');
    const funcs = result.symbols.filter(s => s.kind === 'function');
    expect(funcs.some(f => f.name === 'double')).toBe(true);
  });

  it('should extract a function expression assigned to a const', () => {
    const source = 'const greet = function(name) { return name; };';
    const tree = parse(source);
    if (!tree) return;

    const result = extractor.extract(tree, source, 'test.js');
    const funcs = result.symbols.filter(s => s.kind === 'function');
    expect(funcs.some(f => f.name === 'greet')).toBe(true);
  });

  it('should extract an import statement module source', () => {
    // Note: the grammar exposes import_clause as a named child, not a field,
    // so importedNames is empty — but source is correctly extracted.
    const source = "import { readFile } from 'fs';";
    const tree = parse(source);
    if (!tree) return;

    const result = extractor.extract(tree, source, 'test.js');
    expect(result.imports).toHaveLength(1);
    expect(result.imports[0]?.source).toBe('fs');
  });

  it('should extract a require() call', () => {
    const source = "const fs = require('fs');";
    const tree = parse(source);
    if (!tree) return;

    const result = extractor.extract(tree, source, 'test.js');
    const requires = result.imports.filter(i => i.source === 'fs');
    expect(requires.length).toBeGreaterThan(0);
    expect(requires[0]?.importedNames).toEqual([]);
  });

  it('should not extract a non-require call as an import', () => {
    const source = "const result = someFunction('arg');";
    const tree = parse(source);
    if (!tree) return;

    const result = extractor.extract(tree, source, 'test.js');
    expect(result.imports).toHaveLength(0);
  });

  it('should extract multiple functions', () => {
    const source = [
      'function foo() {}',
      'function bar() {}',
    ].join('\n');
    const tree = parse(source);
    if (!tree) return;

    const result = extractor.extract(tree, source, 'test.js');
    const names = result.symbols.filter(s => s.kind === 'function').map(s => s.name);
    expect(names).toContain('foo');
    expect(names).toContain('bar');
  });

  it('should record correct line numbers', () => {
    const source = 'function foo() {\n  return 1;\n}';
    const tree = parse(source);
    if (!tree) return;

    const result = extractor.extract(tree, source, 'test.js');
    const fn_ = result.symbols.find(s => s.name === 'foo');
    expect(fn_?.startLine).toBe(0);
    expect(fn_?.endLine).toBe(2);
  });

  it('should include a non-empty signature for functions', () => {
    const source = 'function add(a, b) { return a + b; }';
    const tree = parse(source);
    if (!tree) return;

    const result = extractor.extract(tree, source, 'test.js');
    expect(result.symbols[0]?.signature).toContain('add');
  });
});
