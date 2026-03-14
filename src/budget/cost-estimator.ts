/**
 * @module cost-estimator
 * Estimates monetary cost from token usage for common LLM models.
 */

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
};

/** Default fallback pricing when a model is unknown and no overrides exist. */
const DEFAULT_PRICING: { input: number; output: number } = { input: 5.00, output: 15.00 };

/** Per-model cost override from user configuration. */
export interface CostOverride {
  input: number;
  output: number;
}

/** Callback used by CostEstimator to emit warnings (defaults to console.warn). */
export type WarnFn = (message: string) => void;

/**
 * Estimates the monetary cost of LLM API calls based on token counts
 * and per-model pricing tables.
 *
 * Resolution order:
 * 1. User-supplied `costOverrides` (from config)
 * 2. Built-in `MODEL_PRICING` table
 * 3. Generic default ($5/$15 per 1M tokens) with a log warning
 */
export class CostEstimator {
  private readonly overrides: Record<string, CostOverride>;
  private readonly warnedModels = new Set<string>();
  private readonly warn: WarnFn;

  constructor(costOverrides?: Record<string, CostOverride>, warn?: WarnFn) {
    this.overrides = costOverrides ?? {};
    this.warn = warn ?? console.warn.bind(console);
  }

  /**
   * Resolve pricing for a given model using the three-tier fallback chain.
   */
  private resolvePricing(model: string): { input: number; output: number } {
    // 1. Check user overrides
    if (this.overrides[model]) return this.overrides[model];
    // 2. Check built-in table
    if (MODEL_PRICING[model]) return MODEL_PRICING[model];
    // 3. Fall back to default and warn once
    if (!this.warnedModels.has(model)) {
      this.warnedModels.add(model);
      this.warn(
        `[CostEstimator] Unknown model "${model}" — using default pricing ($${DEFAULT_PRICING.input}/$${DEFAULT_PRICING.output} per 1M tokens). ` +
        `Consider adding costOverrides for this model in your config.`,
      );
    }
    return DEFAULT_PRICING;
  }

  /**
   * Estimate cost given explicit prompt and completion token counts.
   *
   * @param model - Model identifier.
   * @param promptTokens - Total number of input / prompt tokens (includes cached tokens).
   * @param completionTokens - Number of output / completion tokens.
   * @param cachedInputTokens - Number of cached input tokens (subset of promptTokens, billed at 50% of input price).
   * @returns Breakdown of input (non-cached), output, cached, and total cost in USD.
   */
  estimate(
    model: string,
    promptTokens: number,
    completionTokens: number,
    cachedInputTokens?: number,
  ): { input: number; output: number; cached: number; total: number } {
    const pricing = this.resolvePricing(model);
    const nonCachedPrompt = Math.max(0, promptTokens - (cachedInputTokens ?? 0));
    const input = (nonCachedPrompt / 1_000_000) * pricing.input;
    const output = (completionTokens / 1_000_000) * pricing.output;
    const cached = cachedInputTokens !== undefined
      ? (cachedInputTokens / 1_000_000) * pricing.input * 0.5
      : 0;
    return { input, output, cached, total: input + output + cached };
  }

  /**
   * Estimate cost from a single total-token count by assuming an
   * 80 % prompt / 20 % completion split (reflecting agentic workloads
   * with large context windows).
   *
   * @param model - Model identifier.
   * @param totalTokens - Combined token count.
   * @returns Breakdown of input, output, and total cost in USD.
   */
  estimateFromTotal(
    model: string,
    totalTokens: number,
  ): { input: number; output: number; total: number } {
    const promptTokens = Math.round(totalTokens * 0.8);
    const completionTokens = totalTokens - promptTokens;
    return this.estimate(model, promptTokens, completionTokens);
  }

  /**
   * Project the cost of a single invocation given a model and average
   * token count. Used for pre-invocation cap enforcement.
   *
   * @param model - Model identifier.
   * @param avgTokensPerTask - Estimated total tokens for the invocation.
   * @returns Projected total cost in USD.
   */
  projectCost(model: string, avgTokensPerTask: number): { total: number } {
    const { total } = this.estimateFromTotal(model, avgTokensPerTask);
    return { total };
  }

  /** Return the list of model identifiers with known pricing. */
  getSupportedModels(): string[] {
    return Object.keys(MODEL_PRICING);
  }

  /**
   * Format a numeric cost value as a USD string (four decimal places).
   *
   * @param cost - Cost in USD.
   * @returns Formatted string, e.g. `"$0.0125"`.
   */
  static formatCost(cost: number): string {
    return `$${cost.toFixed(4)}`;
  }
}
