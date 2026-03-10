/**
 * Phase 2 — Impact Assessment (agentic, single agent)
 */

import type { FlowExecutionContext } from '@cadre-dev/framework/flow';
import type { MigrationFlowContext } from '../context.js';
import type { PhaseResult } from '../../agents/types.js';
import { buildInvocation, launchAgentWithEvents, recordTokens } from './shared.js';

export async function launchImpactAssessor(
  flowCtx: FlowExecutionContext<MigrationFlowContext>,
): Promise<PhaseResult> {
  const ctx = flowCtx.context;
  const start = Date.now();

  const checkpointState = ctx.checkpoint.getState();
  if (checkpointState.completedPhases.includes(2)) {
    ctx.logger.info('Phase 2 skipped on resume — impact assessment already complete');
    return { phase: 2, name: 'Impact Assessment', success: true, outputPath: ctx.paths.impactAssessmentFile, duration: Date.now() - start };
  }

  const contextFile = await ctx.contextBuilder.buildContext('impact-assessor', 2);
  const inv = buildInvocation(ctx, 'impact-assessor', contextFile, 2);
  const result = await launchAgentWithEvents(ctx, inv);
  recordTokens(ctx, result, 2);

  return {
    phase: 2, name: 'Impact Assessment',
    success: result.success,
    outputPath: ctx.paths.impactAssessmentFile,
    duration: Date.now() - start,
    error: result.error,
    exitCode: result.success ? undefined : result.exitCode,
    stderr: result.success ? undefined : result.stderr,
  };
}
