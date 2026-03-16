import { AgentInvocation, AgentResult, AgentLauncherFn } from '../agents/types.js';

/** Minimal logger interface. */
export interface LoggerLike {
  warn(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

/** Configuration options for retry behaviour. */
export interface RetryOptions {
  /** Maximum number of attempts before considering the task failed. */
  maxAttempts: number;
  /** Initial backoff delay in milliseconds (default: 1000). */
  initialDelayMs?: number;
  /** Maximum backoff delay in milliseconds (default: 30000). */
  maxDelayMs?: number;
  /** Called after each failed attempt (before the next retry). */
  onRetry?: (attempt: number, error: string) => Promise<void>;
  /**
   * Called when all retries are exhausted.
   * If it returns a new invocation, that invocation is tried as a recovery attempt.
   */
  onExhausted?: (taskId: string, lastError: string) => Promise<AgentInvocation | null>;
}

/** Result of a retried execution, augmented with attempt metadata. */
export type RetryResult = AgentResult & {
  /** Total number of attempts made (including the initial attempt and any recovery). */
  attempts: number;
  /** Whether a parity-failure-resolver escalation was attempted. */
  recoveryAttempted: boolean;
  /** Whether this successful result came from a retry (i.e. not the first attempt). */
  wasRetry: boolean;
};

/** Heuristic classification for transient infrastructure/model transport failures. */
function isInfrastructureFailure(errorText: string): boolean {
  return /\b503\b|goaway|connection_error|service unavailable|network error|connection (refused|reset|timed out)|deadline exceeded|timed? ?out/i
    .test(errorText);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Compute delay for next retry attempt.
 * Infrastructure failures use a fast profile (250ms–2s).
 * Logical failures use standard exponential backoff.
 */
function computeDelay(
  attempt: number,
  errorText: string,
  baseDelayMs: number,
  maxDelayMs: number,
): number {
  if (isInfrastructureFailure(errorText)) {
    const exponential = 250 * Math.pow(2, attempt - 1);
    const jitter = Math.random() * 100;
    return Math.min(exponential + jitter, 2_000);
  }
  const exponential = baseDelayMs * Math.pow(2, attempt - 1);
  const jitter = Math.random() * baseDelayMs * 0.5;
  return Math.min(exponential + jitter, maxDelayMs);
}

/**
 * Executes agent invocations with retry logic and optional recovery escalation.
 *
 * Uses error-adaptive backoff: infrastructure failures get fast retry (250ms–2s),
 * logical failures get standard exponential backoff. When retries are exhausted,
 * an optional recovery agent can be invoked; if it succeeds, the original task
 * is retried once more.
 */
export class RetryExecutor {
  constructor(private launcher: AgentLauncherFn, private logger: LoggerLike) {}

  /** Execute with retries and exponential backoff. Returns the result of the last attempt. */
  async executeWithRetry(invocation: AgentInvocation, options: RetryOptions): Promise<RetryResult> {
    let lastResult: AgentResult | null = null;
    let recoveryAttempted = false;
    const taskId = invocation.workItemId || undefined;
    const label = `${invocation.agent}${taskId ? ` (${taskId})` : ''}`;
    const baseDelayMs = options.initialDelayMs ?? 1_000;
    const maxDelayMs = options.maxDelayMs ?? 30_000;

    let totalAttempts = 0;

    for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
      totalAttempts = attempt;
      this.logger.info(`Attempt ${attempt}/${options.maxAttempts} for ${label}`);

      const attemptInv: AgentInvocation = {
        ...invocation,
        extensions: {
          ...invocation.extensions,
          attemptNumber: attempt,
          maxAttempts: options.maxAttempts,
        },
      };

      const result = await this.launcher(attemptInv);
      lastResult = result;

      if (result.success) {
        return {
          ...result,
          attempts: totalAttempts,
          recoveryAttempted,
          wasRetry: totalAttempts > 1,
        };
      }

      const errorText = result.error ?? 'unknown error';

      // Notify caller of retry (e.g. for checkpoint writes)
      if (attempt < options.maxAttempts && options.onRetry) {
        await options.onRetry(attempt, errorText);
      }

      // Wait before next attempt (skip delay after last attempt)
      if (attempt < options.maxAttempts) {
        const delay = computeDelay(attempt, errorText, baseDelayMs, maxDelayMs);
        await sleep(delay);
      }
    }

    // All retries exhausted — attempt recovery escalation
    if (options.onExhausted && taskId) {
      const errorStr = lastResult?.error ?? 'unknown';
      const recoveryInvocation = await options.onExhausted(taskId, errorStr);

      if (recoveryInvocation) {
        this.logger.info(`Attempting parity-failure-resolver for ${taskId}`);
        recoveryAttempted = true;
        const recoveryResult = await this.launcher(recoveryInvocation);

        if (recoveryResult.success) {
          // Recovery succeeded — retry original once more
          this.logger.info(`Recovery succeeded, retrying original task ${taskId}`);
          totalAttempts++;
          const retryResult = await this.launcher({
            ...invocation,
            extensions: {
              ...invocation.extensions,
              attemptNumber: totalAttempts,
              maxAttempts: options.maxAttempts,
            },
          });
          lastResult = retryResult;

          return {
            ...retryResult,
            attempts: totalAttempts,
            recoveryAttempted: true,
            wasRetry: true,
          };
        }

        lastResult = recoveryResult;
      }
    }

    return {
      ...(lastResult ?? {
        agent: invocation.agent,
        workItemId: invocation.workItemId,
        exitCode: 1,
        success: false,
        timedOut: false,
        duration: 0,
        stdout: '',
        stderr: '',
        tokenUsage: null,
        outputPath: invocation.outputPath,
        outputExists: false,
        error: 'all retries exhausted',
        extensions: {},
      }),
      attempts: totalAttempts,
      recoveryAttempted,
      wasRetry: totalAttempts > 1,
    } as RetryResult;
  }
}
