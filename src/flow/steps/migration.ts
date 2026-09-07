/**
 * Phase 4 — Iterative Migration
 *
 * The core migration loop, supporting both per-task and wave-barrier
 * execution modes.  Extracted from orchestrator.ts (previously ~2500 lines).
 */

import { join } from 'node:path';
import {
  defineFlow, step, loop, parallel, conditional,
  type FlowDefinition, type FlowNode,
  type FlowRunnerOptions,
} from '@cadre-dev/framework/flow';
import type { FlowExecutionContext } from '@cadre-dev/framework/flow';
import type { MigrationFlowContext, WaveValidationResult } from '../context.js';
import type { PhaseResult, MigrationTask } from '../../agents/types.js';
import type { TaskGraphOutput } from './task-graph.js';
import { toAgentRemediationContext } from '../../agents/types.js';
import type { PriorRecoveryAttempt } from '../../agents/types.js';
import { parseMigrationPlan } from '../../agents/plan-parser.js';
import { resolveLoopMaxIterations } from '../iteration-policy.js';
import { ParallelExecutor } from '../../execution/parallel-executor.js';
import { TaskQueue } from '../../execution/task-queue.js';
import { RetryExecutor } from '../../execution/retry.js';
import { CostEstimator } from '../../budget/cost-estimator.js';
import { Phase4CheckpointAdapter } from '../checkpoint-adapter.js';
import { fileExists, readJson, countFileLines } from '../../util/fs.js';

import {
  AVG_TOKENS_PER_TASK, RETRY_OVERHEAD_MULTIPLIER,
  buildInvocation, launchAgentWithEvents, recordTokens,
  commitForAgent, commitForTask, commitForWave,
  runCommand, runCommandWithRecovery,
  buildRemediationContext, taskScopePayload,
  recordRetryTarget, raiseTerminalExhaustion,
  getConfiguredRuntimeModel, getQualityGateMode,
  isGitAutomationEnabled, getFailureRecoveryModel, isTransientModelFailure,
  selectModelForInvocation, applyRoutingCaps, getDefaultRoutingModel,
  storeParityResult, checkParityResult, hasNonMinorParityIssues,
  getParityIssueSummary, resolverReducedScope,
  markPhase4Substep, markPhase4TaskStarted, getPhase4TaskDuration,
  registerPhase4TaskScope,
  assertPhaseSuccess,
} from './shared.js';
import type { Phase4TaskSubstep } from '../phase4-substeps.js';
import { PHASE } from '../phases.js';

const PER_TASK_FLOW_ID = 'phase-4-per-task';
const WAVE_BARRIER_FLOW_ID = 'phase-4-wave-barrier';
const SYNC_EPOCH_FLOW_ID = 'phase-4-sync-epoch';

type RoutingConfig = NonNullable<MigrationFlowContext['config']['models']['routing']>;

function getRoutingHeavyModel(routing: RoutingConfig): string | undefined {
  return routing.heavy;
}

function getRoutingCriticalModel(routing: RoutingConfig): string | undefined {
  return routing.critical;
}

function buildWaveTaskBranch(
  task: MigrationTask,
  retryExec: RetryExecutor,
  gateMode: ReturnType<typeof getQualityGateMode>,
): FlowNode<MigrationFlowContext>[] {
  const branchSteps: FlowNode<MigrationFlowContext>[] = [
    step<MigrationFlowContext>({
      id: `${task.id}/migrate`,
      run: (c) => runTrackedPhase4TaskSubstep(c, task, 'migrate', () =>
        runMigrateSubstep(c.context, task, retryExec)),
    }),
    step<MigrationFlowContext>({
      id: `${task.id}/commit`,
      run: (c) => runTrackedPhase4TaskSubstep(c, task, 'commit', () =>
        runCommitSubstep(c.context, task)),
    }),
    step<MigrationFlowContext>({
      id: `${task.id}/parity`,
      run: (c) => runTrackedPhase4TaskSubstep(c, task, 'parity', () =>
        runParitySubstep(c.context, task)),
    }),
  ];
  if (gateMode !== 'skip') {
    branchSteps.push(
      step<MigrationFlowContext>({
        id: `${task.id}/parity-gate`,
        run: (c) => runTrackedPhase4TaskSubstep(c, task, 'parity-gate', () =>
          runParityGateSubstep(c.context, task)),
      }),
      step<MigrationFlowContext>({
        id: `${task.id}/minor-repass`,
        run: (c) => runTrackedPhase4TaskSubstep(c, task, 'minor-repass', () =>
          runMinorRepassSubstep(c.context, task)),
      }),
    );
  }
  branchSteps.push(step<MigrationFlowContext>({
    id: `${task.id}/target-index`,
    run: (c) => runTrackedPhase4TaskSubstep(c, task, 'target-index', () =>
      runTargetIndexSubstep(c.context, task)),
  }));
  return branchSteps;
}

async function runTrackedPhase4TaskSubstep<T>(
  flowCtx: FlowExecutionContext<MigrationFlowContext>,
  task: MigrationTask,
  substep: Phase4TaskSubstep,
  action: () => Promise<T>,
): Promise<T> {
  if (flowCtx.context.checkpoint.getState().completedTasks.includes(task.id)) {
    return undefined as T;
  }
  if (substep === 'migrate') await markPhase4TaskStarted(flowCtx.context, task.id);
  try {
    const result = await action();
    await markPhase4Substep(flowCtx.context, task.id, substep, flowCtx.executionPath.join('/'));
    return result;
  } catch (error) {
    await rollbackTaskCandidate(flowCtx.context, task.id);
    throw error;
  }
}

async function rollbackTaskCandidate(ctx: MigrationFlowContext, taskId: string): Promise<void> {
  // A shared wave/epoch scope is rolled back only after its parallel work has
  // quiesced (or by the runtime resource scope on fatal exit).
  if (ctx.targetChanges.isSharedTaskScope(taskId)) return;
  const rolledBack = await ctx.targetChanges.rollbackTask(taskId);
  if (rolledBack) await invalidateRolledBackTarget(ctx);
}

async function rollbackScopeCandidate(ctx: MigrationFlowContext, scopeId: string): Promise<void> {
  if (!(await ctx.targetChanges.has(scopeId))) return;
  await ctx.targetChanges.rollback(scopeId);
  await invalidateRolledBackTarget(ctx);
}

async function invalidateRolledBackTarget(ctx: MigrationFlowContext): Promise<void> {
  if (ctx.targetKbServer) {
    await ctx.targetKbServer.stop();
    ctx.targetKbServer = undefined;
  }
  if (ctx.targetIndexer) await ctx.targetIndexer.invalidate();
}

async function completePhase4Tasks(
  ctx: MigrationFlowContext,
  tasks: MigrationTask[],
  executionId?: string,
): Promise<void> {
  const alreadyCompleted = new Set(ctx.checkpoint.getState().completedTasks);
  const newlyCompleted = tasks.filter(task => !alreadyCompleted.has(task.id));
  await ctx.checkpoint.completeTasks(tasks.map(task => ({
    taskId: task.id,
    durationMs: getPhase4TaskDuration(ctx, task.id),
    ...(tasks.length === 1 && executionId ? { executionId } : {}),
  })));

  for (const task of newlyCompleted) {
    const duration = getPhase4TaskDuration(ctx, task.id) ?? 0;
    await ctx.progress.updateTask(task.id, 'completed', {
      sourceFiles: task.sourceFiles,
      targetFiles: task.targetFiles,
    });
    ctx.logger.event({ type: 'task-completed', taskId: task.id, name: task.name, duration });
  }
  if (ctx.phase4Snapshot) ctx.phase4Snapshot.completedTaskCount += newlyCompleted.length;
}

function computeTargetOverlapPredecessors(tasks: MigrationTask[]): Map<string, string[]> {
  const predecessors = new Map<string, Set<string>>();
  const lastWriterByTarget = new Map<string, string>();

  for (const task of tasks) {
    for (const targetFile of new Set(task.targetFiles)) {
      const previousTaskId = lastWriterByTarget.get(targetFile);
      if (previousTaskId && previousTaskId !== task.id) {
        const deps = predecessors.get(task.id) ?? new Set<string>();
        deps.add(previousTaskId);
        predecessors.set(task.id, deps);
      }
      lastWriterByTarget.set(targetFile, task.id);
    }
  }

  return new Map(
    [...predecessors.entries()].map(([taskId, deps]) => [taskId, [...deps]]),
  );
}

function splitWaveIntoNonOverlappingBatches(tasks: MigrationTask[]): MigrationTask[][] {
  const pending = [...tasks];
  const batches: MigrationTask[][] = [];

  while (pending.length > 0) {
    const batch = TaskQueue.selectNonOverlappingBatch(pending, pending.length);
    if (batch.length === 0) {
      throw new Error('Failed to build a non-overlapping task batch for wave execution');
    }
    batches.push(batch);
    const batchIds = new Set(batch.map(task => task.id));
    for (let i = pending.length - 1; i >= 0; i--) {
      if (batchIds.has(pending[i]!.id)) pending.splice(i, 1);
    }
  }

  return batches;
}

// ─── Substep Functions ───────────────────────────────────────────────
// Each function executes one logical substep within a per-task migration.
// The framework's checkpoint skip replaces the manual hasPhase4Substep guards.

async function runMigrateSubstep(
  ctx: MigrationFlowContext, task: MigrationTask, retryExec: RetryExecutor,
  remediationContext?: import('../../agents/types.js').RemediationContext,
): Promise<{ durationMs: number }> {
  const changeScope = ctx.targetChanges.scopeForTask(task.id);
  await ctx.targetChanges.begin(changeScope, {
    mode: ctx.targetChanges.isSharedTaskScope(task.id) ? 'full' : 'tracked',
    files: task.targetFiles,
  });
  const migratorCtx = await ctx.contextBuilder.buildContext('code-migrator', PHASE.MIGRATION, task.id, {
    sourceFiles: task.sourceFiles, targetFiles: task.targetFiles,
    kbEntry: task.knowledgeBaseRef, ...taskScopePayload(task),
    ...(remediationContext ? { remediationContext: toAgentRemediationContext(remediationContext) } : {}),
  });
  const migratorInv = buildInvocation(ctx, 'code-migrator', migratorCtx, PHASE.MIGRATION, task.id, task);
  const fallbackModel = getFailureRecoveryModel(ctx);
  const routing = ctx.config.models?.routing;
  const initialRoutingDecision = routing?.enabled
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
        const routing = ctx.config.models?.routing;
        if (!routing) return;
        const escalateAt = routing.escalateOnRetryAttempt ?? 2;
        if (attempt >= escalateAt) {
          const targetTier = initialRoutingDecision.tier === 'normal'
            ? 'heavy' as const : initialRoutingDecision.tier === 'heavy' ? 'critical' as const : 'critical' as const;
          const escalatedModel = targetTier === 'critical'
            ? (getRoutingCriticalModel(routing) ?? getRoutingHeavyModel(routing))
            : getRoutingHeavyModel(routing);
          if (escalatedModel) {
            const retryDecision = applyRoutingCaps(ctx, {
              ...initialRoutingDecision, tier: targetTier, selectedModel: escalatedModel,
              reason: `${initialRoutingDecision.reason}:retry-escalation`, escalated: true,
            }, task.id);
            if (retryDecision.tier !== 'normal') {
              migratorInv.modelOverride = retryDecision.selectedModel;
              migratorInv.extensions = {
                ...migratorInv.extensions,
                routingTier: retryDecision.tier,
                routingReason: retryDecision.reason,
              };
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
      const retryContext = await ctx.contextBuilder.buildContext('code-migrator', PHASE.MIGRATION, task.id, {
        sourceFiles: task.sourceFiles, targetFiles: task.targetFiles,
        kbEntry: task.knowledgeBaseRef, ...taskScopePayload(task),
        remediationContext: toAgentRemediationContext(retryExhaustionRemediation),
      });
      migratorInv.contextPath = retryContext.contextPath;
      migratorInv.outputPath = retryContext.outputPath;
      const recoveryCtx = await ctx.contextBuilder.buildContext('parity-failure-resolver', PHASE.MIGRATION, taskId, {
        failureReport: lastError, sourceFiles: task.sourceFiles, targetFiles: task.targetFiles,
        kbEntry: task.knowledgeBaseRef, attemptNumber: ctx.config.options.maxRetriesPerTask,
        ...taskScopePayload(task), remediationContext: toAgentRemediationContext(retryExhaustionRemediation),
      });
      return buildInvocation(ctx, 'parity-failure-resolver', recoveryCtx, PHASE.MIGRATION, taskId);
    },
  });

  await ctx.targetChanges.trackFiles(
    changeScope,
    migratorResult.extensions.outputFiles ?? task.targetFiles,
  );

  recordTokens(ctx, migratorResult, PHASE.MIGRATION);
  if (!migratorResult.success) {
    await raiseTerminalExhaustion(ctx, {
      reasonCode: 'task-retries-exhausted', taskId: task.id,
      check: remediationContext?.failureTarget.check ?? 'code-migrator',
      wave: remediationContext?.failureTarget.wave,
      summary: migratorResult.error ?? `code-migrator failed after ${ctx.config.options.maxRetriesPerTask} retries`,
    });
  }
  return { durationMs: migratorResult.duration };
}

async function runCommitSubstep(
  ctx: MigrationFlowContext, task: MigrationTask,
): Promise<void> {
  await commitForAgent(ctx, 'code-migrator', PHASE.MIGRATION, task.id, task.name);
}

async function runTargetIndexSubstep(
  ctx: MigrationFlowContext, task: MigrationTask,
): Promise<void> {
  if (!ctx.targetIndexer) return;
  // Serialize all target DB writes through gitLimiter (pLimit(1))
  // to prevent SQLITE_BUSY under concurrent task execution.
  await ctx.gitLimiter(async () => {
    try {
      await ctx.targetIndexer!.updateForFiles(task.targetFiles);
    } catch (err) {
      ctx.logger.warn(`Target index update failed for ${task.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}

async function runParitySubstep(
  ctx: MigrationFlowContext, task: MigrationTask,
): Promise<void> {
  const parityCtx = await ctx.contextBuilder.buildContext('parity-verifier', PHASE.MIGRATION, task.id, {
    sourceFiles: task.sourceFiles, targetFiles: task.targetFiles, ...taskScopePayload(task),
  });
  const testCtx = await ctx.contextBuilder.buildContext('test-writer', PHASE.MIGRATION, task.id, {
    sourceFiles: task.sourceFiles, targetFiles: task.targetFiles, kbEntry: task.knowledgeBaseRef,
    testType: 'unit', ...taskScopePayload(task),
  });
  const parallelExec = new ParallelExecutor(2, (inv) => launchAgentWithEvents(ctx, inv), ctx.logger);
  const [parityResult, testResult] = await parallelExec.executeAll([
    buildInvocation(ctx, 'parity-verifier', parityCtx, PHASE.MIGRATION, task.id),
    buildInvocation(ctx, 'test-writer', testCtx, PHASE.MIGRATION, task.id),
  ]);
  ctx.peakConcurrency = Math.max(ctx.peakConcurrency, parallelExec.peakConcurrency);
  if (parityResult) { recordTokens(ctx, parityResult, PHASE.MIGRATION); storeParityResult(ctx, parityResult, task.id); }
  if (testResult) recordTokens(ctx, testResult, PHASE.MIGRATION);
  if (testResult) {
    await ctx.targetChanges.trackFiles(
      ctx.targetChanges.scopeForTask(task.id),
      testResult.extensions.outputFiles ?? [],
    );
  }
  if (testResult?.success) await commitForAgent(ctx, 'test-writer', PHASE.MIGRATION, task.id, task.name);
  if (!parityResult?.success || !testResult?.success) {
    const failed = [parityResult, testResult].find(result => !result?.success);
    assertPhaseSuccess({
      phase: 4, name: 'Iterative Migration', success: false, duration: 0,
      error: failed?.error ?? `Required parity/test work failed for ${task.id}`,
      exitCode: failed?.exitCode ?? undefined,
      stderr: failed?.stderr,
    });
  }
}

async function runParityGateSubstep(
  ctx: MigrationFlowContext, task: MigrationTask,
): Promise<void> {
  const gateMode = getQualityGateMode(ctx);
  if (gateMode === 'skip') return;

  const maxParityRetries = ctx.config.options.maxRetriesPerTask;
  let parityPassed = checkParityResult(ctx, task.id);

  if (!parityPassed && gateMode === 'enforce') {
    const priorAttempts: PriorRecoveryAttempt[] = [];
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

      const recoveryCtx = await ctx.contextBuilder.buildContext('parity-failure-resolver', PHASE.MIGRATION, task.id, {
        failureReport: enrichedSummary, sourceFiles: task.sourceFiles, targetFiles: task.targetFiles,
        kbEntry: task.knowledgeBaseRef, attemptNumber: attempt,
        ...taskScopePayload(task), remediationContext: toAgentRemediationContext(parityRemediation),
      });
      const recoveryInv = buildInvocation(ctx, 'parity-failure-resolver', recoveryCtx, PHASE.MIGRATION, task.id);
      const recoveryResult = await launchAgentWithEvents(ctx, recoveryInv);
      recordTokens(ctx, recoveryResult, PHASE.MIGRATION);
      await ctx.targetChanges.trackFiles(
        ctx.targetChanges.scopeForTask(task.id),
        recoveryResult.extensions.outputFiles ?? task.targetFiles,
      );
      if (!recoveryResult.success) { ctx.logger.warn(`Parity-failure-resolver failed for ${task.id} on attempt ${attempt}`); continue; }
      if (resolverReducedScope(recoveryResult)) {
        ctx.logger.info(`Resolver adjudicated remaining issues as out-of-scope for ${task.id}`);
        parityPassed = true; break;
      }
      await commitForAgent(ctx, 'parity-failure-resolver', PHASE.MIGRATION, task.id, task.name);

      const reParityCtx = await ctx.contextBuilder.buildContext('parity-verifier', PHASE.MIGRATION, task.id, {
        sourceFiles: task.sourceFiles, targetFiles: task.targetFiles, ...taskScopePayload(task),
      });
      const reParityResult = await launchAgentWithEvents(ctx, buildInvocation(ctx, 'parity-verifier', reParityCtx, PHASE.MIGRATION, task.id));
      recordTokens(ctx, reParityResult, PHASE.MIGRATION);
      storeParityResult(ctx, reParityResult, task.id);
      parityPassed = checkParityResult(ctx, task.id);
      if (parityPassed) { ctx.logger.info(`Parity recovered for ${task.id} on attempt ${attempt}`); break; }
      const storedResult = ctx.parityResults.get(task.id);
      const unresolvedIssues = (storedResult?.issues ?? []).filter(i => i.severity !== 'minor').map(i => i.description);
      priorAttempts.push({ attempt, issueCount: storedResult?.issues?.length ?? 0, unresolvedIssues, fullIssues: storedResult?.issues });
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

}

async function runMinorRepassSubstep(
  ctx: MigrationFlowContext, task: MigrationTask,
): Promise<void> {
  const gateMode = getQualityGateMode(ctx);
  if (gateMode === 'skip') return;

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
    const repassCtx = await ctx.contextBuilder.buildContext('code-migrator', PHASE.MIGRATION, task.id, {
      sourceFiles: task.sourceFiles, targetFiles: task.targetFiles,
      kbEntry: task.knowledgeBaseRef, ...taskScopePayload(task),
      remediationContext: toAgentRemediationContext(minorRemediation),
    });
    const repassScope = `${ctx.targetChanges.scopeForTask(task.id)}/minor-repass`;
    await ctx.targetChanges.begin(repassScope, { mode: 'tracked', files: task.targetFiles });
    const repassResult = await launchAgentWithEvents(ctx, buildInvocation(ctx, 'code-migrator', repassCtx, PHASE.MIGRATION, task.id));
    recordTokens(ctx, repassResult, PHASE.MIGRATION);
    await ctx.targetChanges.trackFiles(repassScope, repassResult.extensions.outputFiles ?? task.targetFiles);
    if (repassResult.success) {
      const reParityCtx = await ctx.contextBuilder.buildContext('parity-verifier', PHASE.MIGRATION, task.id, {
        sourceFiles: task.sourceFiles, targetFiles: task.targetFiles, ...taskScopePayload(task),
      });
      const reParityResult = await launchAgentWithEvents(ctx, buildInvocation(ctx, 'parity-verifier', reParityCtx, PHASE.MIGRATION, task.id));
      recordTokens(ctx, reParityResult, PHASE.MIGRATION);
      if (!reParityResult.success) {
        await ctx.targetChanges.rollback(repassScope);
        assertPhaseSuccess({
          phase: 4, name: 'Iterative Migration', success: false, duration: 0,
          error: reParityResult.error ?? `Minor re-pass verification failed for ${task.id}`,
          exitCode: reParityResult.exitCode ?? undefined,
          stderr: reParityResult.stderr,
        });
      }
      storeParityResult(ctx, reParityResult, task.id);
      const repassParity = ctx.parityResults.get(task.id);
      if (repassParity?.parity === 'pass' || (repassParity && repassParity.issues.length === 0)) {
        ctx.logger.info(`Minor parity issues fully resolved for ${task.id}`);
        await ctx.targetChanges.accept(repassScope);
      } else if (repassParity && repassParity.issues.every(i => i.severity === 'minor')) {
        ctx.logger.info(`${task.id} still has ${repassParity.issues.length} minor issue(s) — accepting`);
        await ctx.targetChanges.accept(repassScope);
      } else {
        ctx.logger.warn(`${task.id} re-pass introduced non-minor issues — reverting`);
        await ctx.targetChanges.rollback(repassScope);
        ctx.parityResults.set(task.id, currentResult);
      }
    } else {
      await ctx.targetChanges.rollback(repassScope);
      ctx.logger.warn(`Code-migrator re-pass failed for ${task.id} — proceeding with existing minor issues`);
    }
  }
}

async function runFormatSubstep(ctx: MigrationFlowContext, task: MigrationTask): Promise<void> {
  if (!ctx.config.target.formatCommand) return;
  const formatResult = await runCommand(ctx, 'format', ctx.config.target.formatCommand, task.id);
  if (!formatResult.success) ctx.logger.warn(`Format failed for ${task.id}: ${formatResult.error ?? 'unknown'}`);
}

async function runBuildSubstep(ctx: MigrationFlowContext, task: MigrationTask): Promise<void> {
  if (!ctx.config.target.buildCommand) return;
  const gateMode = getQualityGateMode(ctx);
  if (gateMode === 'enforce') {
    await runCommandWithRecovery(ctx, 'build', ctx.config.target.buildCommand, task);
  } else if (gateMode === 'advisory') {
    const buildResult = await runCommand(ctx, 'build', ctx.config.target.buildCommand, task.id);
    if (!buildResult.success) ctx.logger.warn(`Build check failed for ${task.id}, deferring enforcement`);
  }
}

async function runTestSubstep(ctx: MigrationFlowContext, task: MigrationTask): Promise<void> {
  if (!ctx.config.target.testCommand) return;
  const gateMode = getQualityGateMode(ctx);
  if (gateMode === 'enforce') {
    await runCommandWithRecovery(ctx, 'test', ctx.config.target.testCommand, task);
  } else if (gateMode === 'advisory') {
    const testResult = await runCommand(ctx, 'test', ctx.config.target.testCommand, task.id);
    if (!testResult.success) ctx.logger.warn(`Test check failed for ${task.id}, deferring enforcement`);
  }
}

// ─── Flow Builders ───────────────────────────────────────────────────

/**
 * Build a per-task nested flow where each task is a sequence of substeps
 * and tasks are ordered by their dependency edges.
 */
function buildPerTaskFlow(
  ctx: MigrationFlowContext,
  tasks: MigrationTask[],
  retryExec: RetryExecutor,
): FlowDefinition<MigrationFlowContext> {
  const taskSet = new Set(tasks.map(t => t.id));
  const gateMode = getQualityGateMode(ctx);
  const overlapPredecessors = computeTargetOverlapPredecessors(tasks);
  const overlapDependencyCount = [...overlapPredecessors.values()].reduce((sum, deps) => sum + deps.length, 0);

  const nodes: FlowNode<MigrationFlowContext>[] = [];

  if (overlapDependencyCount > 0) {
    ctx.logger.info(
      `Per-task mode: added ${overlapDependencyCount} target-overlap ordering edge(s) across ` +
      `${overlapPredecessors.size} task(s)`,
    );
  }

  for (const task of tasks) {
    const deps = new Set(task.dependencies.filter(d => taskSet.has(d)));
    for (const overlapDep of overlapPredecessors.get(task.id) ?? []) deps.add(overlapDep);
    const substepIds: string[] = [];

    // Migrate
    const migrateId = `${task.id}/migrate`;
    nodes.push(step<MigrationFlowContext>({
      id: migrateId,
      dependsOn: deps.size > 0 ? [...deps].map(d => `${d}/complete`) : undefined,
      run: (c) => runTrackedPhase4TaskSubstep(c, task, 'migrate', () =>
        runMigrateSubstep(c.context, task, retryExec)),
    }));
    substepIds.push(migrateId);

    // Commit
    const commitId = `${task.id}/commit`;
    nodes.push(step<MigrationFlowContext>({
      id: commitId,
      dependsOn: [migrateId],
      run: (c) => runTrackedPhase4TaskSubstep(c, task, 'commit', () =>
        runCommitSubstep(c.context, task)),
    }));
    substepIds.push(commitId);

    // Parity + test writer
    const parityId = `${task.id}/parity`;
    nodes.push(step<MigrationFlowContext>({
      id: parityId,
      dependsOn: [commitId],
      run: (c) => runTrackedPhase4TaskSubstep(c, task, 'parity', () =>
        runParitySubstep(c.context, task)),
    }));
    substepIds.push(parityId);

    let lastId = parityId;

    if (gateMode !== 'skip') {
      const parityGateId = `${task.id}/parity-gate`;
      nodes.push(step<MigrationFlowContext>({
        id: parityGateId,
        dependsOn: [parityId],
        run: (c) => runTrackedPhase4TaskSubstep(c, task, 'parity-gate', () =>
          runParityGateSubstep(c.context, task)),
      }));
      substepIds.push(parityGateId);

      const repassId = `${task.id}/minor-repass`;
      nodes.push(step<MigrationFlowContext>({
        id: repassId,
        dependsOn: [parityGateId],
        run: (c) => runTrackedPhase4TaskSubstep(c, task, 'minor-repass', () =>
          runMinorRepassSubstep(c.context, task)),
      }));
      substepIds.push(repassId);
      lastId = repassId;
    }

    if (ctx.config.target.formatCommand) {
      const fmtId = `${task.id}/format`;
      nodes.push(step<MigrationFlowContext>({
        id: fmtId,
        dependsOn: [lastId],
        run: (c) => runTrackedPhase4TaskSubstep(c, task, 'format', () =>
          runFormatSubstep(c.context, task)),
      }));
      substepIds.push(fmtId);
      lastId = fmtId;
    }
    if (ctx.config.target.buildCommand) {
      const buildId = `${task.id}/build`;
      nodes.push(step<MigrationFlowContext>({
        id: buildId,
        dependsOn: [lastId],
        run: (c) => runTrackedPhase4TaskSubstep(c, task, 'build', () =>
          runBuildSubstep(c.context, task)),
      }));
      substepIds.push(buildId);
      lastId = buildId;
    }
    if (ctx.config.target.testCommand) {
      const testId = `${task.id}/test`;
      nodes.push(step<MigrationFlowContext>({
        id: testId,
        dependsOn: [lastId],
        run: (c) => runTrackedPhase4TaskSubstep(c, task, 'test', () =>
          runTestSubstep(c.context, task)),
      }));
      substepIds.push(testId);
      lastId = testId;
    }

    // Publish to the target index only after every required quality gate.
    const targetIndexId = `${task.id}/target-index`;
    nodes.push(step<MigrationFlowContext>({
      id: targetIndexId,
      dependsOn: [lastId],
      run: (c) => runTrackedPhase4TaskSubstep(c, task, 'target-index', () =>
        runTargetIndexSubstep(c.context, task)),
    }));
    substepIds.push(targetIndexId);
    lastId = targetIndexId;

    // Completion marker for dependency tracking
    const completeId = `${task.id}/complete`;
    nodes.push(step<MigrationFlowContext>({
      id: completeId,
      dependsOn: [lastId],
      run: async (c) => {
        if (c.context.checkpoint.getState().completedTasks.includes(task.id)) return;
        await commitForTask(c.context, task);
        await completePhase4Tasks(c.context, [task], c.executionPath.join('/'));
        await c.context.targetChanges.accept(c.context.targetChanges.scopeForTask(task.id));
      },
    }));
  }

  return defineFlow(PER_TASK_FLOW_ID, nodes);
}

/**
 * Build a wave-barrier nested flow from pre-computed topological waves.
 */
function buildWaveBarrierFlow(
  ctx: MigrationFlowContext,
  waves: MigrationTask[][],
  retryExec: RetryExecutor,
): FlowDefinition<MigrationFlowContext> {
  const nodes: FlowNode<MigrationFlowContext>[] = [];
  const configuredMaxConvergence = ctx.config.options.waveControl?.maxConvergenceIterations;
  const maxConvergence = resolveLoopMaxIterations(configuredMaxConvergence, 3);
  const maxConvergenceLabel = (configuredMaxConvergence ?? 3) === 0
    ? 'unlimited'
    : String(configuredMaxConvergence ?? 3);
  const gateMode = getQualityGateMode(ctx);

  for (let w = 0; w < waves.length; w++) {
    const waveTasks = waves[w]!;
    const prevDep = w > 0 ? [`wave-${w - 1}-commit`] : undefined;

    // Wave start marker — emit lifecycle event
    const waveTasksCopy = waveTasks;
    const waveTaskIds = waveTasksCopy.map(t => t.id);
    const targetChangeScope = `phase-4-wave-${w}`;
    const waveBatches = splitWaveIntoNonOverlappingBatches(waveTasksCopy);
    nodes.push(step<MigrationFlowContext>({
      id: `wave-${w}-start`,
      dependsOn: prevDep,
      run: async (c) => {
        await c.context.targetChanges.begin(targetChangeScope);
        if (c.context.phase4Snapshot) c.context.phase4Snapshot.waveCount++;
        c.context.logger.info(`Wave ${w}: migrating ${waveTasksCopy.length} task(s)`);
        if (waveBatches.length > 1) {
          c.context.logger.info(
            `Wave ${w}: split into ${waveBatches.length} non-overlapping batch(es) to avoid shared target-file edits`,
          );
        }
        c.context.logger.event({ type: 'wave-started', wave: w, taskIds: waveTaskIds });
        await c.context.progress.appendWaveLifecycle({ wave: w, milestone: 'started' });
      },
    }));

    // Wave task execution (parallel branches)
    // Each branch runs: migrate → commit → target-index → parity → parity-gate → minor-repass
    // Build/test gates run at the wave barrier, but parity is per-task.
    if (waveBatches.length === 1) {
      nodes.push(parallel<MigrationFlowContext>({
        id: `wave-${w}-tasks`,
        dependsOn: [`wave-${w}-start`],
        branches: Object.fromEntries(waveTasksCopy.map(task => [
          task.id,
          buildWaveTaskBranch(task, retryExec, gateMode),
        ])),
      }));
    } else {
      let batchDependency = `wave-${w}-start`;
      for (let batchIndex = 0; batchIndex < waveBatches.length; batchIndex++) {
        const batch = waveBatches[batchIndex]!;
        const batchId = `wave-${w}-tasks-batch-${batchIndex}`;
        nodes.push(parallel<MigrationFlowContext>({
          id: batchId,
          dependsOn: [batchDependency],
          branches: Object.fromEntries(batch.map(task => [
            task.id,
            buildWaveTaskBranch(task, retryExec, gateMode),
          ])),
        }));
        batchDependency = batchId;
      }
      nodes.push(step<MigrationFlowContext>({
        id: `wave-${w}-tasks`,
        dependsOn: [batchDependency],
        run: async () => undefined,
      }));
    }

    // Barrier entry marker
    nodes.push(step<MigrationFlowContext>({
      id: `wave-${w}-barrier-enter`,
      dependsOn: [`wave-${w}-tasks`],
      run: async (c) => {
        c.context.logger.event({ type: 'wave-completed', wave: w, taskIds: waveTaskIds, duration: 0 });
        await c.context.progress.appendWaveLifecycle({ wave: w, milestone: 'completed' });
        c.context.logger.event({ type: 'wave-barrier-entered', wave: w });
        await c.context.progress.appendWaveLifecycle({ wave: w, milestone: 'barrier-entered' });
      },
    }));

    // Convergence loop: validate → conditional fix → re-validate
    nodes.push(loop<MigrationFlowContext>({
      id: `wave-${w}-convergence`,
      dependsOn: [`wave-${w}-barrier-enter`],
      maxIterations: maxConvergence,
      do: [
        step<MigrationFlowContext>({
          id: `wave-${w}-validate`,
          run: async (c) => runWaveValidation(c.context, w),
        }),
        conditional<MigrationFlowContext>({
          id: `wave-${w}-recovery`,
          when: (c) => {
            const result = c.getStepOutput<WaveValidationResult>(`wave-${w}-validate`);
            return result?.success === false;
          },
          then: [step<MigrationFlowContext>({
            id: `wave-${w}-fix`,
            run: async (c) => {
              const validation = c.getStepOutput<WaveValidationResult>(`wave-${w}-validate`);
              if (!validation) {
                throw new Error(
                  `Wave ${w} recovery triggered but no validation result found for step wave-${w}-validate. ` +
                  `This is a runtime bug — the convergence loop conditional should only fire after validation completes.`,
                );
              }
              return recoverWaveValidationFailure(c.context, w, waveTasksCopy, validation);
            },
          })],
        }),
      ],
      until: (c) => {
        const result = c.getStepOutput<WaveValidationResult>(`wave-${w}-validate`);
        return result?.success === true;
      },
    }));

    // Convergence check — raise terminal exhaustion if loop didn't converge
    nodes.push(step<MigrationFlowContext>({
      id: `wave-${w}-check`,
      dependsOn: [`wave-${w}-convergence`],
      run: async (c) => {
        const result = c.getStepOutput<WaveValidationResult>(`wave-${w}-validate`);
        if (result && !result.success) {
          await rollbackScopeCandidate(c.context, targetChangeScope);
          await raiseTerminalExhaustion(c.context, {
            reasonCode: 'wave-convergence-exhausted', wave: w, check: 'wave-validation',
            summary: `Wave ${w} failed to converge after ${maxConvergenceLabel} iteration(s)`,
          });
        }
      },
    }));

    // Wave commit + barrier release
    nodes.push(step<MigrationFlowContext>({
      id: `wave-${w}-commit`,
      dependsOn: [`wave-${w}-check`],
      run: async (c) => {
        c.context.deferGitCommits = false;
        await commitForWave(c.context, w, waveTasksCopy.map(t => t.id));
        await completePhase4Tasks(c.context, waveTasksCopy);
        await c.context.targetChanges.accept(targetChangeScope);
        c.context.deferGitCommits = true;
        c.context.logger.event({ type: 'wave-barrier-released', wave: w, duration: 0 });
        await c.context.progress.appendWaveLifecycle({ wave: w, milestone: 'barrier-released' });
      },
    }));
  }

  return defineFlow(WAVE_BARRIER_FLOW_ID, nodes);
}

/**
 * Build a sync-epoch nested flow from pre-computed epochs.
 *
 * Each epoch is a dependency-closed group of topological levels.
 * Build runs at every epoch boundary. Tests run every `testEveryNEpochs` epochs
 * and always at the final epoch.
 */
function buildSyncEpochFlow(
  ctx: MigrationFlowContext,
  epochs: Epoch[],
  retryExec: RetryExecutor,
): FlowDefinition<MigrationFlowContext> {
  const nodes: FlowNode<MigrationFlowContext>[] = [];
  const epochConfig = ctx.config.options.epochControl;
  const configuredMaxConvergence = epochConfig?.maxConvergenceIterations;
  const maxConvergence = resolveLoopMaxIterations(configuredMaxConvergence, 3);
  const maxConvergenceLabel = (configuredMaxConvergence ?? 3) === 0
    ? 'unlimited'
    : String(configuredMaxConvergence ?? 3);
  const testEveryN = epochConfig?.testEveryNEpochs ?? 2;
  const gateMode = getQualityGateMode(ctx);

  for (let e = 0; e < epochs.length; e++) {
    const epoch = epochs[e]!;
    const epochTasks = epoch.tasks;
    const prevDep = e > 0 ? [`epoch-${e - 1}-commit`] : undefined;
    const epochTaskIds = epochTasks.map(t => t.id);
    const targetChangeScope = `phase-4-epoch-${e}`;
    const epochBatches = splitWaveIntoNonOverlappingBatches(epochTasks);
    const isLastEpoch = e === epochs.length - 1;
    const runTestsThisEpoch = isLastEpoch || ((e + 1) % testEveryN === 0);

    // Epoch start marker
    nodes.push(step<MigrationFlowContext>({
      id: `epoch-${e}-start`,
      dependsOn: prevDep,
      run: async (c) => {
        await c.context.targetChanges.begin(targetChangeScope);
        if (c.context.phase4Snapshot) c.context.phase4Snapshot.waveCount++;
        c.context.logger.info(
          `Epoch ${e}: migrating ${epochTasks.length} task(s) spanning level(s) [${epoch.levels.join(', ')}]`,
        );
        if (epochBatches.length > 1) {
          c.context.logger.info(
            `Epoch ${e}: split into ${epochBatches.length} non-overlapping batch(es)`,
          );
        }
        c.context.logger.event({ type: 'epoch-started', epoch: e, taskIds: epochTaskIds, levels: epoch.levels });
        await c.context.progress.appendWaveLifecycle({ wave: e, milestone: 'started' });
      },
    }));

    // Epoch task execution (parallel branches, batched by target-file overlap)
    if (epochBatches.length === 1) {
      nodes.push(parallel<MigrationFlowContext>({
        id: `epoch-${e}-tasks`,
        dependsOn: [`epoch-${e}-start`],
        branches: Object.fromEntries(epochTasks.map(task => [
          task.id,
          buildWaveTaskBranch(task, retryExec, gateMode),
        ])),
      }));
    } else {
      let batchDep = `epoch-${e}-start`;
      for (let bi = 0; bi < epochBatches.length; bi++) {
        const batch = epochBatches[bi]!;
        const batchId = `epoch-${e}-tasks-batch-${bi}`;
        nodes.push(parallel<MigrationFlowContext>({
          id: batchId,
          dependsOn: [batchDep],
          branches: Object.fromEntries(batch.map(task => [
            task.id,
            buildWaveTaskBranch(task, retryExec, gateMode),
          ])),
        }));
        batchDep = batchId;
      }
      nodes.push(step<MigrationFlowContext>({
        id: `epoch-${e}-tasks`,
        dependsOn: [batchDep],
        run: async () => undefined,
      }));
    }

    // Sync point entry
    nodes.push(step<MigrationFlowContext>({
      id: `epoch-${e}-sync-enter`,
      dependsOn: [`epoch-${e}-tasks`],
      run: async (c) => {
        c.context.logger.event({ type: 'epoch-completed', epoch: e, taskIds: epochTaskIds, duration: 0 });
        await c.context.progress.appendWaveLifecycle({ wave: e, milestone: 'completed' });
        c.context.logger.event({ type: 'epoch-sync-entered', epoch: e });
        await c.context.progress.appendWaveLifecycle({ wave: e, milestone: 'barrier-entered' });
      },
    }));

    // Convergence loop: build (always) + test (conditional) → fix → re-validate
    nodes.push(loop<MigrationFlowContext>({
      id: `epoch-${e}-convergence`,
      dependsOn: [`epoch-${e}-sync-enter`],
      maxIterations: maxConvergence,
      do: [
        step<MigrationFlowContext>({
          id: `epoch-${e}-validate`,
          run: async (c) => runEpochValidation(c.context, e, runTestsThisEpoch),
        }),
        conditional<MigrationFlowContext>({
          id: `epoch-${e}-recovery`,
          when: (c) => {
            const result = c.getStepOutput<WaveValidationResult>(`epoch-${e}-validate`);
            return result?.success === false;
          },
          then: [step<MigrationFlowContext>({
            id: `epoch-${e}-fix`,
            run: async (c) => {
              const validation = c.getStepOutput<WaveValidationResult>(`epoch-${e}-validate`);
              if (!validation) {
                throw new Error(
                  `Epoch ${e} recovery triggered but no validation result found. ` +
                  `This is a runtime bug.`,
                );
              }
              return recoverWaveValidationFailure(c.context, e, epochTasks, validation);
            },
          })],
        }),
      ],
      until: (c) => {
        const result = c.getStepOutput<WaveValidationResult>(`epoch-${e}-validate`);
        return result?.success === true;
      },
    }));

    // Convergence check
    nodes.push(step<MigrationFlowContext>({
      id: `epoch-${e}-check`,
      dependsOn: [`epoch-${e}-convergence`],
      run: async (c) => {
        const result = c.getStepOutput<WaveValidationResult>(`epoch-${e}-validate`);
        if (result && !result.success) {
          await rollbackScopeCandidate(c.context, targetChangeScope);
          await raiseTerminalExhaustion(c.context, {
            reasonCode: 'wave-convergence-exhausted', wave: e, check: 'epoch-validation',
            summary: `Epoch ${e} failed to converge after ${maxConvergenceLabel} iteration(s)`,
          });
        }
      },
    }));

    // Epoch commit + sync release
    nodes.push(step<MigrationFlowContext>({
      id: `epoch-${e}-commit`,
      dependsOn: [`epoch-${e}-check`],
      run: async (c) => {
        c.context.deferGitCommits = false;
        await commitForWave(c.context, e, epochTaskIds);
        await completePhase4Tasks(c.context, epochTasks);
        await c.context.targetChanges.accept(targetChangeScope);
        c.context.deferGitCommits = true;
        c.context.logger.event({ type: 'epoch-sync-released', epoch: e, duration: 0 });
        await c.context.progress.appendWaveLifecycle({ wave: e, milestone: 'barrier-released' });
      },
    }));
  }

  return defineFlow(SYNC_EPOCH_FLOW_ID, nodes);
}

/**
 * Run epoch sync-point validation.
 * Build always runs. Tests run only when `runTests` is true.
 */
async function runEpochValidation(
  ctx: MigrationFlowContext, epoch: number, runTests: boolean,
): Promise<WaveValidationResult> {
  if (ctx.phase4Snapshot) ctx.phase4Snapshot.waveValidationRuns++;
  const epochTaskId = `epoch-${epoch}`;

  if (ctx.config.target.formatCommand) {
    const format = await runCommand(ctx, 'format', ctx.config.target.formatCommand, epochTaskId);
    if (!format.success) ctx.logger.warn(`Epoch ${epoch} format failed: ${format.error ?? 'unknown'}`);
  }

  // Build always runs at epoch boundaries
  if (ctx.config.target.buildCommand) {
    const build = await runCommand(ctx, 'build', ctx.config.target.buildCommand, epochTaskId);
    if (!build.success) {
      return { success: false, failedLabel: 'build', failedCommand: ctx.config.target.buildCommand, failure: build };
    }
  }

  // Tests run conditionally
  if (runTests && ctx.config.target.testCommand) {
    const test = await runCommand(ctx, 'test', ctx.config.target.testCommand, epochTaskId);
    if (!test.success) {
      return { success: false, failedLabel: 'test', failedCommand: ctx.config.target.testCommand, failure: test };
    }
  }

  return { success: true };
}

/**
 * Group tasks into topological waves using Kahn's algorithm.
 * Each wave contains tasks whose dependencies are all in prior waves.
 *
 * @throws {Error} if any tasks cannot be scheduled (e.g. unresolved cyclic deps)
 */
export function computeTopologicalWaves(tasks: MigrationTask[]): MigrationTask[][] {
  const taskMap = new Map(tasks.map(t => [t.id, t]));
  const taskSet = new Set(tasks.map(t => t.id));
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();

  for (const t of tasks) {
    const deps = t.dependencies.filter(d => taskSet.has(d));
    inDegree.set(t.id, deps.length);
    for (const d of deps) {
      if (!adj.has(d)) adj.set(d, []);
      adj.get(d)!.push(t.id);
    }
  }

  const waves: MigrationTask[][] = [];
  let ready = tasks.filter(t => (inDegree.get(t.id) ?? 0) === 0);

  while (ready.length > 0) {
    waves.push(ready);
    const nextReady: MigrationTask[] = [];
    for (const t of ready) {
      for (const dep of adj.get(t.id) ?? []) {
        const newDeg = (inDegree.get(dep) ?? 1) - 1;
        inDegree.set(dep, newDeg);
        if (newDeg === 0) nextReady.push(taskMap.get(dep)!);
      }
    }
    ready = nextReady;
  }

  const scheduledCount = waves.reduce((sum, w) => sum + w.length, 0);
  if (scheduledCount !== tasks.length) {
    const scheduled = new Set(waves.flat().map(t => t.id));
    const unscheduled = tasks.filter(t => !scheduled.has(t.id));
    const ids = unscheduled.map(t => t.id).slice(0, 20);
    throw new Error(
      `computeTopologicalWaves: scheduled ${scheduledCount}/${tasks.length} tasks. ` +
      `${tasks.length - scheduledCount} task(s) have unresolvable dependencies ` +
      `(likely SCC-internal cycles not stripped). Unscheduled: [${ids.join(', ')}]`,
    );
  }

  return waves;
}

/**
 * Epoch metadata produced by {@link computeEpochs}.
 * Contains the tasks in the epoch and which topological levels it spans.
 */
export interface Epoch {
  /** Zero-based epoch index. */
  index: number;
  /** Tasks in this epoch. */
  tasks: MigrationTask[];
  /** Topological level indices included in this epoch. */
  levels: number[];
}

/**
 * Group tasks into sync-epochs from topological levels.
 *
 * Algorithm:
 *   1. Build topological levels (reuses computeTopologicalWaves).
 *   2. Merge `levelsPerSync` consecutive levels into each epoch.
 *   3. When `preferCompilationUnitClosure` is true, expand the epoch
 *      boundary to pull in tasks from the next level(s) that share a
 *      compilation unit with tasks already admitted, as long as that
 *      does not violate dependency order (all predecessors are either
 *      in the current or earlier epochs).
 *
 * @throws {Error} if tasks cannot be fully scheduled.
 */
export function computeEpochs(
  tasks: MigrationTask[],
  levelsPerSync: number,
  preferCompilationUnitClosure: boolean,
): Epoch[] {
  const levels = computeTopologicalWaves(tasks);
  if (levels.length === 0) return [];

  const taskSet = new Set(tasks.map(t => t.id));
  const assigned = new Set<string>(); // tasks already assigned to an epoch
  const epochs: Epoch[] = [];
  let levelIdx = 0;

  while (levelIdx < levels.length) {
    // Merge `levelsPerSync` consecutive levels
    const endIdx = Math.min(levelIdx + levelsPerSync, levels.length);
    const epochLevels: number[] = [];
    const epochTasks: MigrationTask[] = [];

    for (let i = levelIdx; i < endIdx; i++) {
      epochLevels.push(i);
      for (const t of levels[i]!) {
        if (!assigned.has(t.id)) {
          epochTasks.push(t);
        }
      }
    }

    let nextLevelIdx = endIdx;

    // Compilation-unit closure expansion
    if (preferCompilationUnitClosure && nextLevelIdx < levels.length) {
      const epochTaskIds = new Set(epochTasks.map(t => t.id));
      // Collect compilation units referenced by tasks in this epoch
      const epochUnits = new Set<string>();
      for (const t of epochTasks) {
        if (t.compilationUnit) epochUnits.add(t.compilationUnit);
      }

      // Try pulling tasks from subsequent levels into this epoch
      let expanded = true;
      while (expanded && nextLevelIdx < levels.length) {
        expanded = false;
        const candidateLevel = levels[nextLevelIdx]!;
        const pulled: MigrationTask[] = [];

        for (const candidate of candidateLevel) {
          if (assigned.has(candidate.id)) continue;
          if (!candidate.compilationUnit || !epochUnits.has(candidate.compilationUnit)) continue;
          // Check dependency closure: all deps must be in this epoch or already assigned
          const depsOk = candidate.dependencies
            .filter(d => taskSet.has(d))
            .every(d => epochTaskIds.has(d) || assigned.has(d));
          if (depsOk) {
            pulled.push(candidate);
          }
        }

        if (pulled.length > 0) {
          for (const t of pulled) {
            epochTasks.push(t);
            epochTaskIds.add(t.id);
          }
          epochLevels.push(nextLevelIdx);

          // Count unassigned tasks remaining in this level
          const remainingInLevel = candidateLevel.filter(
            t => !assigned.has(t.id) && !epochTaskIds.has(t.id),
          ).length;

          if (remainingInLevel === 0) {
            // Entire level consumed → advance past it
            nextLevelIdx++;
            expanded = true;
          } else {
            // Partial pull — remaining tasks stay for the next epoch
            break;
          }
        }
      }
    }

    // Mark all tasks in this epoch as assigned
    for (const t of epochTasks) {
      assigned.add(t.id);
    }

    epochs.push({
      index: epochs.length,
      tasks: epochTasks,
      levels: epochLevels,
    });

    levelIdx = nextLevelIdx;
  }

  return epochs;
}

// ─── Subflow Builder ─────────────────────────────────────────────────
// Called by the parent flow's subflow thunk to construct the Phase 4
// child flow dynamically, based on discovered tasks and execution mode.

/**
 * Resolve migration tasks from the task-graph output, context, or filesystem.
 */
async function discoverTasks(
  ctx: MigrationFlowContext,
  input?: TaskGraphOutput,
): Promise<MigrationTask[] | null> {
  if (input?.tasks && Array.isArray(input.tasks)) return normalizeTaskDependencies(ctx, input.tasks);
  if (ctx.phase1TaskGraphResult?.extensions.outputParsed && Array.isArray(ctx.phase1TaskGraphResult.extensions.structuredOutput?.['tasks'])) {
    return normalizeTaskDependencies(
      ctx,
      ctx.phase1TaskGraphResult.extensions.structuredOutput['tasks'] as MigrationTask[],
    );
  }
  const planPath = ctx.paths.migrationPlanFile;
  if (!(await fileExists(planPath))) {
    const mergedPlanPath = join(ctx.paths.artifactsPlanningDir, 'tasks-merged.json');
    if (await fileExists(mergedPlanPath)) {
      ctx.logger.warn('Task graph step output unavailable — falling back to tasks-merged.json');
      return normalizeTaskDependencies(ctx, await readJson<MigrationTask[]>(mergedPlanPath));
    }
    return null; // No plan found
  }
  ctx.logger.warn('Task graph step output unavailable — falling back to parseMigrationPlan');
  return parseMigrationPlan(planPath);
}

function normalizeTaskDependencies(
  ctx: MigrationFlowContext,
  tasks: MigrationTask[],
): MigrationTask[] {
  const taskIds = new Set(tasks.map(task => task.id));
  return tasks.map(task => {
    const dependencies = task.dependencies.filter(dependency => taskIds.has(dependency));
    if (dependencies.length !== task.dependencies.length) {
      const removed = task.dependencies.filter(dependency => !taskIds.has(dependency));
      ctx.logger.warn(`Task ${task.id} references non-existent dependencies: ${removed.join(', ')}; dropping them`);
      return { ...task, dependencies };
    }
    return task;
  });
}

/**
 * Sort tasks topologically with SCC-aware dependency filtering.
 */
async function sortTasksSccAware(
  ctx: MigrationFlowContext,
  tasks: MigrationTask[],
  input?: TaskGraphOutput,
): Promise<MigrationTask[]> {
  let sccs: string[][] = input?.sccs ??
    (ctx.phase1TaskGraphResult?.extensions.structuredOutput?.['sccs'] as string[][] | undefined) ?? [];
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
  if (sccs.length === 0) return TaskQueue.topologicalSort(tasks);
  const sccMembership = new Map<string, string[]>();
  for (const scc of sccs) for (const id of scc) sccMembership.set(id, scc);
  const tasksForSort = tasks.map(t => {
    const myScc = sccMembership.get(t.id);
    if (!myScc) return t;
    const sccSet = new Set(myScc);
    return { ...t, dependencies: t.dependencies.filter(d => !sccSet.has(d)) };
  });
  return TaskQueue.topologicalSort(tasksForSort);
}

/**
 * Compute Phase 4 concurrency from config and execution mode.
 */
export function computePhase4Concurrency(ctx: MigrationFlowContext): number {
  const executionMode = ctx.config.options.executionMode ?? 'per-task';
  return isGitAutomationEnabled(ctx) && executionMode !== 'wave-barrier' && executionMode !== 'sync-epoch'
    ? 1 : ctx.config.options.maxParallelAgents;
}

/**
 * Compute Phase 4 runner options from context.
 * Used to dynamically populate the subflow's runnerOptions ref before execution.
 */
export function computePhase4RunnerOptions(ctx: MigrationFlowContext): FlowRunnerOptions<MigrationFlowContext> {
  return {
    checkpoint: new Phase4CheckpointAdapter(ctx.checkpoint),
    concurrency: computePhase4Concurrency(ctx),
  };
}

/**
 * Build the Phase 4 child flow definition.
 *
 * Called by the parent flow's `subflow` thunk. Discovers tasks, sorts them
 * topologically, projects costs, and returns the appropriate nested flow
 * (per-task or wave-barrier).
 *
 * Returns `null` when no tasks are found (the parent flow treats this as a
 * successful no-op via the empty flow).
 */
export async function buildPhase4Subflow(
  parentCtx: FlowExecutionContext<MigrationFlowContext>,
  taskGraphInput?: TaskGraphOutput,
): Promise<FlowDefinition<MigrationFlowContext>> {
  const ctx = parentCtx.context;
  const start = Date.now();

  // 1. Task discovery
  const tasks = await discoverTasks(ctx, taskGraphInput);
  if (tasks === null) {
    const failResult: PhaseResult = {
      phase: 4, name: 'Iterative Migration', success: false, duration: Date.now() - start,
      error: 'migration-plan.md and tasks-merged.json not found — Phase 1 may not have completed',
    };
    assertPhaseSuccess(failResult);
  }
  if (!tasks || tasks.length === 0) {
    ctx.logger.warn('No tasks found in migration plan');
    // Return an empty flow — the subflow completes immediately as a no-op.
    return defineFlow('phase-4-empty', []);
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
    `Phase 4: ${taskCount} tasks, estimated ~${estimatedTotalTokens.toLocaleString()} tokens, ` +
    `projected cost: ${CostEstimator.formatCost(projected.total)} (${model})`,
  );
  await ctx.progress.appendEvent(`Phase 4 projection: ${taskCount} tasks, ~${CostEstimator.formatCost(projected.total)} estimated`);
  if (ctx.config.options.tokenBudget) {
    const currentUsage = ctx.tokenTracker.getTotal();
    if (currentUsage + estimatedTotalTokens > ctx.config.options.tokenBudget) {
      ctx.logger.warn(
        `Projected Phase 4 usage (${estimatedTotalTokens.toLocaleString()}) plus current (${currentUsage.toLocaleString()}) exceeds budget`,
      );
    }
  }

  // 2. Topological sort — SCC-aware
  const sortedTasks = await sortTasksSccAware(ctx, tasks, taskGraphInput);

  // 3. Build the nested Phase 4 flow
  const retryExec = new RetryExecutor(
    (inv) => launchAgentWithEvents(ctx, inv), ctx.logger,
  );
  const executionMode = ctx.config.options.executionMode ?? 'per-task';
  const plannedWaves = executionMode === 'wave-barrier'
    ? computeTopologicalWaves(sortedTasks)
    : [];
  const plannedEpochs = executionMode === 'sync-epoch'
    ? computeEpochs(
        sortedTasks,
        ctx.config.options.epochControl?.levelsPerSync ?? 2,
        ctx.config.options.epochControl?.preferCompilationUnitClosure ?? true,
      )
    : [];

  if (executionMode === 'wave-barrier') {
    for (let waveIndex = 0; waveIndex < plannedWaves.length; waveIndex++) {
      for (const task of plannedWaves[waveIndex]!) {
        registerPhase4TaskScope(ctx, task.id, `${WAVE_BARRIER_FLOW_ID}/wave-${waveIndex}-`);
        ctx.targetChanges.bindTask(task.id, `phase-4-wave-${waveIndex}`);
      }
    }
  } else if (executionMode === 'sync-epoch') {
    for (let epochIndex = 0; epochIndex < plannedEpochs.length; epochIndex++) {
      for (const task of plannedEpochs[epochIndex]!.tasks) {
        registerPhase4TaskScope(ctx, task.id, `${SYNC_EPOCH_FLOW_ID}/epoch-${epochIndex}-`);
        ctx.targetChanges.bindTask(task.id, `phase-4-epoch-${epochIndex}`);
      }
    }
  } else {
    for (const task of sortedTasks) {
      registerPhase4TaskScope(ctx, task.id, `${PER_TASK_FLOW_ID}/${task.id}/`);
      ctx.targetChanges.bindTask(task.id, task.id);
    }
  }
  await ctx.checkpoint.save(ctx.checkpoint.getState());

  ctx.phase4Snapshot = {
    executionMode, phase4DurationMs: 0,
    completedTaskCount: sortedTasks.filter(task => ctx.checkpoint.getState().completedTasks.includes(task.id)).length,
    plannedWaveCount: plannedWaves.length || plannedEpochs.length,
    waveCount: 0, waveValidationRuns: 0, waveConvergenceIterations: 0,
    waveConvergenceFailures: 0, waveConvergenceLimitHits: 0,
    buildCommandRuns: 0, testCommandRuns: 0, formatCommandRuns: 0,
    lintCommandRuns: 0, commandRecoveryAttempts: 0, commandInfraRetries: 0,
    recoveryLoopTimeMs: 0,
  };
  ctx.progress.setTotalTasks(sortedTasks.length);

  if (plannedWaves.length > 0) {
    const plannedWaveTaskIds = plannedWaves.map((wave) => wave.map((task) => task.id));
    await ctx.progress.setWavePlan(plannedWaveTaskIds);
    ctx.logger.info(
      `Phase 4 wave plan: ${plannedWaves.length} wave(s) precomputed for ${sortedTasks.length} task(s)`,
    );
    await ctx.progress.appendEvent(
      `Phase 4 wave plan published: ${plannedWaves.length} wave(s) precomputed ahead of execution`,
    );
    for (let waveIndex = 0; waveIndex < plannedWaveTaskIds.length; waveIndex++) {
      const taskIds = plannedWaveTaskIds[waveIndex]!;
      ctx.logger.info(
        `Phase 4 wave ${waveIndex} (${waveIndex + 1}/${plannedWaveTaskIds.length}): ` +
        `${taskIds.length} task(s) -> ${taskIds.join(', ')}`,
      );
    }
  }

  if (plannedEpochs.length > 0) {
    const epochTaskIds = plannedEpochs.map(ep => ep.tasks.map(t => t.id));
    await ctx.progress.setWavePlan(epochTaskIds);
    const testEveryN = ctx.config.options.epochControl?.testEveryNEpochs ?? 2;
    ctx.logger.info(
      `Phase 4 epoch plan: ${plannedEpochs.length} epoch(s) for ${sortedTasks.length} task(s) ` +
      `(levelsPerSync=${ctx.config.options.epochControl?.levelsPerSync ?? 2}, ` +
      `testEvery=${testEveryN}, ` +
      `compilationUnitClosure=${ctx.config.options.epochControl?.preferCompilationUnitClosure ?? true})`,
    );
    await ctx.progress.appendEvent(
      `Phase 4 epoch plan published: ${plannedEpochs.length} epoch(s) precomputed ahead of execution`,
    );
    for (let epochIdx = 0; epochIdx < plannedEpochs.length; epochIdx++) {
      const epoch = plannedEpochs[epochIdx]!;
      const ids = epoch.tasks.map(t => t.id);
      ctx.logger.info(
        `Phase 4 epoch ${epochIdx} (${epochIdx + 1}/${plannedEpochs.length}): ` +
        `${ids.length} task(s), levels [${epoch.levels.join(', ')}] -> ${ids.join(', ')}`,
      );
    }
  }

  if (executionMode === 'wave-barrier' || executionMode === 'sync-epoch') {
    ctx.deferGitCommits = true;
  }

  if (executionMode === 'sync-epoch') {
    return buildSyncEpochFlow(ctx, plannedEpochs, retryExec);
  }
  return executionMode === 'wave-barrier'
    ? buildWaveBarrierFlow(ctx, plannedWaves, retryExec)
    : buildPerTaskFlow(ctx, sortedTasks, retryExec);
}

// ─── Helpers ──────────────────────────────────────────────────────────

async function runWaveValidation(ctx: MigrationFlowContext, wave: number): Promise<WaveValidationResult> {
  if (ctx.phase4Snapshot) ctx.phase4Snapshot.waveValidationRuns++;
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
  waveCandidates: MigrationTask[],
  validation: WaveValidationResult,
): Promise<boolean> {
  if (validation.success) return true;
  const { failedLabel, failedCommand, failure } = validation;
  if (!failedLabel || !failedCommand || !failure) {
    throw new Error(
      `Wave ${wave} validation failed but returned incomplete result ` +
      `(failedLabel=${failedLabel}, failedCommand=${failedCommand}, failure=${!!failure}). ` +
      `This is a runtime bug — WaveValidationResult must include failure details when success=false.`,
    );
  }
  if (failure.success) return true;
  const waveTask = buildWaveRecoveryTask(wave, waveCandidates);
  const artifactPaths = Array.from(new Set(waveCandidates.flatMap(t => [...t.sourceFiles, ...t.targetFiles])));
  return runCommandWithRecovery(ctx, failedLabel, failedCommand, waveTask, {
    initialFailure: failure, wave, retryScope: 'wave', artifactPaths,
    suppressTerminalOnExhaustion: true,
    failureSummary: failure.error ?? `Wave ${wave} ${failedLabel} failed`,
    expectedSuccessCondition: `Wave ${wave} ${failedLabel} passes`,
  });
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

        const recoveryCtx = await ctx.contextBuilder.buildContext('parity-failure-resolver', PHASE.MIGRATION, task.id, {
          failureReport: enrichedSummary, sourceFiles: task.sourceFiles, targetFiles: task.targetFiles,
          kbEntry: task.knowledgeBaseRef, attemptNumber: attempt,
          ...taskScopePayload(task), remediationContext: toAgentRemediationContext(parityRemediation),
        });
        const recoveryResult = await launchAgentWithEvents(ctx, buildInvocation(ctx, 'parity-failure-resolver', recoveryCtx, PHASE.MIGRATION, task.id));
        recordTokens(ctx, recoveryResult, PHASE.MIGRATION);
        if (!recoveryResult.success) return;

        const reMigrateCtx = await ctx.contextBuilder.buildContext('code-migrator', PHASE.MIGRATION, task.id, {
          sourceFiles: task.sourceFiles, targetFiles: task.targetFiles,
          kbEntry: task.knowledgeBaseRef, ...taskScopePayload(task),
          remediationContext: toAgentRemediationContext(parityRemediation),
        });
        const reMigrateResult = await launchAgentWithEvents(ctx, buildInvocation(ctx, 'code-migrator', reMigrateCtx, PHASE.MIGRATION, task.id));
        recordTokens(ctx, reMigrateResult, PHASE.MIGRATION);
        if (!reMigrateResult.success) return;

        const reParityCtx = await ctx.contextBuilder.buildContext('parity-verifier', PHASE.MIGRATION, task.id, {
          sourceFiles: task.sourceFiles, targetFiles: task.targetFiles, ...taskScopePayload(task),
        });
        const reParityResult = await launchAgentWithEvents(ctx, buildInvocation(ctx, 'parity-verifier', reParityCtx, PHASE.MIGRATION, task.id));
        recordTokens(ctx, reParityResult, PHASE.MIGRATION);
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
