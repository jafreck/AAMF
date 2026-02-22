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
});
