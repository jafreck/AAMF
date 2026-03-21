/**
 * MigrationFlowContext — the shared context object threaded through all
 * flow nodes.  Holds config, infrastructure services, and mutable run-time
 * state for the migration pipeline.
 */

import type pLimit from 'p-limit';
import type { MigrationConfig } from '../config/schema.js';
import type { CheckpointManager } from '../core/checkpoint.js';
import type { AgentLauncher } from '../core/agent-launcher.js';
import type { ProgressWriter } from '../core/progress.js';
import type { Logger } from '../logging/logger.js';
import type { TokenTracker } from '../budget/token-tracker.js';
import type { CostEstimator } from '../budget/cost-estimator.js';
import type { MetricsCollector, Phase4MetricsSnapshot } from '../observability/metrics-collector.js';
import type { ReportGenerator } from '../observability/report-generator.js';
import type { ContextBuilder } from '../agents/context-builder.js';
import type { RetryExecutor } from '../execution/retry.js';
import type { RuntimePaths } from '../core/runtime-paths.js';
import type {
  AgentInvocation,
  AgentResult,
  AgentName,
  MigrationTask,
  CompilationUnit,
  RemediationContext,
  RoutingDecision,
  ModelTier,
  InvocationMetric,
  E2eSuiteBrief,
} from '../agents/types.js';
import type { EmbeddingProvider } from '@jafreck/lore';
import type { KbServerProcess } from '../core/kb-server-process.js';
import type { TargetIndexer } from '../core/target-indexer.js';
import type { SymbolMapper } from '../core/symbol-mapper.js';
import type { TaskQueue } from '../execution/task-queue.js';

/** Parity result data extracted from parity-verifier aamf-json output. */
export interface ParityResultData {
  parity: 'pass' | 'partial' | 'fail';
  issues: Array<{
    severity: 'critical' | 'major' | 'minor';
    description: string;
    details: string;
    sourceLocation: string;
    targetLocation?: string;
  }>;
}

export interface RetryTargetDetails {
  scope: 'task' | 'parity' | 'command' | 'wave';
  attempt: number;
  maxAttempts: number;
  taskId?: string;
  wave?: number;
  check?: string;
  summary: string;
}

export interface TerminalExhaustionDetails {
  reasonCode: import('../agents/types.js').TerminalReasonCode;
  taskId?: string;
  wave?: number;
  check?: string;
  summary: string;
}

export type CommandExecutionResult = {
  success: boolean;
  error?: string;
  infraError?: string;
  rawError?: string;
  logPath?: string;
};

export interface WaveValidationResult {
  success: boolean;
  failedLabel?: 'build' | 'test';
  failedCommand?: string;
  failure?: CommandExecutionResult;
}

export type QualityGateMode = 'enforce' | 'advisory' | 'skip';

/**
 * The full context object shared across all flow steps.
 * Passed as the `TContext` generic parameter to `defineFlow<MigrationFlowContext>()`.
 */
export interface MigrationFlowContext {
  // ── Immutable configuration ──
  readonly config: MigrationConfig;
  readonly projectRoot: string;
  readonly runId: string;
  readonly paths: RuntimePaths;
  readonly maxPhase?: number;

  // ── Infrastructure services ──
  readonly checkpoint: CheckpointManager;
  readonly launcher: AgentLauncher;
  readonly progress: ProgressWriter;
  readonly logger: Logger;
  readonly tokenTracker: TokenTracker;
  readonly costEstimator: CostEstimator;
  readonly metricsCollector: MetricsCollector;
  readonly reportGenerator: ReportGenerator;
  readonly contextBuilder: ContextBuilder;
  readonly buildLimiter: ReturnType<typeof pLimit>;
  readonly gitLimiter: ReturnType<typeof pLimit>;

  // ── Mutable run-time state ──
  /** KB server process - started during Phase 0 */
  kbServer?: KbServerProcess;
  /** Target KB server process - started after first target index build */
  targetKbServer?: KbServerProcess;
  /** Target codebase indexer - builds/updates kb-target.db */
  targetIndexer?: TargetIndexer;
  /** Source↔Target symbol mapper */
  symbolMapper?: SymbolMapper;
  /** Embedding provider - created during Phase 0 */
  embedder?: EmbeddingProvider;
  /** Task graph result from Phase 1 for Phase 4 consumption */
  phase1TaskGraphResult?: AgentResult;
  /** Peak concurrency observed across all ParallelExecutor instances */
  peakConcurrency: number;
  /** In-memory cache of parity-verifier results */
  parityResults: Map<string, ParityResultData>;
  /** Unique task IDs that consumed routed-task budget */
  routedTaskIds: Set<string>;
  /** Cumulative projected escalation cost (USD) */
  escalationCostUsd: number;
  /** Phase 4 observability counters */
  phase4Snapshot?: Phase4MetricsSnapshot;
  /** When true, per-task/per-agent git commits are suppressed (wave-barrier mode) */
  deferGitCommits: boolean;
}
