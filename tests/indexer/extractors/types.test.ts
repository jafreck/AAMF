import { describe, it, expect } from 'vitest';
import { ParserPool } from '@jafreck/lore';
import {
  walk,
  findFirst,
  nodeSignature,
  emptyResult,
} from '@jafreck/lore';

// ─── Helper ───────────────────────────────────────────────────────────────────

function getTree(language: string, source: string) {
  const pool = new ParserPool();
  return pool.parse(language, source);
}

// ─── emptyResult ──────────────────────────────────────────────────────────────

describe('emptyResult', () => {
  it('should return an object with empty arrays', () => {
    const result = emptyResult();
    expect(result.symbols).toEqual([]);
    expect(result.imports).toEqual([]);
    expect(result.callRefs).toEqual([]);
  });

  it('should return a new object on each call', () => {
    const a = emptyResult();
    const b = emptyResult();
    expect(a).not.toBe(b);
    a.symbols.push({ name: 'x', kind: 'function', startLine: 0, endLine: 0, signature: '' });
    expect(b.symbols).toHaveLength(0);
  });
});

// ─── walk ─────────────────────────────────────────────────────────────────────

describe('walk', () => {
  it('should yield all nodes in depth-first order', () => {
    const tree = getTree('javascript', 'const x = 1;');
    if (!tree) return; // grammar unavailable

    const nodes = [...walk(tree.rootNode)];
    expect(nodes.length).toBeGreaterThan(0);
    // First node is always the root
    expect(nodes[0]).toBe(tree.rootNode);
  });

  it('should yield at least one node for non-empty source', () => {
    const tree = getTree('javascript', 'function foo() {}');
    if (!tree) return;

    const nodes = [...walk(tree.rootNode)];
    expect(nodes.length).toBeGreaterThan(1);
  });

  it('should yield a single node for a leaf node', () => {
    const tree = getTree('javascript', '1');
    if (!tree) return;

    const root = tree.rootNode;
    // Drill down to a leaf
    let leaf = root;
    while (leaf.childCount > 0) {
      leaf = leaf.children[0]!;
    }
    const nodes = [...walk(leaf)];
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toBe(leaf);
  });
});

// ─── findFirst ────────────────────────────────────────────────────────────────

describe('findFirst', () => {
  it('should return the first node with the given type', () => {
    const tree = getTree('javascript', 'function foo() {}');
    if (!tree) return;

    const result = findFirst(tree.rootNode, 'identifier');
    expect(result).not.toBeNull();
    expect(result?.text).toBe('foo');
  });

  it('should return null when the type is not found', () => {
    const tree = getTree('javascript', 'const x = 1;');
    if (!tree) return;

    const result = findFirst(tree.rootNode, 'nonexistent_node_type_xyz');
    expect(result).toBeNull();
  });
});

// ─── nodeSignature ────────────────────────────────────────────────────────────

describe('nodeSignature', () => {
  it('should return text before the first opening brace', () => {
    const tree = getTree('javascript', 'function foo(a, b) { return a + b; }');
    if (!tree) return;

    const fnNode = findFirst(tree.rootNode, 'function_declaration');
    if (!fnNode) return;

    const sig = nodeSignature(fnNode);
    expect(sig).toContain('function foo');
    expect(sig).not.toContain('{');
  });

  it('should return the first line when there is no opening brace', () => {
    const tree = getTree('python', 'x = 1\ny = 2');
    if (!tree) return;

    const root = tree.rootNode;
    // Use a node that has no braces
    const exprNode = findFirst(root, 'assignment') ?? findFirst(root, 'expression_statement');
    if (!exprNode) return;

    const sig = nodeSignature(exprNode);
    expect(sig).toBeTruthy();
    expect(sig.includes('\n')).toBe(false);
  });
});
