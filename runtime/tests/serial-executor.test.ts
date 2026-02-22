import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { SerialExecutor } from '../src/execution/serial-executor.js';
import { AgentInvocation, AgentResult } from '../src/agents/types.js';
import { createMockLauncher, createSilentLogger } from './helpers/mocks.js';

describe('SerialExecutor', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'aamf-serial-test-'));
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

  it('should execute invocations in order and return results', async () => {
    const callOrder: string[] = [];
    const launcher = async (inv: AgentInvocation): Promise<AgentResult> => {
      callOrder.push(inv.taskId ?? '');
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
    const executor = new SerialExecutor(launcher, logger);

    const invocations = [makeInvocation('a'), makeInvocation('b'), makeInvocation('c')];
    const results = await executor.executeAll(invocations);

    expect(results).toHaveLength(3);
    expect(results[0]!.taskId).toBe('a');
    expect(results[1]!.taskId).toBe('b');
    expect(results[2]!.taskId).toBe('c');
    expect(callOrder).toEqual(['a', 'b', 'c']);
  });

  it('should continue executing after a failure', async () => {
    const launcher = createMockLauncher((inv) => {
      if (inv.taskId === 'b') {
        return { exitCode: 1, success: false, error: 'Task b failed' };
      }
      return {};
    });
    const logger = createSilentLogger(tempDir);
    const executor = new SerialExecutor(launcher, logger);

    const invocations = [makeInvocation('a'), makeInvocation('b'), makeInvocation('c')];
    const results = await executor.executeAll(invocations);

    expect(results).toHaveLength(3);
    expect(results[0]!.success).toBe(true);
    expect(results[1]!.success).toBe(false);
    expect(results[2]!.success).toBe(true);
  });

  it('should handle empty invocation list', async () => {
    const launcher = createMockLauncher();
    const logger = createSilentLogger(tempDir);
    const executor = new SerialExecutor(launcher, logger);

    const results = await executor.executeAll([]);

    expect(results).toEqual([]);
  });
});
