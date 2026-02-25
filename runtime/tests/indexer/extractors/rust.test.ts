import { describe, it, expect } from 'vitest';
import { ParserPool } from '../../../src/indexer/parser.js';
import { RustExtractor } from '../../../src/indexer/extractors/rust.js';

function parse(source: string) {
  const pool = new ParserPool();
  return pool.parse('rust', source);
}

describe('RustExtractor', () => {
  const extractor = new RustExtractor();

  it('should return empty result for an empty source', () => {
    const tree = parse('');
    if (!tree) return;
    const result = extractor.extract(tree, '', 'lib.rs');
    expect(result.symbols).toEqual([]);
    expect(result.imports).toEqual([]);
    expect(result.callRefs).toEqual([]);
  });

  it('should extract a simple fn', () => {
    const source = 'fn add(a: i32, b: i32) -> i32 { a + b }';
    const tree = parse(source);
    if (!tree) return;

    const result = extractor.extract(tree, source, 'lib.rs');
    const funcs = result.symbols.filter(s => s.kind === 'function');
    expect(funcs.length).toBeGreaterThan(0);
    expect(funcs[0]?.name).toBe('add');
  });

  it('should extract a struct', () => {
    const source = 'struct Point { x: f64, y: f64 }';
    const tree = parse(source);
    if (!tree) return;

    const result = extractor.extract(tree, source, 'lib.rs');
    const structs = result.symbols.filter(s => s.kind === 'struct');
    expect(structs.length).toBeGreaterThan(0);
    expect(structs[0]?.name).toBe('Point');
  });

  it('should extract an enum', () => {
    const source = 'enum Color { Red, Green, Blue }';
    const tree = parse(source);
    if (!tree) return;

    const result = extractor.extract(tree, source, 'lib.rs');
    const enums = result.symbols.filter(s => s.kind === 'enum');
    expect(enums.length).toBeGreaterThan(0);
    expect(enums[0]?.name).toBe('Color');
  });

  it('should extract a trait', () => {
    const source = 'trait Drawable { fn draw(&self); }';
    const tree = parse(source);
    if (!tree) return;

    const result = extractor.extract(tree, source, 'lib.rs');
    const traits = result.symbols.filter(s => s.kind === 'trait');
    expect(traits.length).toBeGreaterThan(0);
    expect(traits[0]?.name).toBe('Drawable');
  });

  it('should extract an impl block', () => {
    const source = 'struct Foo; impl Foo { fn new() -> Foo { Foo } }';
    const tree = parse(source);
    if (!tree) return;

    const result = extractor.extract(tree, source, 'lib.rs');
    const impls = result.symbols.filter(s => s.kind === 'impl');
    expect(impls.length).toBeGreaterThan(0);
    expect(impls[0]?.name).toContain('Foo');
  });

  it('should extract a trait impl', () => {
    const source = 'struct Foo; trait Bar {} impl Bar for Foo {}';
    const tree = parse(source);
    if (!tree) return;

    const result = extractor.extract(tree, source, 'lib.rs');
    const impls = result.symbols.filter(s => s.kind === 'impl');
    expect(impls.length).toBeGreaterThan(0);
    const traitImpl = impls.find(i => i.name.includes('for'));
    expect(traitImpl?.name).toContain('Bar');
    expect(traitImpl?.name).toContain('Foo');
  });

  it('should extract a use declaration', () => {
    const source = 'use std::collections::HashMap;';
    const tree = parse(source);
    if (!tree) return;

    const result = extractor.extract(tree, source, 'lib.rs');
    expect(result.imports).toHaveLength(1);
    expect(result.imports[0]?.source).toContain('HashMap');
  });

  it('should extract multiple use declarations', () => {
    const source = 'use std::fs;\nuse std::io::Read;';
    const tree = parse(source);
    if (!tree) return;

    const result = extractor.extract(tree, source, 'lib.rs');
    expect(result.imports).toHaveLength(2);
  });

  it('should record startLine and endLine on symbols', () => {
    const source = 'fn foo() {\n  let x = 1;\n}';
    const tree = parse(source);
    if (!tree) return;

    const result = extractor.extract(tree, source, 'lib.rs');
    const fn_ = result.symbols.find(s => s.name === 'foo');
    expect(fn_?.startLine).toBe(0);
    expect(fn_?.endLine).toBe(2);
  });
});
