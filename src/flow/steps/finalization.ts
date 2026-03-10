/**
 * Phase 7 — E2E Testing & Documentation (parallel fan-out)
 */

import { join } from 'node:path';
import type { FlowExecutionContext } from '@cadre-dev/framework/flow';
import type { MigrationFlowContext } from '../context.js';
import type { PhaseResult, AgentResult, AgentName, E2eSuiteBrief } from '../../agents/types.js';
import { parseE2eTestPlan } from '../../agents/plan-parser.js';
import { ParallelExecutor } from '../../execution/parallel-executor.js';
import { RetryExecutor } from '../../execution/retry.js';
import { fileExists } from '../../util/fs.js';
import {
  buildInvocation, launchAgentWithEvents, recordTokens,
  commitForAgent, isGitAutomationEnabled,
  getPhase7Cursor, savePhase7Cursor,
} from './shared.js';

export async function launchFinalization(
  flowCtx: FlowExecutionContext<MigrationFlowContext>,
): Promise<PhaseResult> {
  const ctx = flowCtx.context;
  const start = Date.now();
  const phase7Cursor = getPhase7Cursor(ctx);
  const completedAgents = new Set(phase7Cursor.completedAgents);
  const completedSuites = new Set(phase7Cursor.completedSuites);
  const results: AgentResult[] = [];

  const skipAsCompleted = (agent: AgentName): AgentResult => ({
    agent, exitCode: 0, success: true, outputFiles: [], duration: 0, outputParsed: false,
  });
  const saveCursor = async (step: string) => {
    await savePhase7Cursor(ctx, {
      completedAgents: Array.from(completedAgents),
      completedSuites: Array.from(completedSuites),
      lastSuccessfulStep: step,
    });
  };

  // Stage 1: e2e-test-crafter (plan-only)
  if (completedAgents.has('e2e-test-crafter')) {
    results.push(skipAsCompleted('e2e-test-crafter'));
  } else {
    const e2eCtx = await ctx.contextBuilder.buildContext('e2e-test-crafter', 6, undefined, { planOnly: true });
    const crafterResult = await launchAgentWithEvents(ctx, buildInvocation(ctx, 'e2e-test-crafter', e2eCtx, 7));
    results.push(crafterResult);
    recordTokens(ctx, crafterResult, 7);
    if (crafterResult.success) {
      if (isGitAutomationEnabled(ctx)) await commitForAgent(ctx, 'e2e-test-crafter', 7);
      completedAgents.add('e2e-test-crafter');
      await saveCursor('completed-e2e-test-crafter');
    } else {
      return { phase: 7, name: 'E2E Testing & Documentation', success: false, outputPath: ctx.config.target.outputPath, duration: Date.now() - start, error: crafterResult.error ?? 'e2e-test-crafter failed' };
    }
  }

  // Stage 2: Parse suites
  const planPath = join(ctx.config.target.outputPath, 'e2e', 'e2e-test-plan.md');
  let suites: E2eSuiteBrief[] = [];
  if (await fileExists(planPath)) {
    suites = await parseE2eTestPlan(planPath);
  } else {
    ctx.logger.warn('No e2e-test-plan.md; skipping suite fan-out');
  }

  // Stage 3: Fan-out test-writer per suite
  let docWriterHandled = false;

  if (suites.length === 0) {
    ctx.logger.warn('E2E plan contains zero suites');
  } else {
    const pendingSuites = suites.filter(s => !completedSuites.has(s.id));
    if (pendingSuites.length === 0) {
      ctx.logger.info('All E2E suites already completed');
    } else if (suites.length === 1) {
      const result = await executeSuiteWithRetry(ctx, pendingSuites[0]!, completedAgents, completedSuites);
      results.push(result);
    } else if (isGitAutomationEnabled(ctx)) {
      for (const suite of pendingSuites) {
        if (isSuiteBudgetExceeded(ctx, suite.id)) break;
        const result = await executeSuiteWithRetry(ctx, suite, completedAgents, completedSuites);
        results.push(result);
      }
    } else {
      const suitePromise = executeParallelSuiteFanOut(ctx, pendingSuites, suites, results, completedAgents, completedSuites);
      const docPromise = executeDocumentationWriter(ctx, completedAgents, results, skipAsCompleted, saveCursor);
      await Promise.all([suitePromise, docPromise]);
      docWriterHandled = true;
    }
  }

  // Stage 4: Documentation writer
  if (!docWriterHandled) {
    await executeDocumentationWriter(ctx, completedAgents, results, skipAsCompleted, saveCursor);
  }

  const allSuccess = results.every(r => r.success);
  const errors = results.filter(r => !r.success).map(r => r.error);
  if (allSuccess) await saveCursor('complete');

  return {
    phase: 7, name: 'E2E Testing & Documentation', success: allSuccess,
    outputPath: ctx.config.target.outputPath, duration: Date.now() - start,
    error: errors.length > 0 ? errors.join('; ') : undefined,
  };
}

async function executeSuiteWithRetry(
  ctx: MigrationFlowContext, suite: E2eSuiteBrief,
  completedAgents: Set<string>, completedSuites: Set<string>,
): Promise<AgentResult> {
  if (isSuiteBudgetExceeded(ctx, suite.id)) {
    return { agent: 'test-writer', taskId: suite.id, exitCode: 1, success: false, outputFiles: [], duration: 0, outputParsed: false, error: `Budget exceeded before suite ${suite.id}` };
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
    await savePhase7Cursor(ctx, { completedAgents: Array.from(completedAgents), completedSuites: Array.from(completedSuites), lastSuccessfulStep: `completed-suite-${suite.id}` });
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
    lastSuccessfulStep: completedSuites.size === allSuites.length ? 'all-suites-complete' : `completed-${completedSuites.size}-of-${allSuites.length}-suites`,
  });
}

async function executeDocumentationWriter(
  ctx: MigrationFlowContext, completedAgents: Set<string>,
  results: AgentResult[],
  skipAsCompleted: (agent: AgentName) => AgentResult,
  saveCursor: (step: string) => Promise<void>,
): Promise<void> {
  if (completedAgents.has('documentation-writer')) {
    results.push(skipAsCompleted('documentation-writer'));
    return;
  }
  const docCtx = await ctx.contextBuilder.buildContext('documentation-writer', 7);
  const docResult = await launchAgentWithEvents(ctx, buildInvocation(ctx, 'documentation-writer', docCtx, 7));
  results.push(docResult);
  recordTokens(ctx, docResult, 7);
  if (docResult.success) {
    if (isGitAutomationEnabled(ctx)) await commitForAgent(ctx, 'documentation-writer', 7);
    completedAgents.add('documentation-writer');
    await saveCursor('completed-documentation-writer');
  }
}
