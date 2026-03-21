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
import { parseMigrationPlan } from '../../agents/plan-parser.js';
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
  assertPhaseSuccess,
} from './shared.js';

// ─── Substep Functions ───────────────────────────────────────────────
// Each function executes one logical substep within a per-task migration.
// The framework's checkpoint skip replaces the manual hasPhase4Substep guards.

async function runMigrateSubstep(
  ctx: MigrationFlowContext, task: MigrationTask, retryExec: RetryExecutor,
  remediationContext?: import('../../agents/types.js').RemediationContext,
): Promise<{ durationMs: number }> {
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
      const retryContext = await ctx.contextBuilder.buildContext('code-migrator', 5, task.id, {
        sourceFiles: task.sourceFiles, targetFiles: task.targetFiles,
        kbEntry: task.knowledgeBaseRef, ...taskScopePayload(task),
        remediationContext: toAgentRemediationContext(retryExhaustionRemediation),
      });
      migratorInv.contextPath = retryContext.contextPath;
      migratorInv.outputPath = retryContext.outputPath;
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
  return { durationMs: migratorResult.duration };
}

async function runCommitSubstep(
  ctx: MigrationFlowContext, task: MigrationTask,
): Promise<void> {
  await commitForAgent(ctx, 'code-migrator', 5, task.id, task.name);
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

async function runSymbolMappingSubstep(
  ctx: MigrationFlowContext, task: MigrationTask,
): Promise<void> {
  if (!ctx.symbolMapper || !task.symbols?.length) return;
  await ctx.gitLimiter(async () => {
    try {
      await ctx.symbolMapper!.updateMappingsForTask(
        task.id, task.symbols!, task.targetFiles, 'migrated',
      );
    } catch (err) {
      ctx.logger.warn(`Symbol mapping failed for ${task.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}

async function runParitySubstep(
  ctx: MigrationFlowContext, task: MigrationTask,
): Promise<void> {
  const parityCtx = await ctx.contextBuilder.buildContext('parity-verifier', 5, task.id, {
    sourceFile: task.sourceFiles[0], targetFile: task.targetFiles[0], ...taskScopePayload(task),
  });
  const testCtx = await ctx.contextBuilder.buildContext('test-writer', 5, task.id, {
    targetFile: task.targetFiles[0], kbEntry: task.knowledgeBaseRef,
    testType: 'unit', ...taskScopePayload(task),
  });
  const parallelExec = new ParallelExecutor(2, (inv) => launchAgentWithEvents(ctx, inv), ctx.logger);
  const [parityResult, testResult] = await parallelExec.executeAll([
    buildInvocation(ctx, 'parity-verifier', parityCtx, 5, task.id),
    buildInvocation(ctx, 'test-writer', testCtx, 5, task.id),
  ]);
  ctx.peakConcurrency = Math.max(ctx.peakConcurrency, parallelExec.peakConcurrency);
  if (parityResult) { recordTokens(ctx, parityResult, 5); storeParityResult(ctx, parityResult, task.id); }
  if (testResult) recordTokens(ctx, testResult, 5);
  if (testResult?.success) await commitForAgent(ctx, 'test-writer', 5, task.id, task.name);
}

async function runParityGateSubstep(
  ctx: MigrationFlowContext, task: MigrationTask,
): Promise<void> {
  const gateMode = getQualityGateMode(ctx);
  if (gateMode === 'skip') return;

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

  // Update symbol mapping status based on parity outcome.
  if (ctx.symbolMapper) {
    const status = parityPassed ? 'migrated' : 'parity-failed';
    await ctx.gitLimiter(async () => {
      try { await ctx.symbolMapper!.updateTaskStatus(task.id, status); } catch { /* best-effort */ }
    });
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

  const nodes: FlowNode<MigrationFlowContext>[] = [];

  for (const task of tasks) {
    const deps = task.dependencies.filter(d => taskSet.has(d));
    const substepIds: string[] = [];

    // Migrate
    const migrateId = `${task.id}/migrate`;
    nodes.push(step<MigrationFlowContext>({
      id: migrateId,
      dependsOn: deps.length > 0 ? deps.map(d => `${d}/complete`) : undefined,
      run: (c) => runMigrateSubstep(c.context, task, retryExec),
    }));
    substepIds.push(migrateId);

    // Commit
    const commitId = `${task.id}/commit`;
    nodes.push(step<MigrationFlowContext>({
      id: commitId,
      dependsOn: [migrateId],
      run: (c) => runCommitSubstep(c.context, task),
    }));
    substepIds.push(commitId);

    // Target index update + symbol mapping (after commit, before parity)
    const targetIndexId = `${task.id}/target-index`;
    nodes.push(step<MigrationFlowContext>({
      id: targetIndexId,
      dependsOn: [commitId],
      run: (c) => runTargetIndexSubstep(c.context, task),
    }));
    substepIds.push(targetIndexId);

    const symbolMapId = `${task.id}/symbol-map`;
    nodes.push(step<MigrationFlowContext>({
      id: symbolMapId,
      dependsOn: [targetIndexId],
      run: (c) => runSymbolMappingSubstep(c.context, task),
    }));
    substepIds.push(symbolMapId);

    // Parity + test writer
    const parityId = `${task.id}/parity`;
    nodes.push(step<MigrationFlowContext>({
      id: parityId,
      dependsOn: [symbolMapId],
      run: (c) => runParitySubstep(c.context, task),
    }));
    substepIds.push(parityId);

    let lastId = parityId;

    if (gateMode !== 'skip') {
      const parityGateId = `${task.id}/parity-gate`;
      nodes.push(step<MigrationFlowContext>({
        id: parityGateId,
        dependsOn: [parityId],
        run: (c) => runParityGateSubstep(c.context, task),
      }));
      substepIds.push(parityGateId);

      const repassId = `${task.id}/minor-repass`;
      nodes.push(step<MigrationFlowContext>({
        id: repassId,
        dependsOn: [parityGateId],
        run: (c) => runMinorRepassSubstep(c.context, task),
      }));
      substepIds.push(repassId);
      lastId = repassId;
    }

    if (ctx.config.target.formatCommand) {
      const fmtId = `${task.id}/format`;
      nodes.push(step<MigrationFlowContext>({
        id: fmtId,
        dependsOn: [lastId],
        run: (c) => runFormatSubstep(c.context, task),
      }));
      substepIds.push(fmtId);
      lastId = fmtId;
    }
    if (ctx.config.target.buildCommand) {
      const buildId = `${task.id}/build`;
      nodes.push(step<MigrationFlowContext>({
        id: buildId,
        dependsOn: [lastId],
        run: (c) => runBuildSubstep(c.context, task),
      }));
      substepIds.push(buildId);
      lastId = buildId;
    }
    if (ctx.config.target.testCommand) {
      const testId = `${task.id}/test`;
      nodes.push(step<MigrationFlowContext>({
        id: testId,
        dependsOn: [lastId],
        run: (c) => runTestSubstep(c.context, task),
      }));
      substepIds.push(testId);
      lastId = testId;
    }

    // Completion marker for dependency tracking
    const completeId = `${task.id}/complete`;
    nodes.push(step<MigrationFlowContext>({
      id: completeId,
      dependsOn: [lastId],
      run: async (c) => {
        await ctx.progress.updateTask(task.id, 'completed', { sourceFiles: task.sourceFiles, targetFiles: task.targetFiles });
        ctx.logger.event({ type: 'task-completed', taskId: task.id, name: task.name, duration: 0 });
        await commitForTask(c.context, task);
      },
    }));
  }

  return defineFlow('phase-4-per-task', nodes);
}

/**
 * Build a wave-barrier nested flow from pre-computed topological waves.
 */
function buildWaveBarrierFlow(
  ctx: MigrationFlowContext,
  tasks: MigrationTask[],
  retryExec: RetryExecutor,
): FlowDefinition<MigrationFlowContext> {
  const waves = computeTopologicalWaves(tasks);
  const nodes: FlowNode<MigrationFlowContext>[] = [];
  const maxConvergence = ctx.config.options.waveControl?.maxConvergenceIterations ?? 3;

  for (let w = 0; w < waves.length; w++) {
    const waveTasks = waves[w]!;
    const prevDep = w > 0 ? [`wave-${w - 1}-commit`] : undefined;

    // Wave start marker — emit lifecycle event
    const waveTasksCopy = waveTasks;
    const waveTaskIds = waveTasksCopy.map(t => t.id);
    nodes.push(step<MigrationFlowContext>({
      id: `wave-${w}-start`,
      dependsOn: prevDep,
      run: async (c) => {
        if (c.context.phase4Snapshot) c.context.phase4Snapshot.waveCount++;
        c.context.logger.info(`Wave ${w}: migrating ${waveTasksCopy.length} task(s)`);
        c.context.logger.event({ type: 'wave-started', wave: w, taskIds: waveTaskIds });
        await c.context.progress.appendWaveLifecycle({ wave: w, milestone: 'started' });
      },
    }));

    // Wave task execution (parallel branches)
    nodes.push(parallel<MigrationFlowContext>({
      id: `wave-${w}-tasks`,
      dependsOn: [`wave-${w}-start`],
      branches: Object.fromEntries(waveTasksCopy.map(task => [
        task.id,
        [step<MigrationFlowContext>({
          id: `${task.id}/migrate`,
          run: (c) => runMigrateSubstep(c.context, task, retryExec),
        })],
      ])),
    }));

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
            run: async (c) => recoverWaveValidationFailure(c.context, w, waveTasksCopy),
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
          await raiseTerminalExhaustion(c.context, {
            reasonCode: 'wave-convergence-exhausted', wave: w, check: 'wave-validation',
            summary: `Wave ${w} failed to converge after ${maxConvergence} iteration(s)`,
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
        c.context.deferGitCommits = true;
        c.context.logger.event({ type: 'wave-barrier-released', wave: w, duration: 0 });
        await c.context.progress.appendWaveLifecycle({ wave: w, milestone: 'barrier-released' });
      },
    }));
  }

  return defineFlow('phase-4-wave-barrier', nodes);
}

/**
 * Group tasks into topological waves using Kahn's algorithm.
 * Each wave contains tasks whose dependencies are all in prior waves.
 */
function computeTopologicalWaves(tasks: MigrationTask[]): MigrationTask[][] {
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

  return waves;
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
  if (input?.tasks && Array.isArray(input.tasks)) return input.tasks;
  if (ctx.phase1TaskGraphResult?.extensions.outputParsed && Array.isArray(ctx.phase1TaskGraphResult.extensions.structuredOutput?.['tasks'])) {
    return ctx.phase1TaskGraphResult.extensions.structuredOutput['tasks'] as MigrationTask[];
  }
  const planPath = ctx.paths.migrationPlanFile;
  if (!(await fileExists(planPath))) {
    const mergedPlanPath = join(ctx.paths.artifactsPlanningDir, 'tasks-merged.json');
    if (await fileExists(mergedPlanPath)) {
      ctx.logger.warn('Task graph step output unavailable — falling back to tasks-merged.json');
      return readJson<MigrationTask[]>(mergedPlanPath);
    }
    return null; // No plan found
  }
  ctx.logger.warn('Task graph step output unavailable — falling back to parseMigrationPlan');
  return parseMigrationPlan(planPath);
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
  const sorted = TaskQueue.topologicalSort(tasksForSort);
  const origMap = new Map(tasks.map(t => [t.id, t]));
  return sorted.map(t => origMap.get(t.id) ?? t);
}

/**
 * Compute Phase 4 concurrency from config and execution mode.
 */
export function computePhase4Concurrency(ctx: MigrationFlowContext): number {
  const executionMode = ctx.config.options.executionMode ?? 'per-task';
  return isGitAutomationEnabled(ctx) && executionMode !== 'wave-barrier'
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

  ctx.phase4Snapshot = {
    executionMode, phase4DurationMs: 0, completedTaskCount: 0,
    waveCount: 0, waveValidationRuns: 0, waveConvergenceIterations: 0,
    waveConvergenceFailures: 0, waveConvergenceLimitHits: 0,
    buildCommandRuns: 0, testCommandRuns: 0, formatCommandRuns: 0,
    lintCommandRuns: 0, commandRecoveryAttempts: 0, commandInfraRetries: 0,
    recoveryLoopTimeMs: 0,
  };
  ctx.progress.setTotalTasks(sortedTasks.length);

  if (executionMode === 'wave-barrier') {
    ctx.deferGitCommits = true;
  }

  return executionMode === 'wave-barrier'
    ? buildWaveBarrierFlow(ctx, sortedTasks, retryExec)
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
  validation?: WaveValidationResult,
): Promise<boolean> {
  if (validation?.success) return true;
  const failedLabel = validation?.failedLabel;
  const failedCommand = validation?.failedCommand;
  const failure = validation?.failure;
  if (!failedLabel || !failedCommand || !failure || failure.success) return false;
  const waveTask = buildWaveRecoveryTask(wave, waveCandidates);
  const artifactPaths = Array.from(new Set(waveCandidates.flatMap(t => [...t.sourceFiles, ...t.targetFiles])));
  return runCommandWithRecovery(ctx, failedLabel, failedCommand, waveTask, undefined, {
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
