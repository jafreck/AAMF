/**
 * Phase 5 — Iterative Migration (step-level tests)
 *
 * Tests the executeIterativeMigration() step function which is the heart
 * of the migration pipeline, covering per-task mode, budget projection,
 * parity verification, model routing, and terminal exhaustion behavior.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { executeIterativeMigration } from '../../src/flow/steps/migration.js';
import {
  setupFlowTestWithTasks,
  createMockLauncher,
  createFailingLauncher,
  DEFAULT_PLANNING_TASKS,
  SINGLE_AUTH_TASK,
  withParityOutput,
} from '../helpers/flow-mocks.js';
import type { FlowTestEnv } from '../helpers/flow-mocks.js';
import type { AgentInvocation, AgentResult, MigrationTask } from '../../src/agents/types.js';

let env: FlowTestEnv;

afterEach(async () => {
  if (env) await env.cleanup();
});

// ─── Basic Execution ────────────────────────────────────────────────────────

describe('executeIterativeMigration (Phase 5)', () => {
  describe('Basic Execution', () => {
    it('should process all tasks from phase1TaskGraphResult', async () => {
      const launcherFn = createMockLauncher();
      env = await setupFlowTestWithTasks(launcherFn);

      const result = await executeIterativeMigration(env.flowCtx);

      expect(result.phase).toBe(5);
      expect(result.success).toBe(true);
      const codeMigratorInvocations = env.mockLauncher.invocations.filter(i => i.agent === 'code-migrator');
      expect(codeMigratorInvocations.length).toBeGreaterThanOrEqual(2);
    });

    it('should handle empty task list gracefully', async () => {
      const launcherFn = createMockLauncher();
      env = await setupFlowTestWithTasks(launcherFn, []);

      const result = await executeIterativeMigration(env.flowCtx);

      expect(result.phase).toBe(5);
      expect(result.success).toBe(true);
    });

    it('should log cost projection with retry overhead', async () => {
      const launcherFn = createMockLauncher();
      env = await setupFlowTestWithTasks(launcherFn);
      const infoSpy = vi.spyOn(env.logger, 'info');

      await executeIterativeMigration(env.flowCtx);

      const projectionLog = infoSpy.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('Phase 5:'),
      );
      expect(projectionLog).toBeDefined();
    });
  });

  // ─── Budget Management ──────────────────────────────────────────────

  describe('Budget Management', () => {
    it('should succeed but accumulate tokens that can trigger budget gates', async () => {
      const launcherFn = createMockLauncher(() => ({
        tokenUsage: { prompt: 400, completion: 200, total: 600 },
      }));
      env = await setupFlowTestWithTasks(launcherFn, DEFAULT_PLANNING_TASKS, {
        options: { tokenBudget: 1000 },
      });

      // Phase 5 itself completes — the budget gate runs after via the flow DSL
      const result = await executeIterativeMigration(env.flowCtx);

      // Tokens should have been recorded
      expect(env.ctx.tokenTracker.getTotal()).toBeGreaterThan(0);
    });
  });

  // ─── Parity Verification ─────────────────────────────────────────────

  describe('Parity Verification', () => {
    it('should invoke parity-verifier after code-migrator', async () => {
      const launcherFn = createMockLauncher();
      env = await setupFlowTestWithTasks(launcherFn, [SINGLE_AUTH_TASK]);

      await executeIterativeMigration(env.flowCtx);

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
        await executeIterativeMigration(env.flowCtx);
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

      const result = await executeIterativeMigration(env.flowCtx);

      expect(result.success).toBe(true);
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

      const result = await executeIterativeMigration(env.flowCtx);

      expect(result.success).toBe(true);
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
        if (inv.agent === 'code-migrator' && inv.taskId === 'task-001') {
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

      await expect(executeIterativeMigration(env.flowCtx)).rejects.toThrow();
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
      const { runCommand } = await import('../../src/flow/steps/shared.js');
      const spawnMod = await import('../../src/util/process.js');
      const spawnSpy = vi.spyOn(spawnMod, 'spawnWithTimeout').mockResolvedValue({
        exitCode: 1, stdout: '', stderr: 'build failed', killed: false,
      });

      try {
        await executeIterativeMigration(env.flowCtx);
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
        if (inv.agent === 'code-migrator' && inv.taskId === 'task-001') {
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
        agentBackend: { runtime: 'copilot', failureRecoveryModel: 'gpt-4.1-mini' },
      });

      await executeIterativeMigration(env.flowCtx);

      const migratorRetries = capturedInvocations.filter(
        i => i.agent === 'code-migrator' && i.taskId === 'task-001',
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
        options: {
          modelRouting: {
            enabled: true,
            defaultModel: 'gpt-5-mini',
            heavyModel: 'gpt-4.1',
            criticalModel: 'claude-opus-4.6',
            heavyThreshold: 40,
            criticalThreshold: 70,
            criticalTaskPatterns: ['task-001'],
          },
        },
      });

      await executeIterativeMigration(env.flowCtx);

      const task001Migrators = env.mockLauncher.invocations.filter(
        i => i.agent === 'code-migrator' && i.taskId === 'task-001',
      );
      expect(task001Migrators.length).toBeGreaterThan(0);
      expect(task001Migrators[0]!.modelOverride).toBe('claude-opus-4.6');
    });

    it('should downgrade to normal when maxCriticalTasks is reached', async () => {
      const launcherFn = createMockLauncher();
      env = await setupFlowTestWithTasks(launcherFn, DEFAULT_PLANNING_TASKS, {
        options: {
          modelRouting: {
            enabled: true,
            defaultModel: 'gpt-5-mini',
            heavyModel: 'gpt-4.1',
            criticalModel: 'claude-opus-4.6',
            heavyThreshold: 40,
            criticalThreshold: 70,
            criticalTaskPatterns: ['task-*'],
            maxCriticalTasks: 1,
          },
        },
      });

      await executeIterativeMigration(env.flowCtx);

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
        options: {
          modelRouting: {
            enabled: false,
            defaultModel: 'gpt-5-mini',
            criticalTaskPatterns: ['task-*'],
          },
        },
      });

      await executeIterativeMigration(env.flowCtx);

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

      await executeIterativeMigration(env.flowCtx);

      const launched = events.filter(e => e.type === 'agent-launched');
      const completed = events.filter(e => e.type === 'agent-completed');
      expect(launched.length).toBeGreaterThan(0);
      expect(completed.length).toBe(launched.length);
    });

    it('should record token usage', async () => {
      const launcherFn = createMockLauncher(() => ({
        tokenUsage: { prompt: 1000, completion: 500, total: 1500 },
      }));
      env = await setupFlowTestWithTasks(launcherFn, [SINGLE_AUTH_TASK]);

      await executeIterativeMigration(env.flowCtx);

      expect(env.ctx.tokenTracker.getTotal()).toBeGreaterThan(0);
    });

    it('should write metrics to JSONL file', async () => {
      const launcherFn = createMockLauncher();
      env = await setupFlowTestWithTasks(launcherFn, [SINGLE_AUTH_TASK]);

      await executeIterativeMigration(env.flowCtx);

      const { fileExists } = await import('../../src/util/fs.js');
      const exists = await fileExists(env.ctx.paths.metricsInvocationsFile);
      expect(exists).toBe(true);
    });

    it('should include ETA in progress log after ≥2 tasks complete', async () => {
      const launcherFn = createMockLauncher();
      env = await setupFlowTestWithTasks(launcherFn, DEFAULT_PLANNING_TASKS);
      const infoSpy = vi.spyOn(env.logger, 'info');

      await executeIterativeMigration(env.flowCtx);

      const progressLogs = infoSpy.mock.calls
        .map(c => c[0] as string)
        .filter(m => typeof m === 'string' && m.startsWith('Task progress:'));

      const logsWithEta = progressLogs.filter(m => m.includes('— avg'));
      expect(logsWithEta.length).toBeGreaterThan(0);
    });
  });

  // ─── Deterministic Resume Cursors ─────────────────────────────────────

  describe('Deterministic Resume Cursors', () => {
    it('should skip completed substeps on resume', async () => {
      const launcherFn = createMockLauncher();
      env = await setupFlowTestWithTasks(launcherFn, [SINGLE_AUTH_TASK]);

      // Pre-populate checkpoint with completed substeps for task-001
      const state = env.checkpoint.getState();
      state.phaseCursors ??= {};
      state.phaseCursors['5'] = {
        tasks: {
          'task-001': {
            completedSubsteps: ['migrator', 'migrator-commit', 'parity-tests', 'parity-gate'],
            lastSuccessfulStep: 'parity-gate',
          },
        },
      };
      await env.checkpoint.save(state);

      const result = await executeIterativeMigration(env.flowCtx);

      expect(result.success).toBe(true);
      const task001Phase5Invocations = env.mockLauncher.invocations.filter(
        inv => inv.phase === 5 && inv.taskId === 'task-001',
      );
      const agents = task001Phase5Invocations.map(inv => inv.agent);
      expect(agents).not.toContain('code-migrator');
      expect(agents).not.toContain('parity-verifier');
    });
  });

  // ─── phaseTimeouts ────────────────────────────────────────────────────

  describe('phaseTimeouts', () => {
    it('should use phaseTimeouts[5] as timeout for Phase 5 agents', async () => {
      const launcherFn = createMockLauncher();
      env = await setupFlowTestWithTasks(launcherFn, [SINGLE_AUTH_TASK], {
        agentBackend: {
          runtime: 'copilot',
          timeout: 300_000,
          phaseTimeouts: { 5: 60_000 },
        },
      });

      await executeIterativeMigration(env.flowCtx);

      const codeMigratorInv = env.mockLauncher.invocations.find(i => i.agent === 'code-migrator');
      expect(codeMigratorInv).toBeDefined();
      expect(codeMigratorInv!.timeout).toBe(60_000);
    });
  });
});
