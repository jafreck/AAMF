/**
 * @module flow
 *
 * Declarative, runtime-owned migration flow.
 */

export { migrationFlow, buildFlowUpToPhase, nodeIdToPhase, PHASE_BOUNDARY_NODE_IDS, MAX_PHASE } from './migration-flow.js';
export { AamfFlowCheckpointAdapter, Phase4CheckpointAdapter } from './checkpoint-adapter.js';
export type { MigrationFlowContext } from './context.js';
export type { TaskGraphOutput } from './steps/task-graph.js';
export type {
  ParityResultData,
  RetryTargetDetails,
  TerminalExhaustionDetails,
  CommandExecutionResult,
  WaveValidationResult,
  QualityGateMode,
} from './context.js';

// Re-export errors for backwards compatibility
export { TerminalExhaustionError, MigrationError, classifyError } from './steps/shared.js';
