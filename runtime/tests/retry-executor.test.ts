import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { RetryExecutor, RetryOptions } from '../src/execution/retry.js';
import { AgentInvocation, AgentResult } from '../src/agents/types.js';
import {
  createMockLauncher,
  createFailingLauncher,
  createSilentLogger,
} from './helpers/mocks.js';

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
      contextFile: '/tmp/context.json',
      progressDir: '/tmp/progress',
      phase: 5,
      taskId: 'task-001',
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
            taskId: inv.taskId,
            exitCode: 1,
            success: false,
            outputFiles: [],
            duration: 100,
            error: `Attempt ${attempt} failed`,
          };
        }
        return {
          agent: inv.agent,
          taskId: inv.taskId,
          exitCode: 0,
          success: true,
          outputFiles: [],
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

      // Mock sleep to avoid actual waiting, but capture delay values
      const sleepSpy = vi.spyOn(executor as any, 'sleep').mockResolvedValue(undefined);

      await executor.executeWithRetry(makeInvocation(), {
        maxAttempts: 5,
        initialDelayMs: 1000,
        maxDelayMs: 2000,
      });

      // All sleep calls should be at most maxDelayMs
      for (const call of sleepSpy.mock.calls) {
        expect(call[0]).toBeLessThanOrEqual(2000);
      }
      // Should have had at least 1 sleep call
      expect(sleepSpy.mock.calls.length).toBeGreaterThan(0);
    });

    it('should use fast backoff profile for infrastructure failures', async () => {
      const launcher = createFailingLauncher(
        ['code-migrator'],
        'Execution failed: CAPIError: 503 {"error":{"message":"HTTP/2 GOAWAY connection terminated","type":"connection_error"}}',
      );
      const logger = createSilentLogger(tempDir);
      const executor = new RetryExecutor(launcher, logger);

      const sleepSpy = vi.spyOn(executor as any, 'sleep').mockResolvedValue(undefined);

      await executor.executeWithRetry(makeInvocation(), {
        maxAttempts: 4,
        initialDelayMs: 10_000,
        maxDelayMs: 30_000,
      });

      for (const call of sleepSpy.mock.calls) {
        expect(call[0]).toBeLessThanOrEqual(2_000);
      }
      expect(sleepSpy.mock.calls.length).toBeGreaterThan(0);
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
        contextFile: '/tmp/recovery-ctx.json',
        progressDir: '/tmp/progress',
        phase: 5,
        taskId: 'task-001',
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
            taskId: inv.taskId,
            exitCode: 0,
            success: true,
            outputFiles: [],
            duration: 100,
          };
        }
        // code-migrator: fail first 2 (retries), succeed on the post-recovery attempt
        if (callCount <= 2) {
          return {
            agent: inv.agent,
            taskId: inv.taskId,
            exitCode: 1,
            success: false,
            outputFiles: [],
            duration: 100,
            error: 'Failed',
          };
        }
        return {
          agent: inv.agent,
          taskId: inv.taskId,
          exitCode: 0,
          success: true,
          outputFiles: [],
          duration: 100,
        };
      };

      const logger = createSilentLogger(tempDir);
      const executor = new RetryExecutor(launcher, logger);

      const recoveryInvocation: AgentInvocation = {
        agent: 'parity-failure-resolver',
        contextFile: '/tmp/recovery-ctx.json',
        progressDir: '/tmp/progress',
        phase: 5,
        taskId: 'task-001',
      };

      const result = await executor.executeWithRetry(makeInvocation(), {
        maxAttempts: 2,
        initialDelayMs: 0,
        onExhausted: async () => recoveryInvocation,
      });

      expect(result.attempts).toBe(3); // maxAttempts + 1
      expect(result.recoveryAttempted).toBe(true);
      expect(result.success).toBe(true);
    });

    it('should return failure when recovery also fails', async () => {
      // Both code-migrator and parity-failure-resolver always fail
      const launcher = async (inv: AgentInvocation): Promise<AgentResult> => ({
        agent: inv.agent,
        taskId: inv.taskId,
        exitCode: 1,
        success: false,
        outputFiles: [],
        duration: 100,
        error: 'Failed',
      });

      const logger = createSilentLogger(tempDir);
      const executor = new RetryExecutor(launcher, logger);

      const recoveryInvocation: AgentInvocation = {
        agent: 'parity-failure-resolver',
        contextFile: '/tmp/recovery.json',
        progressDir: '/tmp/progress',
        phase: 5,
        taskId: 'task-001',
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

    it('should skip recovery when invocation has no taskId', async () => {
      const launcher = createFailingLauncher(['code-migrator']);
      const logger = createSilentLogger(tempDir);
      const executor = new RetryExecutor(launcher, logger);

      const onExhausted = vi.fn();

      const result = await executor.executeWithRetry(
        makeInvocation({ taskId: undefined }),
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
            taskId: inv.taskId,
            exitCode: 1,
            success: false,
            outputFiles: [],
            duration: 100,
            error: 'Failed',
          };
        }
        return {
          agent: inv.agent,
          taskId: inv.taskId,
          exitCode: 0,
          success: true,
          outputFiles: [],
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
        taskId: inv.taskId,
        exitCode: inv.agent === 'parity-failure-resolver' ? 0 : 1,
        success: inv.agent === 'parity-failure-resolver',
        outputFiles: [],
        duration: 100,
        error: inv.agent === 'parity-failure-resolver' ? undefined : 'Failed',
      });

      const logger = createSilentLogger(tempDir);
      const executor = new RetryExecutor(launcher, logger);

      const recoveryInvocation: AgentInvocation = {
        agent: 'parity-failure-resolver',
        contextFile: '/tmp/recovery.json',
        progressDir: '/tmp/progress',
        phase: 5,
        taskId: 'task-001',
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
