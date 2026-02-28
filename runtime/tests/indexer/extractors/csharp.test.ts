import { describe, it, expect } from 'vitest';
import { ParserPool, CSharpExtractor } from '@aamf/lore';

function parse(source: string) {
  const pool = new ParserPool();
  return pool.parse('csharp', source);
}

describe('CSharpExtractor', () => {
  const extractor = new CSharpExtractor();

  it('should return empty result for an empty source', () => {
    const tree = parse('');
    if (!tree) return;
    const result = extractor.extract(tree, '', 'Program.cs');
    expect(result.symbols).toEqual([]);
    expect(result.imports).toEqual([]);
    expect(result.callRefs).toEqual([]);
  });

  it('should extract a class declaration', () => {
    const source = 'class Animal { }';
    const tree = parse(source);
    if (!tree) return;

    const result = extractor.extract(tree, source, 'Animal.cs');
    const classes = result.symbols.filter(s => s.kind === 'class');
    expect(classes.length).toBeGreaterThan(0);
    expect(classes[0]?.name).toBe('Animal');
  });

  it('should extract an interface declaration', () => {
    const source = 'interface IDrawable { void Draw(); }';
    const tree = parse(source);
    if (!tree) return;

    const result = extractor.extract(tree, source, 'IDrawable.cs');
    const ifaces = result.symbols.filter(s => s.kind === 'interface');
    expect(ifaces.length).toBeGreaterThan(0);
    expect(ifaces[0]?.name).toBe('IDrawable');
  });

  it('should extract a struct declaration', () => {
    const source = 'struct Point { public float X; public float Y; }';
    const tree = parse(source);
    if (!tree) return;

    const result = extractor.extract(tree, source, 'Point.cs');
    const structs = result.symbols.filter(s => s.kind === 'struct');
    expect(structs.length).toBeGreaterThan(0);
    expect(structs[0]?.name).toBe('Point');
  });

  it('should extract an enum declaration', () => {
    const source = 'enum Color { Red, Green, Blue }';
    const tree = parse(source);
    if (!tree) return;

    const result = extractor.extract(tree, source, 'Color.cs');
    const enums = result.symbols.filter(s => s.kind === 'enum');
    expect(enums.length).toBeGreaterThan(0);
    expect(enums[0]?.name).toBe('Color');
  });

  it('should extract a method declaration', () => {
    const source = 'class Foo { public int Add(int a, int b) { return a + b; } }';
    const tree = parse(source);
    if (!tree) return;

    const result = extractor.extract(tree, source, 'Foo.cs');
    const methods = result.symbols.filter(s => s.kind === 'function');
    expect(methods.length).toBeGreaterThan(0);
    expect(methods[0]?.name).toBe('Add');
  });

  it('should extract a simple using directive', () => {
    const source = 'using System.Collections.Generic;\nclass Foo {}';
    const tree = parse(source);
    if (!tree) return;

    const result = extractor.extract(tree, source, 'Foo.cs');
    expect(result.imports.length).toBeGreaterThan(0);
    const imp = result.imports.find(i => i.source === 'System.Collections.Generic');
    expect(imp).toBeDefined();
    expect(imp?.importedNames).toContain('Generic');
  });

  it('should extract an aliased using directive', () => {
    const source = 'using MyList = System.Collections.Generic.List<int>;\nclass Foo {}';
    const tree = parse(source);
    if (!tree) return;

    const result = extractor.extract(tree, source, 'Foo.cs');
    expect(result.imports.length).toBeGreaterThan(0);
    const imp = result.imports[0];
    expect(imp?.importedNames).toContain('MyList');
  });

  it('should record correct line numbers', () => {
    const source = 'class Foo {\n  public void Bar() {\n  }\n}';
    const tree = parse(source);
    if (!tree) return;

    const result = extractor.extract(tree, source, 'Foo.cs');
    const method = result.symbols.find(s => s.name === 'Bar');
    expect(method?.startLine).toBe(1);
  });
});
