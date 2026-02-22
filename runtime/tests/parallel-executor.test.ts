import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { ParallelExecutor } from '../src/execution/parallel-executor.js';
import { AgentInvocation, AgentResult } from '../src/agents/types.js';
import { createMockLauncher, createSilentLogger } from './helpers/mocks.js';

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
      contextFile: `/tmp/context-${id}.json`,
      progressDir: '/tmp/progress',
      phase: 4,
      taskId: id,
    };
  }

  it('should execute all invocations and return results in order', async () => {
    const launcher = createMockLauncher();
    const logger = createSilentLogger(tempDir);
    const executor = new ParallelExecutor(3, launcher, logger);

    const invocations = [makeInvocation('a'), makeInvocation('b'), makeInvocation('c')];
    const results = await executor.executeAll(invocations);

    expect(results).toHaveLength(3);
    expect(results[0]!.taskId).toBe('a');
    expect(results[1]!.taskId).toBe('b');
    expect(results[2]!.taskId).toBe('c');
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
        taskId: inv.taskId,
        exitCode: 0,
        success: true,
        outputFiles: [],
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
      if (inv.taskId === 'b') {
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
      if (inv.taskId === 'b') {
        throw new Error('Launcher crashed');
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
});
