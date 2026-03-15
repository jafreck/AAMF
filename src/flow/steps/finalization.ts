/**
 * Phase 7 — E2E Testing & Documentation
 *
 * Split into three exported functions for the flow DSL:
 * - launchE2eTestCrafter: step() — creates e2e-test-plan.md
 * - launchE2eSuiteWriters: step() inside parallel() e2e branch
 * - launchDocWriter: step() inside parallel() docs branch
 */

import { join } from 'node:path';
import type { FlowExecutionContext } from '@cadre-dev/framework/flow';
import type { MigrationFlowContext } from '../context.js';
import type { AgentResult, AgentName, E2eSuiteBrief } from '../../agents/types.js';
import { parseE2eTestPlan } from '../../agents/plan-parser.js';
import { ParallelExecutor } from '../../execution/parallel-executor.js';
import { RetryExecutor } from '../../execution/retry.js';
import { fileExists } from '../../util/fs.js';
import {
  buildInvocation, launchAgentWithEvents, recordTokens,
  commitForAgent, isGitAutomationEnabled,
  getPhase7Cursor, savePhase7Cursor,
  assertPhaseSuccess,
} from './shared.js';

// ─── Stage 1: E2E Test Plan ──────────────────────────────────────────

export async function launchE2eTestCrafter(
  flowCtx: FlowExecutionContext<MigrationFlowContext>,
): Promise<AgentResult> {
  const ctx = flowCtx.context;
  const phase7Cursor = getPhase7Cursor(ctx);
  const completedAgents = new Set(phase7Cursor.completedAgents);

  if (completedAgents.has('e2e-test-crafter')) {
    return { agent: 'e2e-test-crafter', workItemId: '', exitCode: 0, success: true, timedOut: false, duration: 0, stdout: '', stderr: '', tokenUsage: null, outputPath: '', outputExists: false, extensions: {} };
  }

  const e2eCtx = await ctx.contextBuilder.buildContext('e2e-test-crafter', 6, undefined, { planOnly: true });
  const crafterResult = await launchAgentWithEvents(ctx, buildInvocation(ctx, 'e2e-test-crafter', e2eCtx, 7));
  recordTokens(ctx, crafterResult, 7);

  if (crafterResult.success) {
    if (isGitAutomationEnabled(ctx)) await commitForAgent(ctx, 'e2e-test-crafter', 7);
    completedAgents.add('e2e-test-crafter');
    await savePhase7Cursor(ctx, {
      completedAgents: Array.from(completedAgents),
      completedSuites: Array.from(getPhase7Cursor(ctx).completedSuites),
      lastSuccessfulStep: 'completed-e2e-test-crafter',
    });
  } else {
    assertPhaseSuccess({
      phase: 7, name: 'E2E Testing & Documentation', success: false,
      duration: 0, error: crafterResult.error ?? 'e2e-test-crafter failed',
    });
  }

  return crafterResult;
}

// ─── Stage 2+3: Suite Writers (parallel branch) ──────────────────────

export async function launchE2eSuiteWriters(
  flowCtx: FlowExecutionContext<MigrationFlowContext>,
): Promise<unknown> {
  const ctx = flowCtx.context;
  const phase7Cursor = getPhase7Cursor(ctx);
  const completedAgents = new Set(phase7Cursor.completedAgents);
  const completedSuites = new Set(phase7Cursor.completedSuites);
  const results: AgentResult[] = [];

  const planPath = join(ctx.config.target.outputPath, 'e2e', 'e2e-test-plan.md');
  let suites: E2eSuiteBrief[] = [];
  if (await fileExists(planPath)) {
    suites = await parseE2eTestPlan(planPath);
  } else {
    ctx.logger.warn('No e2e-test-plan.md; skipping suite fan-out');
    return { suites: 0 };
  }

  if (suites.length === 0) {
    ctx.logger.warn('E2E plan contains zero suites');
    return { suites: 0 };
  }

  const pendingSuites = suites.filter(s => !completedSuites.has(s.id));
  if (pendingSuites.length === 0) {
    ctx.logger.info('All E2E suites already completed');
    return { suites: suites.length };
  }

  // When git is enabled, run suites sequentially to avoid concurrent git ops
  if (isGitAutomationEnabled(ctx) || suites.length === 1) {
    for (const suite of pendingSuites) {
      if (isSuiteBudgetExceeded(ctx, suite.id)) break;
      const result = await executeSuiteWithRetry(ctx, suite, completedAgents, completedSuites);
      results.push(result);
    }
  } else {
    await executeParallelSuiteFanOut(ctx, pendingSuites, suites, results, completedAgents, completedSuites);
  }

  const allSuccess = results.every(r => r.success);
  if (!allSuccess) {
    const errors = results.filter(r => !r.success).map(r => r.error);
    assertPhaseSuccess({
      phase: 7, name: 'E2E Testing & Documentation', success: false,
      duration: 0, error: errors.join('; '),
    });
  }

  return { suites: suites.length, completed: completedSuites.size };
}

// ─── Stage 4: Documentation Writer (parallel branch) ─────────────────

export async function launchDocWriter(
  flowCtx: FlowExecutionContext<MigrationFlowContext>,
): Promise<AgentResult> {
  const ctx = flowCtx.context;
  const phase7Cursor = getPhase7Cursor(ctx);
  const completedAgents = new Set(phase7Cursor.completedAgents);

  if (completedAgents.has('documentation-writer')) {
    return { agent: 'documentation-writer', workItemId: '', exitCode: 0, success: true, timedOut: false, duration: 0, stdout: '', stderr: '', tokenUsage: null, outputPath: '', outputExists: false, extensions: {} };
  }

  const docCtx = await ctx.contextBuilder.buildContext('documentation-writer', 7);
  const docResult = await launchAgentWithEvents(ctx, buildInvocation(ctx, 'documentation-writer', docCtx, 7));
  recordTokens(ctx, docResult, 7);

  if (docResult.success) {
    if (isGitAutomationEnabled(ctx)) await commitForAgent(ctx, 'documentation-writer', 7);
    completedAgents.add('documentation-writer');
    await savePhase7Cursor(ctx, {
      completedAgents: Array.from(completedAgents),
      completedSuites: Array.from(getPhase7Cursor(ctx).completedSuites),
      lastSuccessfulStep: 'completed-documentation-writer',
    });
  } else {
    assertPhaseSuccess({
      phase: 7, name: 'E2E Testing & Documentation', success: false,
      duration: 0, error: docResult.error ?? 'documentation-writer failed',
    });
  }

  return docResult;
}

// ─── Helpers ──────────────────────────────────────────────────────────

async function executeSuiteWithRetry(
  ctx: MigrationFlowContext, suite: E2eSuiteBrief,
  completedAgents: Set<string>, completedSuites: Set<string>,
): Promise<AgentResult> {
  if (isSuiteBudgetExceeded(ctx, suite.id)) {
    return { agent: 'test-writer', workItemId: suite.id, exitCode: 1, success: false, timedOut: false, duration: 0, stdout: '', stderr: '', tokenUsage: null, outputPath: '', outputExists: false, error: `Budget exceeded before suite ${suite.id}`, extensions: {} };
  }
  const suiteCtx = await ctx.contextBuilder.buildContext('test-writer', 6, suite.id, { e2eSuiteBrief: suite });
  const retryExec = new RetryExecutor(inv => launchAgentWithEvents(ctx, inv), ctx.logger);
  const suiteResult = await retryExec.executeWithRetry(
    buildInvocation(ctx, 'test-writer', suiteCtx, 7, suite.id),
    { maxAttempts: ctx.config.options.maxRetriesPerTask },
  );
  recordTokens(ctx, suiteResult, 7);
  if (suiteResult.success) {
    if (isGitAutomationEnabled(ctx)) await commitForAgent(ctx, 'test-writer', 7, suite.id, suite.name);
    completedSuites.add(suite.id);
    await savePhase7Cursor(ctx, {
      completedAgents: Array.from(completedAgents),
      completedSuites: Array.from(completedSuites),
      lastSuccessfulStep: `completed-suite-${suite.id}`,
    });
  }
  return suiteResult;
}

function isSuiteBudgetExceeded(ctx: MigrationFlowContext, suiteId: string): boolean {
  if (!ctx.config.options.tokenBudget) return false;
  const threshold = ctx.tokenTracker.checkThreshold(ctx.config.options.tokenBudget);
  if (threshold === 'exceeded') {
    ctx.logger.warn(`Budget exceeded before suite ${suiteId}`);
    return true;
  }
  return false;
}

async function executeParallelSuiteFanOut(
  ctx: MigrationFlowContext, pendingSuites: E2eSuiteBrief[],
  allSuites: E2eSuiteBrief[], results: AgentResult[],
  completedAgents: Set<string>, completedSuites: Set<string>,
): Promise<void> {
  const budgetFiltered = pendingSuites.filter(s => !isSuiteBudgetExceeded(ctx, s.id));
  if (budgetFiltered.length === 0) return;
  const invocations = [];
  for (const suite of budgetFiltered) {
    const suiteCtx = await ctx.contextBuilder.buildContext('test-writer', 6, suite.id, { e2eSuiteBrief: suite });
    invocations.push(buildInvocation(ctx, 'test-writer', suiteCtx, 7, suite.id));
  }
  const retryExec = new RetryExecutor(inv => launchAgentWithEvents(ctx, inv), ctx.logger);
  const parallel = new ParallelExecutor(
    Math.min(ctx.config.options.maxE2eSuiteConcurrency ?? ctx.config.options.maxParallelAgents, budgetFiltered.length),
    inv => retryExec.executeWithRetry(inv, { maxAttempts: ctx.config.options.maxRetriesPerTask }),
    ctx.logger,
  );
  const parallelResults = await parallel.executeAll(invocations);
  ctx.peakConcurrency = Math.max(ctx.peakConcurrency, parallel.peakConcurrency);
  for (let i = 0; i < parallelResults.length; i++) {
    const suite = budgetFiltered[i]!;
    const result = parallelResults[i]!;
    results.push(result);
    recordTokens(ctx, result, 7);
    if (result.success) completedSuites.add(suite.id);
  }
  await savePhase7Cursor(ctx, {
    completedAgents: Array.from(completedAgents),
    completedSuites: Array.from(completedSuites),
    lastSuccessfulStep: completedSuites.size === allSuites.length
      ? 'all-suites-complete'
      : `completed-${completedSuites.size}-of-${allSuites.length}-suites`,
  });
}
