/**
 * Phase 8 — Idiomatic Refactor
 *
 * Exported as a single-iteration step for the `loop()` DSL node.
 * Each iteration runs idiomatic-reviewer, then idiomatic-refactorer for
 * each issue found.
 */

import type { FlowExecutionContext } from '@cadre-dev/framework/flow';
import type { MigrationFlowContext } from '../context.js';
import type { PhaseResult } from '../../agents/types.js';
import {
  buildInvocation, launchAgentWithEvents, recordTokens,
  commitForAgent, runCommand,
  getPhase8Cursor, savePhase8Cursor,
  assertPhaseSuccess,
} from './shared.js';

/**
 * Run a single iteration of the idiomatic review → refactor loop.
 * Called by `loop({ id: 'idiomatic-loop', ... })` in the flow definition.
 */
export async function runIdiomaticReviewIteration(
  flowCtx: FlowExecutionContext<MigrationFlowContext>,
): Promise<{ issues: number }> {
  const ctx = flowCtx.context;
  const phase8Cursor = getPhase8Cursor(ctx);
  const start = Date.now();

  // Review
  const reviewCtx = await ctx.contextBuilder.buildContext('idiomatic-reviewer', 8);
  const reviewInv = buildInvocation(ctx, 'idiomatic-reviewer', reviewCtx, 8);
  const reviewResult = await launchAgentWithEvents(ctx, reviewInv);
  recordTokens(ctx, reviewResult, 8);

  if (!reviewResult.success) {
    const failResult: PhaseResult = {
      phase: 8, name: 'Idiomatic Refactor', success: false,
      duration: Date.now() - start, error: reviewResult.error,
      exitCode: reviewResult.exitCode, stderr: reviewResult.stderr,
    };
    assertPhaseSuccess(failResult);
  }

  let issues: Array<{ file: string; location: string; issue: string; suggestion: string; details: string }>;
  if (reviewResult.outputParsed && Array.isArray(reviewResult.structuredOutput?.['issues'])) {
    issues = reviewResult.structuredOutput['issues'] as typeof issues;
  } else {
    ctx.logger.warn('Idiomatic-reviewer structured output unavailable');
    const failResult: PhaseResult = {
      phase: 8, name: 'Idiomatic Refactor', success: false,
      duration: Date.now() - start, error: 'No structured issues output',
    };
    assertPhaseSuccess(failResult);
    return { issues: 0 }; // unreachable
  }

  if (issues.length === 0) {
    ctx.logger.info('Idiomatic review found no issues');
    await savePhase8Cursor(ctx, {
      iteration: phase8Cursor.iteration + 1, issueIndex: 0,
      lastSuccessfulStep: 'no-issues',
    });
    return { issues: 0 };
  }

  ctx.logger.info(`Idiomatic review found ${issues.length} issue(s), refactoring`);
  const resumeIssueIndex = Math.max(0, phase8Cursor.issueIndex);

  for (let issueIndex = resumeIssueIndex; issueIndex < issues.length; issueIndex++) {
    const issue = issues[issueIndex]!;
    await savePhase8Cursor(ctx, {
      iteration: phase8Cursor.iteration, issueIndex,
      currentFile: issue.file, lastSuccessfulStep: 'refactor-started',
    });

    const refactorCtx = await ctx.contextBuilder.buildContext('idiomatic-refactorer', 8, undefined, {
      targetFile: issue.file, issue,
    });
    const refactorInv = buildInvocation(ctx, 'idiomatic-refactorer', refactorCtx, 8);
    const refactorResult = await launchAgentWithEvents(ctx, refactorInv);
    recordTokens(ctx, refactorResult, 8);

    if (refactorResult.success) {
      if (ctx.config.target.formatCommand) {
        const fmtResult = await runCommand(ctx, 'format', ctx.config.target.formatCommand, `phase8-${issue.file}`);
        if (!fmtResult.success) ctx.logger.warn(`Phase 8 format failed for ${issue.file}: ${fmtResult.error ?? 'unknown'}`);
      }
      await commitForAgent(ctx, 'idiomatic-refactorer', 8, issue.file);
      if (ctx.config.target.lintCommand) {
        const lintResult = await runCommand(ctx, 'lint', ctx.config.target.lintCommand, `phase8-${issue.file}`);
        if (!lintResult.success) ctx.logger.warn(`Phase 8 lint failed for ${issue.file}: ${lintResult.error ?? 'unknown'}`);
      }
      await savePhase8Cursor(ctx, {
        iteration: phase8Cursor.iteration, issueIndex: issueIndex + 1,
        lastSuccessfulStep: 'refactor-complete',
      });
    } else {
      const failResult: PhaseResult = {
        phase: 8, name: 'Idiomatic Refactor', success: false,
        duration: Date.now() - start,
      };
      assertPhaseSuccess(failResult);
    }
  }

  await savePhase8Cursor(ctx, {
    iteration: phase8Cursor.iteration + 1, issueIndex: 0,
    lastSuccessfulStep: 'iteration-complete',
  });

  return { issues: issues.length };
}

/**
 * `until` predicate for the Phase 8 loop — returns true when no
 * idiomatic issues were found in the last iteration.
 */
export function noIdiomaticIssues(
  ctx: FlowExecutionContext<MigrationFlowContext>,
): boolean {
  const lastOutput = ctx.getStepOutput<{ issues: number }>('idiomatic-iteration');
  return lastOutput != null && lastOutput.issues === 0;
}
