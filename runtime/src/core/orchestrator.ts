import { join } from 'node:path';
import { PHASES, PhaseDefinition } from './phase-registry.js';
import { CheckpointManager } from './checkpoint.js';
import { AgentLauncher } from './agent-launcher.js';
import { ProgressWriter } from './progress.js';
import {
  AgentInvocation,
  AgentResult,
  AgentName,
  MigrationResult,
  PhaseResult,
} from '../agents/types.js';
import { ContextBuilder } from '../agents/context-builder.js';
import { ResultParser } from '../agents/result-parser.js';
import { MigrationConfig } from '../config/schema.js';
import { ParallelExecutor } from '../execution/parallel-executor.js';
import { TaskQueue } from '../execution/task-queue.js';
import { RetryExecutor } from '../execution/retry.js';
import { TokenTracker } from '../budget/token-tracker.js';
import { Logger } from '../logging/logger.js';
import { fileExists } from '../util/fs.js';

/** Error thrown when a critical phase fails. */
export class MigrationError extends Error {
  constructor(
    public readonly phase: PhaseDefinition,
    public readonly result: PhaseResult,
  ) {
    super(`Phase ${phase.id} (${phase.name}) failed: ${result.error ?? 'unknown error'}`);
    this.name = 'MigrationError';
  }
}

/**
 * The main orchestrator that sequences all 7 migration phases.
 *
 * Mirrors the logic in `migration-orchestrator.agent.md` but as executable
 * TypeScript rather than a prompt — the orchestrator manages processes, files,
 * checkpoints, and budgets while agents do the actual reasoning.
 */
export class MigrationOrchestrator {
  private readonly contextBuilder: ContextBuilder;
  private readonly tokenTracker: TokenTracker;
  private readonly progressDir: string;

  constructor(
    private readonly config: MigrationConfig,
    private readonly checkpoint: CheckpointManager,
    private readonly launcher: AgentLauncher,
    private readonly progress: ProgressWriter,
    private readonly logger: Logger,
    projectRoot: string,
  ) {
    this.progressDir = join(projectRoot, '.copilot', 'migration', config.projectName);
    this.contextBuilder = new ContextBuilder(config, this.progressDir);
    this.tokenTracker = new TokenTracker();
  }

  // ─── Public API ──────────────────────────────────────────────────────

  async run(): Promise<MigrationResult> {
    const startTime = Date.now();
    const state = this.checkpoint.getState();
    const resumePoint = this.checkpoint.getResumePoint();

    // Restore token usage from checkpoint
    this.tokenTracker.loadFromCheckpoint(state.tokenUsage);

    this.logger.event({ type: 'migration-started', projectName: this.config.projectName });
    await this.progress.appendEvent('Migration started');

    const phaseResults: PhaseResult[] = [];
    let aborted = false;

    for (const phase of PHASES) {
      // Skip already-completed phases on resume
      if (phase.id < resumePoint.phase) {
        phaseResults.push({
          phase: phase.id,
          name: phase.name,
          success: true,
          outputPath: state.phaseOutputs[phase.id],
          duration: 0,
        });
        continue;
      }

      await this.progress.updatePhase(phase.id, 'in-progress');
      this.logger.event({ type: 'phase-started', phase: phase.id, name: phase.name });
      this.logger.setPhase(phase.id);

      const phaseStart = Date.now();
      let result: PhaseResult;

      try {
        result = await this.executePhase(phase);
      } catch (err) {
        result = {
          phase: phase.id,
          name: phase.name,
          success: false,
          duration: Date.now() - phaseStart,
          error: err instanceof Error ? err.message : String(err),
        };
      }

      phaseResults.push(result);

      if (result.success) {
        await this.checkpoint.completePhase(phase.id, result.outputPath ?? '');
        await this.progress.updatePhase(phase.id, 'completed');
        this.logger.event({
          type: 'phase-completed',
          phase: phase.id,
          name: phase.name,
          success: true,
          duration: result.duration,
        });
      } else {
        await this.progress.updatePhase(phase.id, 'failed', result.error);
        this.logger.event({
          type: 'phase-failed',
          phase: phase.id,
          name: phase.name,
          error: result.error ?? 'unknown',
        });

        if (phase.critical) {
          aborted = true;
          await this.progress.appendEvent(`Migration aborted: Phase ${phase.id} failed`);
          break;
        }
      }

      // Budget check
      if (this.config.options.tokenBudget) {
        const threshold = this.tokenTracker.checkThreshold(this.config.options.tokenBudget);
        if (threshold === 'exceeded') {
          this.logger.event({
            type: 'budget-exceeded',
            usage: this.tokenTracker.getTotal(),
            budget: this.config.options.tokenBudget,
          });
          await this.progress.appendEvent('Token budget exceeded — pausing migration');
          aborted = true;
          break;
        }
        if (threshold === 'warning') {
          const pct = Math.round(
            (this.tokenTracker.getTotal() / this.config.options.tokenBudget) * 100,
          );
          this.logger.event({
            type: 'budget-warning',
            usage: this.tokenTracker.getTotal(),
            budget: this.config.options.tokenBudget,
            percentage: pct,
          });
        }
      }

      this.progress.setTokenUsage(this.tokenTracker.getTotal());
    }

    const totalDuration = Date.now() - startTime;
    const finalState = this.checkpoint.getState();

    const migrationResult: MigrationResult = {
      success: !aborted && phaseResults.every((r) => r.success),
      projectName: this.config.projectName,
      phases: phaseResults,
      totalDuration,
      tokenUsage: this.tokenTracker.toCheckpointData(),
      failedTasks: finalState.failedTasks.map((f) => f.taskId),
      blockedTasks: finalState.blockedTasks,
    };

    this.logger.event({
      type: 'migration-completed',
      projectName: this.config.projectName,
      success: migrationResult.success,
      duration: totalDuration,
    });
    await this.progress.finalize(migrationResult);
    return migrationResult;
  }

  // ─── Phase Router ────────────────────────────────────────────────────

  private async executePhase(phase: PhaseDefinition): Promise<PhaseResult> {
    const start = Date.now();
    switch (phase.id) {
      case 1:
        return this.executePhase1(start);
      case 2:
        return this.executePhase2(start);
      case 3:
        return this.executePhase3(start);
      case 4:
        return this.executePhase4(start);
      case 5:
        return this.executePhase5(start);
      case 6:
        return this.executePhase6(start);
      case 7:
        return this.executePhase7(start);
      default:
        throw new Error(`Unknown phase: ${phase.id}`);
    }
  }

  // ─── Phase 1: Impact Assessment ──────────────────────────────────────

  private async executePhase1(start: number): Promise<PhaseResult> {
    const contextFile = await this.contextBuilder.buildContext('impact-assessor', 1);
    const inv = this.buildInvocation('impact-assessor', contextFile, 1);
    const result = await this.launcher.launchAgent(inv);
    this.recordTokens(result, 1);

    const outputPath = join(this.progressDir, 'impact-assessment.md');
    return {
      phase: 1,
      name: 'Impact Assessment',
      success: result.success,
      outputPath,
      duration: Date.now() - start,
      error: result.error,
    };
  }

  // ─── Phase 2: Knowledge Base Construction ────────────────────────────

  private async executePhase2(start: number): Promise<PhaseResult> {
    // 1. Launch knowledge-builder
    const kbContext = await this.contextBuilder.buildContext('knowledge-builder', 2);
    const kbInv = this.buildInvocation('knowledge-builder', kbContext, 2);
    const kbResult = await this.launcher.launchAgent(kbInv);
    this.recordTokens(kbResult, 2);

    if (!kbResult.success) {
      return {
        phase: 2,
        name: 'Knowledge Base Construction',
        success: false,
        duration: Date.now() - start,
        error: kbResult.error,
      };
    }

    // 2. Find large files from KB output — launch analyzers in parallel
    const largeFilesDir = join(this.progressDir, 'knowledge-base', 'large-files');
    if (await fileExists(largeFilesDir)) {
      const { readdir } = await import('node:fs/promises');
      const files = await readdir(largeFilesDir);
      if (files.length > 0) {
        const invocations: AgentInvocation[] = [];
        for (const file of files) {
          const ctx = await this.contextBuilder.buildContext(
            'large-file-analyzer',
            2,
            `lfa-${file}`,
            { filePath: join(largeFilesDir, file) },
          );
          invocations.push(
            this.buildInvocation('large-file-analyzer', ctx, 2, `lfa-${file}`),
          );
        }

        const parallel = new ParallelExecutor(
          this.config.options.maxParallelAgents,
          (inv) => this.launcher.launchAgent(inv),
          this.logger,
        );
        const results = await parallel.executeAll(invocations);
        for (const r of results) this.recordTokens(r, 2);
      }
    }

    const outputPath = join(this.progressDir, 'knowledge-base');
    return {
      phase: 2,
      name: 'Knowledge Base Construction',
      success: true,
      outputPath,
      duration: Date.now() - start,
    };
  }

  // ─── Phase 3: Migration Planning ─────────────────────────────────────

  private async executePhase3(start: number): Promise<PhaseResult> {
    // 1. Launch migration-planner
    const planContext = await this.contextBuilder.buildContext('migration-planner', 3);
    const planInv = this.buildInvocation('migration-planner', planContext, 3);
    const planResult = await this.launcher.launchAgent(planInv);
    this.recordTokens(planResult, 3);

    if (!planResult.success) {
      return {
        phase: 3,
        name: 'Migration Planning',
        success: false,
        duration: Date.now() - start,
        error: planResult.error,
      };
    }

    // 2. Check if adjudicator is needed (competing strategies)
    const adjudicationFile = join(this.progressDir, 'competing-strategies.md');
    if (await fileExists(adjudicationFile)) {
      const adjCtx = await this.contextBuilder.buildContext('adjudicator', 3, undefined, {
        competingStrategiesFile: adjudicationFile,
        decisionType: 'migration-strategy',
      });
      const adjInv = this.buildInvocation('adjudicator', adjCtx, 3);
      const adjResult = await this.launcher.launchAgent(adjInv);
      this.recordTokens(adjResult, 3);
    }

    const outputPath = join(this.progressDir, 'migration-plan.md');
    return {
      phase: 3,
      name: 'Migration Planning',
      success: true,
      outputPath,
      duration: Date.now() - start,
    };
  }

  // ─── Phase 4: Iterative Migration ────────────────────────────────────

  private async executePhase4(start: number): Promise<PhaseResult> {
    const planPath = join(this.progressDir, 'migration-plan.md');
    if (!(await fileExists(planPath))) {
      return {
        phase: 4,
        name: 'Iterative Migration',
        success: false,
        duration: Date.now() - start,
        error: 'migration-plan.md not found — Phase 3 may not have completed',
      };
    }

    // 1. Parse migration plan
    const tasks = await ResultParser.parseMigrationPlan(planPath);
    if (tasks.length === 0) {
      this.logger.warn('No tasks found in migration plan');
      return {
        phase: 4,
        name: 'Iterative Migration',
        success: true,
        outputPath: this.config.target.outputPath,
        duration: Date.now() - start,
      };
    }

    // 2. Topological sort
    const sortedTasks = TaskQueue.topologicalSort(tasks);

    // 3. Build queue, apply checkpoint
    const queue = new TaskQueue(sortedTasks);
    const checkpointState = this.checkpoint.getState();
    queue.markCompleted(checkpointState.completedTasks);
    this.progress.setTotalTasks(sortedTasks.length);

    // 4. Process tasks
    const retryExec = new RetryExecutor(
      (inv) => this.launcher.launchAgent(inv),
      this.logger,
    );

    while (!queue.isComplete()) {
      const readyTasks = queue.getReady();
      if (readyTasks.length === 0) {
        this.logger.error('Deadlock: no tasks are ready but queue is not complete');
        break;
      }

      for (const task of readyTasks) {
        this.logger.event({ type: 'task-started', taskId: task.id, name: task.name });
        await this.checkpoint.setCurrentTask(task.id);
        await this.progress.updateTask(task.id, 'in-progress');

        // a. Code migration with retry
        const migratorCtx = await this.contextBuilder.buildContext(
          'code-migrator',
          4,
          task.id,
          {
            sourceFiles: task.sourceFiles,
            targetFiles: task.targetFiles,
            kbEntry: task.knowledgeBaseRef,
          },
        );
        const migratorInv = this.buildInvocation('code-migrator', migratorCtx, 4, task.id);

        const migratorResult = await retryExec.executeWithRetry(migratorInv, {
          maxAttempts: this.config.options.maxRetriesPerTask,
          onRetry: async (attempt, error) => {
            this.logger.warn(`Retry ${attempt} for ${task.id}: ${error}`);
            await this.checkpoint.failTask(task.id, error, attempt, false);
          },
          onExhausted: async (taskId, lastError) => {
            // Escalate to failure-recovery agent
            const recoveryCtx = await this.contextBuilder.buildContext(
              'failure-recovery',
              4,
              taskId,
              {
                failureReport: lastError,
                sourceFile: task.sourceFiles[0],
                targetFile: task.targetFiles[0],
                kbEntry: task.knowledgeBaseRef,
                attemptNumber: this.config.options.maxRetriesPerTask,
              },
            );
            return this.buildInvocation('failure-recovery', recoveryCtx, 4, taskId);
          },
        });

        this.recordTokens(migratorResult, 4);

        if (!migratorResult.success) {
          queue.markBlocked(task.id);
          await this.checkpoint.blockTask(task.id);
          await this.progress.updateTask(task.id, 'blocked', {
            error: migratorResult.error,
          });
          this.logger.event({
            type: 'task-blocked',
            taskId: task.id,
            name: task.name,
            reason: migratorResult.error ?? 'max retries exceeded',
          });
          continue;
        }

        // b–c. Parity + test-writer in parallel
        const parityCtx = await this.contextBuilder.buildContext(
          'parity-verifier',
          4,
          task.id,
          {
            sourceFile: task.sourceFiles[0],
            targetFile: task.targetFiles[0],
          },
        );
        const testCtx = await this.contextBuilder.buildContext(
          'test-writer',
          4,
          task.id,
          {
            targetFile: task.targetFiles[0],
            kbEntry: task.knowledgeBaseRef,
            testType: 'unit',
          },
        );

        const parallel = new ParallelExecutor(
          2,
          (inv) => this.launcher.launchAgent(inv),
          this.logger,
        );
        const [parityResult, testResult] = await parallel.executeAll([
          this.buildInvocation('parity-verifier', parityCtx, 4, task.id),
          this.buildInvocation('test-writer', testCtx, 4, task.id),
        ]);
        if (parityResult) this.recordTokens(parityResult, 4);
        if (testResult) this.recordTokens(testResult, 4);

        // d. Complete task
        queue.complete(task.id);
        await this.checkpoint.completeTask(task.id);

        const progress = queue.getProgress();
        await this.progress.updateTask(task.id, 'completed', {
          sourceFiles: task.sourceFiles,
          targetFiles: task.targetFiles,
        });
        this.logger.event({
          type: 'task-completed',
          taskId: task.id,
          name: task.name,
          duration: migratorResult.duration,
        });
        this.logger.info(
          `Task progress: ${progress.completed}/${progress.total} (${progress.blocked} blocked)`,
        );
      }
    }

    const finalProgress = queue.getProgress();
    return {
      phase: 4,
      name: 'Iterative Migration',
      success: finalProgress.blocked === 0,
      outputPath: this.config.target.outputPath,
      duration: Date.now() - start,
      error:
        finalProgress.blocked > 0
          ? `${finalProgress.blocked} task(s) blocked after max retries`
          : undefined,
    };
  }

  // ─── Phase 5: Final Parity Verification ──────────────────────────────

  private async executePhase5(start: number): Promise<PhaseResult> {
    const MAX_LOOPBACK = 2;

    for (let iteration = 0; iteration <= MAX_LOOPBACK; iteration++) {
      const ctx = await this.contextBuilder.buildContext('final-parity-checker', 5);
      const inv = this.buildInvocation('final-parity-checker', ctx, 5);
      const result = await this.launcher.launchAgent(inv);
      this.recordTokens(result, 5);

      if (!result.success) {
        return {
          phase: 5,
          name: 'Final Parity Verification',
          success: false,
          duration: Date.now() - start,
          error: result.error,
        };
      }

      // Parse report for required fixes
      const reportPath = join(this.progressDir, 'final-parity-report.md');
      if (!(await fileExists(reportPath))) break;

      const fixes = await ResultParser.parseFinalParityReport(reportPath);
      if (fixes.length === 0) break;

      if (iteration < MAX_LOOPBACK) {
        this.logger.info(
          `Final parity found ${fixes.length} issue(s), loop-back iteration ${iteration + 1}`,
        );
        // Create targeted fix tasks and re-migrate
        for (const fix of fixes) {
          const fixCtx = await this.contextBuilder.buildContext(
            'code-migrator',
            5,
            `fix-${iteration}-${fixes.indexOf(fix)}`,
            {
              sourceFiles: fix.sourceFile ? [fix.sourceFile] : [],
              targetFiles: fix.targetFile ? [fix.targetFile] : [],
              description: fix.description,
            },
          );
          const fixInv = this.buildInvocation(
            'code-migrator',
            fixCtx,
            5,
            `fix-${iteration}-${fixes.indexOf(fix)}`,
          );
          const fixResult = await this.launcher.launchAgent(fixInv);
          this.recordTokens(fixResult, 5);
        }
      } else {
        this.logger.warn('Max loop-back iterations reached, proceeding with remaining issues');
      }
    }

    const outputPath = join(this.progressDir, 'final-parity-report.md');
    return {
      phase: 5,
      name: 'Final Parity Verification',
      success: true,
      outputPath,
      duration: Date.now() - start,
    };
  }

  // ─── Phase 6: E2E Testing & Documentation ────────────────────────────

  private async executePhase6(start: number): Promise<PhaseResult> {
    const e2eCtx = await this.contextBuilder.buildContext('e2e-test-crafter', 6);
    const docCtx = await this.contextBuilder.buildContext('documentation-writer', 6);

    const parallel = new ParallelExecutor(
      2,
      (inv) => this.launcher.launchAgent(inv),
      this.logger,
    );

    const results = await parallel.executeAll([
      this.buildInvocation('e2e-test-crafter', e2eCtx, 6),
      this.buildInvocation('documentation-writer', docCtx, 6),
    ]);

    for (const r of results) this.recordTokens(r, 6);

    const allSuccess = results.every((r) => r.success);
    const errors = results.filter((r) => !r.success).map((r) => r.error);

    return {
      phase: 6,
      name: 'E2E Testing & Documentation',
      success: allSuccess,
      outputPath: this.config.target.outputPath,
      duration: Date.now() - start,
      error: errors.length > 0 ? errors.join('; ') : undefined,
    };
  }

  // ─── Phase 7: Completion ─────────────────────────────────────────────

  private async executePhase7(start: number): Promise<PhaseResult> {
    await this.progress.appendEvent('Migration pipeline complete — finalizing');
    this.logger.info('All phases complete');

    return {
      phase: 7,
      name: 'Completion',
      success: true,
      outputPath: this.progressDir,
      duration: Date.now() - start,
    };
  }

  // ─── Helpers ─────────────────────────────────────────────────────────

  private buildInvocation(
    agent: AgentName,
    contextFile: string,
    phase: number,
    taskId?: string,
  ): AgentInvocation {
    return {
      agent,
      contextFile,
      progressDir: this.progressDir,
      phase,
      taskId,
      timeout: this.config.copilot.timeout,
    };
  }

  private recordTokens(result: AgentResult, phase: number): void {
    if (result.tokenUsage) {
      this.tokenTracker.record(result.agent, phase, result.tokenUsage.total);
    }
  }
}
