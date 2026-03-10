/**
 * Phase 8 — Idiomatic Refactor (optional, review-refactor loop)
 */

import type { FlowExecutionContext } from '@cadre-dev/framework/flow';
import type { MigrationFlowContext } from '../context.js';
import type { PhaseResult } from '../../agents/types.js';
import {
  buildInvocation, launchAgentWithEvents, recordTokens,
  commitForAgent, runCommand,
  getPhase8Cursor, savePhase8Cursor,
} from './shared.js';

export async function launchIdiomaticRefactor(
  flowCtx: FlowExecutionContext<MigrationFlowContext>,
): Promise<PhaseResult> {
  const ctx = flowCtx.context;
  const start = Date.now();
  const maxIterations = ctx.config.options.idiomaticRefactor?.maxIterations ?? 2;
  const phase8Cursor = getPhase8Cursor(ctx);

  if (phase8Cursor.lastSuccessfulStep === 'complete' || phase8Cursor.iteration >= maxIterations) {
    return { phase: 8, name: 'Idiomatic Refactor', success: true, outputPath: ctx.config.target.outputPath, duration: Date.now() - start };
  }

  const startIteration = Math.min(phase8Cursor.iteration, Math.max(0, maxIterations - 1));

  for (let iteration = startIteration; iteration < maxIterations; iteration++) {
    if (iteration !== phase8Cursor.iteration) {
      await savePhase8Cursor(ctx, { iteration, issueIndex: 0, lastSuccessfulStep: 'iteration-started' });
    }

    // Review
    const reviewCtx = await ctx.contextBuilder.buildContext('idiomatic-reviewer', 8);
    const reviewInv = buildInvocation(ctx, 'idiomatic-reviewer', reviewCtx, 8);
    const reviewResult = await launchAgentWithEvents(ctx, reviewInv);
    recordTokens(ctx, reviewResult, 8);

    if (!reviewResult.success) {
      return { phase: 8, name: 'Idiomatic Refactor', success: false, duration: Date.now() - start, error: reviewResult.error, exitCode: reviewResult.exitCode, stderr: reviewResult.stderr };
    }

    let issues: Array<{ file: string; location: string; issue: string; suggestion: string; details: string }>;
    if (reviewResult.outputParsed && Array.isArray(reviewResult.structuredOutput?.['issues'])) {
      issues = reviewResult.structuredOutput['issues'] as typeof issues;
    } else {
      ctx.logger.warn('Idiomatic-reviewer structured output unavailable');
      return { phase: 8, name: 'Idiomatic Refactor', success: false, duration: Date.now() - start, error: 'No structured issues output' };
    }

    if (issues.length === 0) {
      await savePhase8Cursor(ctx, { iteration: iteration + 1, issueIndex: 0, lastSuccessfulStep: 'no-issues' });
      break;
    }

    if (iteration < maxIterations - 1) {
      ctx.logger.info(`Idiomatic review found ${issues.length} issue(s), refactor iteration ${iteration + 1}`);
      const resumeIssueIndex = iteration === phase8Cursor.iteration ? Math.max(0, phase8Cursor.issueIndex) : 0;
      for (let issueIndex = resumeIssueIndex; issueIndex < issues.length; issueIndex++) {
        const issue = issues[issueIndex]!;
        await savePhase8Cursor(ctx, { iteration, issueIndex, currentFile: issue.file, lastSuccessfulStep: 'refactor-started' });

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
          await savePhase8Cursor(ctx, { iteration, issueIndex: issueIndex + 1, lastSuccessfulStep: 'refactor-complete' });
        } else {
          return { phase: 8, name: 'Idiomatic Refactor', success: false, duration: Date.now() - start };
        }
      }
      await savePhase8Cursor(ctx, { iteration: iteration + 1, issueIndex: 0, lastSuccessfulStep: 'iteration-complete' });
    } else {
      ctx.logger.warn('Max idiomatic refactor iterations reached');
    }
  }

  await savePhase8Cursor(ctx, { iteration: maxIterations, issueIndex: 0, lastSuccessfulStep: 'complete' });
  return { phase: 8, name: 'Idiomatic Refactor', success: true, outputPath: ctx.config.target.outputPath, duration: Date.now() - start };
}
