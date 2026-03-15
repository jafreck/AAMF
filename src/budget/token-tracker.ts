/**
 * @module token-tracker
 * Tracks token usage across agents and phases for budget management.
 *
 * Delegates to @cadre-dev/framework's TokenTracker for record storage,
 * checkpoint restore (via loadFromAggregates), and per-task breakdowns.
 */
import { TokenTracker as FrameworkTokenTracker } from '@cadre-dev/framework/runtime';

/**
 * Tracks cumulative token usage broken down by agent, phase, and task,
 * with budget threshold checking and checkpoint serialization support.
 */
export class TokenTracker {
  private readonly inner = new FrameworkTokenTracker();
  private totalCachedInput = 0;

  /** Record token usage for a given agent and phase. */
  record(agent: string, phase: number, tokens: number, cachedInput?: number, taskId?: string): void {
    this.inner.record(taskId, agent, phase, tokens);
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
    return this.inner.getTotal();
  }

  /** Return token usage keyed by agent name. */
  getByAgent(): Record<string, number> {
    return this.inner.getByAgent();
  }

  /** Return token usage keyed by phase number. */
  getByPhase(): Record<number, number> {
    return this.inner.getByPhase();
  }

  /**
   * Return token usage keyed by task ID.
   * Only contains entries for invocations where a taskId was provided
   * (typically Phase 5 migration tasks).
   */
  getByTask(): Record<string, number> {
    return this.inner.getByWorkItem();
  }

  /** Check whether total usage is within the given budget. */
  isWithinBudget(budget: number): boolean {
    return this.inner.getTotal() <= budget;
  }

  /**
   * Check budget threshold status.
   *
   * @returns `'ok'` when usage is below 80 %, `'warning'` between 80–100 %, `'exceeded'` above 100 %.
   */
  checkThreshold(budget: number): 'ok' | 'warning' | 'exceeded' {
    const ratio = this.inner.getTotal() / budget;
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
    this.inner.loadFromAggregates(data);
  }

  /** Export current state for checkpoint serialization. */
  toCheckpointData(): {
    total: number;
    byPhase: Record<number, number>;
    byAgent: Record<string, number>;
  } {
    return {
      total: this.getTotal(),
      byPhase: this.getByPhase(),
      byAgent: this.getByAgent(),
    };
  }
}
