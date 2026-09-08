import type { MigrationFlowContext } from './context.js';

export type FailurePolicy = 'fatal' | 'blocked-domain-outcome' | 'advisory';

/** Operations that are explicitly non-blocking in the product contract. */
export const ADVISORY_OPERATIONS = [
  'dependency-summary',
  'scaffold-generation',
  'scaffold-verification',
  'target-index-enrichment',
  'target-kb-server',
] as const;

export type AdvisoryOperation = (typeof ADVISORY_OPERATIONS)[number];

export function recordAdvisoryFailure(
  ctx: Pick<MigrationFlowContext, 'logger'>,
  operation: AdvisoryOperation,
  error: unknown,
): void {
  const message = error instanceof Error ? error.message : String(error);
  ctx.logger.warn(`[advisory:${operation}] ${message}`);
}
