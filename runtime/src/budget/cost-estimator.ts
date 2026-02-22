/**
 * @module cost-estimator
 * Estimates monetary cost from token usage for common LLM models.
 */

/** Pricing per 1 M tokens (USD) for input and output. */
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  'gpt-4o': { input: 2.50, output: 10.00 },
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
  'gpt-4-turbo': { input: 10.00, output: 30.00 },
  'claude-sonnet-4-20250514': { input: 3.00, output: 15.00 },
  'claude-3-5-haiku': { input: 0.80, output: 4.00 },
  'claude-opus-4-20250514': { input: 15.00, output: 75.00 },
};

/**
 * Estimates the monetary cost of LLM API calls based on token counts
 * and per-model pricing tables.
 */
export class CostEstimator {
  /**
   * Estimate cost given explicit prompt and completion token counts.
   *
   * @param model - Model identifier (falls back to `gpt-4o` pricing if unknown).
   * @param promptTokens - Number of input / prompt tokens.
   * @param completionTokens - Number of output / completion tokens.
   * @returns Breakdown of input, output, and total cost in USD.
   */
  estimate(
    model: string,
    promptTokens: number,
    completionTokens: number,
  ): { input: number; output: number; total: number } {
    const pricing = MODEL_PRICING[model] ?? MODEL_PRICING['gpt-4o']!;
    const input = (promptTokens / 1_000_000) * pricing.input;
    const output = (completionTokens / 1_000_000) * pricing.output;
    return { input, output, total: input + output };
  }

  /**
   * Estimate cost from a single total-token count by assuming a
   * 60 % prompt / 40 % completion split.
   *
   * @param model - Model identifier.
   * @param totalTokens - Combined token count.
   * @returns Breakdown of input, output, and total cost in USD.
   */
  estimateFromTotal(
    model: string,
    totalTokens: number,
  ): { input: number; output: number; total: number } {
    const promptTokens = Math.round(totalTokens * 0.6);
    const completionTokens = totalTokens - promptTokens;
    return this.estimate(model, promptTokens, completionTokens);
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
