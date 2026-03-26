/**
 * @module agents/types
 *
 * Core type definitions for the AAMF agent system.
 * Defines the contracts for agent invocation, results, context,
 * migration tasks, and phase tracking.
 */

// ─── Agent Identity ──────────────────────────────────────────────────────────

/** Lightweight alias for a JSON Schema object. */
export type JsonSchema = Record<string, unknown>;

/** All recognized agent names in the AAMF system. */
export type AgentName =
  | 'migration-orchestrator'
  | 'knowledge-builder'
  | 'migration-planner'
  | 'adjudicator'
  | 'code-migrator'
  | 'parity-verifier'
  | 'test-writer'
  | 'parity-failure-resolver'
  | 'final-parity-checker'
  | 'e2e-test-crafter'
  | 'documentation-writer'
  | 'migration-runner'
  | 'idiomatic-reviewer'
  | 'idiomatic-refactorer';

// ─── MCP Server Config ───────────────────────────────────────────────────────

/**
 * Configuration that an MCP client uses to connect to the shared KB HTTP server.
 * The server runs for the duration of the migration and all agents connect to
 * the same instance via this URL.
 */
export interface McpServerConfig {
  /** HTTP URL of the running KB MCP server (e.g. `"http://localhost:4321/mcp"`). */
  url: string;
}

// ─── Invocation & Results ────────────────────────────────────────────────────

/**
 * Describes a request to invoke a specific agent.
 *
 * The orchestrator builds an `AgentInvocation` for every agent it needs to
 * run, including the context file path, progress directory, and optional
 * overrides such as timeout or extra arguments.
 */
/** AAMF-specific extensions on AgentInvocation (not in the framework). */
export interface AgentInvocationExtensions {
  /** Progress directory, typically `.aamf/migration/{projectName}`. */
  progressDir?: string;
  /** Arbitrary key-value pairs forwarded to the agent process. */
  additionalArgs?: Record<string, string>;
  /** MCP server config for the KB server; serialised as --mcp-config to the agent subprocess. */
  mcpConfig?: McpServerConfig;
  /** Path to the KB SQLite database; injected as KB_DB_PATH env var into the agent subprocess. */
  kbDbPath?: string;
  /** MCP server config for the target KB server (migrated codebase index). */
  targetMcpConfig?: McpServerConfig;
  /** Path to the target KB SQLite database. */
  targetKbDbPath?: string;
  /** Routing tier assigned by the model routing policy (undefined when routing is inactive). */
  routingTier?: ModelTier;
  /** Human-readable reason for the routing decision. */
  routingReason?: string;
  /** Current attempt number (1-based), set by RetryExecutor. */
  attemptNumber?: number;
  /** Maximum attempts allowed, set by RetryExecutor. */
  maxAttempts?: number;
}

export interface AgentInvocation {
  /** The agent to invoke. */
  agent: AgentName;

  /** Absolute or workspace-relative path to the context JSON file. */
  contextPath: string;

  /** Expected output path(s). */
  outputPath: string;

  /** Migration phase number (1-based). */
  phase: number;

  /** Work-item identifier (mapped from taskId; empty string for non-task phases). */
  workItemId: string;

  /** Timeout in milliseconds; overrides the default agent timeout. */
  timeout?: number;

  /** Model override for this single invocation (e.g. fallback model on infra failures). */
  modelOverride?: string;

  /** Pre-generated invocation ID for log correlation; runners use this instead of generating their own. */
  invocationId?: string;

  /** AAMF-specific extension fields not present in the framework. */
  extensions?: AgentInvocationExtensions;
}

/** AAMF-specific extensions on AgentResult (not in the framework). */
export interface AgentResultExtensions {
  /** Files created or modified by the agent during execution. */
  outputFiles?: string[];
  /** Structured data parsed from the agent's output, if applicable. */
  structuredOutput?: Record<string, unknown>;
  /** Whether the agent's output was successfully parsed into structured form. */
  outputParsed?: boolean;
  /** Error message describing why output parsing failed, if applicable. */
  parseError?: string;
  /** Estimated premium requests consumed (Copilot only). */
  premiumRequests?: number;
  /** Structured event data from `copilot --output-format json`, when available. */
  copilotEvents?: {
    totalEvents: number;
    toolCalls: Array<{ name: string; status: string }>;
    resultSummary?: {
      exitCode: number;
      premiumRequests?: number;
      totalApiDurationMs?: number;
      sessionDurationMs?: number;
      codeChanges?: { linesAdded: number; linesRemoved: number; filesModified: string[] };
    };
    errorCount: number;
  };
  /** Time in milliseconds the invocation spent waiting in the queue before launch. */
  queueDelay?: number;
  /** Time in milliseconds from process spawn to the first output file being detected. */
  spawnToFirstOutput?: number;
}

/**
 * The outcome of a single agent execution.
 *
 * Returned by the runner after an agent process completes (or fails).
 */
export interface AgentResult {
  /** The agent that produced this result. */
  agent: AgentName;

  /** Work-item identifier (mapped from taskId; empty string for non-task phases). */
  workItemId: string;

  /** Process exit code (`0` = success, `null` if not available). */
  exitCode: number | null;

  /** Convenience flag derived from `exitCode === 0`. */
  success: boolean;

  /** Whether the agent was killed due to timeout. */
  timedOut: boolean;

  /** Wall-clock duration of the agent run in milliseconds. */
  duration: number;

  /** Full stdout from the agent process. */
  stdout: string;

  /** Full stderr from the agent process. */
  stderr: string;

  /** Token-usage breakdown reported by the agent. */
  tokenUsage: { input: number; output: number; cachedInput?: number } | null;

  /** Path to the output file(s) the agent produced. */
  outputPath: string;

  /** Whether the expected output file exists. */
  outputExists: boolean;

  /** Captured error message when the agent fails. */
  error?: string;

  /** Unique identifier for this specific invocation, for log correlation. */
  invocationId?: string;

  /** AAMF-specific extension fields not present in the framework. */
  extensions: AgentResultExtensions;
}

// ─── Agent Context ───────────────────────────────────────────────────────────

/**
 * Contextual data passed to an agent at invocation time.
 *
 * Serialised to JSON and written to `contextPath` so that the agent can
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

  /**
   * User-provided migration guidance directives from the config file.
   * Every agent receives the same array so it can respect project-specific
   * constraints (e.g. "do not use wrapper crates").
   */
  guidance?: string[];

  /** Arbitrary extra data specific to the invoking phase or agent. */
  payload?: Record<string, unknown>;
}

// ─── Execution Strategy ──────────────────────────────────────────────────────

/**
 * Execution-topology context passed to planning agents (`migration-planner`,
 * `migration-planner`) so they can tailor task granularity, grouping, and
 * dependency design to the actual Phase 4 execution mode.
 *
 * Agents that receive this in their `payload.executionStrategy` can, for
 * example, co-locate related files into the same wave-friendly grouping,
 * avoid target-directory overlap that would shrink wave batch size, or
 * calibrate task complexity against the available recovery budget.
 */
export interface ExecutionStrategy {
  /** Phase 4 execution mode. */
  executionMode: 'per-task' | 'wave-barrier' | 'sync-epoch';

  /** Maximum number of agent subprocesses running in parallel. */
  maxParallelAgents: number;

  /** Wave-barrier settings (only meaningful when `executionMode === 'wave-barrier'`). */
  waveControl: {
    /** Maximum build/test convergence iterations per wave before giving up. 0 = unlimited. */
    maxConvergenceIterations: number;
  };

  /** Maximum retry attempts per task before failure-adjudication. */
  maxRetriesPerTask: number;

  /** Shell command used to build the target project (empty when not configured). */
  buildCommand?: string;

  /** Shell command used to test the target project (empty when not configured). */
  testCommand?: string;

  /** Shell command used to format generated code (empty when not configured). */
  formatCommand?: string;

  /** Shell command used to lint the target project (empty when not configured). */
  lintCommand?: string;

  /**
   * Whether concurrently runnable tasks must have non-overlapping target files.
   * Always `true` — exposed so the planner can reason about the constraint.
   */
  requiresNonOverlappingTargets: true;
}

// ─── Recovery Remediation Contracts ───────────────────────────────────────────

/**
 * Location details describing which wave/task/check failed and needs remediation.
 */
export interface RemediationTargetContext {
  /** Phase 4 wave number when the failure occurred. */
  wave?: number;
  /** Task identifier associated with the failure. */
  taskId?: string;
  /** Parity/build/test check identifier associated with the failure. */
  check?: string;
}

/**
 * Agent-facing remediation context serialized into the context JSON file.
 * Contains only what agents need — failure classification, artifact paths,
 * and prior-attempt history.  The truncated `failureSummary` that was
 * previously included is omitted; agents receive full failure details via
 * the artifact file paths instead.
 */
export interface AgentRemediationContext {
  /** Canonical failure category (e.g. parity, build, test, convergence). */
  failureKind: string;
  /** Wave/task/check location describing the failure target. */
  failureTarget: RemediationTargetContext;
  /** File/report/artifact paths relevant to remediation. */
  artifactPaths: string[];
  /** Condition that determines whether remediation was successful. */
  expectedSuccessCondition: string;
  /** Path to the parity-failure-resolver's analysis output, if available. */
  adjudicationReportPath?: string;
  /** Structured parity issues from the parity-verifier, if the failure is parity-related. */
  parityIssues?: Array<{
    severity: string;
    description: string;
    details: string;
    sourceLocation: string;
    targetLocation?: string;
    suggestedFix?: string;
  }>;
  /** Outcomes of prior recovery attempts, enabling the agent to avoid repeating failed strategies. */
  priorAttempts?: PriorRecoveryAttempt[];
}

/**
 * Internal remediation state used by the orchestrator, logging, and progress
 * systems.  Extends the agent-facing context with a `failureSummary` field
 * used only for runtime log messages and progress reports.
 *
 * Call {@link toAgentRemediationContext} to strip internal-only fields before
 * passing to the context builder.
 */
export interface RemediationContext extends AgentRemediationContext {
  /** Normalized summary kept for runtime logging and progress reports. */
  failureSummary: string;
}

/**
 * Strip internal-only fields from a {@link RemediationContext}, producing an
 * {@link AgentRemediationContext} safe for serialization into the agent
 * context JSON.
 */
export function toAgentRemediationContext(state: RemediationContext): AgentRemediationContext {
  const { failureSummary: _, ...agentCtx } = state;
  return agentCtx;
}

/** Outcome record from a single prior recovery attempt. */
export interface PriorRecoveryAttempt {
  /** 1-based attempt number. */
  attempt: number;
  /** Number of issues found by parity-verifier on this attempt. */
  issueCount: number;
  /** Descriptions of non-minor issues that remained unresolved. */
  unresolvedIssues: string[];
  /** Full parity issues from this attempt, enabling the resolver to avoid regressions. */
  fullIssues?: Array<{
    severity: string;
    description: string;
    details: string;
    sourceLocation: string;
    targetLocation?: string;
    suggestedFix?: string;
  }>;
}

// ─── Terminal Exhaustion Contracts ────────────────────────────────────────────

/** Canonical terminal exhaustion reason codes for Phase 4 fail-fast outcomes. */
export type TerminalReasonCode =
  | 'wave-convergence-exhausted'
  | 'task-retries-exhausted'
  | 'parity-non-minor-exhausted'
  | 'command-recovery-exhausted';

// ─── E2E Suite Briefs ────────────────────────────────────────────────────────

/**
 * A discrete E2E test suite definition extracted from the e2e-test-crafter's
 * plan output.  Each brief describes one test suite that will be handed to
 * an independent `test-writer` agent invocation during Phase 6 fan-out.
 */
export interface E2eSuiteBrief {
  /** Unique suite identifier, e.g. `"suite-001"`. */
  id: string;

  /** Human-readable name for the suite. */
  name: string;

  /** Brief description of the suite's testing purpose. */
  purpose: string;

  /** Target files/modules the suite exercises. */
  targetFiles: string[];

  /** Knowledge-base reference keys relevant to this suite. */
  kbReferences: string[];

  /** Test framework to use (e.g. `"vitest"`, `"jest"`, `"pytest"`). */
  framework: string;

  /** Directory or file path where the suite's test files should be written. */
  outputLocation: string;

  /** High-level scenario descriptions that the suite must cover. */
  scenarios: string[];
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

  /** Structured symbol data for this task (name, kind, file, line range). */
  symbols?: Array<{
    name: string;
    kind: string;
    file: string;
    startLine: number;
    endLine: number;
  }>;

  /** Total non-overlapping lines covered by symbols in this task. */
  totalLines?: number;

  /** Optional line range in the source file to scope the migration.
   *  For single-file tasks this is the exact symbol range.
   *  For multi-file tasks this is the primary file's range (see fileRanges). */
  lineRange?: { start: number; end: number };

  /** Per-file line ranges for multi-file tasks. Maps source file path to line range. */
  fileRanges?: Record<string, { start: number; end: number }>;

  /**
   * Compilation unit this task belongs to.  Set by the task-graph-builder when
   * a `compilation-units.json` artifact is available from the migration-planner.
   * Build checks only run at compilation-unit boundaries.
   */
  compilationUnit?: string;
}

// ─── Compilation Units ──────────────────────────────────────────────────────

/**
 * A target compilation unit (crate, package, project) that groups related
 * source files into a buildable boundary.  Emitted by `migration-planner`
 * in `planning/compilation-units.json`.
 *
 * The runtime validates cross-unit dependencies against the Lore symbol graph
 * and only runs build checks when all tasks in a unit are complete.
 */
export interface CompilationUnit {
  /** Stable identifier, e.g. `"core"`, `"dict-builder"`. */
  id: string;

  /** Human-readable name for the compilation unit. */
  name: string;

  /** Target path for the compilation unit (e.g. `"crates/zstd-core"`). */
  targetPath: string;

  /** Source files that belong to this unit. */
  sourceFiles: string[];

  /** IDs of other compilation units this one depends on. */
  dependsOn: string[];

  /** Agent's rationale for this grouping. */
  rationale?: string;
}

// ─── Module Groups ──────────────────────────────────────────────────────────

/**
 * @deprecated Use {@link CompilationUnit} instead.
 * A logical grouping of related source modules, emitted by `migration-planner`
 * in `planning/groups.json`.
 */
export interface ModuleGroup {
  /**
   * Stable, filesystem-safe identifier (e.g. `"core"`, `"api"`, `"utils-1"`).
   */
  id: string;

  /** Human-readable name shown in logs and progress output. */
  name: string;

  /**
   * Absolute paths to the knowledge-base analysis files that are relevant to
   * this group.
   */
  analysisFiles: string[];

  /** Optional prose description of what the group contains. */
  description?: string;
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

  /** Sum of all session durations (in milliseconds) across all resume runs. */
  cumulativeDuration?: number;
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

  /** Process exit code of the agent that caused the failure, if applicable. */
  exitCode?: number;

  /** Raw stderr from the agent that caused the failure, if applicable. */
  stderr?: string;
}

// ─── Task Tracking ───────────────────────────────────────────────────────────

/**
 * Tracks a task that has failed during migration.
 *
 * Used by the orchestrator to decide whether to retry, escalate to
 * parity-failure-resolver, or mark the task as terminal.
 */
export interface FailedTask {
  /** The task that failed. */
  taskId: string;

  /** Number of execution attempts so far. */
  attempts: number;

  /** Error message from the most recent attempt. */
  lastError: string;

  /** Whether the parity-failure-resolver agent has already been invoked. */
  recoveryAttempted: boolean;
}

// ─── Invocation Metrics ──────────────────────────────────────────────────────

/**
 * Structured metric record emitted for every agent invocation.
 * Captured at launch/complete/fail boundaries for observability reporting.
 */
export interface InvocationMetric {
  /** Run identifier for the migration session. */
  runId: string;
  /** Migration phase number (1-based). */
  phase: number;
  /** Task identifier, when the invocation targets a specific task. */
  taskId: string;
  /** Agent type that was invoked. */
  agentType: AgentName;
  /** Unique identifier for this specific invocation. */
  invocationId: string;
  /** ISO-8601 timestamp when the invocation started. */
  startTime: string;
  /** ISO-8601 timestamp when the invocation ended. */
  endTime: string;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
  /** 1-based attempt number for this invocation. */
  attemptNumber: number;
  /** Maximum retry attempts configured for this invocation. */
  maxAttempts: number;
  /** Whether this invocation is a retry of a previous attempt. */
  wasRetry: boolean;
  /** Outcome of the invocation. */
  status: 'success' | 'failed' | 'cancelled';
  /** Model identifier used for this invocation. */
  model: string;
  /** Number of prompt (input) tokens consumed. */
  tokensPrompt: number;
  /** Number of completion (output) tokens consumed. */
  tokensCompletion: number;
  /** Total tokens consumed (prompt + completion). */
  tokensTotal: number;
  /** Estimated cost in USD for this invocation. */
  costUsd: number;
  /** Number of cached input tokens (subset of tokensPrompt), if available. */
  cachedTokens?: number;
  /** Estimated premium requests consumed (Copilot only), if available. */
  premiumRequests?: number;
  /** Model routing tier assigned to this invocation. */
  routingTier?: ModelTier;
  /** Human-readable reason for the routing decision. */
  routingReason?: string;
  /** Incremental cost (USD) attributed to model escalation. */
  escalationCostUsd?: number;
}

// ─── Model Routing ───────────────────────────────────────────────────────────

/** Tier assigned to a task by the model routing policy. */
export type ModelTier = 'normal' | 'heavy' | 'critical';

/**
 * The outcome of the model routing policy for a single invocation.
 */
export interface RoutingDecision {
  /** Computed tier for the task. */
  tier: ModelTier;
  /** Model identifier selected for the invocation. */
  selectedModel: string;
  /** Human-readable reason for the routing decision. */
  reason: string;
  /** Numeric complexity score (0–100) that drove the tier selection. */
  score: number;
  /** Whether the model was escalated from a lower tier (e.g. due to retries). */
  escalated: boolean;
}

// ─── Task Details ────────────────────────────────────────────────────────────

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

// ─── Agent Launcher ──────────────────────────────────────────────────────────

/** Function signature for launching an agent invocation and returning its result. */
export interface AgentLauncherFn {
  (invocation: AgentInvocation): Promise<AgentResult>;
}
