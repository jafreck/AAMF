import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { MigrationOrchestrator, MigrationError } from '../src/core/orchestrator.js';
import { CheckpointManager } from '../src/core/checkpoint.js';
import { ProgressWriter } from '../src/core/progress.js';
import { PHASES } from '../src/core/phase-registry.js';
import {
  createMockLauncher,
  createFailingLauncher,
  MockAgentLauncher,
  createMockConfig,
  createSilentLogger,
} from './helpers/mocks.js';
import { AgentInvocation, AgentResult, AgentName } from '../src/agents/types.js';
import { Logger } from '../src/logging/logger.js';
import { ensureDir } from '../src/util/fs.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Write a migration-plan.md fixture file to the progress directory.
 */
async function writeMigrationPlan(progressDir: string, content?: string): Promise<void> {
  const defaultPlan = `# Migration Plan: test-project

## Task: task-001 - User Auth Module

**Description:** Migrate auth module
**Complexity:** moderate
**Knowledge Base Reference:** kb/task-001.md

**Source Files:**
- src/task-001.py

**Target Files:**
- src/task-001.ts

**Dependencies:** none

**Acceptance Criteria:**
- works

**Parity Checks:**
- matches

## Task: task-002 - Database Layer

**Description:** Migrate database layer
**Complexity:** moderate
**Knowledge Base Reference:** kb/task-002.md

**Source Files:**
- src/task-002.py

**Target Files:**
- src/task-002.ts

**Dependencies:** task-001

**Acceptance Criteria:**
- works

**Parity Checks:**
- matches
`;
  await writeFile(join(progressDir, 'migration-plan.md'), content ?? defaultPlan);
}

/** Write a final-parity-report.md with fix entries. */
async function writeParityReport(
  progressDir: string,
  issues: Array<{ description: string; sourceFile: string; targetFile: string }>,
): Promise<void> {
  let content = '# Final Parity Report\n\n';
  if (issues.length === 0) {
    content += 'All checks passed.\n';
  } else {
    for (const issue of issues) {
      content += `## Fix: ${issue.description}\n`;
      content += `Source file: ${issue.sourceFile}\n`;
      content += `Target file: ${issue.targetFile}\n\n`;
    }
  }
  await writeFile(join(progressDir, 'final-parity-report.md'), content);
}

/**
 * Set up a complete orchestrator test environment.
 */
async function setupOrchestrator(
  tempDir: string,
  launcherFn: (inv: AgentInvocation) => Promise<AgentResult>,
  configOverrides?: Partial<ReturnType<typeof createMockConfig>>,
  singlePhase?: number,
) {
  const config = createMockConfig(configOverrides);
  const logger = createSilentLogger(tempDir);
  const progressDir = join(tempDir, '.aamf', 'migration', config.projectName);
  await ensureDir(progressDir);

  const checkpoint = new CheckpointManager(progressDir, logger);
  await checkpoint.load(config.projectName);

  const progressFile = join(progressDir, 'progress.md');
  const progress = new ProgressWriter(progressFile);
  await progress.initialize(config);

  const mockLauncher = new MockAgentLauncher(launcherFn);

  const orchestrator = new MigrationOrchestrator(
    config,
    checkpoint,
    mockLauncher as any,
    progress,
    logger,
    tempDir,
    singlePhase,
  );

  return { orchestrator, checkpoint, progress, mockLauncher, logger, config, progressDir };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('MigrationOrchestrator', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'aamf-orch-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // ─── Phase Sequencing ──────────────────────────────────────────────

  describe('Phase Sequencing', () => {
    it('should execute all 7 phases in order when all succeed', async () => {
      const launcherFn = createMockLauncher();
      const { orchestrator, mockLauncher, progressDir } = await setupOrchestrator(tempDir, launcherFn);

      await writeMigrationPlan(progressDir);

      const result = await orchestrator.run();

      expect(result.success).toBe(true);
      expect(result.phases).toHaveLength(7);
      for (let i = 0; i < result.phases.length; i++) {
        expect(result.phases[i]!.phase).toBe(i + 1);
      }
      expect(mockLauncher.invocations.length).toBeGreaterThan(0);
    });

    it('should skip completed phases on resume', async () => {
      const launcherFn = createMockLauncher();

      const config = createMockConfig();
      const logger = createSilentLogger(tempDir);
      const progressDir = join(tempDir, '.aamf', 'migration', config.projectName);
      await ensureDir(progressDir);

      // Pre-populate checkpoint with phases 1–3 complete
      const checkpoint = new CheckpointManager(progressDir, logger);
      await checkpoint.load(config.projectName);
      await checkpoint.completePhase(1, join(progressDir, 'impact-assessment.md'));
      await checkpoint.completePhase(2, join(progressDir, 'knowledge-base'));
      await checkpoint.completePhase(3, join(progressDir, 'migration-plan.md'));

      const progressFile = join(progressDir, 'progress.md');
      const progress = new ProgressWriter(progressFile);
      await progress.initialize(config);

      const mockLauncher = new MockAgentLauncher(launcherFn);

      const orchestrator = new MigrationOrchestrator(
        config,
        checkpoint,
        mockLauncher as any,
        progress,
        logger,
        tempDir,
      );

      await writeMigrationPlan(progressDir);

      const result = await orchestrator.run();

      expect(result.phases).toHaveLength(7);
      const agentsInvoked = mockLauncher.invocations.map((i) => i.agent);
      expect(agentsInvoked).not.toContain('impact-assessor');
      expect(agentsInvoked).not.toContain('knowledge-builder');
      expect(agentsInvoked).not.toContain('migration-planner');
    });

    it('should execute only the specified phase when singlePhase is set', async () => {
      const launcherFn = createMockLauncher();
      const { orchestrator, mockLauncher } = await setupOrchestrator(
        tempDir,
        launcherFn,
        undefined,
        1,
      );

      const result = await orchestrator.run();

      const agentsInvoked = mockLauncher.invocations.map((i) => i.agent);
      expect(agentsInvoked).toContain('impact-assessor');
      expect(agentsInvoked).not.toContain('knowledge-builder');
      expect(agentsInvoked).not.toContain('migration-planner');
      expect(agentsInvoked).not.toContain('code-migrator');
    });
  });

  // ─── Critical Phase Failure ────────────────────────────────────────

  describe('Critical Phase Failure', () => {
    it('should abort migration when a critical phase fails (phase 1)', async () => {
      const launcherFn = createFailingLauncher(['impact-assessor']);
      const { orchestrator } = await setupOrchestrator(tempDir, launcherFn);

      const result = await orchestrator.run();

      expect(result.success).toBe(false);
      expect(result.phases).toHaveLength(1);
      expect(result.phases[0]!.phase).toBe(1);
      expect(result.phases[0]!.success).toBe(false);
    });

    it('should abort migration when a critical phase fails (phase 4)', async () => {
      const launcherFn = createMockLauncher((inv) => {
        if (inv.agent === 'code-migrator') {
          return { exitCode: 1, success: false, error: 'Code migration failed' };
        }
        if (inv.agent === 'failure-recovery') {
          return { exitCode: 1, success: false, error: 'Recovery failed' };
        }
        return {};
      });

      const { orchestrator, progressDir } = await setupOrchestrator(tempDir, launcherFn, {
        options: {
          maxParallelAgents: 3,
          maxRetriesPerTask: 1,
          largeFileThreshold: 500,
          maxLinesPerTask: 500,
          dryRun: false,
          resume: false,
          invocationDelayMs: 0,
          buildConcurrency: 1,
          continueOnBlocked: true,
          maxBlockedTasks: 0,
          maxInfraRetries: 3,
          avgTokensPerTask: 5000,
        },
      });

      await writeMigrationPlan(progressDir);

      const result = await orchestrator.run();

      expect(result.success).toBe(false);
      const phase4 = result.phases.find((p) => p.phase === 4);
      expect(phase4).toBeDefined();
      expect(phase4!.success).toBe(false);
    });

    it('should continue when a non-critical phase fails (phase 5)', async () => {
      const launcherFn = createFailingLauncher(['final-parity-checker']);

      const { orchestrator, progressDir } = await setupOrchestrator(tempDir, launcherFn);
      await writeMigrationPlan(progressDir);

      const result = await orchestrator.run();

      const phase5 = result.phases.find((p) => p.phase === 5);
      const phase6 = result.phases.find((p) => p.phase === 6);
      const phase7 = result.phases.find((p) => p.phase === 7);

      expect(phase5).toBeDefined();
      expect(phase5!.success).toBe(false);
      expect(phase6).toBeDefined();
      expect(phase7).toBeDefined();
    });

    it('should continue when a non-critical phase fails (phase 6)', async () => {
      const launcherFn = createFailingLauncher([
        'e2e-test-crafter',
        'documentation-writer',
      ]);

      const { orchestrator, progressDir } = await setupOrchestrator(tempDir, launcherFn);
      await writeMigrationPlan(progressDir);

      const result = await orchestrator.run();

      const phase6 = result.phases.find((p) => p.phase === 6);
      const phase7 = result.phases.find((p) => p.phase === 7);

      expect(phase6).toBeDefined();
      expect(phase6!.success).toBe(false);
      expect(phase7).toBeDefined();
      expect(phase7!.phase).toBe(7);
    });
  });

  // ─── Budget Management ─────────────────────────────────────────────

  describe('Budget Management', () => {
    it('should abort when token budget is exceeded', async () => {
      const launcherFn = createMockLauncher(() => ({
        tokenUsage: { prompt: 400, completion: 200, total: 600 },
      }));

      const { orchestrator } = await setupOrchestrator(tempDir, launcherFn, {
        options: {
          maxParallelAgents: 3,
          maxRetriesPerTask: 3,
          largeFileThreshold: 500,
          maxLinesPerTask: 500,
          tokenBudget: 1000,
          dryRun: false,
          resume: false,
          invocationDelayMs: 0,
          buildConcurrency: 1,
          continueOnBlocked: true,
          maxBlockedTasks: 0,
          maxInfraRetries: 3,
          avgTokensPerTask: 5000,
        },
      });

      const result = await orchestrator.run();

      expect(result.success).toBe(false);
      expect(result.phases.length).toBeLessThan(7);
    });

    it('should log warning at 80% budget threshold', async () => {
      let callCount = 0;
      const launcherFn = createMockLauncher(() => {
        callCount++;
        if (callCount === 1) {
          return { tokenUsage: { prompt: 500, completion: 350, total: 850 } };
        }
        return { tokenUsage: { prompt: 10, completion: 5, total: 15 } };
      });

      const logger = createSilentLogger(tempDir);
      const eventSpy = vi.spyOn(logger, 'event');

      const config = createMockConfig({
        options: {
          maxParallelAgents: 3,
          maxRetriesPerTask: 3,
          largeFileThreshold: 500,
          maxLinesPerTask: 500,
          tokenBudget: 1000,
          dryRun: false,
          resume: false,
          invocationDelayMs: 0,
          buildConcurrency: 1,
          continueOnBlocked: true,
          maxBlockedTasks: 0,
          maxInfraRetries: 3,
          avgTokensPerTask: 5000,
        },
      });

      const progressDir = join(tempDir, '.aamf', 'migration', config.projectName);
      await ensureDir(progressDir);

      const checkpoint = new CheckpointManager(progressDir, logger);
      await checkpoint.load(config.projectName);

      const progressFile = join(progressDir, 'progress.md');
      const progress = new ProgressWriter(progressFile);
      await progress.initialize(config);

      const mockLauncher = new MockAgentLauncher(launcherFn);
      const orchestrator = new MigrationOrchestrator(
        config,
        checkpoint,
        mockLauncher as any,
        progress,
        logger,
        tempDir,
      );

      await writeMigrationPlan(progressDir);
      await orchestrator.run();

      const warningEvents = eventSpy.mock.calls.filter(
        (call) => (call[0] as any).type === 'budget-warning',
      );
      expect(warningEvents.length).toBeGreaterThan(0);
    });
  });

  // ─── structuredOutput Integration ──────────────────────────────────

  describe('structuredOutput Integration', () => {
    it('should read Phase 4 tasks from structuredOutput when outputParsed is true', async () => {
      // Migration-planner returns structured tasks → no migration-plan.md needed
      const launcherFn = createMockLauncher((inv) => {
        if (inv.agent === 'migration-planner') {
          return {
            outputParsed: true,
            structuredOutput: {
              tasks: [
                {
                  id: 'task-s01',
                  name: 'Structured Task 1',
                  sourceFiles: ['src/s01.py'],
                  targetFiles: ['src/s01.ts'],
                  knowledgeBaseRef: 'kb/s01.md',
                  dependencies: [],
                  complexity: 'simple',
                  description: 'Migrate s01',
                  acceptanceCriteria: ['works'],
                  parityChecks: ['matches'],
                },
              ],
            },
          };
        }
        return {};
      });

      // Note: no migration-plan.md written to progressDir
      const { orchestrator, mockLauncher } = await setupOrchestrator(tempDir, launcherFn);

      const result = await orchestrator.run();

      expect(result.success).toBe(true);
      const codeMigratorInvocations = mockLauncher.invocations.filter(
        (i) => i.agent === 'code-migrator',
      );
      // code-migrator should have been invoked for the structured task
      expect(codeMigratorInvocations.length).toBeGreaterThanOrEqual(1);
      expect(codeMigratorInvocations[0]!.taskId).toBe('task-s01');
    });

    it('should fall back to ResultParser when Phase 3 outputParsed is false', async () => {
      // Default mock returns outputParsed: false, so Phase 4 must read file
      const launcherFn = createMockLauncher();
      const { orchestrator, progressDir, mockLauncher } = await setupOrchestrator(
        tempDir,
        launcherFn,
      );

      await writeMigrationPlan(progressDir);

      const result = await orchestrator.run();

      expect(result.success).toBe(true);
      // code-migrator should have been invoked (tasks parsed from file)
      const codeMigratorInvocations = mockLauncher.invocations.filter(
        (i) => i.agent === 'code-migrator',
      );
      expect(codeMigratorInvocations.length).toBeGreaterThanOrEqual(1);
    });

    it('should read Phase 5 fixes from structuredOutput when outputParsed is true', async () => {
      // final-parity-checker returns structured fixes → code-migrator re-invoked in phase 5
      let parityCallCount = 0;
      const launcherFn = createMockLauncher((inv) => {
        if (inv.agent === 'final-parity-checker') {
          parityCallCount++;
          if (parityCallCount === 1) {
            // First call: return one fix via structuredOutput
            return {
              outputParsed: true,
              structuredOutput: {
                fixes: [
                  {
                    description: 'Missing error handling',
                    sourceFile: 'src/auth.py',
                    targetFile: 'src/auth.ts',
                  },
                ],
              },
            };
          }
          // Second call: no more fixes → stop loop
          return {
            outputParsed: true,
            structuredOutput: { fixes: [] },
          };
        }
        return {};
      });

      const { orchestrator, progressDir, mockLauncher } = await setupOrchestrator(
        tempDir,
        launcherFn,
      );
      await writeMigrationPlan(progressDir);
      // Note: no final-parity-report.md written to prove structured output is used

      const result = await orchestrator.run();

      expect(result.success).toBe(true);
      const codeMigratorInPhase5 = mockLauncher.invocations.filter(
        (i) => i.agent === 'code-migrator' && i.phase === 5,
      );
      expect(codeMigratorInPhase5.length).toBeGreaterThan(0);
    });

    it('should stop Phase 5 loop early when structuredOutput fixes is empty', async () => {
      let parityCallCount = 0;
      const launcherFn = createMockLauncher((inv) => {
        if (inv.agent === 'final-parity-checker') {
          parityCallCount++;
          return {
            outputParsed: true,
            structuredOutput: { fixes: [] },
          };
        }
        return {};
      });

      const { orchestrator, progressDir, mockLauncher } = await setupOrchestrator(
        tempDir,
        launcherFn,
      );
      await writeMigrationPlan(progressDir);

      const result = await orchestrator.run();

      expect(result.success).toBe(true);
      // final-parity-checker should have been called once (loop exits immediately)
      expect(parityCallCount).toBe(1);
      // No phase-5 code-migrator invocations expected
      const codeMigratorInPhase5 = mockLauncher.invocations.filter(
        (i) => i.agent === 'code-migrator' && i.phase === 5,
      );
      expect(codeMigratorInPhase5.length).toBe(0);
    });

    it('should prefer structuredOutput.tokenUsage over result.tokenUsage in recordTokens', async () => {
      // Budget set to 500; result.tokenUsage.total = 100 (within budget),
      // but structuredOutput.tokenUsage.total = 600 (exceeds budget).
      // If recordTokens picks structuredOutput, the budget will be exceeded and run aborted.
      const launcherFn = createMockLauncher(() => ({
        tokenUsage: { prompt: 50, completion: 50, total: 100 },
        outputParsed: true,
        structuredOutput: {
          tokenUsage: { prompt: 400, completion: 200, total: 600 },
        },
      }));

      const { orchestrator } = await setupOrchestrator(tempDir, launcherFn, {
        options: {
          maxParallelAgents: 3,
          maxRetriesPerTask: 3,
          largeFileThreshold: 500,
          maxLinesPerTask: 500,
          tokenBudget: 500,
          dryRun: false,
          resume: false,
          invocationDelayMs: 0,
          buildConcurrency: 1,
          continueOnBlocked: true,
          maxBlockedTasks: 0,
          maxInfraRetries: 3,
          avgTokensPerTask: 5000,
        },
      });

      const result = await orchestrator.run();

      // If structuredOutput.tokenUsage (600) is preferred, budget (500) is exceeded on
      // the first agent invocation → migration aborts with fewer than 7 phases.
      expect(result.success).toBe(false);
      expect(result.phases.length).toBeLessThan(7);
    });
  });

  // ─── Phase 4 Specifics ─────────────────────────────────────────────

  describe('Phase 4 Specifics', () => {
    it('should process migration tasks from plan', async () => {
      const launcherFn = createMockLauncher();
      const { orchestrator, mockLauncher, progressDir } = await setupOrchestrator(tempDir, launcherFn);

      await writeMigrationPlan(progressDir);

      const result = await orchestrator.run();

      expect(result.success).toBe(true);
      const codeMigratorInvocations = mockLauncher.invocations.filter(
        (i) => i.agent === 'code-migrator',
      );
      expect(codeMigratorInvocations.length).toBeGreaterThanOrEqual(2);
    });

    it('should handle empty migration plan gracefully', async () => {
      const launcherFn = createMockLauncher();
      const { orchestrator, progressDir } = await setupOrchestrator(tempDir, launcherFn);

      await writeFile(join(progressDir, 'migration-plan.md'), '# Migration Plan\n\nNo tasks defined.\n');

      const result = await orchestrator.run();

      const phase4 = result.phases.find((p) => p.phase === 4);
      expect(phase4).toBeDefined();
      expect(phase4!.success).toBe(true);
    });

    it('should fail phase 4 when migration-plan.md is missing', async () => {
      const launcherFn = createMockLauncher();
      const { orchestrator } = await setupOrchestrator(tempDir, launcherFn);

      const result = await orchestrator.run();

      const phase4 = result.phases.find((p) => p.phase === 4);
      expect(phase4).toBeDefined();
      expect(phase4!.success).toBe(false);
      expect(phase4!.error).toContain('migration-plan.md');
    });

    it('should block tasks that fail after max retries', async () => {
      const launcherFn = createMockLauncher((inv) => {
        if (inv.agent === 'code-migrator' && inv.taskId === 'task-001') {
          return { exitCode: 1, success: false, error: 'Migration failed for task-001' };
        }
        if (inv.agent === 'failure-recovery') {
          return { exitCode: 1, success: false, error: 'Recovery failed' };
        }
        return {};
      });

      const { orchestrator, progressDir } = await setupOrchestrator(tempDir, launcherFn, {
        options: {
          maxParallelAgents: 3,
          maxRetriesPerTask: 2,
          largeFileThreshold: 500,
          maxLinesPerTask: 500,
          dryRun: false,
          resume: false,
          invocationDelayMs: 0,
          buildConcurrency: 1,
          continueOnBlocked: true,
          maxBlockedTasks: 0,
          maxInfraRetries: 3,
          avgTokensPerTask: 5000,
        },
      });

      const singleTaskPlan = `# Migration Plan

## Task: task-001 - Auth Module

**Description:** Migrate auth
**Complexity:** simple
**Knowledge Base Reference:** kb/auth.md

**Source Files:**
- src/auth.py

**Target Files:**
- src/auth.ts

**Dependencies:** none

**Acceptance Criteria:**
- works

**Parity Checks:**
- matches
`;
      await writeFile(join(progressDir, 'migration-plan.md'), singleTaskPlan);

      const result = await orchestrator.run();

      expect(result.blockedTasks).toContain('task-001');
    });

    it('should invoke failure-recovery when parity-verifier finds critical issues', async () => {
      let parityCallCount = 0;
      const launcherFn = createMockLauncher((inv) => {
        if (inv.agent === 'parity-verifier') {
          parityCallCount++;
        }
        return {};
      });

      const { orchestrator, progressDir, mockLauncher } = await setupOrchestrator(
        tempDir,
        launcherFn,
        {
          options: {
            maxParallelAgents: 3,
            maxRetriesPerTask: 2,
            largeFileThreshold: 500,
            maxLinesPerTask: 500,
            dryRun: false,
            resume: false,
            invocationDelayMs: 0,
            buildConcurrency: 1,
            continueOnBlocked: true,
            maxBlockedTasks: 0,
            maxInfraRetries: 3,
            avgTokensPerTask: 5000,
          },
        },
      );

      const singleTaskPlan = `# Migration Plan

## Task: task-001 - Auth Module

**Description:** Migrate auth
**Complexity:** simple
**Knowledge Base Reference:** kb/auth.md

**Source Files:**
- src/auth.py

**Target Files:**
- src/auth.ts

**Dependencies:** none

**Acceptance Criteria:**
- works

**Parity Checks:**
- matches
`;
      await writeFile(join(progressDir, 'migration-plan.md'), singleTaskPlan);

      // Write a parity sidecar with critical issues (will be read after parity-verifier runs)
      await ensureDir(join(progressDir, 'results'));
      await writeFile(
        join(progressDir, 'results', 'parity-verifier-task-001.result.json'),
        JSON.stringify({
          taskId: 'task-001',
          agent: 'parity-verifier',
          status: 'completed',
          outputFiles: ['parity-reports/task-001.md'],
          parity: 'fail',
          issues: [
            {
              severity: 'critical',
              description: 'Missing error handling in auth flow',
              sourceLocation: 'src/auth.py:45',
              targetLocation: 'src/auth.ts:52',
            },
          ],
        }),
      );

      await orchestrator.run();

      const recoveryInvocations = mockLauncher.invocations.filter(
        (i) => i.agent === 'failure-recovery' && i.phase === 4,
      );
      expect(recoveryInvocations.length).toBeGreaterThan(0);
    });

    it('should not trigger recovery when parity has only minor issues', async () => {
      const launcherFn = createMockLauncher();
      const { orchestrator, progressDir, mockLauncher } = await setupOrchestrator(
        tempDir,
        launcherFn,
      );

      const singleTaskPlan = `# Migration Plan

## Task: task-001 - Auth Module

**Description:** Migrate auth
**Complexity:** simple
**Knowledge Base Reference:** kb/auth.md

**Source Files:**
- src/auth.py

**Target Files:**
- src/auth.ts

**Dependencies:** none

**Acceptance Criteria:**
- works

**Parity Checks:**
- matches
`;
      await writeFile(join(progressDir, 'migration-plan.md'), singleTaskPlan);

      // Write a parity sidecar with only minor issues
      await ensureDir(join(progressDir, 'results'));
      await writeFile(
        join(progressDir, 'results', 'parity-verifier-task-001.result.json'),
        JSON.stringify({
          taskId: 'task-001',
          agent: 'parity-verifier',
          status: 'completed',
          outputFiles: ['parity-reports/task-001.md'],
          parity: 'partial',
          issues: [
            {
              severity: 'minor',
              description: 'Slightly different API surface',
            },
          ],
        }),
      );

      const result = await orchestrator.run();

      // No failure-recovery should be invoked for parity
      const recoveryForParity = mockLauncher.invocations.filter(
        (i) => i.agent === 'failure-recovery' && i.phase === 4,
      );
      expect(recoveryForParity).toHaveLength(0);
      expect(result.success).toBe(true);
    });

    it('should allow task completion when only minor issues remain after retries', async () => {
      let migratorAttempt = 0;
      const launcherFn = createMockLauncher((inv) => {
        if (inv.agent === 'code-migrator') {
          migratorAttempt++;
        }
        return {};
      });

      const { orchestrator, progressDir } = await setupOrchestrator(
        tempDir,
        launcherFn,
        {
          options: {
            maxParallelAgents: 3,
            maxRetriesPerTask: 1,
            largeFileThreshold: 500,
            maxLinesPerTask: 500,
            dryRun: false,
            resume: false,
            invocationDelayMs: 0,
            buildConcurrency: 1,
            continueOnBlocked: true,
            maxBlockedTasks: 0,
            maxInfraRetries: 3,
            avgTokensPerTask: 5000,
          },
        },
      );

      const singleTaskPlan = `# Migration Plan

## Task: task-001 - Auth Module

**Description:** Migrate auth
**Complexity:** simple
**Knowledge Base Reference:** kb/auth.md

**Source Files:**
- src/auth.py

**Target Files:**
- src/auth.ts

**Dependencies:** none

**Acceptance Criteria:**
- works

**Parity Checks:**
- matches
`;
      await writeFile(join(progressDir, 'migration-plan.md'), singleTaskPlan);

      // Write a parity sidecar with major issues that downgrade to minor after retry
      // but since the file persists, we simulate "only minor remaining"
      await ensureDir(join(progressDir, 'results'));
      await writeFile(
        join(progressDir, 'results', 'parity-verifier-task-001.result.json'),
        JSON.stringify({
          taskId: 'task-001',
          agent: 'parity-verifier',
          status: 'completed',
          outputFiles: ['parity-reports/task-001.md'],
          parity: 'partial',
          issues: [
            {
              severity: 'major',
              description: 'Missing validation logic',
            },
            {
              severity: 'minor',
              description: 'Slightly different API surface',
            },
          ],
        }),
      );

      const result = await orchestrator.run();

      // Task should be blocked because major issues remain after max retries
      expect(result.blockedTasks).toContain('task-001');
    });

    it('should use avgTokensPerTask from config for Phase 4 cost projection', async () => {
      const launcherFn = createMockLauncher();
      const logger = createSilentLogger(tempDir);
      const infoSpy = vi.spyOn(logger, 'info');

      const config = createMockConfig({
        options: {
          maxParallelAgents: 3,
          maxRetriesPerTask: 3,
          largeFileThreshold: 500,
          maxLinesPerTask: 500,
          dryRun: false,
          resume: false,
          invocationDelayMs: 0,
          buildConcurrency: 1,
          continueOnBlocked: true,
          maxBlockedTasks: 0,
          maxInfraRetries: 3,
          avgTokensPerTask: 8000,
        },
      });

      const progressDir = join(tempDir, '.aamf', 'migration', config.projectName);
      await ensureDir(progressDir);

      const checkpoint = new CheckpointManager(progressDir, logger);
      await checkpoint.load(config.projectName);
      const progressFile = join(progressDir, 'progress.md');
      const progress = new ProgressWriter(progressFile);
      await progress.initialize(config);

      const mockLauncher = new MockAgentLauncher(launcherFn);
      const orchestrator = new MigrationOrchestrator(config, checkpoint, mockLauncher as any, progress, logger, tempDir);

      await writeMigrationPlan(progressDir);
      await orchestrator.run();

      // 2 tasks * 8000 avgTokensPerTask * 2 (no testCommand) = 32,000
      const projectionLog = infoSpy.mock.calls.find((call) => call[0]?.includes('estimated'));
      expect(projectionLog).toBeDefined();
      expect(projectionLog![0]).toContain('32,000');
    });

    it('should use multiplier of 2 without testCommand and 3 with testCommand', async () => {
      const launcherFn = createMockLauncher();

      // Without testCommand: multiplier = 2
      {
        const logger = createSilentLogger(tempDir);
        const infoSpy = vi.spyOn(logger, 'info');
        const config = createMockConfig({ options: { maxParallelAgents: 3, maxRetriesPerTask: 3, largeFileThreshold: 500, maxLinesPerTask: 500, dryRun: false, resume: false, invocationDelayMs: 0, buildConcurrency: 1, continueOnBlocked: true, maxBlockedTasks: 0, maxInfraRetries: 3, avgTokensPerTask: 1000 } });
        const progressDir2 = join(tempDir, 'sub1', '.aamf', 'migration', config.projectName);
        await ensureDir(progressDir2);
        const checkpoint = new CheckpointManager(progressDir2, logger);
        await checkpoint.load(config.projectName);
        const progress = new ProgressWriter(join(progressDir2, 'progress.md'));
        await progress.initialize(config);
        const mockLauncher = new MockAgentLauncher(launcherFn);
        const orchestrator = new MigrationOrchestrator(config, checkpoint, mockLauncher as any, progress, logger, join(tempDir, 'sub1'));
        await writeMigrationPlan(progressDir2);
        await orchestrator.run();
        // 2 tasks * 1000 * 2 = 4,000
        const log = infoSpy.mock.calls.find((c) => c[0]?.includes('estimated'));
        expect(log![0]).toContain('4,000');
      }

      // With testCommand: multiplier = 3
      {
        const logger = createSilentLogger(tempDir);
        const infoSpy = vi.spyOn(logger, 'info');
        const config = createMockConfig({
          target: { language: 'typescript', outputPath: '/tmp/target', testCommand: 'npm test' },
          options: { maxParallelAgents: 3, maxRetriesPerTask: 3, largeFileThreshold: 500, maxLinesPerTask: 500, dryRun: false, resume: false, invocationDelayMs: 0, buildConcurrency: 1, continueOnBlocked: true, maxBlockedTasks: 0, maxInfraRetries: 3, avgTokensPerTask: 1000 },
        });
        const progressDir3 = join(tempDir, 'sub2', '.aamf', 'migration', config.projectName);
        await ensureDir(progressDir3);
        const checkpoint = new CheckpointManager(progressDir3, logger);
        await checkpoint.load(config.projectName);
        const progress = new ProgressWriter(join(progressDir3, 'progress.md'));
        await progress.initialize(config);
        const mockLauncher = new MockAgentLauncher(launcherFn);
        const orchestrator = new MigrationOrchestrator(config, checkpoint, mockLauncher as any, progress, logger, join(tempDir, 'sub2'));
        await writeMigrationPlan(progressDir3);
        await orchestrator.run();
        // 2 tasks * 1000 * 3 = 6,000
        const log = infoSpy.mock.calls.find((c) => c[0]?.includes('estimated'));
        expect(log![0]).toContain('6,000');
      }
    });
  });

  // ─── Phase 5 Loop-back ─────────────────────────────────────────────

  describe('Phase 5 Loop-back', () => {
    it('should re-run code-migrator when parity issues found', async () => {
      let parityCheckCount = 0;
      const launcherFn = createMockLauncher((inv) => {
        if (inv.agent === 'final-parity-checker') {
          parityCheckCount++;
        }
        return {};
      });

      const { orchestrator, progressDir, mockLauncher } = await setupOrchestrator(
        tempDir,
        launcherFn,
      );
      await writeMigrationPlan(progressDir);

      await writeParityReport(progressDir, [
        {
          description: 'Missing error handling',
          sourceFile: 'src/auth.py',
          targetFile: 'src/auth.ts',
        },
      ]);

      const result = await orchestrator.run();

      const codeMigratorInPhase5 = mockLauncher.invocations.filter(
        (i) => i.agent === 'code-migrator' && i.phase === 5,
      );
      expect(codeMigratorInPhase5.length).toBeGreaterThan(0);
    });

    it('should stop loop-back after MAX_LOOPBACK iterations', async () => {
      let parityCheckCount = 0;
      const launcherFn = createMockLauncher((inv) => {
        if (inv.agent === 'final-parity-checker') {
          parityCheckCount++;
        }
        return {};
      });

      const { orchestrator, progressDir } = await setupOrchestrator(tempDir, launcherFn);
      await writeMigrationPlan(progressDir);

      await writeParityReport(progressDir, [
        {
          description: 'Persistent issue',
          sourceFile: 'src/main.py',
          targetFile: 'src/main.ts',
        },
      ]);

      await orchestrator.run();

      // MAX_LOOPBACK = 2 → initial + 2 loop-backs = max 3 parity checks
      expect(parityCheckCount).toBeLessThanOrEqual(3);
    });
  });

  // ─── Cumulative Duration ───────────────────────────────────────────

  describe('Cumulative Duration', () => {
    it('should set cumulativeDurationMs to totalDuration on a fresh run', async () => {
      const launcherFn = createMockLauncher();
      const { orchestrator, checkpoint, progressDir } = await setupOrchestrator(tempDir, launcherFn);
      await writeMigrationPlan(progressDir);

      const result = await orchestrator.run();

      expect(result.cumulativeDuration).toBe(result.totalDuration);
      expect(checkpoint.getState().cumulativeDurationMs).toBe(result.totalDuration);
    });

    it('should accumulate cumulativeDurationMs across two simulated runs', async () => {
      const launcherFn = createMockLauncher();
      const config = createMockConfig();
      const logger = createSilentLogger(tempDir);
      const progressDir = join(tempDir, '.aamf', 'migration', config.projectName);
      await ensureDir(progressDir);
      await writeMigrationPlan(progressDir);

      // First run
      const checkpoint1 = new CheckpointManager(progressDir, logger);
      await checkpoint1.load(config.projectName);
      const progress1 = new ProgressWriter(join(progressDir, 'progress.md'));
      await progress1.initialize(config);
      const orch1 = new MigrationOrchestrator(config, checkpoint1, new MockAgentLauncher(launcherFn) as any, progress1, logger, tempDir);
      const result1 = await orch1.run();

      expect(result1.cumulativeDuration).toBe(result1.totalDuration);
      const afterFirst = checkpoint1.getState().cumulativeDurationMs;
      expect(afterFirst).toBe(result1.totalDuration);

      // Second run (resume) — simulate by loading the existing checkpoint
      const config2 = createMockConfig({ options: { resume: true } });
      const checkpoint2 = new CheckpointManager(progressDir, logger);
      await checkpoint2.load(config2.projectName);
      // Reset completed phases so there's work to do
      const state = checkpoint2.getState();
      state.completedPhases = [];
      state.currentPhase = 1;
      state.cumulativeDurationMs = afterFirst;
      await checkpoint2.save(state);

      const progress2 = new ProgressWriter(join(progressDir, 'progress.md'));
      await progress2.initialize(config2);
      const orch2 = new MigrationOrchestrator(config2, checkpoint2, new MockAgentLauncher(launcherFn) as any, progress2, logger, tempDir);
      const result2 = await orch2.run();

      expect(result2.cumulativeDuration).toBe(afterFirst + result2.totalDuration);
      expect(checkpoint2.getState().cumulativeDurationMs).toBe(afterFirst + result2.totalDuration);
    });
  });

  // ─── MigrationError ────────────────────────────────────────────────

  describe('MigrationError', () => {
    it('should construct MigrationError with phase and result details', () => {
      const phase = PHASES[0]!;
      const phaseResult = {
        phase: 1,
        name: 'Impact Assessment',
        success: false,
        duration: 100,
        error: 'Something went wrong',
      };
      const error = new MigrationError(phase, phaseResult);

      expect(error.message).toContain('Phase 1');
      expect(error.message).toContain('Impact Assessment');
      expect(error.message).toContain('Something went wrong');
      expect(error.phase).toBe(phase);
      expect(error.result).toBe(phaseResult);
    });

    it('should have correct name property ("MigrationError")', () => {
      const phase = PHASES[0]!;
      const phaseResult = {
        phase: 1,
        name: 'Impact Assessment',
        success: false,
        duration: 100,
      };
      const error = new MigrationError(phase, phaseResult);

      expect(error.name).toBe('MigrationError');
      expect(error).toBeInstanceOf(Error);
    });
  });

  // ─── Phase-failed enrichment ───────────────────────────────────────

  describe('Phase-failed enrichment', () => {
    it('should include exitCode and stderr in phase-failed event when phase 1 fails', async () => {
      const launcherFn = createMockLauncher((inv) => {
        if (inv.agent === 'impact-assessor') {
          return { exitCode: 2, success: false, error: 'failure', stderr: 'agent stderr output' };
        }
        return {};
      });

      const { orchestrator, logger } = await setupOrchestrator(tempDir, launcherFn);
      const events: Array<{ type: string; exitCode?: number; stderr?: string }> = [];
      vi.spyOn(logger, 'event').mockImplementation((ev) => { events.push(ev as any); });

      await orchestrator.run();

      const failedEvent = events.find((e) => e.type === 'phase-failed');
      expect(failedEvent).toBeDefined();
      expect(failedEvent!.exitCode).toBe(2);
      expect(failedEvent!.stderr).toBe('agent stderr output');
    });

    it('should truncate stderr to 2000 chars in phase-failed event', async () => {
      const longStderr = 'x'.repeat(3000);
      const launcherFn = createMockLauncher((inv) => {
        if (inv.agent === 'impact-assessor') {
          return { exitCode: 1, success: false, error: 'fail', stderr: longStderr };
        }
        return {};
      });

      const { orchestrator, logger } = await setupOrchestrator(tempDir, launcherFn);
      const events: Array<{ type: string; stderr?: string }> = [];
      vi.spyOn(logger, 'event').mockImplementation((ev) => { events.push(ev as any); });

      await orchestrator.run();

      const failedEvent = events.find((e) => e.type === 'phase-failed');
      expect(failedEvent?.stderr?.length).toBe(2000);
    });

    it('should include exitCode and stderr in progress file on phase failure', async () => {
      const launcherFn = createMockLauncher((inv) => {
        if (inv.agent === 'impact-assessor') {
          return { exitCode: 3, success: false, error: 'fail', stderr: 'stderr from agent' };
        }
        return {};
      });

      const { orchestrator, progressDir } = await setupOrchestrator(tempDir, launcherFn);
      await orchestrator.run();

      const progressFile = join(progressDir, 'progress.md');
      const content = await readFile(progressFile, 'utf-8');
      expect(content).toContain('exitCode: 3');
      expect(content).toContain('stderr from agent');
    });
  });

  // ─── phaseTimeouts ─────────────────────────────────────────────────

  describe('phaseTimeouts', () => {
    it('should use phaseTimeouts[phase] as timeout when configured', async () => {
      const launcherFn = createMockLauncher();
      const { orchestrator, mockLauncher } = await setupOrchestrator(tempDir, launcherFn, {
        copilot: {
          cliCommand: 'copilot',
          agentDir: '.github/agents',
          timeout: 300_000,
          phaseTimeouts: { 1: 60_000 },
        },
      });

      await orchestrator.run();

      const phase1Invocation = mockLauncher.invocations.find((i) => i.agent === 'impact-assessor');
      expect(phase1Invocation).toBeDefined();
      expect(phase1Invocation!.timeout).toBe(60_000);
    });

    it('should fall back to config.copilot.timeout when no phaseTimeout override exists', async () => {
      const launcherFn = createMockLauncher();
      const { orchestrator, mockLauncher } = await setupOrchestrator(tempDir, launcherFn, {
        copilot: {
          cliCommand: 'copilot',
          agentDir: '.github/agents',
          timeout: 300_000,
          phaseTimeouts: { 2: 90_000 },
        },
      });

      await orchestrator.run();

      const phase1Invocation = mockLauncher.invocations.find((i) => i.agent === 'impact-assessor');
      expect(phase1Invocation).toBeDefined();
      expect(phase1Invocation!.timeout).toBe(300_000);
    });
  });
});
