/**
 * Phase 9 — Completion
 */

import type { FlowExecutionContext } from '@cadre-dev/framework/flow';
import type { MigrationFlowContext } from '../context.js';
import type { PhaseResult } from '../../agents/types.js';

export async function finalizeAndReport(
  flowCtx: FlowExecutionContext<MigrationFlowContext>,
): Promise<PhaseResult> {
  const ctx = flowCtx.context;
  const start = Date.now();
  await ctx.progress.appendEvent('Migration pipeline complete — finalizing');
  ctx.logger.info('All phases complete');
  return { phase: 9, name: 'Completion', success: true, outputPath: ctx.paths.root, duration: Date.now() - start };
}
