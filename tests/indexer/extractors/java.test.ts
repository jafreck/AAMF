import { describe, it, expect } from 'vitest';
import { ParserPool, JavaExtractor } from '@jafreck/lore';

function parse(source: string) {
  const pool = new ParserPool();
  return pool.parse('java', source);
}

describe('JavaExtractor', () => {
  const extractor = new JavaExtractor();

  it('should return empty result for an empty source', () => {
    const tree = parse('');
    if (!tree) return;
    const result = extractor.extract(tree, '', 'Main.java');
    expect(result.symbols).toEqual([]);
    expect(result.imports).toEqual([]);
    expect(result.callRefs).toEqual([]);
  });

  it('should extract a class declaration', () => {
    const source = 'public class Animal { }';
    const tree = parse(source);
    if (!tree) return;

    const result = extractor.extract(tree, source, 'Animal.java');
    const classes = result.symbols.filter(s => s.kind === 'class');
    expect(classes.length).toBeGreaterThan(0);
    expect(classes[0]?.name).toBe('Animal');
  });

  it('should extract an interface declaration', () => {
    const source = 'public interface Drawable { void draw(); }';
    const tree = parse(source);
    if (!tree) return;

    const result = extractor.extract(tree, source, 'Drawable.java');
    const ifaces = result.symbols.filter(s => s.kind === 'interface');
    expect(ifaces.length).toBeGreaterThan(0);
    expect(ifaces[0]?.name).toBe('Drawable');
  });

  it('should extract an enum declaration', () => {
    const source = 'public enum Color { RED, GREEN, BLUE }';
    const tree = parse(source);
    if (!tree) return;

    const result = extractor.extract(tree, source, 'Color.java');
    const enums = result.symbols.filter(s => s.kind === 'enum');
    expect(enums.length).toBeGreaterThan(0);
    expect(enums[0]?.name).toBe('Color');
  });

  it('should extract a method declaration', () => {
    const source = 'public class Foo { public int add(int a, int b) { return a + b; } }';
    const tree = parse(source);
    if (!tree) return;

    const result = extractor.extract(tree, source, 'Foo.java');
    const funcs = result.symbols.filter(s => s.kind === 'function');
    expect(funcs.length).toBeGreaterThan(0);
    expect(funcs[0]?.name).toBe('add');
  });

  it('should extract a simple import declaration', () => {
    const source = 'import java.util.List;\npublic class Foo {}';
    const tree = parse(source);
    if (!tree) return;

    const result = extractor.extract(tree, source, 'Foo.java');
    expect(result.imports.length).toBeGreaterThan(0);
    const imp = result.imports.find(i => i.source === 'java.util.List');
    expect(imp).toBeDefined();
    expect(imp?.importedNames).toContain('List');
  });

  it('should extract a wildcard import declaration', () => {
    const source = 'import java.util.*;\npublic class Foo {}';
    const tree = parse(source);
    if (!tree) return;

    const result = extractor.extract(tree, source, 'Foo.java');
    const imp = result.imports.find(i => i.source === 'java.util.*');
    expect(imp).toBeDefined();
    expect(imp?.importedNames).toEqual([]);
  });

  it('should extract a static import declaration', () => {
    const source = 'import static java.lang.Math.PI;\npublic class Foo {}';
    const tree = parse(source);
    if (!tree) return;

    const result = extractor.extract(tree, source, 'Foo.java');
    expect(result.imports.length).toBeGreaterThan(0);
    const imp = result.imports.find(i => i.source.includes('Math.PI') || i.source === 'java.lang.Math.PI');
    expect(imp).toBeDefined();
  });

  it('should record correct line numbers', () => {
    const source = 'public class Foo {\n  public void bar() {\n  }\n}';
    const tree = parse(source);
    if (!tree) return;

    const result = extractor.extract(tree, source, 'Foo.java');
    const method = result.symbols.find(s => s.name === 'bar');
    expect(method?.startLine).toBe(1);
  });
});
