/**
 * Additional shared-steps tests targeting uncovered lines in shared.ts:
 * - runCommand (with spawnWithTimeout mock)
 * - runCommandWithRecovery (infrastructure retry + code-quality recovery)
 * - raiseTerminalExhaustion
 * - recordRetryTarget
 * - git automation helpers
 * - rehydrateParityFromLog
 * - phase cursor helpers (6, 7, 8)
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { writeFile, mkdir } from 'node:fs/promises';
import {
  runCommand,
  runCommandWithRecovery,
  raiseTerminalExhaustion,
  recordRetryTarget,
  TerminalExhaustionError,
  commitForAgent,
  commitForTask,
  commitForWave,
  ensureGitRepositoryReady,
  getPhase5TaskState,
  hasPhase5Substep,
  markPhase5Substep,
  getPhase6Cursor,
  savePhase6Cursor,
  getPhase7Cursor,
  savePhase7Cursor,
  getPhase8Cursor,
  savePhase8Cursor,
  launchAgentWithEvents,
  recordTokens,
  checkBudget,
  getParityIssueSummary,
  checkParityResult,
} from '../../src/flow/steps/shared.js';
import {
  setupFlowTest,
  setupFlowTestWithTasks,
  createMockLauncher,
  DEFAULT_PLANNING_TASKS,
  SINGLE_AUTH_TASK,
  makeTask,
} from '../helpers/flow-mocks.js';
import type { FlowTestEnv } from '../helpers/flow-mocks.js';
import { TaskQueue } from '../../src/execution/task-queue.js';

let env: FlowTestEnv;

afterEach(async () => {
  if (env) await env.cleanup();
});

// ─── runCommand ──────────────────────────────────────────────────────────────

describe('runCommand', () => {
  it('should return success when command exits 0', async () => {
    const launcherFn = createMockLauncher();
    env = await setupFlowTest(launcherFn);

    const spawnMod = await import('../../src/util/process.js');
    const spawnSpy = vi.spyOn(spawnMod, 'spawnWithTimeout').mockResolvedValue({
      exitCode: 0, stdout: 'build ok', stderr: '', killed: false,
    });

    try {
      const result = await runCommand(env.ctx, 'build', 'npm run build', 'task-001');
      expect(result.success).toBe(true);
    } finally {
      spawnSpy.mockRestore();
    }
  });

  it('should return failure with error details when command fails', async () => {
    const launcherFn = createMockLauncher();
    env = await setupFlowTest(launcherFn);

    const spawnMod = await import('../../src/util/process.js');
    const spawnSpy = vi.spyOn(spawnMod, 'spawnWithTimeout').mockResolvedValue({
      exitCode: 1, stdout: '', stderr: 'compile error', killed: false,
    });

    try {
      const result = await runCommand(env.ctx, 'build', 'npm run build', 'task-001');
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    } finally {
      spawnSpy.mockRestore();
    }
  });

  it('should detect infrastructure errors in command output', async () => {
    const launcherFn = createMockLauncher();
    env = await setupFlowTest(launcherFn);

    const spawnMod = await import('../../src/util/process.js');
    const spawnSpy = vi.spyOn(spawnMod, 'spawnWithTimeout').mockResolvedValue({
      exitCode: 1, stdout: '', stderr: 'no space left on device', killed: false,
    });

    try {
      const result = await runCommand(env.ctx, 'build', 'npm run build', 'task-001');
      expect(result.success).toBe(false);
      expect(result.infraError).toBe('disk-full');
    } finally {
      spawnSpy.mockRestore();
    }
  });

  it('should return failure when command throws', async () => {
    const launcherFn = createMockLauncher();
    env = await setupFlowTest(launcherFn);

    const spawnMod = await import('../../src/util/process.js');
    const spawnSpy = vi.spyOn(spawnMod, 'spawnWithTimeout').mockRejectedValue(
      new Error('spawn ENOENT'),
    );

    try {
      const result = await runCommand(env.ctx, 'build', 'npm run build', 'task-001');
      expect(result.success).toBe(false);
      expect(result.error).toContain('spawn ENOENT');
    } finally {
      spawnSpy.mockRestore();
    }
  });

  it('should return failure when command is killed (timeout)', async () => {
    const launcherFn = createMockLauncher();
    env = await setupFlowTest(launcherFn);

    const spawnMod = await import('../../src/util/process.js');
    const spawnSpy = vi.spyOn(spawnMod, 'spawnWithTimeout').mockResolvedValue({
      exitCode: 137, stdout: '', stderr: '', killed: true,
    });

    try {
      const result = await runCommand(env.ctx, 'build', 'npm run build', 'task-001');
      expect(result.success).toBe(false);
      expect(result.error).toContain('timed out');
    } finally {
      spawnSpy.mockRestore();
    }
  });

  it('should track command counters in phase5Snapshot', async () => {
    const launcherFn = createMockLauncher();
    env = await setupFlowTest(launcherFn);

    env.ctx.phase5Snapshot = {
      executionMode: 'per-task', phase4DurationMs: 0,
      completedTaskCount: 0, waveCount: 0,
      waveValidationRuns: 0, waveConvergenceIterations: 0,
      waveConvergenceFailures: 0, waveConvergenceLimitHits: 0,
      buildCommandRuns: 0, testCommandRuns: 0,
      formatCommandRuns: 0, lintCommandRuns: 0,
      commandRecoveryAttempts: 0, commandInfraRetries: 0,
      recoveryLoopTimeMs: 0,
    };

    const spawnMod = await import('../../src/util/process.js');
    const spawnSpy = vi.spyOn(spawnMod, 'spawnWithTimeout').mockResolvedValue({
      exitCode: 0, stdout: '', stderr: '', killed: false,
    });

    try {
      await runCommand(env.ctx, 'build', 'npm run build', 'task-001');
      expect(env.ctx.phase5Snapshot.buildCommandRuns).toBe(1);

      await runCommand(env.ctx, 'test', 'npm test', 'task-001');
      expect(env.ctx.phase5Snapshot.testCommandRuns).toBe(1);

      await runCommand(env.ctx, 'format', 'prettier', 'task-001');
      expect(env.ctx.phase5Snapshot.formatCommandRuns).toBe(1);

      await runCommand(env.ctx, 'lint', 'eslint', 'task-001');
      expect(env.ctx.phase5Snapshot.lintCommandRuns).toBe(1);
    } finally {
      spawnSpy.mockRestore();
    }
  });
});

// ─── runCommandWithRecovery ──────────────────────────────────────────────────

describe('runCommandWithRecovery', () => {
  it('should return true when command succeeds immediately', async () => {
    const launcherFn = createMockLauncher();
    env = await setupFlowTest(launcherFn);

    const spawnMod = await import('../../src/util/process.js');
    const spawnSpy = vi.spyOn(spawnMod, 'spawnWithTimeout').mockResolvedValue({
      exitCode: 0, stdout: 'ok', stderr: '', killed: false,
    });

    const task = makeTask('task-001');
    const queue = new TaskQueue([task]);

    try {
      const result = await runCommandWithRecovery(env.ctx, 'build', 'npm run build', task, queue);
      expect(result).toBe(true);
    } finally {
      spawnSpy.mockRestore();
    }
  });

  it('should retry on infrastructure errors with backoff', async () => {
    const launcherFn = createMockLauncher();
    env = await setupFlowTest(launcherFn, {
      options: { maxRetriesPerTask: 2, maxInfraRetries: 2, invocationDelayMs: 0 },
    });

    let callCount = 0;
    const spawnMod = await import('../../src/util/process.js');
    const spawnSpy = vi.spyOn(spawnMod, 'spawnWithTimeout').mockImplementation(async () => {
      callCount++;
      if (callCount <= 1) {
        return { exitCode: 1, stdout: '', stderr: 'no space left on device', killed: false };
      }
      return { exitCode: 0, stdout: 'ok', stderr: '', killed: false };
    });

    const task = makeTask('task-001');
    const queue = new TaskQueue([task]);

    try {
      const result = await runCommandWithRecovery(env.ctx, 'build', 'npm run build', task, queue);
      expect(result).toBe(true);
      expect(callCount).toBeGreaterThan(1);
    } finally {
      spawnSpy.mockRestore();
    }
  });

  it('should invoke parity-failure-resolver for code-quality recovery', async () => {
    const launcherFn = createMockLauncher();
    env = await setupFlowTest(launcherFn, {
      options: { maxRetriesPerTask: 2, maxInfraRetries: 0 },
    });

    let buildCallCount = 0;
    const spawnMod = await import('../../src/util/process.js');
    const spawnSpy = vi.spyOn(spawnMod, 'spawnWithTimeout').mockImplementation(async () => {
      buildCallCount++;
      if (buildCallCount <= 2) {
        return { exitCode: 1, stdout: '', stderr: 'type error', killed: false };
      }
      return { exitCode: 0, stdout: 'ok', stderr: '', killed: false };
    });

    const task = makeTask('task-001');
    const queue = new TaskQueue([task]);

    try {
      const result = await runCommandWithRecovery(env.ctx, 'build', 'npm run build', task, queue);
      // Should eventually succeed or throw on exhaustion
      const resolverInvs = env.mockLauncher.invocations.filter(
        i => i.agent === 'parity-failure-resolver',
      );
      expect(resolverInvs.length).toBeGreaterThan(0);
    } finally {
      spawnSpy.mockRestore();
    }
  });

  it('should throw TerminalExhaustionError when recovery exhausted without suppression', async () => {
    const launcherFn = createMockLauncher();
    env = await setupFlowTest(launcherFn, {
      options: { maxRetriesPerTask: 1, maxInfraRetries: 0 },
    });

    const spawnMod = await import('../../src/util/process.js');
    const spawnSpy = vi.spyOn(spawnMod, 'spawnWithTimeout').mockResolvedValue({
      exitCode: 1, stdout: '', stderr: 'always fails', killed: false,
    });

    const task = makeTask('task-001');
    const queue = new TaskQueue([task]);

    try {
      await expect(
        runCommandWithRecovery(env.ctx, 'build', 'npm run build', task, queue),
      ).rejects.toThrow(TerminalExhaustionError);
    } finally {
      spawnSpy.mockRestore();
    }
  });

  it('should return false when suppressTerminalOnExhaustion is true', async () => {
    const launcherFn = createMockLauncher();
    env = await setupFlowTest(launcherFn, {
      options: { maxRetriesPerTask: 1, maxInfraRetries: 0 },
    });

    const spawnMod = await import('../../src/util/process.js');
    const spawnSpy = vi.spyOn(spawnMod, 'spawnWithTimeout').mockResolvedValue({
      exitCode: 1, stdout: '', stderr: 'always fails', killed: false,
    });

    const task = makeTask('task-001');
    const queue = new TaskQueue([task]);

    try {
      const result = await runCommandWithRecovery(env.ctx, 'build', 'npm run build', task, queue, {
        suppressTerminalOnExhaustion: true,
      });
      expect(result).toBe(false);
    } finally {
      spawnSpy.mockRestore();
    }
  });
});

// ─── raiseTerminalExhaustion ─────────────────────────────────────────────────

describe('raiseTerminalExhaustion', () => {
  it('should throw TerminalExhaustionError with normalized summary', async () => {
    const launcherFn = createMockLauncher();
    env = await setupFlowTest(launcherFn);

    await expect(
      raiseTerminalExhaustion(env.ctx, {
        reasonCode: 'task-retries-exhausted',
        taskId: 'task-001',
        check: 'code-migrator',
        summary: '  multiple   spaces   and   newlines\n  here  ',
      }),
    ).rejects.toThrow(TerminalExhaustionError);
  });

  it('should write terminal exhaustion to checkpoint and progress', async () => {
    const launcherFn = createMockLauncher();
    env = await setupFlowTest(launcherFn);

    const checkpointSpy = vi.spyOn(env.checkpoint, 'setTerminalExhaustion');
    const progressSpy = vi.spyOn(env.progress, 'setTerminalExhaustion');

    try {
      await raiseTerminalExhaustion(env.ctx, {
        reasonCode: 'wave-convergence-exhausted',
        wave: 2,
        check: 'build',
        summary: 'Wave 2 build failed',
      });
    } catch {
      // Expected
    }

    expect(checkpointSpy).toHaveBeenCalled();
    expect(progressSpy).toHaveBeenCalled();
  });
});

// ─── recordRetryTarget ───────────────────────────────────────────────────────

describe('recordRetryTarget', () => {
  it('should log and record retry with task scope', async () => {
    const launcherFn = createMockLauncher();
    env = await setupFlowTest(launcherFn);

    const warnSpy = vi.spyOn(env.logger, 'warn');
    const progressSpy = vi.spyOn(env.progress, 'appendRetryTarget');

    await recordRetryTarget(env.ctx, {
      scope: 'task',
      attempt: 1,
      maxAttempts: 3,
      taskId: 'task-001',
      check: 'code-migrator',
      summary: 'Migration failed',
    });

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('task=task-001'));
    expect(progressSpy).toHaveBeenCalled();
  });

  it('should record retry with wave scope', async () => {
    const launcherFn = createMockLauncher();
    env = await setupFlowTest(launcherFn);

    const warnSpy = vi.spyOn(env.logger, 'warn');

    await recordRetryTarget(env.ctx, {
      scope: 'wave',
      attempt: 2,
      maxAttempts: 3,
      wave: 1,
      check: 'build',
      summary: 'Build failed for wave',
    });

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('wave=1'));
  });
});

// ─── launchAgentWithEvents ───────────────────────────────────────────────────

describe('launchAgentWithEvents', () => {
  it('should record metrics and emit events', async () => {
    const launcherFn = createMockLauncher(() => ({
      tokenUsage: { input: 100, output: 50 },
    }));
    env = await setupFlowTest(launcherFn);

    const events: Array<Record<string, unknown>> = [];
    vi.spyOn(env.logger, 'event').mockImplementation((ev) => { events.push(ev as any); });

    const result = await launchAgentWithEvents(env.ctx, {
      agent: 'code-migrator',
      contextPath: '/tmp/ctx.json',
      outputPath: '',
      phase: 5,
      workItemId: 'task-001',
      timeout: 300_000,
    });

    expect(result.success).toBe(true);
    expect(events.some(e => e.type === 'agent-launched')).toBe(true);
    expect(events.some(e => e.type === 'agent-completed')).toBe(true);
  });

  it('should emit agent-failed event on failure', async () => {
    const launcherFn = createMockLauncher(() => ({
      exitCode: 1, success: false, error: 'failed',
    }));
    env = await setupFlowTest(launcherFn);

    const events: Array<Record<string, unknown>> = [];
    vi.spyOn(env.logger, 'event').mockImplementation((ev) => { events.push(ev as any); });

    await launchAgentWithEvents(env.ctx, {
      agent: 'code-migrator',
      contextPath: '/tmp/ctx.json',
      outputPath: '',
      phase: 5,
      workItemId: '',
      timeout: 300_000,
    });

    expect(events.some(e => e.type === 'agent-failed')).toBe(true);
  });
});

// ─── Phase 5 Checkpoint Cursors ──────────────────────────────────────────────

describe('Phase 5 checkpoint cursors', () => {
  it('should initialize empty substeps for new task', async () => {
    const launcherFn = createMockLauncher();
    env = await setupFlowTest(launcherFn);

    const state = getPhase5TaskState(env.ctx, 'task-001');
    expect(state.completedSubsteps).toEqual([]);
  });

  it('should mark and check substeps', async () => {
    const launcherFn = createMockLauncher();
    env = await setupFlowTest(launcherFn);

    expect(hasPhase5Substep(env.ctx, 'task-001', 'migrator')).toBe(false);
    await markPhase5Substep(env.ctx, 'task-001', 'migrator');
    expect(hasPhase5Substep(env.ctx, 'task-001', 'migrator')).toBe(true);
  });

  it('should not duplicate substeps on repeated markings', async () => {
    const launcherFn = createMockLauncher();
    env = await setupFlowTest(launcherFn);

    await markPhase5Substep(env.ctx, 'task-001', 'migrator');
    await markPhase5Substep(env.ctx, 'task-001', 'migrator');
    const state = getPhase5TaskState(env.ctx, 'task-001');
    expect(state.completedSubsteps.filter(s => s === 'migrator')).toHaveLength(1);
  });
});

// ─── Phase 6/7/8 Cursor Helpers ──────────────────────────────────────────────

describe('Phase cursor helpers', () => {
  it('should initialize Phase 6 cursor with defaults', async () => {
    const launcherFn = createMockLauncher();
    env = await setupFlowTest(launcherFn);

    const cursor = getPhase6Cursor(env.ctx);
    expect(cursor.iteration).toBe(0);
    expect(cursor.fixIndex).toBe(0);
  });

  it('should save and retrieve Phase 6 cursor', async () => {
    const launcherFn = createMockLauncher();
    env = await setupFlowTest(launcherFn);

    await savePhase6Cursor(env.ctx, { iteration: 2, fixIndex: 3, lastSuccessfulStep: 'fix-applied' });
    const cursor = getPhase6Cursor(env.ctx);
    expect(cursor.iteration).toBe(2);
    expect(cursor.fixIndex).toBe(3);
    expect(cursor.lastSuccessfulStep).toBe('fix-applied');
  });

  it('should initialize Phase 7 cursor with defaults', async () => {
    const launcherFn = createMockLauncher();
    env = await setupFlowTest(launcherFn);

    const cursor = getPhase7Cursor(env.ctx);
    expect(cursor.completedAgents).toEqual([]);
    expect(cursor.completedSuites).toEqual([]);
  });

  it('should save and retrieve Phase 7 cursor', async () => {
    const launcherFn = createMockLauncher();
    env = await setupFlowTest(launcherFn);

    await savePhase7Cursor(env.ctx, {
      completedAgents: ['e2e-test-crafter'],
      completedSuites: ['suite-001'],
      lastSuccessfulStep: 'completed-suite-suite-001',
    });
    const cursor = getPhase7Cursor(env.ctx);
    expect(cursor.completedAgents).toContain('e2e-test-crafter');
    expect(cursor.completedSuites).toContain('suite-001');
  });

  it('should initialize Phase 8 cursor with defaults', async () => {
    const launcherFn = createMockLauncher();
    env = await setupFlowTest(launcherFn);

    const cursor = getPhase8Cursor(env.ctx);
    expect(cursor.iteration).toBe(0);
    expect(cursor.issueIndex).toBe(0);
  });

  it('should save and retrieve Phase 8 cursor', async () => {
    const launcherFn = createMockLauncher();
    env = await setupFlowTest(launcherFn);

    await savePhase8Cursor(env.ctx, {
      iteration: 1, issueIndex: 2,
      currentFile: 'src/main.ts',
      lastSuccessfulStep: 'refactor-started',
    });
    const cursor = getPhase8Cursor(env.ctx);
    expect(cursor.iteration).toBe(1);
    expect(cursor.issueIndex).toBe(2);
    expect(cursor.currentFile).toBe('src/main.ts');
  });
});

// ─── Git Automation ──────────────────────────────────────────────────────────

describe('Git automation helpers', () => {
  it('commitForAgent should be no-op when git is disabled', async () => {
    const launcherFn = createMockLauncher();
    env = await setupFlowTest(launcherFn);

    const spawnMod = await import('../../src/util/process.js');
    const spawnSpy = vi.spyOn(spawnMod, 'spawnWithTimeout');

    try {
      await commitForAgent(env.ctx, 'code-migrator', 5, 'task-001');
      expect(spawnSpy).not.toHaveBeenCalled();
    } finally {
      spawnSpy.mockRestore();
    }
  });

  it('commitForTask should be no-op when git is disabled', async () => {
    const launcherFn = createMockLauncher();
    env = await setupFlowTest(launcherFn);

    const spawnMod = await import('../../src/util/process.js');
    const spawnSpy = vi.spyOn(spawnMod, 'spawnWithTimeout');

    try {
      await commitForTask(env.ctx, makeTask('task-001'));
      expect(spawnSpy).not.toHaveBeenCalled();
    } finally {
      spawnSpy.mockRestore();
    }
  });

  it('commitForWave should be no-op when git is disabled', async () => {
    const launcherFn = createMockLauncher();
    env = await setupFlowTest(launcherFn);

    const spawnMod = await import('../../src/util/process.js');
    const spawnSpy = vi.spyOn(spawnMod, 'spawnWithTimeout');

    try {
      await commitForWave(env.ctx, 1, ['task-001']);
      expect(spawnSpy).not.toHaveBeenCalled();
    } finally {
      spawnSpy.mockRestore();
    }
  });

  it('commitForAgent should be no-op when deferGitCommits is true', async () => {
    const launcherFn = createMockLauncher();
    env = await setupFlowTest(launcherFn, {
      options: { git: { enabled: true, autoInit: false, commitByAgent: true, commitPerTask: true } },
    });
    env.ctx.deferGitCommits = true;

    const spawnMod = await import('../../src/util/process.js');
    const spawnSpy = vi.spyOn(spawnMod, 'spawnWithTimeout');

    try {
      await commitForAgent(env.ctx, 'code-migrator', 5, 'task-001');
      expect(spawnSpy).not.toHaveBeenCalled();
    } finally {
      spawnSpy.mockRestore();
    }
  });

  it('ensureGitRepositoryReady should be no-op when git is disabled', async () => {
    const launcherFn = createMockLauncher();
    env = await setupFlowTest(launcherFn);

    const spawnMod = await import('../../src/util/process.js');
    const spawnSpy = vi.spyOn(spawnMod, 'spawnWithTimeout');

    try {
      await ensureGitRepositoryReady(env.ctx);
      expect(spawnSpy).not.toHaveBeenCalled();
    } finally {
      spawnSpy.mockRestore();
    }
  });
});

// ─── recordTokens ────────────────────────────────────────────────────────────

describe('recordTokens', () => {
  it('should record token usage to tracker', async () => {
    const launcherFn = createMockLauncher();
    env = await setupFlowTest(launcherFn);

    const fakeResult = {
      agent: 'code-migrator' as const,
      exitCode: 0,
      success: true,
      outputFiles: [] as string[],
      duration: 100,
      extensions: { outputParsed: false },
      tokenUsage: { input: 1000, output: 500 },
    };

    recordTokens(env.ctx, fakeResult, 5);
    expect(env.ctx.tokenTracker.getTotal()).toBe(1500);
  });

  it('should be no-op when no tokenUsage present', async () => {
    const launcherFn = createMockLauncher();
    env = await setupFlowTest(launcherFn);

    const fakeResult = {
      agent: 'code-migrator' as const,
      exitCode: 0,
      success: true,
      outputFiles: [] as string[],
      duration: 100,
      extensions: { outputParsed: false },
    };

    recordTokens(env.ctx, fakeResult as any, 5);
    expect(env.ctx.tokenTracker.getTotal()).toBe(0);
  });
});

// ─── checkBudget with warning threshold ──────────────────────────────────────

describe('checkBudget (warning threshold)', () => {
  it('should emit budget-warning event near threshold', async () => {
    const launcherFn = createMockLauncher();
    env = await setupFlowTest(launcherFn, {
      options: { tokenBudget: 1000 },
    });

    // Record tokens to push past 80% of budget
    env.ctx.tokenTracker.record('code-migrator', 5, 850);

    const events: Array<Record<string, unknown>> = [];
    vi.spyOn(env.logger, 'event').mockImplementation((ev) => { events.push(ev as any); });

    const result = checkBudget(env.ctx);
    expect(result).toBe(true);
    expect(events.some(e => e.type === 'budget-warning')).toBe(true);
  });
});

// ─── Parity rehydration from log files ───────────────────────────────────────

describe('checkParityResult rehydration', () => {
  it('should rehydrate from parity-verifier log when result is missing from context', async () => {
    const launcherFn = createMockLauncher();
    env = await setupFlowTest(launcherFn);

    // Write a fake parity log file
    const logDir = join(env.ctx.paths.logsAgentsDir, 'parity-verifier', 'task-001');
    await mkdir(logDir, { recursive: true });
    const logContent = `Some output\n\`\`\`aamf-json\n${JSON.stringify({
      parity: 'pass',
      issues: [],
    })}\n\`\`\`\n`;
    await writeFile(join(logDir, '001.log'), logContent);

    // Should rehydrate from log
    const result = checkParityResult(env.ctx, 'task-001');
    expect(result).toBe(true);
    // Should now be cached in parityResults
    expect(env.ctx.parityResults.has('task-001')).toBe(true);
  });
});
