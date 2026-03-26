/**
 * Phase 4 — Iterative Migration: Sync-Epoch Mode (step-level tests)
 *
 * Tests the sync-epoch execution path, covering: epoch scheduling from
 * topological levels, compilation-unit closure expansion, selective
 * build/test at epoch boundaries, and convergence recovery.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  buildPhase4Subflow,
  computePhase4Concurrency,
  computeTopologicalWaves,
  computeEpochs,
  type Epoch,
} from '../../../src/flow/steps/migration.js';
import { FlowRunner } from '@cadre-dev/framework/flow';
import { Phase4CheckpointAdapter } from '../../../src/flow/checkpoint-adapter.js';
import type { MigrationFlowContext } from '../../../src/flow/context.js';
import type { MigrationTask } from '../../../src/agents/types.js';
import {
  setupFlowTestWithTasks,
  createMockLauncher,
  DEFAULT_PLANNING_TASKS,
  SINGLE_AUTH_TASK,
  makeTask,
} from '../../helpers/flow-mocks.js';
import type { FlowTestEnv } from '../../helpers/flow-mocks.js';

let env: FlowTestEnv;

afterEach(async () => {
  if (env) await env.cleanup();
});

async function runPhase4(e: FlowTestEnv) {
  const flow = await buildPhase4Subflow(e.flowCtx);
  if (flow.nodes.length === 0) return { status: 'completed' as const, empty: true };

  const runner = new FlowRunner<MigrationFlowContext>();
  return runner.run(flow, e.ctx, {
    checkpoint: new Phase4CheckpointAdapter(e.checkpoint),
    concurrency: computePhase4Concurrency(e.ctx),
  });
}

// ─── computeEpochs unit tests ───────────────────────────────────────────

describe('computeEpochs', () => {
  it('should merge consecutive topological levels', () => {
    const tasks = [
      makeTask('a'),               // level 0
      makeTask('b'),               // level 0
      makeTask('c', ['a']),        // level 1
      makeTask('d', ['a']),        // level 1
      makeTask('e', ['c', 'd']),   // level 2
    ];
    const epochs = computeEpochs(tasks, 2, false);

    // levels 0+1 → epoch 0, level 2 → epoch 1
    expect(epochs).toHaveLength(2);
    expect(epochs[0]!.levels).toEqual([0, 1]);
    expect(epochs[0]!.tasks.map(t => t.id).sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(epochs[1]!.levels).toEqual([2]);
    expect(epochs[1]!.tasks.map(t => t.id)).toEqual(['e']);
  });

  it('should respect levelsPerSync=1', () => {
    const tasks = [
      makeTask('a'),
      makeTask('b', ['a']),
      makeTask('c', ['b']),
    ];
    const epochs = computeEpochs(tasks, 1, false);

    expect(epochs).toHaveLength(3);
    expect(epochs[0]!.tasks.map(t => t.id)).toEqual(['a']);
    expect(epochs[1]!.tasks.map(t => t.id)).toEqual(['b']);
    expect(epochs[2]!.tasks.map(t => t.id)).toEqual(['c']);
  });

  it('should merge 3 levels with levelsPerSync=3', () => {
    const tasks = [
      makeTask('a'),
      makeTask('b', ['a']),
      makeTask('c', ['b']),
      makeTask('d', ['c']),
    ];
    const epochs = computeEpochs(tasks, 3, false);

    // levels 0+1+2 → epoch 0, level 3 → epoch 1
    expect(epochs).toHaveLength(2);
    expect(epochs[0]!.tasks.map(t => t.id)).toEqual(['a', 'b', 'c']);
    expect(epochs[1]!.tasks.map(t => t.id)).toEqual(['d']);
  });

  it('should return empty array for empty task list', () => {
    expect(computeEpochs([], 2, false)).toEqual([]);
  });

  it('should handle all tasks in a single level', () => {
    const tasks = [makeTask('a'), makeTask('b'), makeTask('c')];
    const epochs = computeEpochs(tasks, 2, false);

    expect(epochs).toHaveLength(1);
    expect(epochs[0]!.tasks.map(t => t.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('should expand epoch for compilation-unit closure', () => {
    // task-a and task-c are in the same compilation unit.
    // task-c is at level 2, but should be pulled into epoch 0 (levels 0+1)
    // because task-a at level 0 shares a compilation unit with it.
    const tasks: MigrationTask[] = [
      { ...makeTask('a'), compilationUnit: 'crate-core' },           // level 0
      { ...makeTask('b', ['a']), compilationUnit: 'crate-util' },    // level 1
      { ...makeTask('c', ['a']), compilationUnit: 'crate-core' },    // level 1 (same unit as a)
      { ...makeTask('d', ['b', 'c']), compilationUnit: 'crate-api' }, // level 2
    ];
    // levels: [a] → [b,c] → [d]
    // levelsPerSync=1 without closure: 3 epochs
    // with closure on unit 'crate-core': a (level 0) → expand to pull c (level 1) → epoch 0 contains a, c
    // but wait, c depends on a (which is in this epoch), so dependency closure is met.
    const epochs = computeEpochs(tasks, 1, true);

    // epoch 0: level 0 (a), expanded to pull c from level 1 (same unit, deps met)
    // epoch 0 is a partial pull from level 1, so b stays for the next epoch
    // epoch 1: b (remaining from level 1)
    // epoch 2: d (level 2)
    expect(epochs).toHaveLength(3);
    expect(epochs[0]!.tasks.map(t => t.id).sort()).toEqual(['a', 'c']);
    expect(epochs[1]!.tasks.map(t => t.id)).toEqual(['b']);
    expect(epochs[2]!.tasks.map(t => t.id)).toEqual(['d']);
  });

  it('should not expand across dependency violations', () => {
    // task-c depends on task-b which is at level 1 and NOT in the same
    // compilation unit. Even though c shares a unit with a, pulling c
    // into epoch 0 would violate the dependency constraint.
    const tasks: MigrationTask[] = [
      { ...makeTask('a'), compilationUnit: 'crate-core' },               // level 0
      { ...makeTask('b', ['a']), compilationUnit: 'crate-util' },        // level 1
      { ...makeTask('c', ['b']), compilationUnit: 'crate-core' },        // level 2
    ];
    const epochs = computeEpochs(tasks, 1, true);

    // c depends on b (level 1), b is not in epoch 0, so c cannot be pulled in
    expect(epochs).toHaveLength(3);
    expect(epochs[0]!.tasks.map(t => t.id)).toEqual(['a']);
    expect(epochs[1]!.tasks.map(t => t.id)).toEqual(['b']);
    expect(epochs[2]!.tasks.map(t => t.id)).toEqual(['c']);
  });

  it('should assign sequential epoch indices', () => {
    const tasks = [
      makeTask('a'),
      makeTask('b', ['a']),
      makeTask('c', ['b']),
      makeTask('d', ['c']),
    ];
    const epochs = computeEpochs(tasks, 2, false);

    for (let i = 0; i < epochs.length; i++) {
      expect(epochs[i]!.index).toBe(i);
    }
  });
});

// ─── Sync-Epoch Basic Execution ─────────────────────────────────────────

describe('buildPhase4Subflow — sync-epoch mode', () => {
  it('should complete all tasks in sync-epoch mode', async () => {
    const launcherFn = createMockLauncher();
    env = await setupFlowTestWithTasks(launcherFn, DEFAULT_PLANNING_TASKS, {
      options: {
        executionMode: 'sync-epoch',
        epochControl: { levelsPerSync: 2, testEveryNEpochs: 1, maxConvergenceIterations: 2 },
        qualityPolicy: 'balanced',
      },
    });

    const spawnMod = await import('../../../src/util/process.js');
    const spawnSpy = vi.spyOn(spawnMod, 'spawnWithTimeout').mockResolvedValue({
      exitCode: 0, stdout: 'ok', stderr: '', killed: false,
    });

    try {
      const result = await runPhase4(env);
      expect(result.status).toBe('completed');

      const codeMigratorInvs = env.mockLauncher.invocations.filter(i => i.agent === 'code-migrator');
      expect(codeMigratorInvs.length).toBeGreaterThanOrEqual(2);
    } finally {
      spawnSpy.mockRestore();
    }
  });

  it('should emit epoch lifecycle events', async () => {
    const launcherFn = createMockLauncher();
    env = await setupFlowTestWithTasks(launcherFn, [SINGLE_AUTH_TASK], {
      options: {
        executionMode: 'sync-epoch',
        epochControl: { levelsPerSync: 2, testEveryNEpochs: 1, maxConvergenceIterations: 1 },
        qualityPolicy: 'balanced',
      },
    });

    const events: Array<Record<string, unknown>> = [];
    vi.spyOn(env.logger, 'event').mockImplementation((ev) => { events.push(ev as any); });

    const spawnMod = await import('../../../src/util/process.js');
    const spawnSpy = vi.spyOn(spawnMod, 'spawnWithTimeout').mockResolvedValue({
      exitCode: 0, stdout: 'ok', stderr: '', killed: false,
    });

    try {
      await runPhase4(env);

      const epochEvents = events.filter(e =>
        typeof e.type === 'string' && e.type.startsWith('epoch-'),
      );
      expect(epochEvents.length).toBeGreaterThan(0);
      expect(epochEvents.some(e => e.type === 'epoch-started')).toBe(true);
      expect(epochEvents.some(e => e.type === 'epoch-completed')).toBe(true);
      expect(epochEvents.some(e => e.type === 'epoch-sync-entered')).toBe(true);
      expect(epochEvents.some(e => e.type === 'epoch-sync-released')).toBe(true);
    } finally {
      spawnSpy.mockRestore();
    }
  });

  it('should publish epoch plan before execution', async () => {
    const launcherFn = createMockLauncher();
    env = await setupFlowTestWithTasks(launcherFn, DEFAULT_PLANNING_TASKS, {
      options: {
        executionMode: 'sync-epoch',
        epochControl: { levelsPerSync: 2, testEveryNEpochs: 1, maxConvergenceIterations: 1 },
        qualityPolicy: 'balanced',
      },
    });

    const infoMessages: string[] = [];
    vi.spyOn(env.logger, 'info').mockImplementation((message: string) => {
      infoMessages.push(message);
    });

    await buildPhase4Subflow(env.flowCtx);

    expect(infoMessages.some(m => m.includes('epoch plan:'))).toBe(true);
    expect(infoMessages.some(m => m.includes('Phase 4 epoch 0'))).toBe(true);
  });

  it('should defer git commits in sync-epoch mode', async () => {
    const launcherFn = createMockLauncher();
    const deferStates: boolean[] = [];
    env = await setupFlowTestWithTasks(launcherFn, [SINGLE_AUTH_TASK], {
      options: {
        executionMode: 'sync-epoch',
        epochControl: { levelsPerSync: 2, testEveryNEpochs: 1, maxConvergenceIterations: 1 },
        qualityPolicy: 'balanced',
        git: { enabled: true, autoInit: false, commitByAgent: true, commitPerTask: true },
      },
    });

    const origFn = env.mockLauncher.fn;
    (env.mockLauncher as any).fn = async (inv: any) => {
      deferStates.push(env.ctx.deferGitCommits);
      return origFn(inv);
    };

    const spawnMod = await import('../../../src/util/process.js');
    const spawnSpy = vi.spyOn(spawnMod, 'spawnWithTimeout').mockResolvedValue({
      exitCode: 0, stdout: 'ok', stderr: '', killed: false,
    });

    try {
      await runPhase4(env);
      expect(deferStates.some(d => d === true)).toBe(true);
    } finally {
      spawnSpy.mockRestore();
    }
  });

  it('should allow parallel concurrency in sync-epoch mode', () => {
    // sync-epoch should behave like wave-barrier for concurrency
    const mockConfig = {
      config: {
        options: {
          executionMode: 'sync-epoch' as const,
          maxParallelAgents: 4,
          git: { enabled: true },
        },
      },
    } as unknown as MigrationFlowContext;

    expect(computePhase4Concurrency(mockConfig)).toBe(4);
  });

  // ─── Selective Test Execution ─────────────────────────────────────

  it('should skip tests at non-test epochs but run build', async () => {
    // 3 levels → with levelsPerSync=1 we get 3 epochs.
    // testEveryNEpochs=2 → tests at epoch 1 and epoch 2 (last).
    // epoch 0: build only (no test).
    const tasks = [
      makeTask('a'),
      makeTask('b', ['a']),
      makeTask('c', ['b']),
    ];
    const launcherFn = createMockLauncher();
    env = await setupFlowTestWithTasks(launcherFn, tasks, {
      target: {
        language: 'typescript',
        outputPath: '/tmp/target',
        buildCommand: 'npm run build',
        testCommand: 'npm test',
      },
      options: {
        executionMode: 'sync-epoch',
        epochControl: { levelsPerSync: 1, testEveryNEpochs: 2, maxConvergenceIterations: 1 },
        qualityPolicy: 'balanced',
      },
    });

    const buildCalls: string[] = [];
    const testCalls: string[] = [];
    const spawnMod = await import('../../../src/util/process.js');
    const spawnSpy = vi.spyOn(spawnMod, 'spawnWithTimeout').mockImplementation(async (cmd, args) => {
      const cmdStr = [cmd, ...(args ?? [])].join(' ');
      if (cmdStr.includes('build')) buildCalls.push(cmdStr);
      if (cmdStr.includes('test')) testCalls.push(cmdStr);
      return { exitCode: 0, stdout: 'ok', stderr: '', killed: false };
    });

    try {
      const result = await runPhase4(env);
      expect(result.status).toBe('completed');
      // Build runs every epoch (3 total)
      expect(buildCalls.length).toBe(3);
      // Tests run at epochs 1 and 2 (testEveryNEpochs=2 → epoch 1, and last epoch 2)
      expect(testCalls.length).toBe(2);
    } finally {
      spawnSpy.mockRestore();
    }
  });

  // ─── Convergence Recovery ─────────────────────────────────────────

  it('should retry epoch validation when build fails then succeeds', async () => {
    const launcherFn = createMockLauncher();
    env = await setupFlowTestWithTasks(launcherFn, [SINGLE_AUTH_TASK], {
      target: {
        language: 'typescript',
        outputPath: '/tmp/target',
        buildCommand: 'npm run build',
      },
      options: {
        executionMode: 'sync-epoch',
        epochControl: { levelsPerSync: 2, testEveryNEpochs: 1, maxConvergenceIterations: 3 },
        qualityPolicy: 'strict',
        maxRetriesPerTask: 3,
      },
    });

    let buildCallCount = 0;
    const spawnMod = await import('../../../src/util/process.js');
    const spawnSpy = vi.spyOn(spawnMod, 'spawnWithTimeout').mockImplementation(async () => {
      buildCallCount++;
      if (buildCallCount === 1) {
        return { exitCode: 1, stdout: '', stderr: 'build failed', killed: false };
      }
      return { exitCode: 0, stdout: 'ok', stderr: '', killed: false };
    });

    try {
      const result = await runPhase4(env);
      expect(result.status).toBe('completed');
      expect(buildCallCount).toBeGreaterThanOrEqual(2);
    } finally {
      spawnSpy.mockRestore();
    }
  });

  it('should throw when epoch convergence is exhausted', async () => {
    const launcherFn = createMockLauncher();
    env = await setupFlowTestWithTasks(launcherFn, [SINGLE_AUTH_TASK], {
      target: {
        language: 'typescript',
        outputPath: '/tmp/target',
        buildCommand: 'npm run build',
      },
      options: {
        executionMode: 'sync-epoch',
        epochControl: { levelsPerSync: 2, testEveryNEpochs: 1, maxConvergenceIterations: 2 },
        qualityPolicy: 'strict',
        maxRetriesPerTask: 1,
      },
    });

    const spawnMod = await import('../../../src/util/process.js');
    const spawnSpy = vi.spyOn(spawnMod, 'spawnWithTimeout').mockResolvedValue({
      exitCode: 1, stdout: '', stderr: 'build always fails', killed: false,
    });

    try {
      await expect(runPhase4(env)).rejects.toThrow();
    } finally {
      spawnSpy.mockRestore();
    }
  });
});
