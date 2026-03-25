import { describe, expect, it } from 'vitest';
import { resolveLoopMaxIterations } from '../../src/flow/iteration-policy.js';

describe('resolveLoopMaxIterations', () => {
  it('should use the fallback when config is undefined', () => {
    expect(resolveLoopMaxIterations(undefined, 3)).toBe(3);
  });

  it('should preserve explicit finite limits', () => {
    expect(resolveLoopMaxIterations(5, 3)).toBe(5);
  });

  it('should treat 0 as unlimited', () => {
    expect(resolveLoopMaxIterations(0, 3)).toBe(Number.POSITIVE_INFINITY);
  });
});