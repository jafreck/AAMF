import { AgentInvocation, AgentResult } from '../agents/types.js';
import { Logger } from '../logging/logger.js';

/** Configuration options for retry behaviour. */
export interface RetryOptions {
  /** Maximum number of attempts before considering the task failed. */
  maxAttempts: number;
  /** Called after each failed attempt (before the next retry). */
  onRetry?: (attempt: number, error: string) => Promise<void>;
  /**
   * Called when all retries are exhausted.
   * If it returns a new invocation, that invocation is tried as a recovery attempt.
   */
  onExhausted?: (taskId: string, lastError: string) => Promise<AgentInvocation | null>;
}

/** Function signature for launching an agent invocation and returning its result. */
export interface AgentLauncherFn {
  (invocation: AgentInvocation): Promise<AgentResult>;
}

/** Result of a retried execution, augmented with attempt metadata. */
export type RetryResult = AgentResult & {
  /** Total number of attempts made (including the initial attempt and any recovery). */
  attempts: number;
  /** Whether a failure-recovery escalation was attempted. */
  recoveryAttempted: boolean;
};

/**
 * Executes agent invocations with retry logic and optional failure-recovery escalation.
 *
 * When all retry attempts are exhausted, the executor can optionally invoke an
 * `onExhausted` callback to produce a recovery invocation. If recovery succeeds,
 * the original task is retried once more.
 */
export class RetryExecutor {
  constructor(private launcher: AgentLauncherFn, private logger: Logger) {}

  /** Execute with retries. Returns the result of the last attempt. */
  async executeWithRetry(invocation: AgentInvocation, options: RetryOptions): Promise<RetryResult> {
    let lastResult: AgentResult | null = null;
    let recoveryAttempted = false;

    for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
      this.logger.info(`Attempt ${attempt}/${options.maxAttempts} for ${invocation.agent}${invocation.taskId ? ` (${invocation.taskId})` : ''}`);

      lastResult = await this.launcher(invocation);

      if (lastResult.success) {
        return { ...lastResult, attempts: attempt, recoveryAttempted };
      }

      this.logger.warn(`Attempt ${attempt} failed: ${lastResult.error ?? 'unknown error'}`);

      if (attempt < options.maxAttempts && options.onRetry) {
        await options.onRetry(attempt, lastResult.error ?? 'unknown error');
      }
    }

    // All retries exhausted — try recovery if configured
    if (options.onExhausted && invocation.taskId) {
      const recoveryInvocation = await options.onExhausted(invocation.taskId, lastResult?.error ?? 'unknown');
      if (recoveryInvocation) {
        this.logger.info(`Attempting failure-recovery for ${invocation.taskId}`);
        recoveryAttempted = true;
        const recoveryResult = await this.launcher(recoveryInvocation);
        if (recoveryResult.success) {
          // After recovery, retry the original once more
          this.logger.info(`Recovery succeeded, retrying original task ${invocation.taskId}`);
          const retryResult = await this.launcher(invocation);
          return { ...retryResult, attempts: options.maxAttempts + 1, recoveryAttempted: true };
        }
        return { ...recoveryResult, attempts: options.maxAttempts + 1, recoveryAttempted: true };
      }
    }

    return { ...lastResult!, attempts: options.maxAttempts, recoveryAttempted };
  }
}
