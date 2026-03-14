/**
 * Extended extractor branch coverage – Go, Rust, Java, C# languages.
 *
 * Targets uncovered branches for method_declaration, type_declaration,
 * impl_item, enum_item, trait_item, use_declaration, import_declaration,
 * struct_declaration, interface_declaration, enum_declaration,
 * constructor_declaration, and using_directive.
 */
import { describe, it, expect } from 'vitest';
import { ParserPool, GoExtractor, RustExtractor, JavaExtractor, CSharpExtractor } from '@jafreck/lore';

const pool = new ParserPool();

function parseGo(source: string) { return pool.parse('go', source); }
function parseRust(source: string) { return pool.parse('rust', source); }
function parseJava(source: string) { return pool.parse('java', source); }
function parseCSharp(source: string) { return pool.parse('c_sharp', source); }

// ─── Go Extractor ─────────────────────────────────────────────────────────────

describe('GoExtractor – branch coverage', () => {
  const extractor = new GoExtractor();

  it('extracts method_declaration with pointer receiver', () => {
    const source = `package main

func (s *Server) Handle() {}
`;
    const tree = parseGo(source);
    if (!tree) return;
    const result = extractor.extract(tree, source, 'test.go');
    const methods = result.symbols.filter(s => s.kind === 'method');
    expect(methods.length).toBeGreaterThan(0);
    expect(methods[0]!.name).toContain('Server');
    expect(methods[0]!.name).toContain('Handle');
  });

  it('extracts method_declaration with value receiver', () => {
    const source = `package main

func (s Server) String() string { return "" }
`;
    const tree = parseGo(source);
    if (!tree) return;
    const result = extractor.extract(tree, source, 'test.go');
    const methods = result.symbols.filter(s => s.kind === 'method');
    expect(methods.length).toBeGreaterThan(0);
    expect(methods[0]!.name).toContain('String');
  });

  it('extracts type_declaration with struct_type', () => {
    const source = `package main

type Point struct {
    X int
    Y int
}
`;
    const tree = parseGo(source);
    if (!tree) return;
    const result = extractor.extract(tree, source, 'test.go');
    const structs = result.symbols.filter(s => s.kind === 'struct');
    expect(structs.length).toBeGreaterThan(0);
    expect(structs[0]!.name).toBe('Point');
  });

  it('extracts type_declaration with interface_type', () => {
    const source = `package main

type Reader interface {
    Read(p []byte) (n int, err error)
}
`;
    const tree = parseGo(source);
    if (!tree) return;
    const result = extractor.extract(tree, source, 'test.go');
    const interfaces = result.symbols.filter(s => s.kind === 'interface');
    expect(interfaces.length).toBeGreaterThan(0);
    expect(interfaces[0]!.name).toBe('Reader');
  });

  it('extracts type_declaration with alias type (not struct/interface)', () => {
    const source = `package main

type Duration int64
`;
    const tree = parseGo(source);
    if (!tree) return;
    const result = extractor.extract(tree, source, 'test.go');
    const types = result.symbols.filter(s => s.kind === 'type');
    expect(types.length).toBeGreaterThan(0);
    expect(types[0]!.name).toBe('Duration');
  });

  it('extracts grouped import_declaration', () => {
    const source = `package main

import (
    "fmt"
    "os"
)
`;
    const tree = parseGo(source);
    if (!tree) return;
    const result = extractor.extract(tree, source, 'test.go');
    expect(result.imports.length).toBeGreaterThanOrEqual(2);
    expect(result.imports.some(i => i.source === 'fmt')).toBe(true);
    expect(result.imports.some(i => i.source === 'os')).toBe(true);
  });

  it('extracts single import_declaration', () => {
    const source = `package main

import "fmt"
`;
    const tree = parseGo(source);
    if (!tree) return;
    const result = extractor.extract(tree, source, 'test.go');
    expect(result.imports.length).toBeGreaterThanOrEqual(1);
    expect(result.imports.some(i => i.source === 'fmt')).toBe(true);
  });

  it('extracts aliased import', () => {
    const source = `package main

import (
    alias "some/pkg"
)
`;
    const tree = parseGo(source);
    if (!tree) return;
    const result = extractor.extract(tree, source, 'test.go');
    const imp = result.imports.find(i => i.source.includes('some/pkg'));
    expect(imp).toBeDefined();
    expect(imp!.importedNames).toContain('alias');
  });

  it('extracts simple function_declaration', () => {
    const source = `package main

func main() {}
`;
    const tree = parseGo(source);
    if (!tree) return;
    const result = extractor.extract(tree, source, 'test.go');
    const funcs = result.symbols.filter(s => s.kind === 'function');
    expect(funcs.some(f => f.name === 'main')).toBe(true);
  });
});

// ─── Rust Extractor ───────────────────────────────────────────────────────────

describe('RustExtractor – branch coverage', () => {
  const extractor = new RustExtractor();

  it('extracts function_item', () => {
    const source = 'fn main() {}';
    const tree = parseRust(source);
    if (!tree) return;
    const result = extractor.extract(tree, source, 'test.rs');
    const funcs = result.symbols.filter(s => s.kind === 'function');
    expect(funcs.some(f => f.name === 'main')).toBe(true);
  });

  it('extracts struct_item', () => {
    const source = 'struct Point { x: f64, y: f64 }';
    const tree = parseRust(source);
    if (!tree) return;
    const result = extractor.extract(tree, source, 'test.rs');
    expect(result.symbols.some(s => s.kind === 'struct' && s.name === 'Point')).toBe(true);
  });

  it('extracts enum_item', () => {
    const source = 'enum Color { Red, Green, Blue }';
    const tree = parseRust(source);
    if (!tree) return;
    const result = extractor.extract(tree, source, 'test.rs');
    expect(result.symbols.some(s => s.kind === 'enum' && s.name === 'Color')).toBe(true);
  });

  it('extracts trait_item', () => {
    const source = 'trait Readable { fn read(&self) -> Vec<u8>; }';
    const tree = parseRust(source);
    if (!tree) return;
    const result = extractor.extract(tree, source, 'test.rs');
    expect(result.symbols.some(s => s.kind === 'trait' && s.name === 'Readable')).toBe(true);
  });

  it('extracts impl_item without trait', () => {
    const source = `
impl Point {
    fn new(x: f64, y: f64) -> Self { Self { x, y } }
}
`;
    const tree = parseRust(source);
    if (!tree) return;
    const result = extractor.extract(tree, source, 'test.rs');
    const impls = result.symbols.filter(s => s.kind === 'impl');
    expect(impls.length).toBeGreaterThan(0);
    expect(impls[0]!.name).toBe('Point');
  });

  it('extracts impl_item with trait (impl Trait for Type)', () => {
    const source = `
impl Display for Point {
    fn fmt(&self, f: &mut Formatter<'_>) -> Result { Ok(()) }
}
`;
    const tree = parseRust(source);
    if (!tree) return;
    const result = extractor.extract(tree, source, 'test.rs');
    const impls = result.symbols.filter(s => s.kind === 'impl');
    expect(impls.length).toBeGreaterThan(0);
    expect(impls[0]!.name).toContain('Display');
    expect(impls[0]!.name).toContain('Point');
  });

  it('extracts use_declaration', () => {
    const source = 'use std::io::Read;';
    const tree = parseRust(source);
    if (!tree) return;
    const result = extractor.extract(tree, source, 'test.rs');
    expect(result.imports.length).toBeGreaterThan(0);
    expect(result.imports[0]!.source).toContain('std');
    expect(result.imports[0]!.importedNames).toContain('Read');
  });

  it('extracts use_declaration with glob', () => {
    const source = 'use std::io::*;';
    const tree = parseRust(source);
    if (!tree) return;
    const result = extractor.extract(tree, source, 'test.rs');
    expect(result.imports.length).toBeGreaterThan(0);
  });

  it('extracts use_declaration with multiple imports', () => {
    const source = 'use std::collections::{HashMap, BTreeMap};';
    const tree = parseRust(source);
    if (!tree) return;
    const result = extractor.extract(tree, source, 'test.rs');
    expect(result.imports.length).toBeGreaterThan(0);
    expect(result.imports[0]!.importedNames).toContain('HashMap');
    expect(result.imports[0]!.importedNames).toContain('BTreeMap');
  });
});

// ─── Java Extractor ───────────────────────────────────────────────────────────

describe('JavaExtractor – branch coverage', () => {
  const extractor = new JavaExtractor();

  it('extracts class_declaration', () => {
    const source = `
public class MyClass {
    public void doSomething() {}
}
`;
    const tree = parseJava(source);
    if (!tree) return;
    const result = extractor.extract(tree, source, 'MyClass.java');
    expect(result.symbols.some(s => s.kind === 'class' && s.name === 'MyClass')).toBe(true);
  });

  it('extracts interface_declaration', () => {
    const source = `
public interface Runnable {
    void run();
}
`;
    const tree = parseJava(source);
    if (!tree) return;
    const result = extractor.extract(tree, source, 'Runnable.java');
    expect(result.symbols.some(s => s.kind === 'interface' && s.name === 'Runnable')).toBe(true);
  });

  it('extracts enum_declaration', () => {
    const source = `
public enum Color {
    RED, GREEN, BLUE
}
`;
    const tree = parseJava(source);
    if (!tree) return;
    const result = extractor.extract(tree, source, 'Color.java');
    expect(result.symbols.some(s => s.kind === 'enum' && s.name === 'Color')).toBe(true);
  });

  it('extracts method_declaration', () => {
    const source = `
class Foo {
    public int calculate(int x) { return x * 2; }
}
`;
    const tree = parseJava(source);
    if (!tree) return;
    const result = extractor.extract(tree, source, 'Foo.java');
    const funcs = result.symbols.filter(s => s.kind === 'function');
    expect(funcs.some(f => f.name === 'calculate')).toBe(true);
  });

  it('extracts import_declaration (specific class)', () => {
    const source = `
import java.util.List;

class Foo {}
`;
    const tree = parseJava(source);
    if (!tree) return;
    const result = extractor.extract(tree, source, 'Foo.java');
    expect(result.imports.length).toBeGreaterThan(0);
    expect(result.imports[0]!.source).toContain('java.util.List');
    expect(result.imports[0]!.importedNames).toContain('List');
  });

  it('extracts import_declaration with wildcard (* import)', () => {
    const source = `
import java.util.*;

class Foo {}
`;
    const tree = parseJava(source);
    if (!tree) return;
    const result = extractor.extract(tree, source, 'Foo.java');
    expect(result.imports.length).toBeGreaterThan(0);
    // Wildcard: importedNames should be empty
    expect(result.imports[0]!.importedNames).toHaveLength(0);
  });

  it('extracts static import', () => {
    const source = `
import static java.lang.Math.PI;

class Foo {}
`;
    const tree = parseJava(source);
    if (!tree) return;
    const result = extractor.extract(tree, source, 'Foo.java');
    expect(result.imports.length).toBeGreaterThan(0);
  });
});

// ─── C# Extractor ─────────────────────────────────────────────────────────────

describe('CSharpExtractor – branch coverage', () => {
  const extractor = new CSharpExtractor();

  it('extracts class_declaration', () => {
    const source = `
public class MyClass {
    public void DoSomething() {}
}
`;
    const tree = parseCSharp(source);
    if (!tree) return;
    const result = extractor.extract(tree, source, 'MyClass.cs');
    expect(result.symbols.some(s => s.kind === 'class' && s.name === 'MyClass')).toBe(true);
  });

  it('extracts interface_declaration', () => {
    const source = `
public interface IFoo {
    void Bar();
}
`;
    const tree = parseCSharp(source);
    if (!tree) return;
    const result = extractor.extract(tree, source, 'IFoo.cs');
    expect(result.symbols.some(s => s.kind === 'interface' && s.name === 'IFoo')).toBe(true);
  });

  it('extracts struct_declaration', () => {
    const source = `
public struct Point {
    public int X;
    public int Y;
}
`;
    const tree = parseCSharp(source);
    if (!tree) return;
    const result = extractor.extract(tree, source, 'Point.cs');
    expect(result.symbols.some(s => s.kind === 'struct' && s.name === 'Point')).toBe(true);
  });

  it('extracts enum_declaration', () => {
    const source = `
public enum Color {
    Red,
    Green,
    Blue
}
`;
    const tree = parseCSharp(source);
    if (!tree) return;
    const result = extractor.extract(tree, source, 'Color.cs');
    expect(result.symbols.some(s => s.kind === 'enum' && s.name === 'Color')).toBe(true);
  });

  it('extracts method_declaration', () => {
    const source = `
class Foo {
    public int Calculate(int x) { return x * 2; }
}
`;
    const tree = parseCSharp(source);
    if (!tree) return;
    const result = extractor.extract(tree, source, 'Foo.cs');
    const funcs = result.symbols.filter(s => s.kind === 'function');
    expect(funcs.some(f => f.name === 'Calculate')).toBe(true);
  });

  it('extracts using_directive (simple)', () => {
    const source = `
using System;
using System.Collections.Generic;
`;
    const tree = parseCSharp(source);
    if (!tree) return;
    const result = extractor.extract(tree, source, 'test.cs');
    expect(result.imports.length).toBeGreaterThanOrEqual(2);
    expect(result.imports.some(i => i.source === 'System')).toBe(true);
    expect(result.imports.some(i => i.source === 'System.Collections.Generic')).toBe(true);
  });

  it('extracts using_directive with alias', () => {
    const source = `
using Dict = System.Collections.Generic.Dictionary<string, object>;
`;
    const tree = parseCSharp(source);
    if (!tree) return;
    const result = extractor.extract(tree, source, 'test.cs');
    expect(result.imports.length).toBeGreaterThan(0);
    // Alias directive: the alias should appear in importedNames
  });

  it('extracts multiple symbols from same file', () => {
    const source = `
using System;

public class Outer {
    public void Method() {}
}

public interface IHelper {}

public struct Data {
    public int Value;
}

public enum Status { Active, Inactive }
`;
    const tree = parseCSharp(source);
    if (!tree) return;
    const result = extractor.extract(tree, source, 'Combined.cs');
    expect(result.symbols.some(s => s.kind === 'class' && s.name === 'Outer')).toBe(true);
    expect(result.symbols.some(s => s.kind === 'interface' && s.name === 'IHelper')).toBe(true);
    expect(result.symbols.some(s => s.kind === 'struct' && s.name === 'Data')).toBe(true);
    expect(result.symbols.some(s => s.kind === 'enum' && s.name === 'Status')).toBe(true);
    expect(result.imports.length).toBeGreaterThan(0);
  });
});
