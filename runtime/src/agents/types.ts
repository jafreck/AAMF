/**
 * @module agents/types
 *
 * Core type definitions for the AAMF agent system.
 * Defines the contracts for agent invocation, results, context,
 * migration tasks, and phase tracking.
 */

// ─── Agent Identity ──────────────────────────────────────────────────────────

/** All recognized agent names in the AAMF system. */
export type AgentName =
  | 'migration-orchestrator'
  | 'impact-assessor'
  | 'knowledge-builder'
  | 'large-file-analyzer'
  | 'migration-planner'
  | 'adjudicator'
  | 'code-migrator'
  | 'parity-verifier'
  | 'test-writer'
  | 'failure-recovery'
  | 'final-parity-checker'
  | 'e2e-test-crafter'
  | 'documentation-writer'
  | 'migration-runner';

// ─── Invocation & Results ────────────────────────────────────────────────────

/**
 * Describes a request to invoke a specific agent.
 *
 * The orchestrator builds an `AgentInvocation` for every agent it needs to
 * run, including the context file path, progress directory, and optional
 * overrides such as timeout or extra arguments.
 */
export interface AgentInvocation {
  /** The agent to invoke. */
  agent: AgentName;

  /** Absolute or workspace-relative path to the context JSON file. */
  contextFile: string;

  /** Progress directory, typically `.copilot/migration/{projectName}`. */
  progressDir: string;

  /** Migration phase number (1-based). */
  phase?: number;

  /** Unique task identifier when the agent operates on a single task. */
  taskId?: string;

  /** Arbitrary key-value pairs forwarded to the agent process. */
  additionalArgs?: Record<string, string>;

  /** Timeout in milliseconds; overrides the default agent timeout. */
  timeout?: number;
}

/**
 * The outcome of a single agent execution.
 *
 * Returned by the runner after an agent process completes (or fails).
 */
export interface AgentResult {
  /** The agent that produced this result. */
  agent: AgentName;

  /** Task identifier, when the invocation targeted a specific task. */
  taskId?: string;

  /** Process exit code (`0` = success). */
  exitCode: number;

  /** Convenience flag derived from `exitCode === 0`. */
  success: boolean;

  /** Files created or modified by the agent during execution. */
  outputFiles: string[];

  /** Wall-clock duration of the agent run in milliseconds. */
  duration: number;

  /** Optional token-usage breakdown reported by the agent. */
  tokenUsage?: { prompt: number; completion: number; total: number };

  /** Captured stderr or error message when the agent fails. */
  error?: string;
}

// ─── Agent Context ───────────────────────────────────────────────────────────

/**
 * Contextual data passed to an agent at invocation time.
 *
 * Serialised to JSON and written to `contextFile` so that the agent can
 * read its configuration, input files, and output expectations.
 */
export interface AgentContext {
  /** The agent this context is intended for. */
  agent: AgentName;

  /** Human-readable project name used for directory naming. */
  projectName: string;

  /** Current migration phase (1-based). */
  phase: number;

  /** Optional task identifier for task-scoped agents. */
  taskId?: string;

  /** Source and target configuration for the migration. */
  config: {
    /** Source project details. */
    source: { path: string; language: string };
    /** Target project details. */
    target: { language: string; framework?: string; outputPath: string };
  };

  /** List of input file paths the agent should process. */
  inputFiles: string[];

  /** Directory or file path where the agent should write its output. */
  outputPath: string;

  /** Arbitrary extra data specific to the invoking phase or agent. */
  payload?: Record<string, unknown>;
}

// ─── Migration Tasks ─────────────────────────────────────────────────────────

/**
 * A discrete unit of migration work identified by the planner.
 *
 * Tasks carry their source/target file mappings, dependency graph edges,
 * complexity rating, and acceptance criteria used by the parity verifier.
 */
export interface MigrationTask {
  /** Unique task identifier, e.g. `"task-001"`. */
  id: string;

  /** Short human-readable name for the task. */
  name: string;

  /** Source files that this task reads from. */
  sourceFiles: string[];

  /** Target files that this task will produce or modify. */
  targetFiles: string[];

  /** Reference key into the knowledge base used by this task. */
  knowledgeBaseRef: string;

  /** IDs of tasks that must complete before this one can start. */
  dependencies: string[];

  /** Estimated complexity bucket. */
  complexity: 'simple' | 'moderate' | 'complex';

  /** Prose description of what the task accomplishes. */
  description: string;

  /** List of criteria that must be met for the task to pass review. */
  acceptanceCriteria: string[];

  /** Parity check identifiers that apply to this task. */
  parityChecks: string[];

  /** Optional line range in the source file to scope the migration. */
  lineRange?: { start: number; end: number };
}

// ─── Migration-Level Results ─────────────────────────────────────────────────

/**
 * Aggregate result of an entire migration run across all phases.
 */
export interface MigrationResult {
  /** Whether every phase completed successfully. */
  success: boolean;

  /** Name of the project that was migrated. */
  projectName: string;

  /** Ordered list of per-phase outcomes. */
  phases: PhaseResult[];

  /** Total wall-clock duration of the migration in milliseconds. */
  totalDuration: number;

  /** Token-usage breakdown across the full migration. */
  tokenUsage: {
    /** Sum of all tokens consumed. */
    total: number;
    /** Tokens consumed per phase number. */
    byPhase: Record<number, number>;
    /** Tokens consumed per agent name. */
    byAgent: Record<string, number>;
  };

  /** Task IDs that failed after exhausting retry/recovery attempts. */
  failedTasks: string[];

  /** Task IDs that could not run due to unmet dependencies. */
  blockedTasks: string[];
}

/**
 * Outcome of a single migration phase.
 */
export interface PhaseResult {
  /** Phase number (1-based). */
  phase: number;

  /** Human-readable phase name. */
  name: string;

  /** Whether the phase completed without errors. */
  success: boolean;

  /** Directory or file path containing the phase's output artefacts. */
  outputPath?: string;

  /** Wall-clock duration of the phase in milliseconds. */
  duration: number;

  /** Error message if the phase failed. */
  error?: string;
}

// ─── Task Tracking ───────────────────────────────────────────────────────────

/**
 * Tracks a task that has failed during migration.
 *
 * Used by the orchestrator to decide whether to retry, escalate to
 * failure-recovery, or mark the task as terminal.
 */
export interface FailedTask {
  /** The task that failed. */
  taskId: string;

  /** Number of execution attempts so far. */
  attempts: number;

  /** Error message from the most recent attempt. */
  lastError: string;

  /** Whether the failure-recovery agent has already been invoked. */
  recoveryAttempted: boolean;
}

/**
 * Extended details about a task's execution, used for reporting and
 * post-migration analysis.
 */
export interface TaskDetails {
  /** Source files processed by the task. */
  sourceFiles?: string[];

  /** Target files produced by the task. */
  targetFiles?: string[];

  /** Parity score (0–1) computed by the parity verifier. */
  parityScore?: number;

  /** Number of test cases generated by the test-writer agent. */
  testsGenerated?: number;

  /** Error message if the task encountered a failure. */
  error?: string;
}
