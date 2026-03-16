import { AgentInvocation, AgentResult, AgentLauncherFn } from '../agents/types.js';
import {
  RetryExecutor as FrameworkRetryExecutor,
  RETRY_ORIGINAL,
  type LoggerLike,
} from '@cadre-dev/framework/runtime';

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

/**
 * Signals that an agent invocation succeeded on the CLI level (exit 0) but the
 * result indicates logical failure (success: false). Used to bridge AAMF's
 * return-value-based failure signalling with the framework's exception-based retry.
 */
class AgentLogicalFailure extends Error {
  constructor(readonly result: AgentResult) {
    super(result.error ?? 'agent returned success=false');
  }
}

/** Heuristic classification for transient infrastructure/model transport failures. */
function isInfrastructureFailure(errorText: string): boolean {
  return /\b503\b|goaway|connection_error|service unavailable|network error|connection (refused|reset|timed out)|deadline exceeded|timed? ?out/i
    .test(errorText);
}

/**
 * Executes agent invocations with retry logic and optional recovery escalation.
 *
 * Delegates the retry loop to @cadre-dev/framework's RetryExecutor, using:
 *   - computeDelay for infrastructure fast-retry (250 ms–2 s) vs standard backoff
 *   - async onRetry for checkpoint writes between attempts
 *   - RETRY_ORIGINAL for recovery-then-retry-original pattern
 */
export class RetryExecutor {
  private readonly frameworkRetry: FrameworkRetryExecutor;

  constructor(private launcher: AgentLauncherFn, private logger: LoggerLike) {
    this.frameworkRetry = new FrameworkRetryExecutor(logger);
  }

  /** Execute with retries and exponential backoff. Returns the result of the last attempt. */
  async executeWithRetry(invocation: AgentInvocation, options: RetryOptions): Promise<RetryResult> {
    let lastResult: AgentResult | null = null;
    let recoveryAttempted = false;
    const taskId = invocation.workItemId || undefined;
    const label = `${invocation.agent}${taskId ? ` (${taskId})` : ''}`;

    const frameworkResult = await this.frameworkRetry.execute<AgentResult>({
      fn: async (attempt: number) => {
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
        if (!result.success) {
          throw new AgentLogicalFailure(result);
        }
        return result;
      },
      maxAttempts: options.maxAttempts,
      baseDelayMs: options.initialDelayMs ?? 1_000,
      maxDelayMs: options.maxDelayMs ?? 30_000,

      // Error-adaptive delay: fast profile for transient infra errors,
      // standard exponential backoff for logical failures.
      computeDelay: (attempt, error, defaults) => {
        const errorText = error instanceof AgentLogicalFailure
          ? error.result.error ?? '' : String(error);
        if (isInfrastructureFailure(errorText)) {
          const exponential = 250 * Math.pow(2, attempt - 1);
          const jitter = Math.random() * 100;
          return Math.min(exponential + jitter, 2_000);
        }
        const exponential = defaults.baseDelayMs * Math.pow(2, attempt - 1);
        const jitter = Math.random() * defaults.baseDelayMs * 0.5;
        return Math.min(exponential + jitter, defaults.maxDelayMs);
      },

      onRetry: options.onRetry
        ? async (attempt, err) => {
            const errorStr = err instanceof AgentLogicalFailure
              ? err.result.error ?? 'unknown error' : String(err);
            await options.onRetry!(attempt, errorStr);
          }
        : undefined,

      onExhausted: async (err: unknown) => {
        if (!options.onExhausted || !taskId) return null;
        const errorStr = err instanceof AgentLogicalFailure
          ? err.result.error ?? 'unknown' : String(err);
        const recoveryInvocation = await options.onExhausted(taskId, errorStr);
        if (!recoveryInvocation) return null;

        this.logger.info(`Attempting parity-failure-resolver for ${taskId}`);
        recoveryAttempted = true;
        const recoveryResult = await this.launcher(recoveryInvocation);
        if (recoveryResult.success) {
          this.logger.info(`Recovery succeeded, retrying original task ${taskId}`);
          return RETRY_ORIGINAL;
        }
        lastResult = recoveryResult;
        return null;
      },
      description: label,
    });

    if (frameworkResult.success && frameworkResult.result) {
      return {
        ...frameworkResult.result,
        attempts: frameworkResult.attempts,
        recoveryAttempted: frameworkResult.recoveryUsed || recoveryAttempted,
        wasRetry: frameworkResult.attempts > 1,
      };
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
        error: frameworkResult.error ?? 'all retries exhausted',
        extensions: {},
      }),
      attempts: frameworkResult.attempts,
      recoveryAttempted: frameworkResult.recoveryUsed || recoveryAttempted,
      wasRetry: frameworkResult.attempts > 1,
    } as RetryResult;
  }
}
