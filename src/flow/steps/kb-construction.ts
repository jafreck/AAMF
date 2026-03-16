/**
 * Phase 2 — Knowledge Base Construction (agentic, single agent)
 */

import type { FlowExecutionContext } from '@cadre-dev/framework/flow';
import type { MigrationFlowContext } from '../context.js';
import type { PhaseResult } from '../../agents/types.js';
import { buildInvocation, launchAgentWithEvents, recordTokens, assertPhaseSuccess } from './shared.js';

export async function launchKnowledgeBuilder(
  flowCtx: FlowExecutionContext<MigrationFlowContext>,
): Promise<PhaseResult> {
  const ctx = flowCtx.context;
  const start = Date.now();
  const outputPath = ctx.paths.knowledgeBaseDir;

  const checkpointState = ctx.checkpoint.getState();
  if (checkpointState.completedPhases.includes(2)) {
    ctx.logger.info('Phase 2 skipped on resume — knowledge base already built');
    return { phase: 2, name: 'Knowledge Base Construction', success: true, outputPath, duration: Date.now() - start };
  }

  const kbContext = await ctx.contextBuilder.buildContext('knowledge-builder', 2);
  const kbInv = buildInvocation(ctx, 'knowledge-builder', kbContext, 2);
  const kbResult = await launchAgentWithEvents(ctx, kbInv);
  recordTokens(ctx, kbResult, 2);

  if (!kbResult.success) {
    const failResult: PhaseResult = {
      phase: 2, name: 'Knowledge Base Construction', success: false,
      duration: Date.now() - start, error: kbResult.error,
      exitCode: kbResult.exitCode ?? undefined, stderr: kbResult.stderr,
    };
    assertPhaseSuccess(failResult);
  }

  return { phase: 2, name: 'Knowledge Base Construction', success: true, outputPath, duration: Date.now() - start };
}
