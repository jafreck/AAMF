/**
 * @module cost-estimator
 * Estimates monetary cost from token usage for common LLM models.
 *
 * Delegates to @cadre-dev/framework's CostEstimator, passing AAMF's
 * 50+ model pricing table via the `models` config. AAMF-specific
 * methods (projectCost, formatCost) wrap the framework's API.
 */
import { CostEstimator as FrameworkCostEstimator } from '@cadre-dev/framework/core';

/** Pricing per 1 M tokens (USD) for input and output. */
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  // ── Claude (dot notation — Copilot CLI) ────────────────────────────
  'claude-opus-4.6':        { input:  5.00, output:  25.00 },
  'claude-opus-4.6-fast':   { input: 30.00, output: 150.00 },
  'claude-opus-4.6-1m':     { input: 10.00, output:  37.50 },
  'claude-opus-4.5':        { input:  5.00, output:  25.00 },
  'claude-opus-4.1':        { input: 15.00, output:  75.00 },
  'claude-opus-4':          { input: 15.00, output:  75.00 },
  'claude-opus-3':          { input: 15.00, output:  75.00 },
  'claude-sonnet-4.6':      { input:  3.00, output:  15.00 },
  'claude-sonnet-4.5':      { input:  3.00, output:  15.00 },
  'claude-sonnet-4':        { input:  3.00, output:  15.00 },
  'claude-haiku-4.5':       { input:  1.00, output:   5.00 },
  'claude-haiku-3.5':       { input:  0.80, output:   4.00 },
  'claude-haiku-3':         { input:  0.25, output:   1.25 },
  // ── Claude (dash notation — Claude Code CLI) ──────────────────────
  'claude-opus-4-6':        { input:  5.00, output:  25.00 },
  'claude-opus-4-6-fast':   { input: 30.00, output: 150.00 },
  'claude-opus-4-6-1m':     { input: 10.00, output:  37.50 },
  'claude-opus-4-5':        { input:  5.00, output:  25.00 },
  'claude-opus-4-1':        { input: 15.00, output:  75.00 },
  'claude-sonnet-4-6':      { input:  3.00, output:  15.00 },
  'claude-sonnet-4-5':      { input:  3.00, output:  15.00 },
  'claude-haiku-4-5':       { input:  1.00, output:   5.00 },
  'claude-haiku-3-5':       { input:  0.80, output:   4.00 },
  // ── Gemini ────────────────────────────────────────────────────────
  'gemini-3.1-pro-preview': { input:  2.00, output:  12.00 },
  'gemini-3-pro-preview':   { input:  2.00, output:  12.00 },
  'gemini-3-flash-preview':  { input:  0.50, output:   3.00 },
  'gemini-3.1-flash-lite-preview': { input: 0.25, output: 1.50 },
  'gemini-2.5-pro':         { input:  1.25, output:  10.00 },
  'gemini-2.5-flash':       { input:  0.30, output:   2.50 },
  'gemini-2.5-flash-lite':  { input:  0.10, output:   0.40 },
  'gemini-2.0-flash':       { input:  0.10, output:   0.40 },
  // ── GPT / OpenAI ─────────────────────────────────────────────────
  'gpt-5.3-codex':          { input:  1.75, output:  14.00 },
  'gpt-5.2-codex':          { input:  1.75, output:  14.00 },
  'gpt-5.2':                { input:  1.75, output:  14.00 },
  'gpt-5.2-pro':            { input: 21.00, output: 168.00 },
  'gpt-5.1-codex-max':      { input:  1.25, output:  10.00 },
  'gpt-5.1-codex':          { input:  1.25, output:  10.00 },
  'gpt-5.1':                { input:  1.25, output:  10.00 },
  'gpt-5.1-codex-mini':     { input:  0.25, output:   2.00 },
  'gpt-5':                  { input:  1.25, output:  10.00 },
  'gpt-5-mini':             { input:  0.25, output:   2.00 },
  'gpt-5-nano':             { input:  0.05, output:   0.40 },
  'gpt-4.1':                { input:  2.00, output:   8.00 },
  'gpt-4.1-mini':           { input:  0.40, output:   1.60 },
  'gpt-4.1-nano':           { input:  0.10, output:   0.40 },
  // ── OpenAI reasoning ─────────────────────────────────────────────
  'o3':                     { input:  2.00, output:   8.00 },
  'o3-pro':                 { input: 20.00, output:  80.00 },
  'o4-mini':                { input:  1.10, output:   4.40 },
  // ── Default fallback ─────────────────────────────────────────────
  'default':                { input:  5.00, output:  15.00 },
};

/** Per-model cost override from user configuration. */
export interface CostOverride {
  input: number;
  output: number;
}

/**
 * Estimates the monetary cost of LLM API calls based on token counts
 * and per-model pricing tables.
 *
 * Delegates to @cadre-dev/framework's CostEstimator for the core math,
 * supplying AAMF's pricing table as the `models` config. The framework
 * uses per-1K pricing; AAMF's table is per-1M — converted on construction.
 */
export class CostEstimator {
  private readonly inner: FrameworkCostEstimator;

  constructor(costOverrides?: Record<string, CostOverride>) {
    // Convert AAMF's per-1M pricing to framework's per-1K convention
    const per1K: Record<string, { input: number; output: number }> = {};
    for (const [model, pricing] of Object.entries(MODEL_PRICING)) {
      per1K[model] = { input: pricing.input / 1000, output: pricing.output / 1000 };
    }
    let overrides1K: Record<string, { input: number; output: number }> | undefined;
    if (costOverrides) {
      overrides1K = {};
      for (const [model, pricing] of Object.entries(costOverrides)) {
        overrides1K[model] = { input: pricing.input / 1000, output: pricing.output / 1000 };
      }
    }
    this.inner = new FrameworkCostEstimator({
      models: per1K,
      costOverrides: overrides1K,
      cacheDiscount: 0.5,      // AAMF bills cached tokens at 50% of input price
      defaultInputRatio: 0.8,  // 80/20 prompt/completion split for total-only estimates
    });
  }

  /**
   * Estimate cost given explicit prompt and completion token counts.
   *
   * Returns: input = cost of non-cached prompt tokens, cached = cost of
   * cached tokens at 50% rate, output = completion cost, total = sum.
   */
  estimate(
    model: string,
    promptTokens: number,
    completionTokens: number,
    cachedInputTokens?: number,
  ): { input: number; output: number; cached: number; total: number } {
    const outputEst = this.inner.estimateDetailed(0, completionTokens, model);
    const output = outputEst.outputCost;

    if (cachedInputTokens !== undefined && cachedInputTokens > 0) {
      const nonCachedPrompt = Math.max(0, promptTokens - cachedInputTokens);
      const nonCachedEst = this.inner.estimateDetailed(nonCachedPrompt, 0, model);
      // Cached tokens billed at 50% of input price
      const cachedEst = this.inner.estimateDetailed(cachedInputTokens, 0, model);
      const cached = cachedEst.inputCost * 0.5;
      const input = nonCachedEst.inputCost;
      return { input, output, cached, total: input + output + cached };
    }

    const inputEst = this.inner.estimateDetailed(promptTokens, 0, model);
    return { input: inputEst.inputCost, output, cached: 0, total: inputEst.inputCost + output };
  }

  /**
   * Estimate cost from a single total-token count.
   */
  estimateFromTotal(
    model: string,
    totalTokens: number,
  ): { input: number; output: number; total: number } {
    const est = this.inner.estimate(totalTokens, model);
    return { input: est.inputCost, output: est.outputCost, total: est.totalCost };
  }

  /**
   * Project the cost of a single invocation given a model and average token count.
   */
  projectCost(model: string, avgTokensPerTask: number): { total: number } {
    return { total: this.estimateFromTotal(model, avgTokensPerTask).total };
  }

  /** Return the list of model identifiers with known pricing. */
  getSupportedModels(): string[] {
    return Object.keys(MODEL_PRICING).filter(k => k !== 'default');
  }

  /**
   * Format a numeric cost value as a USD string (four decimal places).
   */
  static formatCost(cost: number): string {
    return `$${cost.toFixed(4)}`;
  }
}
