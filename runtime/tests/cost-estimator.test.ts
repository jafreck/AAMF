import { describe, it, expect } from 'vitest';
import { CostEstimator } from '../src/budget/cost-estimator.js';

describe('CostEstimator', () => {
  const estimator = new CostEstimator();

  it('should calculate correct pricing for gpt-4o (1M tokens each)', () => {
    const result = estimator.estimate('gpt-4o', 1_000_000, 1_000_000);
    expect(result.input).toBe(2.50);
    expect(result.output).toBe(10.00);
    expect(result.total).toBe(12.50);
  });

  it('should calculate correct pricing for claude-opus-4-20250514 (1M tokens each)', () => {
    const result = estimator.estimate('claude-opus-4-20250514', 1_000_000, 1_000_000);
    expect(result.input).toBe(15.00);
    expect(result.output).toBe(75.00);
    expect(result.total).toBe(90.00);
  });

  it('should fall back to gpt-4o pricing for unknown model', () => {
    const unknown = estimator.estimate('unknown-model-xyz', 1_000_000, 1_000_000);
    const gpt4o = estimator.estimate('gpt-4o', 1_000_000, 1_000_000);
    expect(unknown.input).toBe(gpt4o.input);
    expect(unknown.output).toBe(gpt4o.output);
    expect(unknown.total).toBe(gpt4o.total);
  });

  it('should split 60/40 with estimateFromTotal', () => {
    const result = estimator.estimateFromTotal('gpt-4o', 1000);
    // 600 prompt, 400 completion
    const promptTokens = Math.round(1000 * 0.6);
    const completionTokens = 1000 - promptTokens;
    const expected = estimator.estimate('gpt-4o', promptTokens, completionTokens);
    expect(result.input).toBeCloseTo(expected.input, 10);
    expect(result.output).toBeCloseTo(expected.output, 10);
    expect(result.total).toBeCloseTo(expected.total, 10);
  });

  it('should format cost correctly', () => {
    expect(CostEstimator.formatCost(1.5)).toBe('$1.5000');
    expect(CostEstimator.formatCost(0)).toBe('$0.0000');
  });

  it('should list known models including gpt-4o, claude-sonnet-4-20250514, claude-opus-4-20250514', () => {
    const models = estimator.getSupportedModels();
    expect(models).toContain('gpt-4o');
    expect(models).toContain('claude-sonnet-4-20250514');
    expect(models).toContain('claude-opus-4-20250514');
  });

  it('should handle zero tokens without error', () => {
    const result = estimator.estimate('gpt-4o', 0, 0);
    expect(result.input).toBe(0);
    expect(result.output).toBe(0);
    expect(result.total).toBe(0);
  });
});
