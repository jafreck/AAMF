import { describe, it, expect, vi } from 'vitest';
import { CostEstimator } from '../../src/budget/cost-estimator.js';

describe('CostEstimator', () => {
  const estimator = new CostEstimator();

  it('should calculate correct pricing for claude-opus-4.6 (1M tokens each)', () => {
    const result = estimator.estimate('claude-opus-4.6', 1_000_000, 1_000_000);
    expect(result.input).toBe(5.00);
    expect(result.output).toBe(25.00);
    expect(result.total).toBe(30.00);
  });

  it('should calculate correct pricing for gpt-4.1 (1M tokens each)', () => {
    const result = estimator.estimate('gpt-4.1', 1_000_000, 1_000_000);
    expect(result.input).toBe(2.00);
    expect(result.output).toBe(8.00);
    expect(result.total).toBe(10.00);
  });

  it('should calculate correct pricing for claude-sonnet-4.6 (1M tokens each)', () => {
    const result = estimator.estimate('claude-sonnet-4.6', 1_000_000, 1_000_000);
    expect(result.input).toBe(3.00);
    expect(result.output).toBe(15.00);
    expect(result.total).toBe(18.00);
  });

  it('should fall back to default pricing ($5/$15) for unknown model and warn', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const est = new CostEstimator();
    const result = est.estimate('unknown-model-xyz', 1_000_000, 1_000_000);
    expect(result.input).toBe(5.00);
    expect(result.output).toBe(15.00);
    expect(result.total).toBe(20.00);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('unknown-model-xyz'));
    warnSpy.mockRestore();
  });

  it('should only warn once per unknown model', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const est = new CostEstimator();
    est.estimate('new-unknown', 1_000, 1_000);
    est.estimate('new-unknown', 1_000, 1_000);
    const calls = warnSpy.mock.calls.filter(c => String(c[0]).includes('new-unknown'));
    expect(calls).toHaveLength(1);
    warnSpy.mockRestore();
  });

  it('should use costOverrides when provided', () => {
    const est = new CostEstimator({
      'my-custom-model': { input: 1.00, output: 2.00 },
    });
    const result = est.estimate('my-custom-model', 1_000_000, 1_000_000);
    expect(result.input).toBe(1.00);
    expect(result.output).toBe(2.00);
    expect(result.total).toBe(3.00);
  });

  it('should prefer costOverrides over built-in pricing', () => {
    const est = new CostEstimator({
      'claude-opus-4.6': { input: 99.00, output: 99.00 },
    });
    const result = est.estimate('claude-opus-4.6', 1_000_000, 1_000_000);
    expect(result.input).toBe(99.00);
    expect(result.output).toBe(99.00);
  });

  it('should split 80/20 with estimateFromTotal', () => {
    const result = estimator.estimateFromTotal('gpt-4.1', 1000);
    // 800 prompt, 200 completion
    const promptTokens = Math.round(1000 * 0.8);
    const completionTokens = 1000 - promptTokens;
    const expected = estimator.estimate('gpt-4.1', promptTokens, completionTokens);
    expect(result.input).toBeCloseTo(expected.input, 10);
    expect(result.output).toBeCloseTo(expected.output, 10);
    expect(result.total).toBeCloseTo(expected.total, 10);
  });

  it('should format cost correctly', () => {
    expect(CostEstimator.formatCost(1.5)).toBe('$1.5000');
    expect(CostEstimator.formatCost(0)).toBe('$0.0000');
  });

  it('should list known models including current Copilot CLI model names', () => {
    const models = estimator.getSupportedModels();
    expect(models).toContain('claude-sonnet-4.6');
    expect(models).toContain('claude-opus-4.6');
    expect(models).toContain('claude-opus-4.6-1m');
    expect(models).toContain('claude-haiku-4.5');
    expect(models).toContain('gpt-5.2-codex');
    expect(models).toContain('gpt-4.1');
    expect(models).toContain('gemini-3-pro-preview');
    expect(models).toContain('gemini-3.1-pro-preview');
    expect(models).toContain('gemini-2.5-pro');
    expect(models).toContain('o3');
    expect(models).toContain('o4-mini');
  });

  it('should list Claude Code CLI model identifiers (dash notation)', () => {
    const models = estimator.getSupportedModels();
    expect(models).toContain('claude-sonnet-4-5');
    expect(models).toContain('claude-haiku-4-5');
    expect(models).toContain('claude-opus-4-5');
    expect(models).toContain('claude-opus-4-6');
    expect(models).toContain('claude-opus-4-6-1m');
    expect(models).toContain('claude-sonnet-4-6');
  });

  it('should calculate cached token cost at 50% of input price for claude-sonnet-4-5', () => {
    const result = estimator.estimate('claude-sonnet-4-5', 0, 0, 1_000_000);
    // input price = $3/M, cached = 50% = $1.50/M for 1M tokens
    expect(result.cached).toBeCloseTo(1.50, 10);
    expect(result.total).toBeCloseTo(1.50, 10);
  });

  it('should include cached cost in total', () => {
    const result = estimator.estimate('claude-sonnet-4-5', 1_000_000, 1_000_000, 1_000_000);
    // All 1M prompt tokens are cached → input (non-cached) = 0, cached = 1.50, output = 15.00
    expect(result.input).toBe(0);
    expect(result.output).toBe(15.00);
    expect(result.cached).toBeCloseTo(1.50, 10);
    expect(result.total).toBeCloseTo(16.50, 10);
  });

  it('should correctly split cost between cached and non-cached input tokens', () => {
    // 2M prompt tokens total, 1M of which are cached
    const result = estimator.estimate('claude-sonnet-4-5', 2_000_000, 500_000, 1_000_000);
    // non-cached input: 1M * $3/M = $3.00
    // cached input: 1M * $3/M * 0.5 = $1.50
    // output: 500K * $15/M = $7.50
    expect(result.input).toBeCloseTo(3.00, 10);
    expect(result.cached).toBeCloseTo(1.50, 10);
    expect(result.output).toBeCloseTo(7.50, 10);
    expect(result.total).toBeCloseTo(12.00, 10);
  });

  it('should calculate correct pricing for claude-opus-4.6-1m (1M context variant)', () => {
    const result = estimator.estimate('claude-opus-4.6-1m', 1_000_000, 1_000_000);
    expect(result.input).toBe(10.00);
    expect(result.output).toBe(37.50);
    expect(result.total).toBe(47.50);
  });

  it('should calculate correct pricing for claude-opus-4.6-fast', () => {
    const result = estimator.estimate('claude-opus-4.6-fast', 1_000_000, 1_000_000);
    expect(result.input).toBe(30.00);
    expect(result.output).toBe(150.00);
    expect(result.total).toBe(180.00);
  });

  it('should calculate correct pricing for gemini-2.5-pro', () => {
    const result = estimator.estimate('gemini-2.5-pro', 1_000_000, 1_000_000);
    expect(result.input).toBe(1.25);
    expect(result.output).toBe(10.00);
    expect(result.total).toBe(11.25);
  });

  it('should calculate correct pricing for o3 reasoning model', () => {
    const result = estimator.estimate('o3', 1_000_000, 1_000_000);
    expect(result.input).toBe(2.00);
    expect(result.output).toBe(8.00);
    expect(result.total).toBe(10.00);
  });

  it('should return zero cached cost when cachedInputTokens is omitted', () => {
    const result = estimator.estimate('claude-sonnet-4-5', 1_000_000, 0);
    expect(result.cached).toBe(0);
    expect(result.total).toBe(result.input + result.output);
  });

  it('should handle zero tokens without error', () => {
    const result = estimator.estimate('gpt-4.1', 0, 0);
    expect(result.input).toBe(0);
    expect(result.output).toBe(0);
    expect(result.total).toBe(0);
  });

  it('should project cost for a model and average token count', () => {
    const result = estimator.projectCost('claude-sonnet-4.5', 5000);
    expect(result.total).toBeGreaterThan(0);
    // Cross-check: projectCost should match estimateFromTotal
    const expected = estimator.estimateFromTotal('claude-sonnet-4.5', 5000);
    expect(result.total).toBeCloseTo(expected.total, 10);
  });

  it('should project cost of zero for zero tokens', () => {
    const result = estimator.projectCost('gpt-4.1', 0);
    expect(result.total).toBe(0);
  });
});
