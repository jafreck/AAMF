/**
 * Phase 5 — Iterative Migration
 *
 * The core migration loop, supporting both per-task and wave-barrier
 * execution modes.  Extracted from orchestrator.ts (previously ~2500 lines).
 */

import { join } from 'node:path';
import type { FlowExecutionContext } from '@cadre-dev/framework/flow';
import type { MigrationFlowContext, WaveValidationResult } from '../context.js';
import type { PhaseResult, MigrationTask, AgentResult, CompilationUnit } from '../../agents/types.js';
import { toAgentRemediationContext } from '../../agents/types.js';
import { parseMigrationPlan } from '../../agents/plan-parser.js';
import { ParallelExecutor } from '../../execution/parallel-executor.js';
import { TaskQueue } from '../../execution/task-queue.js';
import { RetryExecutor } from '../../execution/retry.js';
import { CostEstimator } from '../../budget/cost-estimator.js';
import { fileExists, readJson, countFileLines } from '../../util/fs.js';
import { formatDuration } from '../../util/format.js';
import {
  AVG_TOKENS_PER_TASK, RETRY_OVERHEAD_MULTIPLIER,
  buildInvocation, launchAgentWithEvents, recordTokens,
  commitForAgent, commitForTask, commitForWave,
  runCommand, runCommandWithRecovery,
  buildRemediationContext, taskScopePayload,
  recordRetryTarget, raiseTerminalExhaustion,
  TerminalExhaustionError,
  getConfiguredRuntimeModel, getQualityGateMode,
  isGitAutomationEnabled, getFailureRecoveryModel, isTransientModelFailure,
  selectModelForInvocation, applyRoutingCaps, getDefaultRoutingModel,
  storeParityResult, checkParityResult, hasNonMinorParityIssues,
  getParityIssueSummary, resolverReducedScope,
  getPhase5TaskState, hasPhase5Substep, markPhase5Substep,
  checkBudget,
} from './shared.js';

export async function executeIterativeMigration(
  flowCtx: FlowExecutionContext<MigrationFlowContext>,
): Promise<PhaseResult> {
  const ctx = flowCtx.context;
  const start = Date.now();
  const planPath = ctx.paths.migrationPlanFile;

  // 1. Parse migration plan
  let tasks: MigrationTask[];
  if (ctx.phase1TaskGraphResult?.outputParsed && Array.isArray(ctx.phase1TaskGraphResult.structuredOutput?.['tasks'])) {
    tasks = ctx.phase1TaskGraphResult.structuredOutput['tasks'] as MigrationTask[];
  } else {
    if (!(await fileExists(planPath))) {
      const mergedPlanPath = join(ctx.paths.artifactsPlanningDir, 'tasks-merged.json');
      if (await fileExists(mergedPlanPath)) {
        ctx.logger.warn('Phase 1 structured output unavailable — falling back to tasks-merged.json');
        tasks = await readJson<MigrationTask[]>(mergedPlanPath);
      } else {
        return {
          phase: 5, name: 'Iterative Migration', success: false, duration: Date.now() - start,
          error: 'migration-plan.md and tasks-merged.json not found — Phase 1 may not have completed',
        };
      }
    } else {
      ctx.logger.warn('Phase 1 structured output unavailable — falling back to parseMigrationPlan');
      tasks = await parseMigrationPlan(planPath);
    }
  }
  if (tasks.length === 0) {
    ctx.logger.warn('No tasks found in migration plan');
    return { phase: 5, name: 'Iterative Migration', success: true, outputPath: ctx.config.target.outputPath, duration: Date.now() - start };
  }

  // 1b. Validate maxLinesPerTask
  const maxLines = ctx.config.options.maxLinesPerTask;
  for (const task of tasks) {
    if (task.lineRange) continue;
    for (const src of task.sourceFiles) {
      try {
        const fullPath = join(ctx.config.source.path, src);
        const lineCount = await countFileLines(fullPath);
        if (lineCount > maxLines) {
          ctx.logger.warn(`Task "${task.id}" source "${src}" has ${lineCount} lines, exceeding maxLinesPerTask (${maxLines})`);
        }
      } catch { /* File may not exist */ }
    }
  }

  // 1c. Cost projection
  const taskCount = tasks.length;
  const agentMultiplier = ctx.config.target.testCommand ? 3 : 2;
  const estimatedTotalTokens = taskCount * AVG_TOKENS_PER_TASK * agentMultiplier * RETRY_OVERHEAD_MULTIPLIER;
  const model = getConfiguredRuntimeModel(ctx);
  const projected = ctx.costEstimator.estimateFromTotal(model, estimatedTotalTokens);
  ctx.logger.info(
    `Phase 5: ${taskCount} tasks, estimated ~${estimatedTotalTokens.toLocaleString()} tokens, ` +
    `projected cost: ${CostEstimator.formatCost(projected.total)} (${model})`,
  );
  await ctx.progress.appendEvent(`Phase 5 projection: ${taskCount} tasks, ~${CostEstimator.formatCost(projected.total)} estimated`);
  if (ctx.config.options.tokenBudget) {
    const currentUsage = ctx.tokenTracker.getTotal();
    if (currentUsage + estimatedTotalTokens > ctx.config.options.tokenBudget) {
      ctx.logger.warn(
        `Projected Phase 5 usage (${estimatedTotalTokens.toLocaleString()}) plus current (${currentUsage.toLocaleString()}) exceeds budget`,
      );
    }
  }

  // 2. Topological sort — SCC-aware
  let sccs: string[][] =
    (ctx.phase1TaskGraphResult?.structuredOutput?.['sccs'] as string[][] | undefined) ?? [];
  if (sccs.length === 0) {
    const sccsFile = join(ctx.paths.artifactsPlanningDir, 'sccs.json');
    if (await fileExists(sccsFile)) {
      try {
        sccs = await readJson<string[][]>(sccsFile);
        ctx.logger.info(`Recovered ${sccs.length} SCC(s) from ${sccsFile}`);
      } catch (err) {
        ctx.logger.warn(`Failed to parse sccs.json: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  const sccMembership = new Map<string, string[]>();
  for (const scc of sccs) for (const id of scc) sccMembership.set(id, scc);

  let sortedTasks: MigrationTask[];
  if (sccs.length > 0) {
    const tasksForSort = tasks.map(t => {
      const myScc = sccMembership.get(t.id);
      if (!myScc) return t;
      const sccSet = new Set(myScc);
      return { ...t, dependencies: t.dependencies.filter(d => !sccSet.has(d)) };
    });
    sortedTasks = TaskQueue.topologicalSort(tasksForSort);
    const origMap = new Map(tasks.map(t => [t.id, t]));
    sortedTasks = sortedTasks.map(t => origMap.get(t.id) ?? t);
  } else {
    sortedTasks = TaskQueue.topologicalSort(tasks);
  }

  // 3. Build queue
  const queue = new TaskQueue(sortedTasks);
  if (sccs.length > 0) queue.setSCCs(sccs);
  const checkpointState = ctx.checkpoint.getState();
  queue.markCompleted(checkpointState.completedTasks);
  ctx.progress.setTotalTasks(sortedTasks.length);
  const completedDurationsMs: number[] = [...checkpointState.completedTaskDurationsMs];

  // 4. Process tasks
  const retryExec = new RetryExecutor(
    (inv) => launchAgentWithEvents(ctx, inv), ctx.logger,
  );
  const continueOnBlocked = ctx.config.options.continueOnBlocked ?? true;
  const maxBlockedTasks = ctx.config.options.maxBlockedTasks ?? 1;
  const executionMode = ctx.config.options.executionMode ?? 'per-task';
  const waveControl = ctx.config.options.waveControl ?? { maxConvergenceIterations: 3 };
  const phase4Parallelism =
    isGitAutomationEnabled(ctx) && executionMode !== 'wave-barrier'
      ? 1 : ctx.config.options.maxParallelAgents;

  ctx.phase5Snapshot = {
    executionMode, phase4DurationMs: 0, completedTaskCount: 0,
    waveCount: 0, waveValidationRuns: 0, waveConvergenceIterations: 0,
    waveConvergenceFailures: 0, waveConvergenceLimitHits: 0,
    buildCommandRuns: 0, testCommandRuns: 0, formatCommandRuns: 0,
    lintCommandRuns: 0, commandRecoveryAttempts: 0, commandInfraRetries: 0,
    recoveryLoopTimeMs: 0,
  };

  if (executionMode === 'wave-barrier') {
    try {
      return await executeWaveBarrier(ctx, start, queue, retryExec, completedDurationsMs,
        continueOnBlocked, maxBlockedTasks, phase4Parallelism, waveControl.maxConvergenceIterations);
    } catch (error) {
      ctx.deferGitCommits = false;
      if (error instanceof TerminalExhaustionError) return buildPhase5TerminalResult(ctx, start, queue, error);
      throw error;
    }
  }

  // Per-task execution mode
  while (!queue.isComplete()) {
    const readyTasks = queue.getReady();
    if (readyTasks.length === 0) {
      const progress = queue.getProgress();
      if (progress.blocked > 0 && progress.remaining > 0) {
        ctx.logger.error(`Deadlock: ${progress.remaining} task(s) remain but none ready (${progress.blocked} blocked)`);
      } else if (progress.remaining > 0) {
        ctx.logger.error('Deadlock: no tasks ready but queue not complete');
      }
      break;
    }

    const batch = TaskQueue.selectNonOverlappingBatch(readyTasks, phase4Parallelism);
    ctx.logger.info(`Executing batch of ${batch.length} task(s) in parallel (${readyTasks.length} ready)`);
    const batchResults = await Promise.allSettled(
      batch.map(task => executeTask(ctx, task, retryExec, queue, completedDurationsMs)),
    );
    const terminalExhaustion = batchResults.find(
      (r): r is PromiseRejectedResult => r.status === 'rejected' && r.reason instanceof TerminalExhaustionError,
    );
    if (terminalExhaustion) return buildPhase5TerminalResult(ctx, start, queue, terminalExhaustion.reason);

    const progress = queue.getProgress();
    if (progress.blocked > 0) {
      if (!continueOnBlocked) { ctx.logger.error(`${progress.blocked} blocked — halting (continueOnBlocked=false)`); break; }
      if (maxBlockedTasks > 0 && progress.blocked >= maxBlockedTasks) { ctx.logger.error(`${progress.blocked} blocked — reached limit`); break; }
      ctx.logger.warn(`${progress.blocked} task(s) blocked, continuing`);
    }
  }

  const finalProgress = queue.getProgress();
  const deadlocked = finalProgress.remaining > 0;
  if (ctx.phase5Snapshot) {
    ctx.phase5Snapshot.phase4DurationMs = Date.now() - start;
    ctx.phase5Snapshot.completedTaskCount = finalProgress.completed;
    ctx.metricsCollector.setPhase4Snapshot(ctx.phase5Snapshot);
    ctx.phase5Snapshot = undefined;
  }

  let waveEndGateError: string | undefined;
  const gateMode = getQualityGateMode(ctx);
  if (!deadlocked && finalProgress.blocked === 0 && gateMode !== 'enforce') {
    const completedWaveTasks = queue.getAllTaskIds()
      .filter(id => queue.isTaskCompleted(id))
      .map(id => queue.getTask(id)!)
      .filter(Boolean);
    waveEndGateError = await runWaveEndQualityGates(ctx, completedWaveTasks);
  }

  return {
    phase: 5, name: 'Iterative Migration',
    success: finalProgress.blocked === 0 && !deadlocked && !waveEndGateError,
    outputPath: ctx.config.target.outputPath, duration: Date.now() - start,
    error: deadlocked
      ? `${finalProgress.remaining} task(s) deadlocked`
      : finalProgress.blocked > 0
        ? `${finalProgress.blocked} task(s) blocked after max retries`
        : waveEndGateError ?? undefined,
  };
}

// ─── Wave Barrier Mode ────────────────────────────────────────────────

async function executeWaveBarrier(
  ctx: MigrationFlowContext, start: number,
  queue: TaskQueue, retryExec: RetryExecutor,
  completedDurationsMs: number[],
  continueOnBlocked: boolean, maxBlockedTasks: number,
  maxParallelAgents: number, maxConvergenceIterations: number,
): Promise<PhaseResult> {
  let wave = 0;
  const taskStartTimes = new Map<string, number>();
  const deferGit = isGitAutomationEnabled(ctx);
  if (deferGit) ctx.deferGitCommits = true;

  while (!queue.isComplete()) {
    const readyTasks = queue.getReady();
    if (readyTasks.length === 0) {
      const progress = queue.getProgress();
      if (progress.blocked > 0 && progress.remaining > 0) {
        ctx.logger.error(`Deadlock: ${progress.remaining} task(s) remain but none ready`);
      } else if (progress.remaining > 0) {
        ctx.logger.error('Deadlock: no tasks ready');
      }
      break;
    }

    const blockedAtWaveStart = queue.getProgress().blocked;
    const waveTasks = readyTasks;
    wave++;
    if (ctx.phase5Snapshot) ctx.phase5Snapshot.waveCount++;
    const waveStart = Date.now();
    const taskIds = waveTasks.map(t => t.id);
    ctx.logger.info(`Wave ${wave}: migrating ${waveTasks.length} task(s)`);
    ctx.logger.event({ type: 'wave-started', wave, taskIds });
    await ctx.progress.appendWaveLifecycle({ wave, milestone: 'started' });

    let migrationResults: Array<{ task: MigrationTask; result: { migrated: boolean; durationMs?: number } }>;
    try {
      migrationResults = await TaskQueue.executePipelined(
        waveTasks, maxParallelAgents,
        async task => {
          if (!taskStartTimes.has(task.id)) taskStartTimes.set(task.id, Date.now());
          return await executeTask(ctx, task, retryExec, queue, completedDurationsMs, 'wave-migration');
        },
      );
    } catch (error) {
      if (error instanceof TerminalExhaustionError) {
        if (deferGit) ctx.deferGitCommits = false;
        return buildPhase5TerminalResult(ctx, start, queue, error);
      }
      throw error;
    }

    ctx.deferGitCommits = false;
    ctx.logger.event({ type: 'wave-completed', wave, taskIds, duration: Date.now() - waveStart });
    await ctx.progress.appendWaveLifecycle({ wave, milestone: 'completed' });
    ctx.logger.event({ type: 'wave-barrier-entered', wave });
    await ctx.progress.appendWaveLifecycle({ wave, milestone: 'barrier-entered' });

    let waveCandidates = migrationResults
      .filter(r => r.result.migrated)
      .map(r => r.task)
      .filter(t => !queue.isTaskBlocked(t.id));

    const barrierStart = Date.now();
    let converged = waveCandidates.length > 0;
    let remainingFailures = 0;

    if (waveCandidates.length > 0) {
      for (let iteration = 1; iteration <= maxConvergenceIterations; iteration++) {
        if (ctx.phase5Snapshot) ctx.phase5Snapshot.waveConvergenceIterations++;
        const validation = await runWaveValidation(ctx, wave);
        if (validation.success) {
          ctx.logger.event({ type: 'wave-convergence-status', wave, iteration, converged: true, remainingFailures: 0 });
          await ctx.progress.appendWaveLifecycle({ wave, milestone: 'convergence', iteration, converged: true, remainingFailures: 0 });
          converged = true; remainingFailures = 0; break;
        }
        converged = false; remainingFailures = waveCandidates.length;
        if (ctx.phase5Snapshot) ctx.phase5Snapshot.waveConvergenceFailures++;
        const failedCheck = validation.failedLabel ?? 'wave-validation';
        const failureSummary = validation.failure?.error ?? `Wave ${wave} ${failedCheck} validation failed`;
        ctx.logger.event({ type: 'wave-convergence-status', wave, iteration, converged: false, remainingFailures });
        await ctx.progress.appendWaveLifecycle({ wave, milestone: 'convergence', iteration, converged: false, remainingFailures });

        if (iteration >= maxConvergenceIterations) break;
        ctx.logger.warn(`Wave ${wave} validation failed, fix wave iteration ${iteration}/${maxConvergenceIterations}`);
        for (const task of waveCandidates) {
          await recordRetryTarget(ctx, {
            scope: 'wave', attempt: iteration, maxAttempts: maxConvergenceIterations,
            taskId: task.id, wave, check: failedCheck, summary: failureSummary,
          });
        }

        try {
          const recovered = await recoverWaveValidationFailure(ctx, wave, waveCandidates, queue, validation);
          if (!recovered) ctx.logger.warn(`Wave ${wave} ${failedCheck} recovery did not converge on iteration ${iteration}`);
        } catch (error) {
          if (error instanceof TerminalExhaustionError) {
            if (deferGit) ctx.deferGitCommits = false;
            return buildPhase5TerminalResult(ctx, start, queue, error);
          }
          throw error;
        }
        waveCandidates = waveCandidates.filter(task => !queue.isTaskBlocked(task.id));
        if (waveCandidates.length === 0) { remainingFailures = 0; break; }
      }
    }

    if (!converged && waveCandidates.length > 0) {
      if (ctx.phase5Snapshot) ctx.phase5Snapshot.waveConvergenceLimitHits++;
      ctx.logger.event({ type: 'wave-convergence-limit-reached', wave, maxIterations: maxConvergenceIterations, remainingFailures });
      await raiseTerminalExhaustion(ctx, {
        reasonCode: 'wave-convergence-exhausted', wave, check: 'wave-validation',
        summary: `Wave ${wave} failed to converge after ${maxConvergenceIterations} iteration(s)`,
      });
    } else {
      const completedIds = waveCandidates
        .filter(t => !queue.isTaskCompleted(t.id) && !queue.isTaskBlocked(t.id))
        .map(t => t.id);
      if (completedIds.length > 0) await commitForWave(ctx, wave, completedIds);
      if (deferGit) ctx.deferGitCommits = true;
      for (const task of waveCandidates) {
        if (queue.isTaskCompleted(task.id) || queue.isTaskBlocked(task.id)) continue;
        const startedAt = taskStartTimes.get(task.id) ?? waveStart;
        await completePhase5Task(ctx, task, queue, completedDurationsMs, Date.now() - startedAt);
      }
    }

    ctx.logger.event({ type: 'wave-barrier-released', wave, duration: Date.now() - barrierStart });
    await ctx.progress.appendWaveLifecycle({ wave, milestone: 'barrier-released' });

    const progress = queue.getProgress();
    const blockedThisWave = progress.blocked - blockedAtWaveStart;
    if (blockedThisWave > 0) {
      if (!continueOnBlocked) { ctx.logger.error(`${progress.blocked} blocked after wave ${wave} — halting`); break; }
      if (maxBlockedTasks > 0 && progress.blocked >= maxBlockedTasks) { ctx.logger.error(`${progress.blocked} blocked — limit reached`); break; }
      ctx.logger.warn(`${progress.blocked} blocked after wave ${wave}, continuing`);
    }
  }

  const finalProgress = queue.getProgress();
  const deadlocked = finalProgress.remaining > 0;
  if (deferGit) ctx.deferGitCommits = false;
  if (ctx.phase5Snapshot) {
    ctx.phase5Snapshot.phase4DurationMs = Date.now() - start;
    ctx.phase5Snapshot.completedTaskCount = finalProgress.completed;
    ctx.metricsCollector.setPhase4Snapshot(ctx.phase5Snapshot);
    ctx.phase5Snapshot = undefined;
  }
  return {
    phase: 5, name: 'Iterative Migration',
    success: finalProgress.blocked === 0 && !deadlocked,
    outputPath: ctx.config.target.outputPath, duration: Date.now() - start,
    error: deadlocked
      ? `${finalProgress.remaining} task(s) deadlocked`
      : finalProgress.blocked > 0 ? `${finalProgress.blocked} task(s) blocked after max retries` : undefined,
  };
}

// ─── Per-Task Execution ───────────────────────────────────────────────

async function executeTask(
  ctx: MigrationFlowContext,
  task: MigrationTask, retryExec: RetryExecutor,
  queue: TaskQueue, completedDurationsMs: number[],
  mode: 'per-task' | 'wave-migration' = 'per-task',
  remediationContext?: import('../../agents/types.js').RemediationContext,
): Promise<{ migrated: boolean; durationMs?: number }> {
  ctx.logger.event({ type: 'task-started', taskId: task.id, name: task.name });
  await ctx.checkpoint.setCurrentTask(task.id);
  await ctx.progress.updateTask(task.id, 'in-progress');

  const taskStartMs = Date.now();
  const taskCursor = getPhase5TaskState(ctx, task.id);
  if (taskCursor.lastSuccessfulStep) {
    ctx.logger.info(`Resuming ${task.id} from substep: ${taskCursor.lastSuccessfulStep}`);
  }
  let completionEventDurationMs = Date.now() - taskStartMs;

  // a. Code migration with retry
  if (!hasPhase5Substep(ctx, task.id, 'migrator')) {
    const migratorCtx = await ctx.contextBuilder.buildContext('code-migrator', 5, task.id, {
      sourceFiles: task.sourceFiles, targetFiles: task.targetFiles,
      kbEntry: task.knowledgeBaseRef, ...taskScopePayload(task),
      ...(remediationContext ? { remediationContext: toAgentRemediationContext(remediationContext) } : {}),
    });
    const migratorInv = buildInvocation(ctx, 'code-migrator', migratorCtx, 5, task.id, task);
    const fallbackModel = getFailureRecoveryModel(ctx);
    const initialRoutingDecision = ctx.config.options.modelRouting?.enabled
      ? selectModelForInvocation(ctx, task, 'code-migrator') : undefined;

    const migratorResult = await retryExec.executeWithRetry(migratorInv, {
      maxAttempts: ctx.config.options.maxRetriesPerTask,
      onRetry: async (attempt, error) => {
        await recordRetryTarget(ctx, {
          scope: remediationContext?.failureKind === 'wave-convergence' ? 'wave' : 'task',
          attempt, maxAttempts: ctx.config.options.maxRetriesPerTask,
          taskId: task.id, wave: remediationContext?.failureTarget.wave,
          check: remediationContext?.failureTarget.check ?? 'code-migrator', summary: error,
        });
        if (fallbackModel && isTransientModelFailure(error) && migratorInv.modelOverride !== fallbackModel) {
          migratorInv.modelOverride = fallbackModel;
          ctx.logger.warn(`Switching ${task.id} code-migrator to fallback model: ${fallbackModel}`);
        } else if (initialRoutingDecision) {
          const routing = ctx.config.options.modelRouting!;
          const escalateAt = routing.escalateOnRetryAttempt ?? 2;
          if (attempt >= escalateAt) {
            const targetTier = initialRoutingDecision.tier === 'normal'
              ? 'heavy' as const : initialRoutingDecision.tier === 'heavy' ? 'critical' as const : 'critical' as const;
            const escalatedModel = targetTier === 'critical'
              ? (routing.criticalModel ?? routing.heavyModel) : routing.heavyModel;
            if (escalatedModel) {
              const retryDecision = applyRoutingCaps(ctx, {
                ...initialRoutingDecision, tier: targetTier, selectedModel: escalatedModel,
                reason: `${initialRoutingDecision.reason}:retry-escalation`, escalated: true,
              }, task.id);
              if (retryDecision.tier !== 'normal') {
                migratorInv.modelOverride = retryDecision.selectedModel;
                migratorInv.routingTier = retryDecision.tier;
                migratorInv.routingReason = retryDecision.reason;
                if (!ctx.routedTaskIds.has(task.id)) ctx.routedTaskIds.add(task.id);
                const defaultModel = getDefaultRoutingModel(ctx);
                const projectedCost = ctx.costEstimator.projectCost(retryDecision.selectedModel, AVG_TOKENS_PER_TASK).total;
                const baseCost = ctx.costEstimator.projectCost(defaultModel, AVG_TOKENS_PER_TASK).total;
                ctx.escalationCostUsd += Math.max(0, projectedCost - baseCost);
                ctx.logger.warn(`Escalating ${task.id} to ${retryDecision.selectedModel} after ${attempt} retries`);
              }
            }
          }
        }
        await ctx.checkpoint.failTask(task.id, error, attempt, false);
      },
      onExhausted: async (taskId, lastError) => {
        const retryExhaustionRemediation = buildRemediationContext({
          failureKind: remediationContext?.failureKind ?? 'task-retry',
          failureSummary: lastError, taskId,
          wave: remediationContext?.failureTarget.wave,
          check: remediationContext?.failureTarget.check ?? 'code-migrator',
          artifactPaths: [...task.sourceFiles, ...task.targetFiles],
          expectedSuccessCondition: `code-migrator succeeds for ${taskId}`,
        });
        const retryContext = await ctx.contextBuilder.buildContext('code-migrator', 5, task.id, {
          sourceFiles: task.sourceFiles, targetFiles: task.targetFiles,
          kbEntry: task.knowledgeBaseRef, ...taskScopePayload(task),
          remediationContext: toAgentRemediationContext(retryExhaustionRemediation),
        });
        migratorInv.contextFile = retryContext;
        const recoveryCtx = await ctx.contextBuilder.buildContext('parity-failure-resolver', 5, taskId, {
          failureReport: lastError, sourceFile: task.sourceFiles[0], targetFile: task.targetFiles[0],
          kbEntry: task.knowledgeBaseRef, attemptNumber: ctx.config.options.maxRetriesPerTask,
          ...taskScopePayload(task), remediationContext: toAgentRemediationContext(retryExhaustionRemediation),
        });
        return buildInvocation(ctx, 'parity-failure-resolver', recoveryCtx, 5, taskId);
      },
    });

    recordTokens(ctx, migratorResult, 5);
    if (!migratorResult.success) {
      await raiseTerminalExhaustion(ctx, {
        reasonCode: 'task-retries-exhausted', taskId: task.id,
        check: remediationContext?.failureTarget.check ?? 'code-migrator',
        wave: remediationContext?.failureTarget.wave,
        summary: migratorResult.error ?? `code-migrator failed after ${ctx.config.options.maxRetriesPerTask} retries`,
      });
    }
    completionEventDurationMs = migratorResult.duration;
    await markPhase5Substep(ctx, task.id, 'migrator');
  }

  if (!hasPhase5Substep(ctx, task.id, 'migrator-commit')) {
    await commitForAgent(ctx, 'code-migrator', 5, task.id, task.name);
    await markPhase5Substep(ctx, task.id, 'migrator-commit');
  }

  // b. Parity + test-writer in parallel
  if (!hasPhase5Substep(ctx, task.id, 'parity-tests')) {
    const parityCtx = await ctx.contextBuilder.buildContext('parity-verifier', 5, task.id, {
      sourceFile: task.sourceFiles[0], targetFile: task.targetFiles[0], ...taskScopePayload(task),
    });
    const testCtx = await ctx.contextBuilder.buildContext('test-writer', 5, task.id, {
      targetFile: task.targetFiles[0], kbEntry: task.knowledgeBaseRef,
      testType: 'unit', ...taskScopePayload(task),
    });
    const parallel = new ParallelExecutor(2, (inv) => launchAgentWithEvents(ctx, inv), ctx.logger);
    const [parityResult, testResult] = await parallel.executeAll([
      buildInvocation(ctx, 'parity-verifier', parityCtx, 5, task.id),
      buildInvocation(ctx, 'test-writer', testCtx, 5, task.id),
    ]);
    ctx.peakConcurrency = Math.max(ctx.peakConcurrency, parallel.peakConcurrency);
    if (parityResult) { recordTokens(ctx, parityResult, 5); storeParityResult(ctx, parityResult, task.id); }
    if (testResult) recordTokens(ctx, testResult, 5);
    if (testResult?.success) await commitForAgent(ctx, 'test-writer', 5, task.id, task.name);
    await markPhase5Substep(ctx, task.id, 'parity-tests');
  }

  const gateMode = getQualityGateMode(ctx);

  // b2. Parity gate
  if (gateMode !== 'skip' && !hasPhase5Substep(ctx, task.id, 'parity-gate')) {
    const maxParityRetries = ctx.config.options.maxRetriesPerTask;
    let parityPassed = checkParityResult(ctx, task.id);

    if (!parityPassed && gateMode === 'enforce') {
      const priorAttempts: Array<{ attempt: number; issueCount: number; unresolvedIssues: string[] }> = [];
      for (let attempt = 1; attempt <= maxParityRetries; attempt++) {
        const issueSummary = getParityIssueSummary(ctx, task.id);
        const enrichedSummary = issueSummary
          ? `Parity verification failed for ${task.id}: ${issueSummary}`
          : `Parity verification failed for ${task.id}`;
        const storedParityResult = ctx.parityResults.get(task.id);
        const parityIssues = storedParityResult?.issues ?? [];
        const parityRemediation = buildRemediationContext({
          failureKind: 'parity', failureSummary: enrichedSummary, taskId: task.id,
          check: 'parity-verifier', artifactPaths: [...task.sourceFiles, ...task.targetFiles],
          expectedSuccessCondition: `Parity checks pass for ${task.id}`,
        });
        parityRemediation.parityIssues = parityIssues;
        if (priorAttempts.length > 0) parityRemediation.priorAttempts = [...priorAttempts];

        await recordRetryTarget(ctx, {
          scope: 'parity', attempt, maxAttempts: maxParityRetries,
          taskId: task.id, check: 'parity-verifier', summary: enrichedSummary,
        });

        const recoveryCtx = await ctx.contextBuilder.buildContext('parity-failure-resolver', 5, task.id, {
          failureReport: enrichedSummary, sourceFile: task.sourceFiles[0], targetFile: task.targetFiles[0],
          kbEntry: task.knowledgeBaseRef, attemptNumber: attempt,
          ...taskScopePayload(task), remediationContext: toAgentRemediationContext(parityRemediation),
        });
        const recoveryInv = buildInvocation(ctx, 'parity-failure-resolver', recoveryCtx, 5, task.id);
        const recoveryResult = await launchAgentWithEvents(ctx, recoveryInv);
        recordTokens(ctx, recoveryResult, 5);
        if (!recoveryResult.success) { ctx.logger.warn(`Parity-failure-resolver failed for ${task.id} on attempt ${attempt}`); continue; }
        if (resolverReducedScope(recoveryResult)) {
          ctx.logger.info(`Resolver adjudicated remaining issues as out-of-scope for ${task.id}`);
          parityPassed = true; break;
        }
        await commitForAgent(ctx, 'parity-failure-resolver', 5, task.id, task.name);

        const reParityCtx = await ctx.contextBuilder.buildContext('parity-verifier', 5, task.id, {
          sourceFile: task.sourceFiles[0], targetFile: task.targetFiles[0], ...taskScopePayload(task),
        });
        const reParityResult = await launchAgentWithEvents(ctx, buildInvocation(ctx, 'parity-verifier', reParityCtx, 5, task.id));
        recordTokens(ctx, reParityResult, 5);
        storeParityResult(ctx, reParityResult, task.id);
        parityPassed = checkParityResult(ctx, task.id);
        if (parityPassed) { ctx.logger.info(`Parity recovered for ${task.id} on attempt ${attempt}`); break; }
        const storedResult = ctx.parityResults.get(task.id);
        const unresolvedIssues = (storedResult?.issues ?? []).filter(i => i.severity !== 'minor').map(i => i.description);
        priorAttempts.push({ attempt, issueCount: storedResult?.issues?.length ?? 0, unresolvedIssues });
      }
      if (!parityPassed) {
        if (hasNonMinorParityIssues(ctx, task.id)) {
          await raiseTerminalExhaustion(ctx, {
            reasonCode: 'parity-non-minor-exhausted', taskId: task.id, check: 'parity-verifier',
            summary: `Parity still has non-minor issues after ${maxParityRetries} attempt(s)`,
          });
        }
        ctx.logger.info(`Parity for ${task.id} has only minor issues after retries, proceeding`);
      }
    } else if (!parityPassed) {
      ctx.logger.warn(`Parity check failed for ${task.id}, deferring enforcement (qualityPolicy=${ctx.config.options.qualityPolicy})`);
    }
    await markPhase5Substep(ctx, task.id, 'parity-gate');
  }

  // b3. Minor-issue repass
  if (gateMode !== 'skip' && !hasPhase5Substep(ctx, task.id, 'minor-parity-repass')) {
    const currentResult = ctx.parityResults.get(task.id);
    if (currentResult && currentResult.issues.length > 0 && currentResult.issues.every(i => i.severity === 'minor')) {
      ctx.logger.info(`${task.id} has ${currentResult.issues.length} minor parity issue(s) — running code-migrator once more`);
      const minorDescriptions = currentResult.issues.map(i => i.description).join('; ');
      const minorRemediation = buildRemediationContext({
        failureKind: 'parity-minor', failureSummary: `Minor parity issues: ${minorDescriptions}`,
        taskId: task.id, check: 'parity-verifier',
        artifactPaths: [...task.sourceFiles, ...task.targetFiles],
        expectedSuccessCondition: `All minor parity issues resolved for ${task.id}`,
      });
      const repassCtx = await ctx.contextBuilder.buildContext('code-migrator', 5, task.id, {
        sourceFiles: task.sourceFiles, targetFiles: task.targetFiles,
        kbEntry: task.knowledgeBaseRef, ...taskScopePayload(task),
        remediationContext: toAgentRemediationContext(minorRemediation),
      });
      const repassResult = await launchAgentWithEvents(ctx, buildInvocation(ctx, 'code-migrator', repassCtx, 5, task.id));
      recordTokens(ctx, repassResult, 5);
      if (repassResult.success) {
        await commitForAgent(ctx, 'code-migrator', 5, task.id, task.name);
        const reParityCtx = await ctx.contextBuilder.buildContext('parity-verifier', 5, task.id, {
          sourceFile: task.sourceFiles[0], targetFile: task.targetFiles[0], ...taskScopePayload(task),
        });
        const reParityResult = await launchAgentWithEvents(ctx, buildInvocation(ctx, 'parity-verifier', reParityCtx, 5, task.id));
        recordTokens(ctx, reParityResult, 5);
        storeParityResult(ctx, reParityResult, task.id);
        const repassParity = ctx.parityResults.get(task.id);
        if (repassParity?.parity === 'pass' || (repassParity && repassParity.issues.length === 0)) {
          ctx.logger.info(`Minor parity issues fully resolved for ${task.id}`);
        } else if (repassParity && repassParity.issues.every(i => i.severity === 'minor')) {
          ctx.logger.info(`${task.id} still has ${repassParity.issues.length} minor issue(s) — accepting`);
        } else {
          ctx.logger.warn(`${task.id} re-pass introduced non-minor issues — reverting`);
          ctx.parityResults.set(task.id, currentResult);
        }
      } else {
        ctx.logger.warn(`Code-migrator re-pass failed for ${task.id} — proceeding with existing minor issues`);
      }
    }
    await markPhase5Substep(ctx, task.id, 'minor-parity-repass');
  }

  if (mode === 'wave-migration') return { migrated: true, durationMs: Date.now() - taskStartMs };

  // c2. Format
  if (ctx.config.target.formatCommand && !hasPhase5Substep(ctx, task.id, 'format')) {
    const formatResult = await runCommand(ctx, 'format', ctx.config.target.formatCommand, task.id);
    if (!formatResult.success) ctx.logger.warn(`Format failed for ${task.id}: ${formatResult.error ?? 'unknown'}`);
    await markPhase5Substep(ctx, task.id, 'format');
  }

  // c3. Build
  if (ctx.config.target.buildCommand && !hasPhase5Substep(ctx, task.id, 'build')) {
    if (gateMode === 'enforce') {
      const buildOk = await runCommandWithRecovery(ctx, 'build', ctx.config.target.buildCommand, task, queue);
      if (!buildOk) return { migrated: false };
      await markPhase5Substep(ctx, task.id, 'build');
    } else if (gateMode === 'advisory') {
      const buildResult = await runCommand(ctx, 'build', ctx.config.target.buildCommand, task.id);
      if (!buildResult.success) ctx.logger.warn(`Build check failed for ${task.id}, deferring enforcement`);
      await markPhase5Substep(ctx, task.id, 'build');
    }
  }

  // c4. Test
  if (ctx.config.target.testCommand && !hasPhase5Substep(ctx, task.id, 'test')) {
    if (gateMode === 'enforce') {
      const testOk = await runCommandWithRecovery(ctx, 'test', ctx.config.target.testCommand, task, queue);
      if (!testOk) return { migrated: false };
      await markPhase5Substep(ctx, task.id, 'test');
    } else if (gateMode === 'advisory') {
      const testResult = await runCommand(ctx, 'test', ctx.config.target.testCommand, task.id);
      if (!testResult.success) ctx.logger.warn(`Test check failed for ${task.id}, deferring enforcement`);
      await markPhase5Substep(ctx, task.id, 'test');
    }
  }

  // d. Complete task
  const durationMs = Date.now() - taskStartMs;
  await completePhase5Task(ctx, task, queue, completedDurationsMs, durationMs, completionEventDurationMs);
  return { migrated: true, durationMs };
}

// ─── Helpers ──────────────────────────────────────────────────────────

function buildPhase5TerminalResult(ctx: MigrationFlowContext, start: number, queue: TaskQueue, error: TerminalExhaustionError): PhaseResult {
  const finalProgress = queue.getProgress();
  if (ctx.phase5Snapshot) {
    ctx.phase5Snapshot.phase4DurationMs = Date.now() - start;
    ctx.phase5Snapshot.completedTaskCount = finalProgress.completed;
    ctx.metricsCollector.setPhase4Snapshot(ctx.phase5Snapshot);
    ctx.phase5Snapshot = undefined;
  }
  return { phase: 5, name: 'Iterative Migration', success: false, outputPath: ctx.config.target.outputPath, duration: Date.now() - start, error: error.message };
}

async function runWaveValidation(ctx: MigrationFlowContext, wave: number): Promise<WaveValidationResult> {
  if (ctx.phase5Snapshot) ctx.phase5Snapshot.waveValidationRuns++;
  const waveTaskId = `wave-${wave}`;
  if (ctx.config.target.formatCommand) {
    const format = await runCommand(ctx, 'format', ctx.config.target.formatCommand, waveTaskId);
    if (!format.success) ctx.logger.warn(`Wave ${wave} format failed: ${format.error ?? 'unknown'}`);
  }
  if (ctx.config.target.buildCommand) {
    const build = await runCommand(ctx, 'build', ctx.config.target.buildCommand, waveTaskId);
    if (!build.success) return { success: false, failedLabel: 'build', failedCommand: ctx.config.target.buildCommand, failure: build };
  }
  if (ctx.config.target.testCommand) {
    const test = await runCommand(ctx, 'test', ctx.config.target.testCommand, waveTaskId);
    if (!test.success) return { success: false, failedLabel: 'test', failedCommand: ctx.config.target.testCommand, failure: test };
  }
  return { success: true };
}

function buildWaveRecoveryTask(wave: number, waveCandidates: MigrationTask[]): MigrationTask {
  const sourceFiles = Array.from(new Set(waveCandidates.flatMap(t => t.sourceFiles)));
  const targetFiles = Array.from(new Set(waveCandidates.flatMap(t => t.targetFiles)));
  const representative = waveCandidates[0];
  return {
    id: `wave-${wave}`, name: `Wave ${wave} validation recovery`,
    sourceFiles, targetFiles,
    knowledgeBaseRef: representative?.knowledgeBaseRef ?? `wave-${wave}`,
    dependencies: [], complexity: 'moderate',
    description: `Recover wave ${wave} validation failure`,
    acceptanceCriteria: [`Wave ${wave} build/test passes`],
    parityChecks: ['wave-validation'],
    lineRange: representative?.lineRange,
  };
}

async function recoverWaveValidationFailure(
  ctx: MigrationFlowContext, wave: number,
  waveCandidates: MigrationTask[], queue: TaskQueue,
  validation: WaveValidationResult,
): Promise<boolean> {
  if (validation.success) return true;
  const { failedLabel, failedCommand, failure } = validation;
  if (!failedLabel || !failedCommand || !failure || failure.success) return false;
  const waveTask = buildWaveRecoveryTask(wave, waveCandidates);
  const artifactPaths = Array.from(new Set(waveCandidates.flatMap(t => [...t.sourceFiles, ...t.targetFiles])));
  return runCommandWithRecovery(ctx, failedLabel, failedCommand, waveTask, queue, {
    initialFailure: failure, wave, retryScope: 'wave', artifactPaths,
    suppressTerminalOnExhaustion: true,
    failureSummary: failure.error ?? `Wave ${wave} ${failedLabel} failed`,
    expectedSuccessCondition: `Wave ${wave} ${failedLabel} passes`,
  });
}

async function completePhase5Task(
  ctx: MigrationFlowContext, task: MigrationTask,
  queue: TaskQueue, completedDurationsMs: number[],
  durationMs: number, eventDurationMs = durationMs,
): Promise<void> {
  queue.complete(task.id);
  await ctx.checkpoint.completeTask(task.id, durationMs);
  completedDurationsMs.push(durationMs);
  const progress = queue.getProgress();
  await ctx.progress.updateTask(task.id, 'completed', { sourceFiles: task.sourceFiles, targetFiles: task.targetFiles });
  ctx.logger.event({ type: 'task-completed', taskId: task.id, name: task.name, duration: eventDurationMs });
  let progressMsg = `Task progress: ${progress.completed}/${progress.total} (${progress.blocked} blocked)`;
  if (completedDurationsMs.length >= 2) {
    const avgMs = completedDurationsMs.reduce((a, b) => a + b, 0) / completedDurationsMs.length;
    const etaMs = progress.remaining * avgMs;
    progressMsg += ` — avg ${formatDuration(avgMs)}/task, ~${formatDuration(etaMs)} remaining`;
  }
  ctx.logger.info(progressMsg);
  await commitForTask(ctx, task);
}

async function runWaveEndQualityGates(
  ctx: MigrationFlowContext, waveTasks: MigrationTask[] = [], waveNumber?: number,
): Promise<string | undefined> {
  const policy = ctx.config.options.qualityPolicy;
  ctx.logger.info(`Running wave-end quality gates (qualityPolicy=${policy})`);
  if (ctx.config.target.buildCommand) {
    const buildResult = await runCommand(ctx, 'build', ctx.config.target.buildCommand, 'wave-end');
    if (!buildResult.success) return `wave-end build gate failed: ${buildResult.error ?? 'unknown'}`;
  }
  if (ctx.config.target.testCommand) {
    const testResult = await runCommand(ctx, 'test', ctx.config.target.testCommand, 'wave-end');
    if (!testResult.success) return `wave-end test gate failed: ${testResult.error ?? 'unknown'}`;
  }

  if (policy === 'deferred-strict' && waveTasks.length > 0) {
    const maxRetries = ctx.config.options.maxRetriesPerTask;
    let failingTasks: MigrationTask[] = [];
    for (const task of waveTasks) {
      if (hasNonMinorParityIssues(ctx, task.id)) failingTasks.push(task);
    }
    if (failingTasks.length === 0) return undefined;
    ctx.logger.info(`Wave-end parity gate: ${failingTasks.length}/${waveTasks.length} task(s) have non-minor issues`);

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      await Promise.all(failingTasks.map(async task => {
        const issueSummary = getParityIssueSummary(ctx, task.id);
        const enrichedSummary = issueSummary ? `Parity failed for ${task.id}: ${issueSummary}` : `Parity failed for ${task.id}`;
        const storedParityResult = ctx.parityResults.get(task.id);
        const parityRemediation = buildRemediationContext({
          failureKind: 'parity', failureSummary: enrichedSummary, taskId: task.id,
          wave: waveNumber, check: 'parity-verifier',
          artifactPaths: [...task.sourceFiles, ...task.targetFiles],
          expectedSuccessCondition: `Parity passes for ${task.id}`,
        });
        parityRemediation.parityIssues = storedParityResult?.issues ?? [];

        const recoveryCtx = await ctx.contextBuilder.buildContext('parity-failure-resolver', 5, task.id, {
          failureReport: enrichedSummary, sourceFile: task.sourceFiles[0], targetFile: task.targetFiles[0],
          kbEntry: task.knowledgeBaseRef, attemptNumber: attempt,
          ...taskScopePayload(task), remediationContext: toAgentRemediationContext(parityRemediation),
        });
        const recoveryResult = await launchAgentWithEvents(ctx, buildInvocation(ctx, 'parity-failure-resolver', recoveryCtx, 5, task.id));
        recordTokens(ctx, recoveryResult, 5);
        if (!recoveryResult.success) return;

        const reMigrateCtx = await ctx.contextBuilder.buildContext('code-migrator', 5, task.id, {
          sourceFiles: task.sourceFiles, targetFiles: task.targetFiles,
          kbEntry: task.knowledgeBaseRef, ...taskScopePayload(task),
          remediationContext: toAgentRemediationContext(parityRemediation),
        });
        const reMigrateResult = await launchAgentWithEvents(ctx, buildInvocation(ctx, 'code-migrator', reMigrateCtx, 5, task.id));
        recordTokens(ctx, reMigrateResult, 5);
        if (!reMigrateResult.success) return;

        const reParityCtx = await ctx.contextBuilder.buildContext('parity-verifier', 5, task.id, {
          sourceFile: task.sourceFiles[0], targetFile: task.targetFiles[0], ...taskScopePayload(task),
        });
        const reParityResult = await launchAgentWithEvents(ctx, buildInvocation(ctx, 'parity-verifier', reParityCtx, 5, task.id));
        recordTokens(ctx, reParityResult, 5);
        storeParityResult(ctx, reParityResult, task.id);
      }));

      const stillFailing: MigrationTask[] = [];
      for (const task of failingTasks) {
        if (hasNonMinorParityIssues(ctx, task.id)) stillFailing.push(task);
      }
      failingTasks = stillFailing;
      if (failingTasks.length === 0) {
        ctx.logger.info(`Wave-end parity remediation converged on attempt ${attempt}`);
        return undefined;
      }
    }

    const firstFailing = failingTasks[0];
    if (firstFailing) {
      await raiseTerminalExhaustion(ctx, {
        reasonCode: 'parity-non-minor-exhausted', taskId: firstFailing.id,
        wave: waveNumber, check: 'parity-verifier',
        summary: `Wave-end parity still has non-minor issues for ${failingTasks.length} task(s)`,
      });
    }
  }
  return undefined;
}
