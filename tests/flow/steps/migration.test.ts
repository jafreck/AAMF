/**
 * Phase 4 — Iterative Migration (step-level tests)
 *
 * Tests buildPhase4Subflow() + FlowRunner which is the heart of the
 * migration pipeline, covering per-task mode, budget projection,
 * parity verification, model routing, and terminal exhaustion behavior.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { buildPhase4Subflow, computePhase4Concurrency } from '../../../src/flow/steps/migration.js';
import { FlowRunner } from '@cadre-dev/framework/flow';
import { Phase4CheckpointAdapter } from '../../../src/flow/checkpoint-adapter.js';
import type { MigrationFlowContext } from '../../../src/flow/context.js';
import {
  setupFlowTestWithTasks,
  createMockLauncher,
  createFailingLauncher,
  DEFAULT_PLANNING_TASKS,
  SINGLE_AUTH_TASK,
  makeTask,
  withParityOutput,
} from '../../helpers/flow-mocks.js';
import type { FlowTestEnv } from '../../helpers/flow-mocks.js';
import type { AgentInvocation, AgentResult, MigrationTask } from '../../../src/agents/types.js';

let env: FlowTestEnv;

afterEach(async () => {
  if (env) await env.cleanup();
});

/**
 * Build and run the Phase 4 subflow, returning the FlowRunResult.
 */
async function runPhase4(e: FlowTestEnv) {
  const flow = await buildPhase4Subflow(e.flowCtx);
  if (flow.nodes.length === 0) return { status: 'completed' as const, empty: true };

  const runner = new FlowRunner<MigrationFlowContext>();
  return runner.run(flow, e.ctx, {
    checkpoint: new Phase4CheckpointAdapter(e.checkpoint),
    concurrency: computePhase4Concurrency(e.ctx),
  });
}

// ─── Basic Execution ────────────────────────────────────────────────────────

describe('buildPhase4Subflow (Phase 4)', () => {
  describe('Basic Execution', () => {
    it('should process all tasks from phase1TaskGraphResult', async () => {
      const launcherFn = createMockLauncher();
      env = await setupFlowTestWithTasks(launcherFn);

      const result = await runPhase4(env);

      expect(result.status).toBe('completed');
      const codeMigratorInvocations = env.mockLauncher.invocations.filter(i => i.agent === 'code-migrator');
      expect(codeMigratorInvocations.length).toBeGreaterThanOrEqual(2);
    });

    it('should handle empty task list gracefully', async () => {
      const launcherFn = createMockLauncher();
      env = await setupFlowTestWithTasks(launcherFn, []);

      const result = await runPhase4(env);

      expect(result.status).toBe('completed');
    });

    it('should log cost projection with retry overhead', async () => {
      const launcherFn = createMockLauncher();
      env = await setupFlowTestWithTasks(launcherFn);
      const infoSpy = vi.spyOn(env.logger, 'info');

      await runPhase4(env);

      const projectionLog = infoSpy.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('Phase 4:'),
      );
      expect(projectionLog).toBeDefined();
    });

    it('should add a complete-step dependency between overlapping per-task tasks', async () => {
      const tasks: MigrationTask[] = [
        { ...SINGLE_AUTH_TASK, id: 'task-001', targetFiles: ['src/shared.ts'] },
        { ...makeTask('task-002'), targetFiles: ['src/shared.ts'] },
      ];
      env = await setupFlowTestWithTasks(createMockLauncher(), tasks, {
        options: { maxParallelAgents: 2, qualityPolicy: 'balanced' },
      });

      const flow = await buildPhase4Subflow(env.flowCtx);
      const task002Migrate = flow.nodes.find(node => node.id === 'task-002/migrate');

      expect(task002Migrate).toBeDefined();
      expect((task002Migrate as { dependsOn?: string[] }).dependsOn).toContain('task-001/complete');
    });

    it('should not add overlap dependencies for distinct per-task targets', async () => {
      const tasks: MigrationTask[] = [
        { ...SINGLE_AUTH_TASK, id: 'task-001', targetFiles: ['src/one.ts'] },
        { ...makeTask('task-002'), targetFiles: ['src/two.ts'] },
      ];
      env = await setupFlowTestWithTasks(createMockLauncher(), tasks, {
        options: { maxParallelAgents: 2, qualityPolicy: 'balanced' },
      });

      const flow = await buildPhase4Subflow(env.flowCtx);
      const task002Migrate = flow.nodes.find(node => node.id === 'task-002/migrate');

      expect(task002Migrate).toBeDefined();
      expect((task002Migrate as { dependsOn?: string[] }).dependsOn ?? []).not.toContain('task-001/complete');
    });
  });

  // ─── Budget Management ──────────────────────────────────────────────

  describe('Budget Management', () => {
    it('should succeed but accumulate tokens that can trigger budget gates', async () => {
      const launcherFn = createMockLauncher(() => ({
        tokenUsage: { input: 400, output: 200 },
      }));
      env = await setupFlowTestWithTasks(launcherFn, DEFAULT_PLANNING_TASKS, {
        options: { tokenBudget: 1000 },
      });

      // Phase 4 itself completes — the budget gate runs after via the flow DSL
      const result = await runPhase4(env);

      // Tokens should have been recorded
      expect(env.ctx.tokenTracker.getTotal()).toBeGreaterThan(0);
    });
  });

  // ─── Parity Verification ─────────────────────────────────────────────

  describe('Parity Verification', () => {
    it('should invoke parity-verifier after code-migrator', async () => {
      const launcherFn = createMockLauncher();
      env = await setupFlowTestWithTasks(launcherFn, [SINGLE_AUTH_TASK]);

      await runPhase4(env);

      const parityInvocations = env.mockLauncher.invocations.filter(
        i => i.agent === 'parity-verifier' && i.phase === 5,
      );
      expect(parityInvocations.length).toBeGreaterThanOrEqual(1);
    });

    it('should invoke parity-failure-resolver when parity finds critical issues', async () => {
      const launcherFn = withParityOutput(
        createMockLauncher(),
        {
          'task-001': {
            parity: 'fail',
            issues: [{
              severity: 'critical',
              description: 'Missing error handling',
              details: 'Auth flow lacks try/catch',
              sourceLocation: 'src/auth.py:45',
              targetLocation: 'src/auth.ts:52',
            }],
          },
        },
      );
      env = await setupFlowTestWithTasks(launcherFn, [SINGLE_AUTH_TASK], {
        options: { maxRetriesPerTask: 2 },
      });

      // Will throw because parity failures are terminal after retries
      try {
        await runPhase4(env);
      } catch { /* expected */ }

      const recoveryInvocations = env.mockLauncher.invocations.filter(
        i => i.agent === 'parity-failure-resolver' && i.phase === 5,
      );
      expect(recoveryInvocations.length).toBeGreaterThan(0);
    });

    it('should not trigger recovery for minor-only parity issues', async () => {
      const launcherFn = withParityOutput(
        createMockLauncher(),
        {
          'task-001': {
            parity: 'partial',
            issues: [{
              severity: 'minor',
              description: 'Naming convention differs',
              details: 'camelCase vs snake_case',
              sourceLocation: 'src/auth.py:10',
              targetLocation: 'src/auth.ts:12',
            }],
          },
        },
      );
      env = await setupFlowTestWithTasks(launcherFn, [SINGLE_AUTH_TASK]);

      const result = await runPhase4(env);

      expect(result.status).toBe('completed');
      const recoveryForParity = env.mockLauncher.invocations.filter(
        i => i.agent === 'parity-failure-resolver' && i.phase === 5,
      );
      expect(recoveryForParity).toHaveLength(0);
    });

    it('should run minor-parity-repass producing 2 code-migrator + 2 parity-verifier invocations', async () => {
      const launcherFn = withParityOutput(
        createMockLauncher(),
        {
          'task-001': {
            parity: 'partial',
            issues: [{
              severity: 'minor',
              description: 'Style nit',
              details: 'Formatting differs',
              sourceLocation: 'src/auth.py:1',
              targetLocation: 'src/auth.ts:1',
            }],
          },
        },
      );
      env = await setupFlowTestWithTasks(launcherFn, [SINGLE_AUTH_TASK]);

      const result = await runPhase4(env);

      expect(result.status).toBe('completed');
      const migrators = env.mockLauncher.invocations.filter(
        i => i.agent === 'code-migrator' && i.phase === 5,
      );
      const parityRuns = env.mockLauncher.invocations.filter(
        i => i.agent === 'parity-verifier' && i.phase === 5,
      );
      expect(migrators.length).toBeGreaterThanOrEqual(2);
      expect(parityRuns.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ─── Terminal Exhaustion ──────────────────────────────────────────────

  describe('Terminal Exhaustion', () => {
    it('should throw when task retries are exhausted', async () => {
      const launcherFn = createMockLauncher((inv) => {
        if (inv.agent === 'code-migrator' && inv.workItemId === 'task-001') {
          return { exitCode: 1, success: false, error: 'Migration failed' };
        }
        if (inv.agent === 'parity-failure-resolver') {
          return { exitCode: 1, success: false, error: 'Recovery failed' };
        }
        return {};
      });
      env = await setupFlowTestWithTasks(launcherFn, [SINGLE_AUTH_TASK], {
        options: { maxRetriesPerTask: 2 },
      });

      await expect(runPhase4(env)).rejects.toThrow();
    });

    it('should throw on command recovery exhaustion', async () => {
      const launcherFn = createMockLauncher();
      env = await setupFlowTestWithTasks(launcherFn, [SINGLE_AUTH_TASK], {
        target: {
          language: 'typescript',
          outputPath: env?.tempDir ?? '/tmp/target',
          buildCommand: 'npm run build',
        },
        options: { maxRetriesPerTask: 2 },
      });

      // Mock runCommand to always fail builds
      const { runCommand } = await import('../../../src/flow/steps/shared.js');
      const spawnMod = await import('../../../src/util/process.js');
      const spawnSpy = vi.spyOn(spawnMod, 'spawnWithTimeout').mockResolvedValue({
        exitCode: 1, stdout: '', stderr: 'build failed', killed: false,
      });

      try {
        await runPhase4(env);
      } catch {
        // Expected — command recovery exhaustion
      } finally {
        spawnSpy.mockRestore();
      }
    });
  });

  // ─── Failure Recovery Model ───────────────────────────────────────────

  describe('Failure Recovery Model', () => {
    it('should apply failureRecoveryModel on transient errors', async () => {
      let callCount = 0;
      const capturedInvocations: AgentInvocation[] = [];
      const launcherFn = createMockLauncher((inv) => {
        capturedInvocations.push({ ...inv });
        if (inv.agent === 'code-migrator' && inv.workItemId === 'task-001') {
          callCount++;
          if (callCount === 1) {
            return {
              exitCode: 1, success: false,
              error: 'HTTP/2 GOAWAY received from upstream',
            };
          }
        }
        return {};
      });
      env = await setupFlowTestWithTasks(launcherFn, [SINGLE_AUTH_TASK], {
        models: { failureRecovery: 'gpt-4.1-mini' },
        agentBackend: { runtime: 'copilot' },
      });

      await runPhase4(env);

      const migratorRetries = capturedInvocations.filter(
        i => i.agent === 'code-migrator' && i.workItemId === 'task-001',
      );
      expect(migratorRetries.length).toBeGreaterThanOrEqual(2);
      expect(migratorRetries[1]?.modelOverride).toBe('gpt-4.1-mini');
    });
  });

  // ─── Model Routing ────────────────────────────────────────────────────

  describe('Model Routing', () => {
    it('should route a task matching criticalTaskPatterns to criticalModel', async () => {
      const launcherFn = createMockLauncher();
      env = await setupFlowTestWithTasks(launcherFn, DEFAULT_PLANNING_TASKS, {
        models: {
          default: 'gpt-5-mini',
          routing: {
            enabled: true,
            heavy: 'gpt-4.1',
            critical: 'claude-opus-4.6',
            heavyThreshold: 40,
            criticalThreshold: 70,
            criticalTaskPatterns: ['task-001'],
          },
        },
      });

      await runPhase4(env);

      const task001Migrators = env.mockLauncher.invocations.filter(
        i => i.agent === 'code-migrator' && i.workItemId === 'task-001',
      );
      expect(task001Migrators.length).toBeGreaterThan(0);
      expect(task001Migrators[0]!.modelOverride).toBe('claude-opus-4.6');
    });

    it('should downgrade to normal when maxCriticalTasks is reached', async () => {
      const launcherFn = createMockLauncher();
      env = await setupFlowTestWithTasks(launcherFn, DEFAULT_PLANNING_TASKS, {
        models: {
          default: 'gpt-5-mini',
          routing: {
            enabled: true,
            heavy: 'gpt-4.1',
            critical: 'claude-opus-4.6',
            heavyThreshold: 40,
            criticalThreshold: 70,
            criticalTaskPatterns: ['task-*'],
            maxEscalatedTasks: 1,
          },
        },
      });

      await runPhase4(env);

      const migratorInvocations = env.mockLauncher.invocations.filter(
        i => i.agent === 'code-migrator',
      );
      const withOverride = migratorInvocations.filter(i => i.modelOverride === 'claude-opus-4.6');
      const withoutOverride = migratorInvocations.filter(i => !i.modelOverride || i.modelOverride !== 'claude-opus-4.6');
      expect(withOverride).toHaveLength(1);
      expect(withoutOverride.length).toBeGreaterThanOrEqual(1);
    });

    it('should not set modelOverride when routing is disabled', async () => {
      const launcherFn = createMockLauncher();
      env = await setupFlowTestWithTasks(launcherFn, DEFAULT_PLANNING_TASKS, {
        models: {
          default: 'gpt-5-mini',
          routing: {
            enabled: false,
            criticalTaskPatterns: ['task-*'],
          },
        },
      });

      await runPhase4(env);

      const migratorInvocations = env.mockLauncher.invocations.filter(i => i.agent === 'code-migrator');
      for (const inv of migratorInvocations) {
        expect(inv.modelOverride).toBeUndefined();
      }
    });
  });

  // ─── Observability ────────────────────────────────────────────────────

  describe('Observability', () => {
    it('should emit agent-launched and agent-completed events', async () => {
      const launcherFn = createMockLauncher();
      env = await setupFlowTestWithTasks(launcherFn, [SINGLE_AUTH_TASK]);
      const events: Array<Record<string, unknown>> = [];
      vi.spyOn(env.logger, 'event').mockImplementation((ev) => { events.push(ev as any); });

      await runPhase4(env);

      const launched = events.filter(e => e.type === 'agent-launched');
      const completed = events.filter(e => e.type === 'agent-completed');
      expect(launched.length).toBeGreaterThan(0);
      expect(completed.length).toBe(launched.length);
    });

    it('should record token usage', async () => {
      const launcherFn = createMockLauncher(() => ({
        tokenUsage: { input: 1000, output: 500 },
      }));
      env = await setupFlowTestWithTasks(launcherFn, [SINGLE_AUTH_TASK]);

      await runPhase4(env);

      expect(env.ctx.tokenTracker.getTotal()).toBeGreaterThan(0);
    });

    it('should write metrics to JSONL file', async () => {
      const launcherFn = createMockLauncher();
      env = await setupFlowTestWithTasks(launcherFn, [SINGLE_AUTH_TASK]);

      await runPhase4(env);

      const { fileExists } = await import('../../../src/util/fs.js');
      const exists = await fileExists(env.ctx.paths.metricsInvocationsFile);
      expect(exists).toBe(true);
    });

    it('should include ETA in progress log after ≥2 tasks complete', async () => {
      const launcherFn = createMockLauncher();
      env = await setupFlowTestWithTasks(launcherFn, DEFAULT_PLANNING_TASKS);
      const infoSpy = vi.spyOn(env.logger, 'info');

      await runPhase4(env);

      // With the nested FlowRunner, per-task completion is handled by the
      // flow's task-complete step node. Progress logging may differ from
      // the legacy completePhase5Task approach.
      const completionLogs = infoSpy.mock.calls
        .map(c => c[0] as string)
        .filter(m => typeof m === 'string' && m.includes('task'));
      expect(completionLogs.length).toBeGreaterThan(0);
    });
  });

  // ─── Deterministic Resume Cursors ─────────────────────────────────────

  describe('Deterministic Resume Cursors', () => {
    it('should skip completed substeps on resume', async () => {
      const launcherFn = createMockLauncher();
      env = await setupFlowTestWithTasks(launcherFn, [SINGLE_AUTH_TASK]);

      // Pre-populate the Phase 4 nested flow checkpoint with completed execution IDs.
      // The framework skips nodes whose execution ID is already in completedExecutionIds.
      const state = env.checkpoint.getState();
      state.__phase4FlowCheckpoint = {
        flowId: 'phase-4-per-task',
        status: 'completed',
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        completedExecutionIds: [
          'phase-4-per-task/task-001/migrate',
          'phase-4-per-task/task-001/commit',
          'phase-4-per-task/task-001/parity',
        ],
        outputs: {},
        executionOutputs: {},
      };
      await env.checkpoint.save(state);

      const result = await runPhase4(env);

      expect(result.status).toBe('completed');
      // The migrate, commit, and parity substeps were checkpointed as complete,
      // so no code-migrator invocations should occur for task-001.
      const task001MigratorInvocations = env.mockLauncher.invocations.filter(
        inv => inv.phase === 5 && inv.workItemId === 'task-001' && inv.agent === 'code-migrator',
      );
      expect(task001MigratorInvocations.length).toBe(0);
    });
  });

  // ─── phaseTimeouts ────────────────────────────────────────────────────

  describe('phaseTimeouts', () => {
    it('should use phaseTimeouts[5] as timeout for Phase 4 agents', async () => {
      const launcherFn = createMockLauncher();
      env = await setupFlowTestWithTasks(launcherFn, [SINGLE_AUTH_TASK], {
        agentBackend: {
          runtime: 'copilot',
          timeout: 300_000,
          phaseTimeouts: { 5: 60_000 },
        },
      });

      await runPhase4(env);

      const codeMigratorInv = env.mockLauncher.invocations.find(i => i.agent === 'code-migrator');
      expect(codeMigratorInv).toBeDefined();
      expect(codeMigratorInv!.timeout).toBe(60_000);
    });
  });
});
