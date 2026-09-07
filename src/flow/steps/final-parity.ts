/**
 * Phase 5 — Final Parity Verification
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
  commitForPhase, buildRemediationContext,
  getPhase5Cursor, savePhase5Cursor,
  assertPhaseSuccess,
} from './shared.js';
import { PHASE } from '../phases.js';

export interface FinalParityIterationResult {
  detected: number;
  applied: number;
  failed: number;
  /** Blocking fixes still requiring a fresh successful parity check. */
  remaining: number;
}

const FINAL_PARITY_CHANGE_SCOPE = 'phase-5-final-parity-fixes';

async function rollbackFinalParityCandidate(ctx: MigrationFlowContext): Promise<void> {
  if (!(await ctx.targetChanges.has(FINAL_PARITY_CHANGE_SCOPE))) return;
  if (ctx.targetKbServer) {
    await ctx.targetKbServer.stop();
    ctx.targetKbServer = undefined;
  }
  await ctx.targetChanges.rollback(FINAL_PARITY_CHANGE_SCOPE);
  if (ctx.targetIndexer) await ctx.targetIndexer.invalidate();
}

/**
 * Run a single iteration of the final-parity-checker → code-migrator fix loop.
 * Called by `loop({ id: 'final-parity-loop', ... })` in the flow definition.
 */
export async function runFinalParityIteration(
  flowCtx: FlowExecutionContext<MigrationFlowContext>,
): Promise<FinalParityIterationResult> {
  const ctx = flowCtx.context;
  const phase5Cursor = getPhase5Cursor(ctx);

  // Run final-parity-checker
  const ctxFile = await ctx.contextBuilder.buildContext('final-parity-checker', PHASE.FINAL_PARITY);
  const inv = buildInvocation(ctx, 'final-parity-checker', ctxFile, PHASE.FINAL_PARITY);
  const result = await launchAgentWithEvents(ctx, inv);
  recordTokens(ctx, result, PHASE.FINAL_PARITY);

  if (!result.success) {
    const failResult: PhaseResult = {
      phase: 5, name: 'Final Parity Verification', success: false,
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
      phase: 5, name: 'Final Parity Verification', success: false,
      duration: 0, error: 'No structured output with fixes array',
    };
    assertPhaseSuccess(failResult);
    return { detected: 0, applied: 0, failed: 0, remaining: 0 }; // unreachable
  }

  if (fixes.length === 0) {
    ctx.logger.info('Final parity check passed — no fixes needed');
    if (await ctx.targetChanges.has(FINAL_PARITY_CHANGE_SCOPE)) {
      await commitForPhase(ctx, PHASE.FINAL_PARITY, 'validated final parity fixes');
      await ctx.targetChanges.accept(FINAL_PARITY_CHANGE_SCOPE);
    }
    await savePhase5Cursor(ctx, {
      iteration: phase5Cursor.iteration + 1, fixIndex: 0,
      lastSuccessfulStep: 'no-fixes',
    });
    return { detected: 0, applied: 0, failed: 0, remaining: 0 };
  }

  ctx.logger.info(`Final parity found ${fixes.length} issue(s), applying fixes`);
  await ctx.targetChanges.begin(FINAL_PARITY_CHANGE_SCOPE);

  // Apply fixes
  const resumeFixIndex = Math.max(0, phase5Cursor.fixIndex);
  let applied = 0;
  for (let fixIndex = resumeFixIndex; fixIndex < fixes.length; fixIndex++) {
    const fix = fixes[fixIndex]!;
    const fixTaskId = `fix-${phase5Cursor.iteration}-${fixIndex}`;
    await savePhase5Cursor(ctx, {
      iteration: phase5Cursor.iteration, fixIndex,
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

    const fixCtx = await ctx.contextBuilder.buildContext('code-migrator', PHASE.FINAL_PARITY, fixTaskId, {
      sourceFiles: fix.sourceFile ? [fix.sourceFile] : [],
      targetFiles: fix.targetFile ? [fix.targetFile] : [],
      taskScope: {
        description: `Fix parity issue: ${fix.description}`,
        acceptanceCriteria: [fix.description],
        parityChecks: [fix.description],
      },
      remediationContext: toAgentRemediationContext(fixRemediation),
    });
    const fixInv = buildInvocation(ctx, 'code-migrator', fixCtx, PHASE.FINAL_PARITY, fixTaskId);
    const fixResult = await launchAgentWithEvents(ctx, fixInv);
    recordTokens(ctx, fixResult, PHASE.FINAL_PARITY);

    if (!fixResult.success) {
      const error = fixResult.error ?? `Required final-parity fix ${fixTaskId} failed`;
      const failedFixes = [
        ...(phase5Cursor.failedFixes ?? []),
        { taskId: fixTaskId, description: fix.description, error },
      ];
      await savePhase5Cursor(ctx, {
        iteration: phase5Cursor.iteration,
        fixIndex,
        lastSuccessfulStep: `fix-failed:${fixTaskId}`,
        hadUnresolvedFixes: true,
        failedFixes,
      });
      await rollbackFinalParityCandidate(ctx);
      assertPhaseSuccess({
        phase: 5, name: 'Final Parity Verification', success: false,
        duration: 0, error,
        exitCode: fixResult.exitCode ?? undefined,
        stderr: fixResult.stderr,
      });
    }

    applied++;
    await savePhase5Cursor(ctx, {
      iteration: phase5Cursor.iteration, fixIndex: fixIndex + 1,
      lastSuccessfulStep: 'fix-applied',
      hadUnresolvedFixes: true,
      failedFixes: phase5Cursor.failedFixes,
    });
  }

  await savePhase5Cursor(ctx, {
    iteration: phase5Cursor.iteration + 1, fixIndex: 0,
    lastSuccessfulStep: 'iteration-complete',
    hadUnresolvedFixes: true,
    failedFixes: phase5Cursor.failedFixes,
  });

  return { detected: fixes.length, applied, failed: 0, remaining: fixes.length };
}

/**
 * `until` predicate for the Phase 5 loop — returns true when no fixes
 * were found in the last iteration (the loop node output).
 */
export function noFixesNeeded(
  ctx: FlowExecutionContext<MigrationFlowContext>,
): boolean {
  // The loop's last iteration output is available via the step output
  const lastOutput = ctx.getStepOutput<FinalParityIterationResult>('final-parity-iteration');
  return lastOutput != null && lastOutput.remaining === 0 && lastOutput.failed === 0;
}

/** Required post-loop gate: loop exhaustion with blocking fixes is failure. */
export async function finalParityConverged(
  ctx: FlowExecutionContext<MigrationFlowContext>,
): Promise<boolean> {
  const converged = noFixesNeeded(ctx);
  if (!converged) await rollbackFinalParityCandidate(ctx.context);
  return converged;
}
