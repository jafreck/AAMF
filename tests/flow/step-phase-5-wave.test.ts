/**
 * Phase 5 — Iterative Migration: Wave-Barrier Mode (step-level tests)
 *
 * Tests the wave-barrier execution path in executeIterativeMigration(),
 * covering: basic wave execution, convergence retry, terminal exhaustion
 * on convergence failure, and completed-task invariant.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { writeFile, mkdir } from 'node:fs/promises';
import { executeIterativeMigration } from '../../src/flow/steps/migration.js';
import {
  setupFlowTestWithTasks,
  createMockLauncher,
  DEFAULT_PLANNING_TASKS,
  SINGLE_AUTH_TASK,
  withParityPassOutput,
  makeTask,
} from '../helpers/flow-mocks.js';
import type { FlowTestEnv } from '../helpers/flow-mocks.js';
import type { AgentInvocation, AgentResult } from '../../src/agents/types.js';

let env: FlowTestEnv;

afterEach(async () => {
  if (env) await env.cleanup();
});

// ─── Wave-Barrier Basic Execution ───────────────────────────────────────────

describe('executeIterativeMigration — wave-barrier mode', () => {
  it('should complete all tasks in wave-barrier mode', async () => {
    const launcherFn = createMockLauncher();
    env = await setupFlowTestWithTasks(launcherFn, DEFAULT_PLANNING_TASKS, {
      options: {
        executionMode: 'wave-barrier',
        waveControl: { maxConvergenceIterations: 2 },
        qualityPolicy: 'balanced',
      },
    });

    // Mock spawnWithTimeout to succeed for wave validation commands
    const spawnMod = await import('../../src/util/process.js');
    const spawnSpy = vi.spyOn(spawnMod, 'spawnWithTimeout').mockResolvedValue({
      exitCode: 0, stdout: 'ok', stderr: '', killed: false,
    });

    try {
      const result = await executeIterativeMigration(env.flowCtx);

      expect(result.phase).toBe(5);
      expect(result.success).toBe(true);
      // All tasks should be processed
      const codeMigratorInvs = env.mockLauncher.invocations.filter(i => i.agent === 'code-migrator');
      expect(codeMigratorInvs.length).toBeGreaterThanOrEqual(2);
    } finally {
      spawnSpy.mockRestore();
    }
  });

  it('should emit wave lifecycle events', async () => {
    const launcherFn = createMockLauncher();
    env = await setupFlowTestWithTasks(launcherFn, [SINGLE_AUTH_TASK], {
      options: {
        executionMode: 'wave-barrier',
        waveControl: { maxConvergenceIterations: 1 },
        qualityPolicy: 'balanced',
      },
    });

    const events: Array<Record<string, unknown>> = [];
    vi.spyOn(env.logger, 'event').mockImplementation((ev) => { events.push(ev as any); });

    const spawnMod = await import('../../src/util/process.js');
    const spawnSpy = vi.spyOn(spawnMod, 'spawnWithTimeout').mockResolvedValue({
      exitCode: 0, stdout: 'ok', stderr: '', killed: false,
    });

    try {
      await executeIterativeMigration(env.flowCtx);

      const waveEvents = events.filter(e =>
        typeof e.type === 'string' && e.type.startsWith('wave-'),
      );
      expect(waveEvents.length).toBeGreaterThan(0);
      expect(waveEvents.some(e => e.type === 'wave-started')).toBe(true);
      expect(waveEvents.some(e => e.type === 'wave-completed')).toBe(true);
    } finally {
      spawnSpy.mockRestore();
    }
  });

  it('should set deferGitCommits during wave migration when git is enabled', async () => {
    const launcherFn = createMockLauncher();
    const deferStates: boolean[] = [];
    env = await setupFlowTestWithTasks(launcherFn, [SINGLE_AUTH_TASK], {
      options: {
        executionMode: 'wave-barrier',
        waveControl: { maxConvergenceIterations: 1 },
        qualityPolicy: 'balanced',
        git: { enabled: true, autoInit: false, commitByAgent: true, commitPerTask: true },
      },
    });

    // Track deferGitCommits via the launcher spy
    const origFn = env.mockLauncher.fn;
    (env.mockLauncher as any).fn = async (inv: AgentInvocation) => {
      deferStates.push(env.ctx.deferGitCommits);
      return origFn(inv);
    };

    const spawnMod = await import('../../src/util/process.js');
    const spawnSpy = vi.spyOn(spawnMod, 'spawnWithTimeout').mockResolvedValue({
      exitCode: 0, stdout: 'ok', stderr: '', killed: false,
    });

    try {
      await executeIterativeMigration(env.flowCtx);
      // At least some invocations should have seen deferGitCommits = true
      expect(deferStates.some(d => d === true)).toBe(true);
    } finally {
      spawnSpy.mockRestore();
    }
  });

  // ─── Wave Convergence Retry ─────────────────────────────────────────

  it('should retry wave validation when build fails then succeeds', async () => {
    const launcherFn = createMockLauncher();
    env = await setupFlowTestWithTasks(launcherFn, [SINGLE_AUTH_TASK], {
      target: {
        language: 'typescript',
        outputPath: '/tmp/target',
        buildCommand: 'npm run build',
      },
      options: {
        executionMode: 'wave-barrier',
        waveControl: { maxConvergenceIterations: 3 },
        qualityPolicy: 'strict',
        maxRetriesPerTask: 3,
      },
    });

    let buildCallCount = 0;
    const spawnMod = await import('../../src/util/process.js');
    const spawnSpy = vi.spyOn(spawnMod, 'spawnWithTimeout').mockImplementation(async (cmd, args) => {
      buildCallCount++;
      if (buildCallCount <= 1) {
        // First build call fails (wave validation)
        return { exitCode: 1, stdout: '', stderr: 'build failed', killed: false };
      }
      // Subsequent calls succeed
      return { exitCode: 0, stdout: 'ok', stderr: '', killed: false };
    });

    try {
      const result = await executeIterativeMigration(env.flowCtx);

      // parity-failure-resolver should have been invoked for wave recovery
      const resolverInvs = env.mockLauncher.invocations.filter(
        i => i.agent === 'parity-failure-resolver',
      );
      expect(resolverInvs.length).toBeGreaterThan(0);
    } finally {
      spawnSpy.mockRestore();
    }
  });

  // ─── Terminal Exhaustion on Wave Convergence ───────────────────────

  it('should throw TerminalExhaustionError when wave convergence exhausted', async () => {
    const launcherFn = createMockLauncher();
    env = await setupFlowTestWithTasks(launcherFn, [SINGLE_AUTH_TASK], {
      target: {
        language: 'typescript',
        outputPath: '/tmp/target',
        buildCommand: 'npm run build',
      },
      options: {
        executionMode: 'wave-barrier',
        waveControl: { maxConvergenceIterations: 2 },
        qualityPolicy: 'strict',
        maxRetriesPerTask: 1,
      },
    });

    // Build always fails → convergence can't succeed
    const spawnMod = await import('../../src/util/process.js');
    const spawnSpy = vi.spyOn(spawnMod, 'spawnWithTimeout').mockResolvedValue({
      exitCode: 1, stdout: '', stderr: 'build always fails', killed: false,
    });

    try {
      await expect(executeIterativeMigration(env.flowCtx)).rejects.toThrow(
        /wave-convergence-exhausted|terminal exhaustion/i,
      );
    } finally {
      spawnSpy.mockRestore();
    }
  });

  // ─── Completed-Task Invariant ──────────────────────────────────────

  it('should exclude previously completed tasks from processing', async () => {
    const launcherFn = createMockLauncher();
    env = await setupFlowTestWithTasks(launcherFn, DEFAULT_PLANNING_TASKS, {
      options: {
        executionMode: 'wave-barrier',
        waveControl: { maxConvergenceIterations: 1 },
        qualityPolicy: 'balanced',
      },
    });

    // Pre-populate checkpoint: task-001 already completed
    const state = env.checkpoint.getState();
    state.completedTasks = ['task-001'];
    state.completedTaskDurationsMs = [1000];
    // Add stale entries that should be filtered
    state.failedTasks = [{ taskId: 'task-001', error: 'stale fail', attempt: 1 }];
    state.blockedTasks = ['task-001'];
    await env.checkpoint.save(state);

    const spawnMod = await import('../../src/util/process.js');
    const spawnSpy = vi.spyOn(spawnMod, 'spawnWithTimeout').mockResolvedValue({
      exitCode: 0, stdout: 'ok', stderr: '', killed: false,
    });

    try {
      const result = await executeIterativeMigration(env.flowCtx);

      // task-001 should NOT have been migrated again
      const task001Invocations = env.mockLauncher.invocations.filter(
        i => i.agent === 'code-migrator' && i.taskId === 'task-001',
      );
      expect(task001Invocations).toHaveLength(0);

      // task-002 should have been processed
      const task002Invocations = env.mockLauncher.invocations.filter(
        i => i.agent === 'code-migrator' && i.taskId === 'task-002',
      );
      expect(task002Invocations.length).toBeGreaterThan(0);
    } finally {
      spawnSpy.mockRestore();
    }
  });

  // ─── Per-task build/test gates ─────────────────────────────────────

  it('should run build and test commands for per-task mode with advisory policy', async () => {
    const launcherFn = createMockLauncher();
    env = await setupFlowTestWithTasks(launcherFn, [SINGLE_AUTH_TASK], {
      target: {
        language: 'typescript',
        outputPath: '/tmp/target',
        buildCommand: 'npm run build',
        testCommand: 'npm test',
      },
      options: {
        qualityPolicy: 'balanced',
      },
    });

    const spawnMod = await import('../../src/util/process.js');
    const spawnSpy = vi.spyOn(spawnMod, 'spawnWithTimeout').mockResolvedValue({
      exitCode: 0, stdout: 'ok', stderr: '', killed: false,
    });

    try {
      const result = await executeIterativeMigration(env.flowCtx);
      expect(result.success).toBe(true);
      // Build and test commands should have been invoked
      expect(spawnSpy).toHaveBeenCalled();
    } finally {
      spawnSpy.mockRestore();
    }
  });

  it('should run format command per-task when configured', async () => {
    const launcherFn = createMockLauncher();
    env = await setupFlowTestWithTasks(launcherFn, [SINGLE_AUTH_TASK], {
      target: {
        language: 'typescript',
        outputPath: '/tmp/target',
        formatCommand: 'prettier --write .',
      },
      options: {
        qualityPolicy: 'balanced',
      },
    });

    const spawnMod = await import('../../src/util/process.js');
    const spawnSpy = vi.spyOn(spawnMod, 'spawnWithTimeout').mockResolvedValue({
      exitCode: 0, stdout: 'ok', stderr: '', killed: false,
    });

    try {
      const result = await executeIterativeMigration(env.flowCtx);
      expect(result.success).toBe(true);
    } finally {
      spawnSpy.mockRestore();
    }
  });

  // ─── Missing Plan Paths ────────────────────────────────────────────

  it('should fail when no migration plan is available', async () => {
    const launcherFn = createMockLauncher();
    // Use setupFlowTest (not WithTasks) to avoid writing tasks-merged.json
    const { setupFlowTest } = await import('../helpers/flow-mocks.js');
    env = await setupFlowTest(launcherFn);

    // Clear the phase1TaskGraphResult so no plan data is available
    env.ctx.phase1TaskGraphResult = undefined;

    // Neither planPath nor tasks-merged.json exist → error
    await expect(executeIterativeMigration(env.flowCtx)).rejects.toThrow(/not found/i);
  });

  it('should fallback to tasks-merged.json when structured output unavailable', async () => {
    const launcherFn = createMockLauncher();
    env = await setupFlowTestWithTasks(launcherFn, [SINGLE_AUTH_TASK]);

    // Clear structured output but keep the tasks-merged.json file (written by setupFlowTestWithTasks)
    env.ctx.phase1TaskGraphResult = undefined;

    const result = await executeIterativeMigration(env.flowCtx);
    expect(result.success).toBe(true);
  });

  // ─── Wave-end quality gates (deferred-strict) ──────────────────────

  it('should run wave-end quality gates for per-task mode with advisory policy', async () => {
    const launcherFn = createMockLauncher();
    env = await setupFlowTestWithTasks(launcherFn, [SINGLE_AUTH_TASK], {
      target: {
        language: 'typescript',
        outputPath: '/tmp/target',
        buildCommand: 'npm run build',
        testCommand: 'npm test',
      },
      options: {
        qualityPolicy: 'balanced',
      },
    });

    const spawnMod = await import('../../src/util/process.js');
    const spawnCalls: string[] = [];
    const spawnSpy = vi.spyOn(spawnMod, 'spawnWithTimeout').mockImplementation(async (_cmd, args) => {
      const cmdStr = Array.isArray(args) ? args.join(' ') : String(args);
      spawnCalls.push(cmdStr);
      return { exitCode: 0, stdout: 'ok', stderr: '', killed: false };
    });

    try {
      const result = await executeIterativeMigration(env.flowCtx);
      expect(result.success).toBe(true);
    } finally {
      spawnSpy.mockRestore();
    }
  });

  it('should report wave-end quality gate failure in result error', async () => {
    const launcherFn = createMockLauncher();
    env = await setupFlowTestWithTasks(launcherFn, [SINGLE_AUTH_TASK], {
      target: {
        language: 'typescript',
        outputPath: '/tmp/target',
        buildCommand: 'npm run build',
      },
      options: {
        qualityPolicy: 'balanced',
      },
    });

    const spawnMod = await import('../../src/util/process.js');
    // Always fail build commands — per-task build runs in advisory mode so
    // the task still completes, but the wave-end quality gate will fail
    const spawnSpy = vi.spyOn(spawnMod, 'spawnWithTimeout').mockResolvedValue({
      exitCode: 1, stdout: '', stderr: 'build fail', killed: false,
    });

    try {
      // The wave-end gate failure sets result.error and assertPhaseSuccess throws
      await expect(executeIterativeMigration(env.flowCtx)).rejects.toThrow();
    } finally {
      spawnSpy.mockRestore();
    }
  });

  // ─── Blocked Tasks ────────────────────────────────────────────────

  it('should halt when continueOnBlocked is false and tasks are blocked', async () => {
    // Make code-migrator fail for task-001 so it becomes blocked
    const launcherFn = createMockLauncher((inv) => {
      if (inv.agent === 'code-migrator' && inv.taskId === 'task-001') {
        return { exitCode: 1, success: false, error: 'Migration failed' };
      }
      if (inv.agent === 'parity-failure-resolver') {
        return { exitCode: 1, success: false, error: 'Recovery failed' };
      }
      return {};
    });
    env = await setupFlowTestWithTasks(launcherFn, DEFAULT_PLANNING_TASKS, {
      options: {
        executionMode: 'wave-barrier',
        waveControl: { maxConvergenceIterations: 1 },
        continueOnBlocked: false,
        maxRetriesPerTask: 1,
        qualityPolicy: 'balanced',
      },
    });

    const spawnMod = await import('../../src/util/process.js');
    const spawnSpy = vi.spyOn(spawnMod, 'spawnWithTimeout').mockResolvedValue({
      exitCode: 0, stdout: 'ok', stderr: '', killed: false,
    });

    try {
      await expect(executeIterativeMigration(env.flowCtx)).rejects.toThrow();
    } finally {
      spawnSpy.mockRestore();
    }
  });

  // ─── Deadlock Detection ────────────────────────────────────────────

  it('should detect deadlock when all remaining tasks are blocked', async () => {
    // Create tasks where task-002 depends on task-001, and task-001 always fails
    const tasks = [
      makeTask('task-001'),
      { ...makeTask('task-002', ['task-001']), dependencies: ['task-001'] },
    ];
    const launcherFn = createMockLauncher((inv) => {
      if (inv.agent === 'code-migrator' && inv.taskId === 'task-001') {
        return { exitCode: 1, success: false, error: 'always fails' };
      }
      if (inv.agent === 'parity-failure-resolver') {
        return { exitCode: 1, success: false, error: 'recovery fails' };
      }
      return {};
    });
    env = await setupFlowTestWithTasks(launcherFn, tasks, {
      options: {
        maxRetriesPerTask: 1,
        continueOnBlocked: true,
        qualityPolicy: 'balanced',
      },
    });

    await expect(executeIterativeMigration(env.flowCtx)).rejects.toThrow();
  });

  // ─── SCC Recovery ─────────────────────────────────────────────────

  it('should handle SCC-aware topological sort', async () => {
    const tasks = [
      makeTask('task-a'),
      makeTask('task-b', ['task-a']),
    ];
    const launcherFn = createMockLauncher();
    env = await setupFlowTestWithTasks(launcherFn, tasks);

    // Inject SCCs into structured output
    env.ctx.phase1TaskGraphResult!.structuredOutput!['sccs'] = [['task-a', 'task-b']];

    const result = await executeIterativeMigration(env.flowCtx);
    expect(result.success).toBe(true);
  });

  // ─── Token budget warning ─────────────────────────────────────────

  it('should log warning when projected usage exceeds budget', async () => {
    const launcherFn = createMockLauncher();
    env = await setupFlowTestWithTasks(launcherFn, DEFAULT_PLANNING_TASKS, {
      options: { tokenBudget: 1 },
    });

    const warnSpy = vi.spyOn(env.logger, 'warn');
    await executeIterativeMigration(env.flowCtx);

    const budgetWarnings = warnSpy.mock.calls.filter(
      c => typeof c[0] === 'string' && c[0].includes('exceeds budget'),
    );
    expect(budgetWarnings.length).toBeGreaterThan(0);
  });
});
