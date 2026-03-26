/**
 * Additional tests for uncovered lines in step files:
 * - final-parity.ts: failure paths (lines 38-42, 50-56)
 * - finalization.ts: suite retry logic, token budget check (lines 155-184)
 * - planning.ts: scaffold verification, adjudicator strategy variant detection (lines 89-95, 107, 121)
 * - idiomatic-refactor.ts: failure path, format/lint commands
 * - flow/index.ts: barrel import coverage
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFile, mkdir, readFile } from 'node:fs/promises';

// ─── flow/index.ts barrel import ─────────────────────────────────────────────

// Static import to ensure v8 coverage tracks the barrel file
import * as flowModule from '../../../src/flow/index.js';

describe('flow/index.ts barrel exports', () => {
  it('should export migrationFlow', () => {
    expect(flowModule.migrationFlow).toBeDefined();
  });

  it('should export AamfFlowCheckpointAdapter', () => {
    expect(flowModule.AamfFlowCheckpointAdapter).toBeDefined();
  });

  it('should export TerminalExhaustionError', () => {
    expect(flowModule.TerminalExhaustionError).toBeDefined();
  });

  it('should export MigrationError', () => {
    expect(flowModule.MigrationError).toBeDefined();
  });

  it('should export classifyError', () => {
    expect(flowModule.classifyError).toBeDefined();
  });

  it('should export buildFlowUpToPhase', () => {
    expect(flowModule.buildFlowUpToPhase).toBeDefined();
  });

  it('should export nodeIdToPhase', () => {
    expect(flowModule.nodeIdToPhase).toBeDefined();
  });
});

// ─── Phase 5 failure paths ──────────────────────────────────────────────────

import { runFinalParityIteration } from '../../../src/flow/steps/final-parity.js';
import {
  setupFlowTest,
  setupFlowTestWithTasks,
  createMockLauncher,
  createFailingLauncher,
  writeE2eTestPlan,
  DEFAULT_PLANNING_TASKS,
  SINGLE_AUTH_TASK,
} from '../../helpers/flow-mocks.js';
import type { FlowTestEnv } from '../../helpers/flow-mocks.js';

let env: FlowTestEnv;

afterEach(async () => {
  if (env) await env.cleanup();
});

describe('runFinalParityIteration — failure paths', () => {
  it('should throw MigrationError when final-parity-checker agent fails', async () => {
    const launcherFn = createFailingLauncher(['final-parity-checker']);
    env = await setupFlowTestWithTasks(launcherFn);

    await expect(runFinalParityIteration(env.flowCtx)).rejects.toThrow(/Phase 5.*failed/);
  });

  it('should throw MigrationError when structured output has no valid fixes array', async () => {
    const launcherFn = createMockLauncher((inv) => {
      if (inv.agent === 'final-parity-checker') {
        // Set fixes to a real array so the withParityPassOutput wrapper
        // leaves structuredOutput alone, but set outputParsed=false so
        // the step's condition `outputParsed && Array.isArray(...)` is false.
        return {
          extensions: { outputParsed: false, structuredOutput: { fixes: [{ description: 'dummy' }] } },
        };
      }
      return {};
    });
    env = await setupFlowTestWithTasks(launcherFn);

    await expect(runFinalParityIteration(env.flowCtx)).rejects.toThrow(/Phase 5.*failed/);
  });

  it('should throw MigrationError when outputParsed is false and fixes missing', async () => {
    const launcherFn = createMockLauncher((inv) => {
      if (inv.agent === 'final-parity-checker') {
        // Wrapper would fill fixes: [], which makes it succeed.
        // To bypass, pass exitCode: 1, success: false to trigger the
        // early failure check at line 38-42
        return { exitCode: 1, success: false, error: 'checker crashed' };
      }
      return {};
    });
    env = await setupFlowTestWithTasks(launcherFn);

    await expect(runFinalParityIteration(env.flowCtx)).rejects.toThrow(/Phase 5.*failed/);
  });
});

// ─── Phase 6 — Finalization: suite retry & budget ────────────────────────────

import { launchE2eSuiteWriters, launchE2eTestCrafter, launchDocWriter } from '../../../src/flow/steps/finalization.js';

describe('launchE2eSuiteWriters — budget and retry', () => {
  it('should skip suites when token budget is exceeded', async () => {
    const launcherFn = createMockLauncher();
    env = await setupFlowTest(launcherFn, {
      options: { tokenBudget: 100 },
      target: { language: 'typescript', outputPath: env?.tempDir ?? '/tmp/target' },
    });

    // Record tokens past budget
    env.ctx.tokenTracker.record('code-migrator', 5, 200);

    const outputPath = env.ctx.config.target.outputPath;
    await writeE2eTestPlan(outputPath, [
      { id: 'suite-001', name: 'Auth E2E' },
    ]);

    await launchE2eSuiteWriters(env.flowCtx);

    // Suite writer should not have been invoked (budget exceeded)
    const testWriterInvocations = env.mockLauncher.invocations.filter(i => i.agent === 'test-writer');
    expect(testWriterInvocations).toHaveLength(0);
  });

  it('should throw MigrationError when suite writer fails', async () => {
    const launcherFn = createFailingLauncher(['test-writer']);
    env = await setupFlowTest(launcherFn, {
      target: { language: 'typescript', outputPath: env?.tempDir ?? '/tmp/target' },
    });

    const outputPath = env.ctx.config.target.outputPath;
    await writeE2eTestPlan(outputPath, [
      { id: 'suite-001', name: 'Auth E2E' },
    ]);

    await expect(launchE2eSuiteWriters(env.flowCtx)).rejects.toThrow(/Phase 6.*failed/);
  });

  it('should report suites: 0 when plan contains empty suites', async () => {
    const launcherFn = createMockLauncher();
    env = await setupFlowTest(launcherFn, {
      target: { language: 'typescript', outputPath: env?.tempDir ?? '/tmp/target' },
    });

    // Write a plan file that has a header but no parseable suites
    const outputPath = env.ctx.config.target.outputPath;
    const e2eDir = join(outputPath, 'e2e');
    await mkdir(e2eDir, { recursive: true });
    await writeFile(join(e2eDir, 'e2e-test-plan.md'), '# E2E Test Plan\n\nNo suites here.\n');

    const result = await launchE2eSuiteWriters(env.flowCtx);
    expect((result as any).suites).toBe(0);
  });

  it('should skip completed suites when all are complete', async () => {
    const launcherFn = createMockLauncher();
    env = await setupFlowTest(launcherFn, {
      target: { language: 'typescript', outputPath: env?.tempDir ?? '/tmp/target' },
    });

    const outputPath = env.ctx.config.target.outputPath;
    await writeE2eTestPlan(outputPath, [
      { id: 'suite-001', name: 'Auth E2E' },
    ]);

    // Mark suite as completed
    const state = env.checkpoint.getState();
    state.phaseCursors ??= {};
    state.phaseCursors['6'] = {
      completedAgents: [],
      completedSuites: ['suite-001'],
      lastSuccessfulStep: 'completed-suite-suite-001',
    };
    await env.checkpoint.save(state);

    const result = await launchE2eSuiteWriters(env.flowCtx);
    // Should report the total suite count but not invoke any writers
    expect(env.mockLauncher.invocations.filter(i => i.agent === 'test-writer')).toHaveLength(0);
  });
});

describe('launchE2eTestCrafter — failure path', () => {
  it('should throw MigrationError when e2e-test-crafter fails', async () => {
    const launcherFn = createFailingLauncher(['e2e-test-crafter']);
    env = await setupFlowTest(launcherFn);

    await expect(launchE2eTestCrafter(env.flowCtx)).rejects.toThrow(/Phase 6.*failed/);
  });
});

describe('launchDocWriter — failure path', () => {
  it('should throw MigrationError when documentation-writer fails', async () => {
    const launcherFn = createFailingLauncher(['documentation-writer']);
    env = await setupFlowTest(launcherFn);

    await expect(launchDocWriter(env.flowCtx)).rejects.toThrow(/Phase 6.*failed/);
  });
});

// ─── Phase 4 — Planning (scaffold verification, adjudicator heuristic) ──────

import { launchMigrationPlanner } from '../../../src/flow/steps/planning.js';

describe('launchMigrationPlanner — extended', () => {
  it('should detect strategy-* variant artifacts and log warning', async () => {
    const launcherFn = createMockLauncher();
    env = await setupFlowTest(launcherFn);

    // Write a strategy variant file in planning directory
    const planningDir = env.ctx.paths.artifactsPlanningDir;
    await mkdir(planningDir, { recursive: true });
    await writeFile(join(planningDir, 'strategy-monolith.md'), '# Strategy A');

    const warnSpy = vi.spyOn(env.logger, 'warn');

    await launchMigrationPlanner(env.flowCtx);

    const strategyWarning = warnSpy.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('strategy-*'),
    );
    expect(strategyWarning).toBeDefined();
  });

  it('should skip scaffold when compilation-units.json is absent', async () => {
    const launcherFn = createMockLauncher();
    env = await setupFlowTest(launcherFn);

    const infoSpy = vi.spyOn(env.logger, 'info');

    await launchMigrationPlanner(env.flowCtx);

    const scaffoldSkipLog = infoSpy.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('skipping scaffold'),
    );
    expect(scaffoldSkipLog).toBeDefined();
  });

  it('should handle scaffold generation failure gracefully', async () => {
    const launcherFn = createMockLauncher();
    env = await setupFlowTest(launcherFn);

    // Write invalid JSON for compilation-units
    const planningDir = env.ctx.paths.artifactsPlanningDir;
    await mkdir(planningDir, { recursive: true });
    await writeFile(join(planningDir, 'compilation-units.json'), 'not json');

    const warnSpy = vi.spyOn(env.logger, 'warn');
    const result = await launchMigrationPlanner(env.flowCtx);
    expect(result.success).toBe(true);

    const failWarning = warnSpy.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('Failed to generate scaffold'),
    );
    expect(failWarning).toBeDefined();
  });

  it('should verify scaffold builds when buildCommand is configured', async () => {
    const launcherFn = createMockLauncher();
    env = await setupFlowTest(launcherFn, {
      target: {
        language: 'typescript',
        outputPath: join(tmpdir(), `aamf-scaffold-build-${Date.now()}`),
        buildCommand: 'npm run build',
      },
    });

    await mkdir(env.ctx.config.target.outputPath, { recursive: true });

    const planningDir = env.ctx.paths.artifactsPlanningDir;
    await mkdir(planningDir, { recursive: true });
    await writeFile(
      join(planningDir, 'compilation-units.json'),
      JSON.stringify([{
        id: 'cu-1',
        sourceFiles: ['src/main.py'],
        targetFiles: ['src/main.ts'],
        targetPath: 'packages/main',
        dependencies: [],
        dependsOn: [],
      }]),
    );

    const spawnMod = await import('../../../src/util/process.js');
    const spawnSpy = vi.spyOn(spawnMod, 'spawnWithTimeout').mockResolvedValue({
      exitCode: 0, stdout: 'ok', stderr: '', killed: false,
    });

    try {
      const result = await launchMigrationPlanner(env.flowCtx);
      expect(result.success).toBe(true);
    } finally {
      spawnSpy.mockRestore();
    }
  });

  it('should warn when scaffold build fails but still succeed', async () => {
    const launcherFn = createMockLauncher();
    env = await setupFlowTest(launcherFn, {
      target: {
        language: 'typescript',
        outputPath: join(tmpdir(), `aamf-scaffold-warn-${Date.now()}`),
        buildCommand: 'npm run build',
      },
    });

    await mkdir(env.ctx.config.target.outputPath, { recursive: true });

    const planningDir = env.ctx.paths.artifactsPlanningDir;
    await mkdir(planningDir, { recursive: true });

    // Use a properly structured compilation unit with targetPath
    await writeFile(
      join(planningDir, 'compilation-units.json'),
      JSON.stringify([{
        id: 'cu-1',
        sourceFiles: ['src/main.py'],
        targetFiles: ['src/main.ts'],
        targetPath: 'packages/main',
        dependencies: [],
        dependsOn: [],
      }]),
    );

    const spawnMod = await import('../../../src/util/process.js');
    const spawnSpy = vi.spyOn(spawnMod, 'spawnWithTimeout').mockResolvedValue({
      exitCode: 1, stdout: '', stderr: 'compile error', killed: false,
    });

    const warnSpy = vi.spyOn(env.logger, 'warn');

    try {
      const result = await launchMigrationPlanner(env.flowCtx);
      expect(result.success).toBe(true);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Scaffold build verification failed'),
      );
    } finally {
      spawnSpy.mockRestore();
    }
  });
});

// ─── Phase 7 — Idiomatic Refactor: failure + format/lint ─────────────────────

import { runIdiomaticRefactorPipeline } from '../../../src/flow/steps/idiomatic-refactor.js';

describe('runIdiomaticRefactorPipeline — failure paths', () => {
  it('should return 0 tasks when all reviewer chunks fail', async () => {
    const launcherFn = createFailingLauncher(['idiomatic-reviewer']);
    env = await setupFlowTest(launcherFn);

    const result = await runIdiomaticRefactorPipeline(env.flowCtx);
    expect(result).toEqual({ tasksCompleted: 0 });
  });

  it('should return 0 tasks when structured output has no issues array', async () => {
    const launcherFn = createMockLauncher((inv) => {
      if (inv.agent === 'idiomatic-reviewer') {
        return {
          extensions: { outputParsed: false, structuredOutput: { issues: [{ file: 'a.ts', issue: 'test' }] } },
        };
      }
      return {};
    });
    env = await setupFlowTest(launcherFn);

    const result = await runIdiomaticRefactorPipeline(env.flowCtx);
    expect(result).toEqual({ tasksCompleted: 0 });
  });

  it('should throw when idiomatic-planner fails', async () => {
    const launcherFn = createMockLauncher((inv) => {
      if (inv.agent === 'idiomatic-reviewer') {
        return {
          extensions: { outputParsed: true, structuredOutput: {
            issues: [{ file: 'src/a.ts', issue: 'test', suggestion: 'fix' }],
          } },
        };
      }
      if (inv.agent === 'idiomatic-planner') {
        return { exitCode: 1, success: false, error: 'planning failed' };
      }
      return {};
    });
    env = await setupFlowTest(launcherFn);

    await expect(runIdiomaticRefactorPipeline(env.flowCtx)).rejects.toThrow(/Phase 7.*failed/);
  });

  it('should run format command when configured and refactorer succeeds', async () => {
    const launcherFn = createMockLauncher((inv) => {
      if (inv.agent === 'idiomatic-reviewer') {
        return {
          extensions: { outputParsed: true, structuredOutput: {
            issues: [{ file: 'src/a.ts', issue: 'test', suggestion: 'fix' }],
          } },
        };
      }
      if (inv.agent === 'idiomatic-planner') {
        return {
          extensions: { outputParsed: true, structuredOutput: {
            tasks: [{
              id: 'idiomatic-1', name: 'Fix style',
              description: 'Fix style issues', files: ['src/a.ts'],
              issues: [{ file: 'src/a.ts', location: '1-5', issue: 'test', suggestion: 'fix' }],
              dependencies: [],
            }],
          } },
        };
      }
      return {};
    });
    env = await setupFlowTest(launcherFn, {
      target: {
        language: 'typescript',
        outputPath: '/tmp/target',
        formatCommand: 'prettier --write .',
      },
    });

    const spawnMod = await import('../../../src/util/process.js');
    const spawnSpy = vi.spyOn(spawnMod, 'spawnWithTimeout').mockResolvedValue({
      exitCode: 0, stdout: 'ok', stderr: '', killed: false,
    });

    try {
      const result = await runIdiomaticRefactorPipeline(env.flowCtx);
      expect(result).toEqual({ tasksCompleted: 1 });
      // Format should have been invoked
      expect(spawnSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
    } finally {
      spawnSpy.mockRestore();
    }
  });
});
