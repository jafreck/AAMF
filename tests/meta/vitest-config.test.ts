import { describe, it, expect } from 'vitest';
import config from '../../vitest.config.js';

describe('vitest.config.ts', () => {
  const testConfig = (config as any).test;

  it('should export a config with a test.coverage section', () => {
    expect(testConfig).toBeDefined();
    expect(testConfig.coverage).toBeDefined();
  });

  it('should use v8 as the coverage provider', () => {
    expect(testConfig.coverage.provider).toBe('v8');
  });

  it('should include text and lcov reporters', () => {
    expect(testConfig.coverage.reporter).toContain('text');
    expect(testConfig.coverage.reporter).toContain('lcov');
  });

  it('should set 80% threshold for lines', () => {
    expect(testConfig.coverage.thresholds.lines).toBe(80);
  });

  it('should set 64% threshold for branches', () => {
    expect(testConfig.coverage.thresholds.branches).toBe(64);
  });

  it('should set 85% threshold for functions', () => {
    expect(testConfig.coverage.thresholds.functions).toBe(85);
  });

  it('should set 79% threshold for statements', () => {
    expect(testConfig.coverage.thresholds.statements).toBe(79);
  });

  it('should have exactly two reporters', () => {
    expect(testConfig.coverage.reporter).toHaveLength(2);
  });
});
