/**
 * Phase 6 — Final Parity Verification (loopback)
 */

import { join } from 'node:path';
import type { FlowExecutionContext } from '@cadre-dev/framework/flow';
import type { MigrationFlowContext } from '../context.js';
import type { PhaseResult } from '../../agents/types.js';
import { toAgentRemediationContext } from '../../agents/types.js';
import {
  buildInvocation, launchAgentWithEvents, recordTokens,
  commitForAgent, buildRemediationContext,
  getPhase6Cursor, savePhase6Cursor,
} from './shared.js';

const MAX_LOOPBACK = 2;

export async function launchFinalParityChecker(
  flowCtx: FlowExecutionContext<MigrationFlowContext>,
): Promise<PhaseResult> {
  const ctx = flowCtx.context;
  const start = Date.now();
  const phase6Cursor = getPhase6Cursor(ctx);

  if (phase6Cursor.lastSuccessfulStep === 'complete' || phase6Cursor.iteration > MAX_LOOPBACK) {
    const outputPath = ctx.config.target.outputPath;
    if (phase6Cursor.hadUnresolvedFixes) {
      return { phase: 6, name: 'Final Parity Verification', success: false, outputPath, duration: Date.now() - start, error: 'Phase 6 previously completed with unresolved fixes' };
    }
    return { phase: 6, name: 'Final Parity Verification', success: true, outputPath, duration: Date.now() - start };
  }

  const startIteration = Math.min(phase6Cursor.iteration, MAX_LOOPBACK);
  let lastIterationFixes: Array<{ description: string; sourceFile: string; targetFile: string }> = [];
  let loopBrokeEarly = false;

  for (let iteration = startIteration; iteration <= MAX_LOOPBACK; iteration++) {
    if (iteration !== phase6Cursor.iteration) {
      await savePhase6Cursor(ctx, { iteration, fixIndex: 0, lastSuccessfulStep: 'iteration-started' });
    }
    const ctxFile = await ctx.contextBuilder.buildContext('final-parity-checker', 6);
    const inv = buildInvocation(ctx, 'final-parity-checker', ctxFile, 6);
    const result = await launchAgentWithEvents(ctx, inv);
    recordTokens(ctx, result, 6);

    if (!result.success) {
      return { phase: 6, name: 'Final Parity Verification', success: false, duration: Date.now() - start, error: result.error, exitCode: result.exitCode, stderr: result.stderr };
    }

    let fixes: Array<{ description: string; sourceFile: string; targetFile: string }>;
    if (result.outputParsed && Array.isArray(result.structuredOutput?.['fixes'])) {
      fixes = result.structuredOutput['fixes'] as typeof fixes;
    } else {
      ctx.logger.warn('Final-parity-checker structured output unavailable');
      return { phase: 6, name: 'Final Parity Verification', success: false, duration: Date.now() - start, error: 'No structured output with fixes array' };
    }

    if (fixes.length === 0) {
      lastIterationFixes = fixes;
      loopBrokeEarly = true;
      await savePhase6Cursor(ctx, { iteration: iteration + 1, fixIndex: 0, lastSuccessfulStep: 'no-fixes' });
      break;
    }
    lastIterationFixes = fixes;

    if (iteration < MAX_LOOPBACK) {
      ctx.logger.info(`Final parity found ${fixes.length} issue(s), loop-back iteration ${iteration + 1}`);
      const resumeFixIndex = iteration === phase6Cursor.iteration ? Math.max(0, phase6Cursor.fixIndex) : 0;
      for (let fixIndex = resumeFixIndex; fixIndex < fixes.length; fixIndex++) {
        const fix = fixes[fixIndex]!;
        const fixTaskId = `fix-${iteration}-${fixIndex}`;
        await savePhase6Cursor(ctx, { iteration, fixIndex, lastSuccessfulStep: 'fix-started' });
        const fixRemediation = buildRemediationContext({
          failureKind: 'parity', failureSummary: fix.description, taskId: fixTaskId,
          check: 'final-parity-checker',
          artifactPaths: [...(fix.sourceFile ? [fix.sourceFile] : []), ...(fix.targetFile ? [fix.targetFile] : [])],
          expectedSuccessCondition: `Parity issue resolved: ${fix.description}`,
        });
        const fixCtx = await ctx.contextBuilder.buildContext('code-migrator', 5, fixTaskId, {
          sourceFiles: fix.sourceFile ? [fix.sourceFile] : [],
          targetFiles: fix.targetFile ? [fix.targetFile] : [],
          taskScope: { description: `Fix parity issue: ${fix.description}`, acceptanceCriteria: [fix.description], parityChecks: [fix.description] },
          remediationContext: toAgentRemediationContext(fixRemediation),
        });
        const fixInv = buildInvocation(ctx, 'code-migrator', fixCtx, 6, fixTaskId);
        const fixResult = await launchAgentWithEvents(ctx, fixInv);
        recordTokens(ctx, fixResult, 6);
        if (fixResult.success) {
          await commitForAgent(ctx, 'code-migrator', 6, fixTaskId);
          await savePhase6Cursor(ctx, { iteration, fixIndex: fixIndex + 1, lastSuccessfulStep: 'fix-applied' });
        }
      }
      await savePhase6Cursor(ctx, { iteration: iteration + 1, fixIndex: 0, lastSuccessfulStep: 'iteration-complete' });
    } else {
      ctx.logger.warn('Max loop-back iterations reached, proceeding with remaining issues');
    }
  }

  const hadUnresolvedFixes = !loopBrokeEarly && lastIterationFixes.length > 0;
  await savePhase6Cursor(ctx, { iteration: MAX_LOOPBACK + 1, fixIndex: 0, lastSuccessfulStep: 'complete', hadUnresolvedFixes });
  const outputPath = join(ctx.paths.artifactsParityDir, 'final-parity-report.md');

  if (hadUnresolvedFixes) {
    const summary = lastIterationFixes.slice(0, 5).map(f => f.description).join('; ');
    return { phase: 6, name: 'Final Parity Verification', success: false, outputPath, duration: Date.now() - start, error: `${lastIterationFixes.length} unresolved fix(es): ${summary}` };
  }
  return { phase: 6, name: 'Final Parity Verification', success: true, outputPath, duration: Date.now() - start };
}
