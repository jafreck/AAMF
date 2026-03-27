import { z } from 'zod';

export const MigrationConfigSchema = z.object({
  projectName: z.string().min(1).regex(/^[a-z0-9-]+$/),
  /**
   * Optional user-provided migration guidance directives.
   *
   * Each entry is a freeform instruction that is injected into every
   * agent's context JSON so that planners, code-migrators, and reviewers
   * can honour project-specific constraints.
   *
   * Examples:
   *   - "Do NOT use any existing crates/packages that wrap the C implementation."
   *   - "Write a pure native Rust port — no FFI or bindgen."
   *   - "Preserve the original directory layout in the target output."
   */
  guidance: z.array(z.string().min(1)).optional(),
  source: z.object({
    path: z.string(),
    language: z.string(),
    entryPoints: z.array(z.string()).optional(),
    excludePatterns: z.array(z.string()).default([
      'node_modules', '.git', 'dist', 'build', '__pycache__'
    ]),
  }),
  target: z.object({
    language: z.string(),
    framework: z.string().optional(),
    outputPath: z.string(),
    buildCommand: z.string().optional(),
    testCommand: z.string().optional(),
    formatCommand: z.string().optional(),
    lintCommand: z.string().optional(),
  }),
  /**
   * Model-selection policy shared across all runtimes.
   *
   * This is the single authoritative location for baseline model choice,
   * difficulty-based escalation, and failure-recovery model overrides.
   */
  models: z.object({
    /** Baseline model used for all invocations unless a policy override applies. */
    default: z.string().optional(),
    /** Model used for failure-recovery retries and parity-failure-resolver. */
    failureRecovery: z.string().optional(),
    /**
     * Difficulty-based per-invocation routing policy.
     * When enabled, the orchestrator may override `models.default` for
     * heavy or critical tasks and agents.
     */
    routing: z.object({
      /** Enable automatic model tier escalation. */
      enabled: z.boolean().default(false),
      /** Model used for heavy-tier tasks (score >= heavyThreshold). */
      heavy: z.string().optional(),
      /** Model used for critical-tier tasks (score >= criticalThreshold). */
      critical: z.string().optional(),
      /** Score threshold (0–100) at which a task is promoted to heavy tier. */
      heavyThreshold: z.number().int().min(0).max(100).default(40),
      /** Score threshold (0–100) at which a task is promoted to critical tier. */
      criticalThreshold: z.number().int().min(0).max(100).default(70),
      /** Agent names that always route to the critical model. */
      criticalAgents: z.array(z.string()).optional(),
      /** Task ID glob patterns (`*` and `?`) that always route to the critical model. */
      criticalTaskPatterns: z.array(z.string()).optional(),
      /** Max tasks escalated beyond the default model per run. 0 = unlimited. */
      maxEscalatedTasks: z.number().int().min(0).default(0),
      /** Max incremental cost (USD) for escalated invocations. 0 = unlimited. */
      maxEscalationCostUsd: z.number().min(0).default(0),
      /** Retry attempt number at which to escalate model tier. */
      escalateOnRetryAttempt: z.number().int().min(1).default(2),
    }).optional(),
  }).default({}),
  options: z.object({
    maxParallelAgents: z.number().int().min(1).default(3),
    maxRetriesPerTask: z.number().int().min(1).max(10).default(3),
    maxLinesPerTask: z.number().int().default(1000),
    tokenBudget: z.number().int().optional(),
    dryRun: z.boolean().default(false),
    resume: z.boolean().default(false),
    /**
     * Reuse the knowledge base from a prior run when starting a fresh migration.
     * When true, a fresh start (resume=false) will preserve the KB index (Phase 0),
     * task graph (Phase 1), and knowledge base (Phase 2) artifacts if they exist
     * and the source fingerprint has not changed.  This avoids re-running expensive
     * agent-based analysis when only the migration strategy, guidance, or later
     * phases need to change.
     * Default: false.
     */
    reuseKb: z.boolean().default(false),
    invocationDelayMs: z.number().int().min(0).default(0),
    /**
     * Maximum number of concurrent build/test commands per output path.
     * Agent code-generation runs at `maxParallelAgents` concurrency, but
     * verification commands (build, test) are limited to this value to
     * avoid file-lock contention in build systems (Cargo, MSBuild, Go, etc.).
     * Set to 0 for unlimited (same as maxParallelAgents). Default: 1.
     */
    buildConcurrency: z.number().int().min(0).max(10).default(1),
    /**
     * Maximum number of concurrent test-writer suites in Phase 6 fan-out.
     * Controls how many E2E test suites can be generated in parallel,
     * separate from the general Phase 4 parallelism (`maxParallelAgents`).
     * When omitted, defaults to the value of `maxParallelAgents`.
     */
    maxE2eSuiteConcurrency: z.number().int().min(1).max(10).optional(),
    /**
     * Phase 4 execution strategy.
     * - `per-task`: existing behavior (migrate + validate task-by-task).
     * - `wave-barrier`: migrate in waves, then validate between waves.
     * - `sync-epoch`: migrate in dependency-closed epochs formed from
     *   consecutive topological levels, preferring compilation-unit
     *   boundaries.  Build runs every epoch; tests run every N epochs.
     */
    executionMode: z.enum(['per-task', 'wave-barrier', 'sync-epoch']).default('per-task'),
    /**
     * Controls for Phase 4 wave/barrier execution mode.
     * These values are ignored in `per-task` mode.
     */
    waveControl: z.object({
      /** Maximum validation/fix iterations per wave. 0 = unlimited. */
      maxConvergenceIterations: z.number().int().min(0).default(3),
    }).default({
      maxConvergenceIterations: 3,
    }),
    /**
     * Controls for Phase 4 sync-epoch execution mode.
     * These values are ignored in `per-task` and `wave-barrier` modes.
     */
    epochControl: z.object({
      /**
       * Number of consecutive topological levels to merge into one epoch.
       * Higher values increase throughput but delay sync points.
       * Default: 2.
       */
      levelsPerSync: z.number().int().min(1).max(10).default(2),
      /**
       * Run the full test suite every N epochs. Build runs every epoch.
       * Set to 1 to test every epoch. Default: 2.
       */
      testEveryNEpochs: z.number().int().min(1).default(2),
      /**
       * When true, expand epoch boundaries to avoid splitting compilation
       * units (crates, packages, projects) when possible without violating
       * dependency order.  Default: true.
       */
      preferCompilationUnitClosure: z.boolean().default(true),
      /** Maximum validation/fix iterations per epoch sync point. 0 = unlimited. */
      maxConvergenceIterations: z.number().int().min(0).default(3),
    }).default({
      levelsPerSync: 2,
      testEveryNEpochs: 2,
      preferCompilationUnitClosure: true,
      maxConvergenceIterations: 3,
    }),
    /**
     * Whether to continue executing independent tasks when one is blocked.
     * When `true` (default), the orchestrator skips blocked tasks and their
     * dependents, continuing with any remaining ready tasks.
     * When `false`, Phase 4 halts on the first blocked task.
     */
    continueOnBlocked: z.boolean().default(true),
    /**
     * Maximum number of blocked tasks before Phase 4 is halted.
     * Only applies when `continueOnBlocked` is `true`. Default: unlimited (0).
     */
    maxBlockedTasks: z.number().int().min(0).default(1),
    qualityPolicy: z.enum(['strict', 'balanced', 'deferred-strict']).default('strict'),
    /**
     * Maximum infrastructure-error retries before invoking parity-failure-resolver.
     * Infrastructure errors (file locks, timeouts, disk-full, OOM) are
     * retried with simple backoff — they don't consume `maxRetriesPerTask`
     * budget and don't invoke the parity-failure-resolver agent.
     * Default: 3.
     */
    maxInfraRetries: z.number().int().min(0).max(10).default(3),
    /**
     * Timeout in milliseconds for build, test, format, and lint commands.
     * Commands that exceed this timeout are killed and classified as hung.
     * This is separate from the agent invocation timeout.
     * Default: 300000 (5 minutes). Set to 0 to use the agent timeout.
     */
    commandTimeout: z.number().int().min(0).default(300_000),

    /**
     * Options for the optional idiomatic refactor phase (Phase 7).
     * When enabled, the idiomatic-reviewer and idiomatic-refactorer agents
     * run after Phase 6 to improve code idiomaticness.
     */
    idiomaticRefactor: z.object({
      enabled: z.boolean().default(false),
      /** Maximum review-and-refactor cycles. 0 = unlimited. */
      maxIterations: z.number().int().min(0).default(2),
    }).optional(),
    /**
     * Options for KB indexing (Phase 0).
     * The Lore indexer always runs in Phase 0 to build a SQLite knowledge-base.
     * An HTTP MCP server is started for agents to query it.
     */
    kbIndex: z.object({
      /**
       * Log level for the Lore KB server's internal structured logger.
       * Lore writes NDJSON entries to `logs/runtime/lore.log`.
       * Set to `'debug'` to monitor every tool call, search, and timing.
       * Default: `'debug'`.
       */
      logLevel: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('debug'),
      /** Embedding configuration for semantic search in the KB. */
      embeddings: z.object({
        /** Enable vector embeddings during indexing (requires Python + sentence-transformers). */
        enabled: z.boolean().default(false),
        /**
         * Full HuggingFace model name compatible with sentence-transformers.
         * The embedding dimensionality is auto-detected from the model at startup.
         * Examples:
         *   'Qwen/Qwen3-Embedding-0.6B'  (~1.5 GB)
         *   'Qwen/Qwen3-Embedding-4B'
         *   'BAAI/bge-small-en-v1.5'
         *   'sentence-transformers/all-MiniLM-L6-v2'
         */
        model: z.string().default('Qwen/Qwen3-Embedding-0.6B'),
        /** Path to the Python binary with sentence-transformers installed. */
        pythonBin: z.string().default('python3'),
      }).optional(),
      /**
       * LSP integration for the Lore indexer.
       * When enabled, Lore starts language servers (e.g. clangd for C/C++,
       * typescript-language-server for TS) to resolve cross-file symbol
       * references, type definitions, and call targets with full semantic
       * accuracy — beyond what tree-sitter can provide alone.
       */
      lsp: z.object({
        /** Enable LSP-powered symbol resolution during indexing. Default: false. */
        enabled: z.boolean().default(false),
        /** Timeout in ms for each LSP request (hover, definition, references). */
        requestTimeoutMs: z.number().int().min(500).default(5000),
        /**
         * Override default language server commands.
         * Keys are language identifiers (e.g. 'c', 'typescript').
         * Values specify the command and args to launch the server.
         * For C/C++ with clangd, pass --compile-commands-dir in args
         * to point to the directory containing compile_commands.json.
         * Example: `{ "c": { "command": "clangd", "args": ["--compile-commands-dir=/path/to/build"] } }`
         */
        servers: z.record(z.string(), z.object({
          command: z.string(),
          args: z.array(z.string()).default([]),
        })).optional(),
      }).optional(),
    }).optional(),
    /**
     * When `true`, AAMF preserves the `.aamf` checkpoint directory and the
     * target output directory after the migration completes instead of
     * deleting them. Useful for post-run inspection and debugging.
     * Can also be enabled at runtime by setting the environment variable
     * `AAMF_KEEP_ARTIFACTS=1` without modifying the config file.
     * Default: false.
     */
    keepArtifacts: z.boolean().default(false),
    /**
     * Deprecated compatibility alias for `models.routing`.
     * Prefer the root-level `models` block for all model-selection policy.
     */
    modelRouting: z.object({
      /** Enable model routing. When false, all tasks use the default model. */
      enabled: z.boolean().default(false),
      /** Model used for normal-tier tasks. */
      defaultModel: z.string().optional(),
      /** Model used for heavy-tier tasks (score >= heavyThreshold). */
      heavyModel: z.string().optional(),
      /** Model used for critical-tier tasks (score >= criticalThreshold). */
      criticalModel: z.string().optional(),
      /** Score threshold (0–100) at which a task is promoted to heavy tier. */
      heavyThreshold: z.number().int().min(0).max(100).default(40),
      /** Score threshold (0–100) at which a task is promoted to critical tier. */
      criticalThreshold: z.number().int().min(0).max(100).default(70),
      /** Agent names that always route to the critical model. */
      criticalAgents: z.array(z.string()).optional(),
      /** Task ID glob patterns (`*` and `?`) that always route to the critical model. */
      criticalTaskPatterns: z.array(z.string()).optional(),
      /** Max tasks routed to heavy/critical models per run. 0 = unlimited. */
      maxCriticalTasks: z.number().int().min(0).default(0),
      /** Max incremental cost (USD) for escalated invocations. 0 = unlimited. */
      maxEscalationCostUsd: z.number().min(0).default(0),
      /** Retry attempt number at which to escalate model tier. */
      escalateOnRetryAttempt: z.number().int().min(1).default(2),
    }).optional(),
    /**
     * Git commit automation for migrated output.
     *
     * When enabled, AAMF ensures `target.outputPath` is a Git repository and
     * creates granular commits during migration (per code-modifying agent and
     * per completed Phase 4 task).
     */
    git: z.object({
      /** Enable automatic git init/add/commit operations. */
      enabled: z.boolean().default(true),
      /** Ensure `target.outputPath` is a git repository (initialise if needed). */
      autoInit: z.boolean().default(true),
      /** Commit after successful code-modifying agent invocations. */
      commitByAgent: z.boolean().default(true),
      /** Commit after each successfully completed Phase 4 task. */
      commitPerTask: z.boolean().default(true),
      /** Allow empty git commits for task-level markers when no files changed. */
      allowEmptyTaskCommits: z.boolean().default(true),
      /** Local git author name used when repository identity is not configured. */
      authorName: z.string().default('AAMF Migration Bot'),
      /** Local git author email used when repository identity is not configured. */
      authorEmail: z.string().default('aamf@local.invalid'),
    }).optional(),
  }).default({
    maxParallelAgents: 3,
    maxRetriesPerTask: 3,
    maxLinesPerTask: 1000,
    dryRun: false,
    resume: false,
    reuseKb: false,
    invocationDelayMs: 0,
    buildConcurrency: 1,
    executionMode: 'per-task',
    waveControl: {
      maxConvergenceIterations: 3,
    },
    epochControl: {
      levelsPerSync: 2,
      testEveryNEpochs: 2,
      preferCompilationUnitClosure: true,
      maxConvergenceIterations: 3,
    },
    continueOnBlocked: true,
    maxBlockedTasks: 1,
    qualityPolicy: 'strict',
    maxInfraRetries: 3,
    commandTimeout: 300_000,
    keepArtifacts: false,
    git: {
      enabled: true,
      autoInit: true,
      commitByAgent: true,
      commitPerTask: true,
      allowEmptyTaskCommits: true,
      authorName: 'AAMF Migration Bot',
      authorEmail: 'aamf@local.invalid',
    },
  }),
  /**
   * Agent backend configuration.
   *
   * `runtime` selects which CLI to use: `'copilot'` (default) or `'claude-code'`.
   * The remaining fields (`cliCommand`, `agentDir`) default based on the
   * selected runtime if not explicitly provided.
   */
  agentBackend: z.object({
    /** Which CLI runtime to use. */
    runtime: z.enum(['copilot', 'claude-code']).default('copilot'),
    /** CLI command to invoke. Defaults to `'copilot'` or `'claude'` based on `runtime`. */
    cliCommand: z.string().optional(),
    /** Deprecated compatibility alias for `models.default`. */
    model: z.string().optional(),
    /** Deprecated compatibility alias for `models.failureRecovery`. */
    failureRecoveryModel: z.string().optional(),
    /**
     * Reasoning effort level for the Copilot CLI (`--effort` flag).
     * Controls how much reasoning the model applies to each request.
     * Only applies when `runtime` is `'copilot'`.
     */
    effort: z.enum(['low', 'medium', 'high', 'xhigh']).optional(),
    /** Directory containing agent definition files. Defaults to `'.github/agents'` (copilot) or `'.claude/agents'` (claude-code). */
    agentDir: z.string().optional(),
    /** Default timeout per agent invocation in milliseconds. */
    timeout: z.number().int().default(300_000),
    /** Per-phase timeout overrides in milliseconds, keyed by phase number. */
    phaseTimeouts: z.record(z.coerce.number(), z.number().int()).optional(),
  }).default({
    runtime: 'copilot',
    timeout: 300_000,
  }).transform((val) => ({
    ...val,
    cliCommand: val.cliCommand ?? (val.runtime === 'claude-code' ? 'claude' : 'copilot'),
    agentDir: val.agentDir ?? (val.runtime === 'claude-code' ? '.claude/agents' : '.github/agents'),
  })),
  environment: z.object({
    /** Whether to resolve PATH from a login shell at startup (default: true). */
    inheritShellPath: z.boolean().default(true),
    /**
     * Shell binary to use for login-PATH resolution.
     * Defaults to the $SHELL environment variable, falling back to /bin/sh.
     * Examples: '/bin/zsh', '/bin/bash', '/usr/bin/fish'
     */
    shell: z.string().optional(),
    /**
     * Additional directories to prepend to PATH for agent subprocesses.
     * Useful when tools like rustc, cargo, etc. live in non-standard locations.
     * Evaluated after login-shell resolution (if enabled), so these take priority.
     * Supports ~ for home directory expansion.
     */
    extraPath: z.array(z.string()).default([]),
  }).default({
    inheritShellPath: true,
    extraPath: [],
  }),
});

export type MigrationConfig = z.infer<typeof MigrationConfigSchema>;
