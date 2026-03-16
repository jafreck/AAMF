/**
 * @module token-tracker
 * Tracks token usage across agents and phases for budget management.
 */

/**
 * Tracks cumulative token usage broken down by agent, phase, and task,
 * with budget threshold checking and checkpoint serialization support.
 */
export class TokenTracker {
  private total = 0;
  private byAgent: Record<string, number> = {};
  private byPhase: Record<number, number> = {};
  private byTask: Record<string, number> = {};
  private totalCachedInput = 0;

  /** Record token usage for a given agent and phase. */
  record(agent: string, phase: number, tokens: number, cachedInput?: number, taskId?: string): void {
    this.total += tokens;
    this.byAgent[agent] = (this.byAgent[agent] ?? 0) + tokens;
    this.byPhase[phase] = (this.byPhase[phase] ?? 0) + tokens;
    if (taskId) {
      this.byTask[taskId] = (this.byTask[taskId] ?? 0) + tokens;
    }
    if (cachedInput !== undefined) {
      this.totalCachedInput += cachedInput;
    }
  }

  /** Return the total number of cached input tokens accumulated. */
  getCachedInput(): number {
    return this.totalCachedInput;
  }

  /** Return the total number of tokens consumed. */
  getTotal(): number {
    return this.total;
  }

  /** Return token usage keyed by agent name. */
  getByAgent(): Record<string, number> {
    return { ...this.byAgent };
  }

  /** Return token usage keyed by phase number. */
  getByPhase(): Record<number, number> {
    return { ...this.byPhase };
  }

  /**
   * Return token usage keyed by task ID.
   * Only contains entries for invocations where a taskId was provided
   * (typically Phase 5 migration tasks).
   */
  getByTask(): Record<string, number> {
    return { ...this.byTask };
  }

  /** Check whether total usage is within the given budget. */
  isWithinBudget(budget: number): boolean {
    return this.total <= budget;
  }

  /**
   * Check budget threshold status.
   *
   * @returns `'ok'` when usage is below 80 %, `'warning'` between 80–100 %, `'exceeded'` above 100 %.
   */
  checkThreshold(budget: number): 'ok' | 'warning' | 'exceeded' {
    const ratio = this.total / budget;
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
    this.total = data.total;
    this.byPhase = { ...data.byPhase };
    this.byAgent = { ...data.byAgent };
  }

  /** Export current state for checkpoint serialization. */
  toCheckpointData(): {
    total: number;
    byPhase: Record<number, number>;
    byAgent: Record<string, number>;
  } {
    return {
      total: this.total,
      byPhase: this.getByPhase(),
      byAgent: this.getByAgent(),
    };
  }
}
