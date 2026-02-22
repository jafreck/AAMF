/**
 * @module token-tracker
 * Tracks token usage across agents and phases for budget management.
 */

/**
 * Tracks cumulative token usage broken down by agent and phase,
 * with budget threshold checking and checkpoint serialization support.
 */
export class TokenTracker {
  private usageByAgent: Map<string, number> = new Map();
  private usageByPhase: Map<number, number> = new Map();
  private totalTokens: number = 0;

  /** Record token usage for a given agent and phase. */
  record(agent: string, phase: number, tokens: number): void {
    this.totalTokens += tokens;
    this.usageByAgent.set(agent, (this.usageByAgent.get(agent) ?? 0) + tokens);
    this.usageByPhase.set(phase, (this.usageByPhase.get(phase) ?? 0) + tokens);
  }

  /** Return the total number of tokens consumed. */
  getTotal(): number {
    return this.totalTokens;
  }

  /** Return token usage keyed by agent name. */
  getByAgent(): Record<string, number> {
    return Object.fromEntries(this.usageByAgent);
  }

  /** Return token usage keyed by phase number. */
  getByPhase(): Record<number, number> {
    return Object.fromEntries(this.usageByPhase);
  }

  /** Check whether total usage is within the given budget. */
  isWithinBudget(budget: number): boolean {
    return this.totalTokens <= budget;
  }

  /**
   * Check budget threshold status.
   *
   * @returns `'ok'` when usage is below 80 %, `'warning'` between 80–100 %, `'exceeded'` above 100 %.
   */
  checkThreshold(budget: number): 'ok' | 'warning' | 'exceeded' {
    const ratio = this.totalTokens / budget;
    if (ratio > 1) return 'exceeded';
    if (ratio >= 0.8) return 'warning';
    return 'ok';
  }

  /**
   * Estimate the number of tokens in a text string.
   *
   * Uses the rough heuristic of 1 token ≈ 4 characters.
   */
  static estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  /** Restore tracker state from checkpoint data. */
  loadFromCheckpoint(data: {
    total: number;
    byPhase: Record<number, number>;
    byAgent: Record<string, number>;
  }): void {
    this.totalTokens = data.total;
    this.usageByAgent = new Map(Object.entries(data.byAgent));
    this.usageByPhase = new Map(
      Object.entries(data.byPhase).map(([k, v]) => [Number(k), v]),
    );
  }

  /** Export current state for checkpoint serialization. */
  toCheckpointData(): {
    total: number;
    byPhase: Record<number, number>;
    byAgent: Record<string, number>;
  } {
    return {
      total: this.totalTokens,
      byPhase: this.getByPhase(),
      byAgent: this.getByAgent(),
    };
  }
}
