import { AgentInvocation, AgentResult } from '../agents/types.js';
import { Logger } from '../logging/logger.js';
import { createHash } from 'node:crypto';

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
  /** Whether this successful result came from a retry (i.e. not the first attempt). */
  wasRetry: boolean;
  /** Signature hash for the most recent failed attempt. */
  failureSignature?: string;
  /** Count of each failure signature observed across attempts. */
  repeatedFailureSignatures?: Record<string, number>;
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
  private static readonly SIGNATURE_SNIPPET_LENGTH = 400;

  /** Heuristic classification for transient infrastructure/model transport failures. */
  private isInfrastructureFailure(errorText: string): boolean {
    return /\b503\b|goaway|connection_error|service unavailable|network error|connection (refused|reset|timed out)|deadline exceeded|timed? ?out/i
      .test(errorText);
  }

  /**
   * Calculate backoff delay with exponential increase and jitter.
   * delay = min(initialDelay * 2^(attempt-1) + random jitter, maxDelay)
   */
  private calculateBackoff(
    attempt: number,
    initialDelayMs: number,
    maxDelayMs: number,
    isInfrastructureFailure: boolean,
  ): number {
    if (isInfrastructureFailure) {
      // For transient infra/model transport failures, retry quickly.
      // Keep waits short to avoid long stalls between attempts.
      const exponential = 250 * Math.pow(2, attempt - 1);
      const jitter = Math.random() * 100;
      return Math.min(exponential + jitter, 2_000);
    }

    const exponential = initialDelayMs * Math.pow(2, attempt - 1);
    const jitter = Math.random() * initialDelayMs * 0.5;
    return Math.min(exponential + jitter, maxDelayMs);
  }

  /** Sleep for a given number of milliseconds. */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private normalizeSnippet(text?: string): string {
    if (!text) return '';
    return text.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, RetryExecutor.SIGNATURE_SNIPPET_LENGTH);
  }

  private buildFailureSignature(invocation: AgentInvocation, result: AgentResult): string {
    const commandContext = this.normalizeSnippet(invocation.additionalArgs?.command)
      || this.normalizeSnippet(invocation.additionalArgs?.prompt)
      || `${invocation.agent}:${invocation.phase ?? 'n/a'}:${invocation.taskId ?? 'n/a'}`;
    const stdoutSnippet = this.normalizeSnippet(
      typeof result.structuredOutput?.stdout === 'string'
        ? result.structuredOutput.stdout
        : undefined,
    );
    const stderrSnippet = this.normalizeSnippet(result.stderr);
    const errorSnippet = this.normalizeSnippet(result.error);
    const payload = JSON.stringify({
      commandContext,
      stdoutSnippet,
      stderrSnippet,
      errorSnippet,
    });
    return createHash('sha256').update(payload).digest('hex');
  }

  /** Execute with retries and exponential backoff. Returns the result of the last attempt. */
  async executeWithRetry(invocation: AgentInvocation, options: RetryOptions): Promise<RetryResult> {
    const initialDelayMs = options.initialDelayMs ?? 1_000;
    const maxDelayMs = options.maxDelayMs ?? 30_000;
    let lastResult: AgentResult | null = null;
    let recoveryAttempted = false;
    const failureSignatures = new Map<string, number>();
    let lastFailureSignature: string | undefined;

    for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
      this.logger.info(`Attempt ${attempt}/${options.maxAttempts} for ${invocation.agent}${invocation.taskId ? ` (${invocation.taskId})` : ''}`);

      const attemptInv = { ...invocation, attemptNumber: attempt, maxAttempts: options.maxAttempts };
      lastResult = await this.launcher(attemptInv);

      if (lastResult.success) {
        return { ...lastResult, attempts: attempt, recoveryAttempted, wasRetry: attempt > 1 };
      }

      this.logger.warn(`Attempt ${attempt} failed: ${lastResult.error ?? 'unknown error'}`);
      lastFailureSignature = this.buildFailureSignature(attemptInv, lastResult);
      failureSignatures.set(lastFailureSignature, (failureSignatures.get(lastFailureSignature) ?? 0) + 1);

      if (attempt < options.maxAttempts) {
        if (options.onRetry) {
          await options.onRetry(attempt, lastResult.error ?? 'unknown error');
        }

        const errorText = lastResult.error ?? 'unknown error';
        const isInfra = this.isInfrastructureFailure(errorText);
        const delay = this.calculateBackoff(attempt, initialDelayMs, maxDelayMs, isInfra);
        this.logger.info(
          `Backing off ${Math.round(delay)}ms before retry ${attempt + 1}` +
          (isInfra ? ' (infra-fast-retry)' : ''),
        );
        await this.sleep(delay);
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
          const retryResult = await this.launcher({ ...invocation, attemptNumber: options.maxAttempts + 1, maxAttempts: options.maxAttempts + 1 });
          return {
            ...retryResult,
            attempts: options.maxAttempts + 1,
            recoveryAttempted: true,
            wasRetry: true,
            failureSignature: lastFailureSignature,
            repeatedFailureSignatures: Object.fromEntries(failureSignatures),
          };
        }
        return {
          ...recoveryResult,
          attempts: options.maxAttempts + 1,
          recoveryAttempted: true,
          wasRetry: true,
          failureSignature: lastFailureSignature,
          repeatedFailureSignatures: Object.fromEntries(failureSignatures),
        };
      }
    }

    return {
      ...lastResult!,
      attempts: options.maxAttempts,
      recoveryAttempted,
      wasRetry: options.maxAttempts > 1,
      failureSignature: lastFailureSignature,
      repeatedFailureSignatures: Object.fromEntries(failureSignatures),
    };
  }
}
