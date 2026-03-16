/**
 * Phase 3 — Knowledge Base Construction (step-level tests)
 * Phase 4 — Migration Strategy (step-level tests)
 *
 * Tests the individual step functions that replaced the orchestrator's
 * executePhase3() and executePhase4() methods.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { launchKnowledgeBuilder } from '../../../src/flow/steps/kb-construction.js';
import { launchMigrationPlanner } from '../../../src/flow/steps/planning.js';
import {
  setupFlowTest,
  createMockLauncher,
  createFailingLauncher,
} from '../../helpers/flow-mocks.js';
import type { FlowTestEnv } from '../../helpers/flow-mocks.js';

let env: FlowTestEnv;

afterEach(async () => {
  if (env) await env.cleanup();
});

// ─── Phase 3 — Knowledge Base Construction ──────────────────────────────────

describe('launchKnowledgeBuilder', () => {
  it('should return success when knowledge-builder agent succeeds', async () => {
    const launcherFn = createMockLauncher();
    env = await setupFlowTest(launcherFn);

    const result = await launchKnowledgeBuilder(env.flowCtx);

    expect(result.phase).toBe(3);
    expect(result.name).toBe('Knowledge Base Construction');
    expect(result.success).toBe(true);
  });

  it('should throw MigrationError when knowledge-builder fails', async () => {
    const launcherFn = createFailingLauncher(['knowledge-builder']);
    env = await setupFlowTest(launcherFn);

    await expect(launchKnowledgeBuilder(env.flowCtx)).rejects.toThrow(/Phase 3.*failed/);
  });

  it('should skip when phase 3 is already completed (checkpoint resume)', async () => {
    const launcherFn = createMockLauncher();
    env = await setupFlowTest(launcherFn);

    // Mark phase 3 as complete in checkpoint
    const state = env.checkpoint.getState();
    state.completedPhases.push(3);
    await env.checkpoint.save(state);

    const result = await launchKnowledgeBuilder(env.flowCtx);

    expect(result.phase).toBe(3);
    expect(result.success).toBe(true);
    // Agent should not have been invoked (skipped on resume)
    expect(env.mockLauncher.invocations).toHaveLength(0);
  });

  it('should record token usage from agent result', async () => {
    const launcherFn = createMockLauncher(() => ({
      tokenUsage: { input: 1000, output: 500 },
    }));
    env = await setupFlowTest(launcherFn);

    await launchKnowledgeBuilder(env.flowCtx);

    const total = env.ctx.tokenTracker.getTotal();
    expect(total).toBe(1500);
  });
});

// ─── Phase 4 — Migration Strategy ───────────────────────────────────────────

describe('launchMigrationPlanner', () => {
  it('should return success when migration-planner agent succeeds', async () => {
    const launcherFn = createMockLauncher();
    env = await setupFlowTest(launcherFn);

    const result = await launchMigrationPlanner(env.flowCtx);

    expect(result.phase).toBe(4);
    expect(result.name).toBe('Migration Strategy');
    expect(result.success).toBe(true);
  });

  it('should throw MigrationError when migration-planner fails', async () => {
    const launcherFn = createFailingLauncher(['migration-planner']);
    env = await setupFlowTest(launcherFn);

    await expect(launchMigrationPlanner(env.flowCtx)).rejects.toThrow(/Phase 4.*failed/);
  });

  it('should skip phase 4a when already completed in checkpoint', async () => {
    const launcherFn = createMockLauncher();
    env = await setupFlowTest(launcherFn);

    const state = env.checkpoint.getState();
    state.phase3aComplete = true;
    await env.checkpoint.save(state);

    const result = await launchMigrationPlanner(env.flowCtx);

    expect(result.success).toBe(true);
    // migration-planner should be skipped, but scaffold step may still run
    const plannerInvocations = env.mockLauncher.invocations.filter(i => i.agent === 'migration-planner');
    expect(plannerInvocations).toHaveLength(0);
  });

  it('should invoke adjudicator when competing-strategies.md exists', async () => {
    const launcherFn = createMockLauncher();
    env = await setupFlowTest(launcherFn);

    // Write competing-strategies file to trigger adjudicator
    const strategiesDir = env.ctx.paths.artifactsPlanningDir;
    await mkdir(strategiesDir, { recursive: true });
    await writeFile(env.ctx.paths.competingStrategiesFile, '# Strategy A\n\n# Strategy B\n');

    await launchMigrationPlanner(env.flowCtx);

    const adjudicatorInvocations = env.mockLauncher.invocations.filter(i => i.agent === 'adjudicator');
    expect(adjudicatorInvocations.length).toBeGreaterThanOrEqual(1);
  });

  it('should generate scaffold when compilation-units.json exists', async () => {
    const launcherFn = createMockLauncher();
    env = await setupFlowTest(launcherFn);

    // Write compilation-units.json to trigger scaffold generation
    const planningDir = env.ctx.paths.artifactsPlanningDir;
    await mkdir(planningDir, { recursive: true });
    const compilationUnitsFile = join(planningDir, 'compilation-units.json');
    await writeFile(compilationUnitsFile, JSON.stringify([
      { id: 'cu-1', sourceFiles: ['src/main.py'], targetFiles: ['src/main.ts'], dependencies: [] },
    ]));

    const result = await launchMigrationPlanner(env.flowCtx);

    expect(result.success).toBe(true);
    // Scaffold should have been marked complete
    const state = env.checkpoint.getState();
    expect(state.scaffoldComplete).toBe(true);
  });
});
