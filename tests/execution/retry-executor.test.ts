import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { RetryExecutor, RetryOptions } from '../../src/execution/retry.js';
import { AgentInvocation, AgentResult } from '../../src/agents/types.js';
import {
  createMockLauncher,
  createFailingLauncher,
  createSilentLogger,
} from '../helpers/mocks.js';

describe('RetryExecutor', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'aamf-retry-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function makeInvocation(overrides?: Partial<AgentInvocation>): AgentInvocation {
    return {
      agent: 'code-migrator',
      contextPath: '/tmp/context.json',
      outputPath: '',
      phase: 5,
      workItemId: 'task-001',
      ...overrides,
    };
  }

  // ─── Basic Retry ───────────────────────────────────────────────────

  describe('Basic Retry', () => {
    it('should return immediately on first success', async () => {
      const launcher = createMockLauncher();
      const logger = createSilentLogger(tempDir);
      const executor = new RetryExecutor(launcher, logger);

      const result = await executor.executeWithRetry(makeInvocation(), {
        maxAttempts: 3,
        initialDelayMs: 0,
      });

      expect(result.success).toBe(true);
      expect(result.attempts).toBe(1);
      expect(result.recoveryAttempted).toBe(false);
    });

    it('should retry up to maxAttempts times', async () => {
      let attempt = 0;
      const launcher = async (inv: AgentInvocation): Promise<AgentResult> => {
        attempt++;
        if (attempt < 3) {
          return {
            agent: inv.agent,
            workItemId: inv.workItemId,
            exitCode: 1,
            success: false,
            duration: 100,
            error: `Attempt ${attempt} failed`,
          };
        }
        return {
          agent: inv.agent,
          workItemId: inv.workItemId,
          exitCode: 0,
          success: true,
          duration: 100,
        };
      };

      const logger = createSilentLogger(tempDir);
      const executor = new RetryExecutor(launcher, logger);

      const result = await executor.executeWithRetry(makeInvocation(), {
        maxAttempts: 3,
        initialDelayMs: 0,
      });

      expect(result.attempts).toBe(3);
      expect(result.success).toBe(true);
    });

    it('should fail after exhausting all retries', async () => {
      const launcher = createFailingLauncher(['code-migrator'], 'Always fails');
      const logger = createSilentLogger(tempDir);
      const executor = new RetryExecutor(launcher, logger);

      const result = await executor.executeWithRetry(makeInvocation(), {
        maxAttempts: 3,
        initialDelayMs: 0,
      });

      expect(result.attempts).toBe(3);
      expect(result.success).toBe(false);
    });
  });

  // ─── Backoff ───────────────────────────────────────────────────────

  describe('Backoff', () => {
    it('should wait between retry attempts', async () => {
      const launcher = createFailingLauncher(['code-migrator']);
      const logger = createSilentLogger(tempDir);
      const executor = new RetryExecutor(launcher, logger);

      const startTime = Date.now();
      await executor.executeWithRetry(makeInvocation(), {
        maxAttempts: 3,
        initialDelayMs: 50,
        maxDelayMs: 500,
      });
      const elapsed = Date.now() - startTime;

      // Should have waited at least 50ms + ~100ms (exponential with jitter)
      expect(elapsed).toBeGreaterThanOrEqual(40);
    });

    it('should respect maxDelayMs cap', async () => {
      const launcher = createFailingLauncher(['code-migrator']);
      const logger = createSilentLogger(tempDir);
      const executor = new RetryExecutor(launcher, logger);

      // With initialDelay=50 and maxDelay=200, 4 retries should complete
      // within a reasonable time bound.
      const startTime = Date.now();
      await executor.executeWithRetry(makeInvocation(), {
        maxAttempts: 5,
        initialDelayMs: 50,
        maxDelayMs: 200,
      });
      const elapsed = Date.now() - startTime;

      expect(elapsed).toBeGreaterThanOrEqual(20);
      expect(elapsed).toBeLessThan(3_000);
    });

    it('should use fast backoff profile for infrastructure failures', async () => {
      let launchCount = 0;
      const launcher = async (inv: AgentInvocation): Promise<AgentResult> => {
        launchCount++;
        // Succeed on 3rd call to verify fast-retry happens
        if (launchCount >= 3) {
          return {
            agent: inv.agent, workItemId: inv.workItemId,
            exitCode: 0, success: true, outputFiles: [], duration: 100, extensions: { outputParsed: false },
          };
        }
        return {
          agent: inv.agent, workItemId: inv.workItemId,
          exitCode: 1, success: false, outputFiles: [], duration: 100, extensions: { outputParsed: false },
          error: 'Execution failed: CAPIError: 503 {"error":{"message":"HTTP/2 GOAWAY connection terminated","type":"connection_error"}}',
        };
      };

      const logger = createSilentLogger(tempDir);
      const executor = new RetryExecutor(launcher, logger);

      const startTime = Date.now();
      const result = await executor.executeWithRetry(makeInvocation(), {
        maxAttempts: 4,
        initialDelayMs: 5_000,  // outer delay is large
        maxDelayMs: 30_000,
      });
      const elapsed = Date.now() - startTime;

      // Infra fast-retry should resolve within ~750ms (250+500),
      // well under the 5s outer backoff.
      expect(result.success).toBe(true);
      expect(elapsed).toBeLessThan(3_000);
    });
  });

  // ─── Callbacks ─────────────────────────────────────────────────────

  describe('Callbacks', () => {
    it('should call onRetry after each failed attempt', async () => {
      const launcher = createFailingLauncher(['code-migrator']);
      const logger = createSilentLogger(tempDir);
      const executor = new RetryExecutor(launcher, logger);

      const onRetry = vi.fn();

      await executor.executeWithRetry(makeInvocation(), {
        maxAttempts: 3,
        initialDelayMs: 0,
        onRetry,
      });

      // onRetry called after attempt 1 and attempt 2, but not after the final attempt 3
      expect(onRetry).toHaveBeenCalledTimes(2);
      expect(onRetry).toHaveBeenCalledWith(1, expect.any(String));
      expect(onRetry).toHaveBeenCalledWith(2, expect.any(String));
    });

    it('should NOT call onRetry after the final attempt', async () => {
      const launcher = createFailingLauncher(['code-migrator']);
      const logger = createSilentLogger(tempDir);
      const executor = new RetryExecutor(launcher, logger);

      const onRetry = vi.fn();

      await executor.executeWithRetry(makeInvocation(), {
        maxAttempts: 2,
        initialDelayMs: 0,
        onRetry,
      });

      // Called only after attempt 1, not after attempt 2
      expect(onRetry).toHaveBeenCalledTimes(1);
      expect(onRetry).toHaveBeenCalledWith(1, expect.any(String));
    });
  });

  // ─── Recovery Escalation ───────────────────────────────────────────

  describe('Recovery Escalation', () => {
    it('should call onExhausted when retries are exhausted', async () => {
      const launcher = createFailingLauncher(['code-migrator']);
      const logger = createSilentLogger(tempDir);
      const executor = new RetryExecutor(launcher, logger);

      const recoveryInvocation: AgentInvocation = {
        agent: 'parity-failure-resolver',
        contextPath: '/tmp/recovery-ctx.json',
        outputPath: '',
        phase: 5,
        workItemId: 'task-001',
      };

      const onExhausted = vi.fn().mockResolvedValue(recoveryInvocation);

      await executor.executeWithRetry(makeInvocation(), {
        maxAttempts: 2,
        initialDelayMs: 0,
        onExhausted,
      });

      expect(onExhausted).toHaveBeenCalledWith('task-001', expect.any(String));
    });

    it('should retry original after successful recovery', async () => {
      let callCount = 0;
      const launcher = async (inv: AgentInvocation): Promise<AgentResult> => {
        callCount++;
        // Original attempts 1-2 fail, recovery succeeds, then original retry succeeds
        if (inv.agent === 'parity-failure-resolver') {
          return {
            agent: inv.agent,
            workItemId: inv.workItemId,
            exitCode: 0,
            success: true,
            duration: 100,
          };
        }
        // code-migrator: fail first 2 (retries), succeed on the post-recovery attempt
        if (callCount <= 2) {
          return {
            agent: inv.agent,
            workItemId: inv.workItemId,
            exitCode: 1,
            success: false,
            duration: 100,
            error: 'Failed',
          };
        }
        return {
          agent: inv.agent,
          workItemId: inv.workItemId,
          exitCode: 0,
          success: true,
          duration: 100,
        };
      };

      const logger = createSilentLogger(tempDir);
      const executor = new RetryExecutor(launcher, logger);

      const recoveryInvocation: AgentInvocation = {
        agent: 'parity-failure-resolver',
        contextPath: '/tmp/recovery-ctx.json',
        outputPath: '',
        phase: 5,
        workItemId: 'task-001',
      };

      const result = await executor.executeWithRetry(makeInvocation(), {
        maxAttempts: 2,
        initialDelayMs: 0,
        onExhausted: async () => recoveryInvocation,
      });

      expect(result.recoveryAttempted).toBe(true);
      expect(result.success).toBe(true);
    });

    it('should return failure when recovery also fails', async () => {
      // Both code-migrator and parity-failure-resolver always fail
      const launcher = async (inv: AgentInvocation): Promise<AgentResult> => ({
        agent: inv.agent,
        workItemId: inv.workItemId,
        exitCode: 1,
        success: false,
        duration: 100,
        error: 'Failed',
      });

      const logger = createSilentLogger(tempDir);
      const executor = new RetryExecutor(launcher, logger);

      const recoveryInvocation: AgentInvocation = {
        agent: 'parity-failure-resolver',
        contextPath: '/tmp/recovery.json',
        outputPath: '',
        phase: 5,
        workItemId: 'task-001',
      };

      const result = await executor.executeWithRetry(makeInvocation(), {
        maxAttempts: 2,
        initialDelayMs: 0,
        onExhausted: async () => recoveryInvocation,
      });

      expect(result.success).toBe(false);
      expect(result.recoveryAttempted).toBe(true);
    });

    it('should skip recovery when onExhausted returns null', async () => {
      const launcher = createFailingLauncher(['code-migrator']);
      const logger = createSilentLogger(tempDir);
      const executor = new RetryExecutor(launcher, logger);

      const onExhausted = vi.fn().mockResolvedValue(null);

      const result = await executor.executeWithRetry(makeInvocation(), {
        maxAttempts: 2,
        initialDelayMs: 0,
        onExhausted,
      });

      expect(result.success).toBe(false);
      expect(result.recoveryAttempted).toBe(false);
      expect(onExhausted).toHaveBeenCalled();
    });

    it('should skip recovery when invocation has no workItemId', async () => {
      const launcher = createFailingLauncher(['code-migrator']);
      const logger = createSilentLogger(tempDir);
      const executor = new RetryExecutor(launcher, logger);

      const onExhausted = vi.fn();

      const result = await executor.executeWithRetry(
        makeInvocation({ workItemId: '' }),
        {
          maxAttempts: 2,
          initialDelayMs: 0,
          onExhausted,
        },
      );

      expect(result.success).toBe(false);
      expect(onExhausted).not.toHaveBeenCalled();
    });
  });

  // ─── wasRetry Field ─────────────────────────────────────────────────

  describe('wasRetry', () => {
    it('should set wasRetry to false on first-attempt success', async () => {
      const launcher = createMockLauncher();
      const logger = createSilentLogger(tempDir);
      const executor = new RetryExecutor(launcher, logger);

      const result = await executor.executeWithRetry(makeInvocation(), {
        maxAttempts: 3,
        initialDelayMs: 0,
      });

      expect(result.success).toBe(true);
      expect(result.attempts).toBe(1);
      expect(result.wasRetry).toBe(false);
    });

    it('should set wasRetry to true when success comes on a retry attempt', async () => {
      let attempt = 0;
      const launcher = async (inv: AgentInvocation): Promise<AgentResult> => {
        attempt++;
        if (attempt < 2) {
          return {
            agent: inv.agent,
            workItemId: inv.workItemId,
            exitCode: 1,
            success: false,
            duration: 100,
            error: 'Failed',
          };
        }
        return {
          agent: inv.agent,
          workItemId: inv.workItemId,
          exitCode: 0,
          success: true,
          duration: 100,
        };
      };

      const logger = createSilentLogger(tempDir);
      const executor = new RetryExecutor(launcher, logger);

      const result = await executor.executeWithRetry(makeInvocation(), {
        maxAttempts: 3,
        initialDelayMs: 0,
      });

      expect(result.success).toBe(true);
      expect(result.attempts).toBe(2);
      expect(result.wasRetry).toBe(true);
    });

    it('should set wasRetry to true when all retries exhausted with maxAttempts > 1', async () => {
      const launcher = createFailingLauncher(['code-migrator']);
      const logger = createSilentLogger(tempDir);
      const executor = new RetryExecutor(launcher, logger);

      const result = await executor.executeWithRetry(makeInvocation(), {
        maxAttempts: 3,
        initialDelayMs: 0,
      });

      expect(result.success).toBe(false);
      expect(result.wasRetry).toBe(true);
    });

    it('should set wasRetry to false when all retries exhausted with maxAttempts = 1', async () => {
      const launcher = createFailingLauncher(['code-migrator']);
      const logger = createSilentLogger(tempDir);
      const executor = new RetryExecutor(launcher, logger);

      const result = await executor.executeWithRetry(makeInvocation(), {
        maxAttempts: 1,
        initialDelayMs: 0,
      });

      expect(result.success).toBe(false);
      expect(result.wasRetry).toBe(false);
    });

    it('should set wasRetry to true on recovery path', async () => {
      const launcher = async (inv: AgentInvocation): Promise<AgentResult> => ({
        agent: inv.agent,
        workItemId: inv.workItemId,
        exitCode: inv.agent === 'parity-failure-resolver' ? 0 : 1,
        success: inv.agent === 'parity-failure-resolver',
        duration: 100,
        error: inv.agent === 'parity-failure-resolver' ? undefined : 'Failed',
      });

      const logger = createSilentLogger(tempDir);
      const executor = new RetryExecutor(launcher, logger);

      const recoveryInvocation: AgentInvocation = {
        agent: 'parity-failure-resolver',
        contextPath: '/tmp/recovery.json',
        outputPath: '',
        phase: 5,
        workItemId: 'task-001',
      };

      const result = await executor.executeWithRetry(makeInvocation(), {
        maxAttempts: 2,
        initialDelayMs: 0,
        onExhausted: async () => recoveryInvocation,
      });

      expect(result.recoveryAttempted).toBe(true);
      expect(result.wasRetry).toBe(true);
    });
  });
});
