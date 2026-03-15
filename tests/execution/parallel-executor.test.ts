import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { ParallelExecutor } from '../../src/execution/parallel-executor.js';
import { AgentInvocation, AgentResult } from '../../src/agents/types.js';
import { createMockLauncher, createSilentLogger, createMockConfig } from '../helpers/mocks.js';

describe('ParallelExecutor', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'aamf-parallel-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function makeInvocation(id: string): AgentInvocation {
    return {
      agent: 'code-migrator',
      contextPath: `/tmp/context-${id}.json`,
      outputPath: '',
      phase: 4,
      workItemId: id,
    };
  }

  it('should execute all invocations and return results in order', async () => {
    const launcher = createMockLauncher();
    const logger = createSilentLogger(tempDir);
    const executor = new ParallelExecutor(3, launcher, logger);

    const invocations = [makeInvocation('a'), makeInvocation('b'), makeInvocation('c')];
    const results = await executor.executeAll(invocations);

    expect(results).toHaveLength(3);
    expect(results[0]!.workItemId).toBe('a');
    expect(results[1]!.workItemId).toBe('b');
    expect(results[2]!.workItemId).toBe('c');
    for (const r of results) {
      expect(r.success).toBe(true);
    }
  });

  it('should respect concurrency limit', async () => {
    let maxConcurrent = 0;
    let currentConcurrent = 0;

    const launcher = async (inv: AgentInvocation): Promise<AgentResult> => {
      currentConcurrent++;
      if (currentConcurrent > maxConcurrent) maxConcurrent = currentConcurrent;
      // Simulate work
      await new Promise((r) => setTimeout(r, 50));
      currentConcurrent--;
      return {
        agent: inv.agent,
        workItemId: inv.workItemId,
        exitCode: 0,
        success: true,
        duration: 50,
      };
    };

    const logger = createSilentLogger(tempDir);

    // With concurrency=1, max concurrent should be 1
    const executor1 = new ParallelExecutor(1, launcher, logger);
    maxConcurrent = 0;
    await executor1.executeAll([makeInvocation('a'), makeInvocation('b'), makeInvocation('c')]);
    expect(maxConcurrent).toBe(1);

    // With concurrency=2, max concurrent should be ≤ 2
    const executor2 = new ParallelExecutor(2, launcher, logger);
    maxConcurrent = 0;
    await executor2.executeAll([makeInvocation('a'), makeInvocation('b'), makeInvocation('c')]);
    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });

  it('should handle mixed success/failure', async () => {
    const launcher = createMockLauncher((inv) => {
      if (inv.workItemId === 'b') {
        return { exitCode: 1, success: false, error: 'Task b failed' };
      }
      return {};
    });
    const logger = createSilentLogger(tempDir);
    const executor = new ParallelExecutor(3, launcher, logger);

    const invocations = [makeInvocation('a'), makeInvocation('b'), makeInvocation('c')];
    const results = await executor.executeAll(invocations);

    expect(results).toHaveLength(3);
    expect(results[0]!.success).toBe(true);
    expect(results[1]!.success).toBe(false);
    expect(results[1]!.error).toBe('Task b failed');
    expect(results[2]!.success).toBe(true);
  });

  it('should catch exceptions from launcher and return error result', async () => {
    const launcher = async (inv: AgentInvocation): Promise<AgentResult> => {
      if (inv.workItemId === 'b') {
        throw new Error('Launcher crashed');
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
    const executor = new ParallelExecutor(3, launcher, logger);

    const invocations = [makeInvocation('a'), makeInvocation('b'), makeInvocation('c')];
    const results = await executor.executeAll(invocations);

    expect(results).toHaveLength(3);
    expect(results[0]!.success).toBe(true);
    expect(results[1]!.success).toBe(false);
    expect(results[1]!.error).toContain('Launcher crashed');
    expect(results[2]!.success).toBe(true);
  });

  it('should handle empty invocation list', async () => {
    const launcher = createMockLauncher();
    const logger = createSilentLogger(tempDir);
    const executor = new ParallelExecutor(3, launcher, logger);

    const results = await executor.executeAll([]);

    expect(results).toEqual([]);
  });

  // ─── Result Independence ─────────────────────────────────────────────

  describe('Result Independence', () => {
    it('should produce independent results for each invocation (no shared state)', async () => {
      // Verify that each invocation produces its own isolated result regardless of concurrency
      const launcher = async (inv: AgentInvocation): Promise<AgentResult> => ({
        agent: inv.agent,
        workItemId: inv.workItemId,
        exitCode: 0,
        success: true,
        timedOut: false,
        duration: 10,
        stdout: '',
        stderr: '',
        tokenUsage: null,
        outputPath: inv.outputPath,
        outputExists: false,
        extensions: { outputParsed: false, outputFiles: [`/output/${inv.workItemId}.ts`] },
      });

      const logger = createSilentLogger(tempDir);
      const executor = new ParallelExecutor(3, launcher, logger);
      const invocations = ['a', 'b', 'c'].map(makeInvocation);
      const results = await executor.executeAll(invocations);

      // Each result's extensions.outputFiles should reflect only that invocation's data
      expect(results[0]!.extensions.outputFiles).toEqual(['/output/a.ts']);
      expect(results[1]!.extensions.outputFiles).toEqual(['/output/b.ts']);
      expect(results[2]!.extensions.outputFiles).toEqual(['/output/c.ts']);
    });
  });

  // ─── Peak Concurrency ─────────────────────────────────────────────

  describe('peakConcurrency', () => {
    it('should start at 0 before executeAll is called', () => {
      const launcher = createMockLauncher();
      const logger = createSilentLogger(tempDir);
      const executor = new ParallelExecutor(3, launcher, logger);

      expect(executor.peakConcurrency).toBe(0);
    });

    it('should track peak concurrency during executeAll', async () => {
      const launcher = async (inv: AgentInvocation): Promise<AgentResult> => {
        await new Promise((r) => setTimeout(r, 50));
        return {
          agent: inv.agent,
          workItemId: inv.workItemId,
          exitCode: 0,
          success: true,
          duration: 50,
        };
      };

      const logger = createSilentLogger(tempDir);
      const executor = new ParallelExecutor(3, launcher, logger);
      await executor.executeAll([makeInvocation('a'), makeInvocation('b'), makeInvocation('c')]);

      expect(executor.peakConcurrency).toBeGreaterThan(0);
      expect(executor.peakConcurrency).toBeLessThanOrEqual(3);
    });

    it('should report peakConcurrency of 1 with concurrency limit of 1', async () => {
      const launcher = async (inv: AgentInvocation): Promise<AgentResult> => {
        await new Promise((r) => setTimeout(r, 10));
        return {
          agent: inv.agent,
          workItemId: inv.workItemId,
          exitCode: 0,
          success: true,
          duration: 10,
        };
      };

      const logger = createSilentLogger(tempDir);
      const executor = new ParallelExecutor(1, launcher, logger);
      await executor.executeAll([makeInvocation('a'), makeInvocation('b'), makeInvocation('c')]);

      expect(executor.peakConcurrency).toBe(1);
    });

    it('should remain 0 when executeAll is called with empty list', async () => {
      const launcher = createMockLauncher();
      const logger = createSilentLogger(tempDir);
      const executor = new ParallelExecutor(3, launcher, logger);

      await executor.executeAll([]);

      expect(executor.peakConcurrency).toBe(0);
    });

    it('should track peak concurrency even when invocations throw', async () => {
      const launcher = async (inv: AgentInvocation): Promise<AgentResult> => {
        if (inv.workItemId === 'b') throw new Error('crash');
        return {
          agent: inv.agent,
          workItemId: inv.workItemId,
          exitCode: 0,
          success: true,
          duration: 10,
        };
      };

      const logger = createSilentLogger(tempDir);
      const executor = new ParallelExecutor(3, launcher, logger);
      await executor.executeAll([makeInvocation('a'), makeInvocation('b'), makeInvocation('c')]);

      expect(executor.peakConcurrency).toBeGreaterThan(0);
    });
  });
});
