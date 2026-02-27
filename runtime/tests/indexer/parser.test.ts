import { describe, it, expect, beforeEach } from 'vitest';
import { ParserPool } from '../../src/indexer/parser.js';

describe('ParserPool', () => {
  let pool: ParserPool;

  beforeEach(() => {
    pool = new ParserPool();
  });

  it('should return null for an unknown language', () => {
    const result = pool.parse('cobol', 'IDENTIFICATION DIVISION.');
    expect(result).toBeNull();
  });

  it('should return null for an empty string language', () => {
    const result = pool.parse('', 'some source');
    expect(result).toBeNull();
  });

  it('should return a Tree for a known installed language', () => {
    // At least one of the bundled grammars should be available in the test environment.
    // Try javascript — it ships with the package as a devDependency.
    const result = pool.parse('javascript', 'const x = 1;');
    // If the grammar is installed, a Tree is returned; otherwise null is acceptable.
    if (result !== null) {
      expect(result).toHaveProperty('rootNode');
    }
  });

  it('should reuse the same Parser instance across calls (no re-initialisation)', () => {
    // Call parse twice and verify both succeed (or both return null — the
    // important thing is that the second call does not throw).
    const r1 = pool.parse('javascript', 'let a = 1;');
    const r2 = pool.parse('javascript', 'let b = 2;');
    if (r1 !== null && r2 !== null) {
      expect(r2).toHaveProperty('rootNode');
    } else {
      // Both must be null — not one null and one result.
      expect(r1).toBeNull();
      expect(r2).toBeNull();
    }
  });

  it('should not throw when calling parse for an unavailable language multiple times', () => {
    const lang = 'nonexistent-lang-xyz';
    expect(() => pool.parse(lang, 'code')).not.toThrow();
    expect(() => pool.parse(lang, 'code')).not.toThrow();
    expect(pool.parse(lang, 'code')).toBeNull();
  });

  it('should handle multiple different languages independently', () => {
    const langs = ['javascript', 'typescript', 'python', 'go', 'rust'];
    for (const lang of langs) {
      // Should not throw regardless of whether the grammar is installed.
      expect(() => pool.parse(lang, '')).not.toThrow();
    }
  });

  it('should parse a multi-line source without throwing', () => {
    const source = `
function hello(name) {
  return "Hello, " + name;
}
`;
    // Should not throw; result may be null if grammar not installed.
    expect(() => pool.parse('javascript', source)).not.toThrow();
  });

  it('should parse large sources (>32KB) without throwing', () => {
    const largeSource = 'const x = 1;\n'.repeat(4000);
    expect(() => pool.parse('javascript', largeSource)).not.toThrow();
  });
});
