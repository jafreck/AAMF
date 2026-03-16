/**
 * Phase 6 — Final Parity Verification
 *
 * Exported as a single-iteration step for the `loop()` DSL node in
 * migration-flow.ts.  Each iteration runs final-parity-checker, applies
 * fixes via code-migrator, and reports whether more fixes are needed.
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
  assertPhaseSuccess,
} from './shared.js';

/**
 * Run a single iteration of the final-parity-checker → code-migrator fix loop.
 * Called by `loop({ id: 'final-parity-loop', ... })` in the flow definition.
 */
export async function runFinalParityIteration(
  flowCtx: FlowExecutionContext<MigrationFlowContext>,
): Promise<{ fixes: number }> {
  const ctx = flowCtx.context;
  const phase6Cursor = getPhase6Cursor(ctx);

  // Run final-parity-checker
  const ctxFile = await ctx.contextBuilder.buildContext('final-parity-checker', 6);
  const inv = buildInvocation(ctx, 'final-parity-checker', ctxFile, 6);
  const result = await launchAgentWithEvents(ctx, inv);
  recordTokens(ctx, result, 6);

  if (!result.success) {
    const failResult: PhaseResult = {
      phase: 6, name: 'Final Parity Verification', success: false,
      duration: 0, error: result.error, exitCode: result.exitCode ?? undefined, stderr: result.stderr,
    };
    assertPhaseSuccess(failResult);
  }

  // Parse fixes from structured output
  let fixes: Array<{ description: string; sourceFile: string; targetFile: string }>;
  if (result.extensions.outputParsed && Array.isArray(result.extensions.structuredOutput?.['fixes'])) {
    fixes = result.extensions.structuredOutput['fixes'] as typeof fixes;
  } else {
    ctx.logger.warn('Final-parity-checker structured output unavailable');
    const failResult: PhaseResult = {
      phase: 6, name: 'Final Parity Verification', success: false,
      duration: 0, error: 'No structured output with fixes array',
    };
    assertPhaseSuccess(failResult);
    return { fixes: 0 }; // unreachable
  }

  if (fixes.length === 0) {
    ctx.logger.info('Final parity check passed — no fixes needed');
    await savePhase6Cursor(ctx, {
      iteration: phase6Cursor.iteration + 1, fixIndex: 0,
      lastSuccessfulStep: 'no-fixes',
    });
    return { fixes: 0 };
  }

  ctx.logger.info(`Final parity found ${fixes.length} issue(s), applying fixes`);

  // Apply fixes
  const resumeFixIndex = Math.max(0, phase6Cursor.fixIndex);
  for (let fixIndex = resumeFixIndex; fixIndex < fixes.length; fixIndex++) {
    const fix = fixes[fixIndex]!;
    const fixTaskId = `fix-${phase6Cursor.iteration}-${fixIndex}`;
    await savePhase6Cursor(ctx, {
      iteration: phase6Cursor.iteration, fixIndex,
      lastSuccessfulStep: 'fix-started',
    });

    const fixRemediation = buildRemediationContext({
      failureKind: 'parity', failureSummary: fix.description, taskId: fixTaskId,
      check: 'final-parity-checker',
      artifactPaths: [
        ...(fix.sourceFile ? [fix.sourceFile] : []),
        ...(fix.targetFile ? [fix.targetFile] : []),
      ],
      expectedSuccessCondition: `Parity issue resolved: ${fix.description}`,
    });

    const fixCtx = await ctx.contextBuilder.buildContext('code-migrator', 5, fixTaskId, {
      sourceFiles: fix.sourceFile ? [fix.sourceFile] : [],
      targetFiles: fix.targetFile ? [fix.targetFile] : [],
      taskScope: {
        description: `Fix parity issue: ${fix.description}`,
        acceptanceCriteria: [fix.description],
        parityChecks: [fix.description],
      },
      remediationContext: toAgentRemediationContext(fixRemediation),
    });
    const fixInv = buildInvocation(ctx, 'code-migrator', fixCtx, 6, fixTaskId);
    const fixResult = await launchAgentWithEvents(ctx, fixInv);
    recordTokens(ctx, fixResult, 6);

    if (fixResult.success) {
      await commitForAgent(ctx, 'code-migrator', 6, fixTaskId);
      await savePhase6Cursor(ctx, {
        iteration: phase6Cursor.iteration, fixIndex: fixIndex + 1,
        lastSuccessfulStep: 'fix-applied',
      });
    }
  }

  await savePhase6Cursor(ctx, {
    iteration: phase6Cursor.iteration + 1, fixIndex: 0,
    lastSuccessfulStep: 'iteration-complete',
  });

  return { fixes: fixes.length };
}

/**
 * `until` predicate for the Phase 6 loop — returns true when no fixes
 * were found in the last iteration (the loop node output).
 */
export function noFixesNeeded(
  ctx: FlowExecutionContext<MigrationFlowContext>,
): boolean {
  // The loop's last iteration output is available via the step output
  const lastOutput = ctx.getStepOutput<{ fixes: number }>('final-parity-iteration');
  return lastOutput != null && lastOutput.fixes === 0;
}
