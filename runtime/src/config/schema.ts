import { z } from 'zod';

export const MigrationConfigSchema = z.object({
  projectName: z.string().min(1).regex(/^[a-z0-9-]+$/),
  agentRuntime: z.enum(['copilot', 'claude-code']).default('copilot'),
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
    testFramework: z.string().optional(),
    buildCommand: z.string().optional(),
    testCommand: z.string().optional(),
  }),
  options: z.object({
    maxParallelAgents: z.number().int().min(1).max(10).default(3),
    maxRetriesPerTask: z.number().int().min(1).max(5).default(3),
    maxLinesPerTask: z.number().int().default(500),
    tokenBudget: z.number().int().optional(),
    contextWindowStrategy: z.enum(['per-invocation', 'session']).default('per-invocation'),
    contextWindowTokens: z.number().int().optional(),
    dryRun: z.boolean().default(false),
    resume: z.boolean().default(false),
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
     * Phase 4 execution strategy.
     * - `per-task`: existing behavior (migrate + validate task-by-task).
     * - `wave-barrier`: migrate in waves, then validate between waves.
     */
    executionMode: z.enum(['per-task', 'wave-barrier']).default('per-task'),
    /**
     * Controls for Phase 4 wave/barrier execution mode.
     * These values are ignored in `per-task` mode.
     */
    waveControl: z.object({
      waveSize: z.number().int().min(1).default(3),
      maxConvergenceIterations: z.number().int().min(1).default(3),
    }).default({
      waveSize: 3,
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
    maxBlockedTasks: z.number().int().min(0).default(0),
    qualityPolicy: z.enum(['strict', 'balanced', 'deferred-strict']).default('strict'),
    /**
     * Maximum infrastructure-error retries before invoking failure-adjudicator.
     * Infrastructure errors (file locks, timeouts, disk-full, OOM) are
     * retried with simple backoff — they don't consume `maxRetriesPerTask`
     * budget and don't invoke the failure-adjudicator agent.
     * Default: 3.
     */
    maxInfraRetries: z.number().int().min(0).max(10).default(3),
    /**
     * Estimated average number of tokens consumed per migration task.
     * Used for Phase 4 cost projection. Default: 5000.
     */
    avgTokensPerTask: z.number().int().min(1).default(5000),
    /**
     * Options for the optional idiomatic refactor phase (Phase 8).
     * When enabled, the idiomatic-reviewer and idiomatic-refactorer agents
     * run after Phase 6 to improve code idiomaticness.
     */
    idiomaticRefactor: z.object({
      enabled: z.boolean().default(false),
      maxIterations: z.number().int().min(1).default(2),
    }).optional(),
    /**
     * Options for the optional KB indexing phase (Phase 0).
     * When enabled (or when AAMF_USE_KB_INDEX=1), the indexer builds a SQLite
     * knowledge-base and an HTTP MCP server is started for agents to query it.
     */
    kbIndex: z.object({
      enabled: z.boolean().default(false),
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
     * Model routing configuration for intelligent model selection.
     * When enabled, the orchestrator selects models based on task complexity,
     * file count, dependencies, and retry history.
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
    maxLinesPerTask: 500,
    contextWindowStrategy: 'per-invocation',
    dryRun: false,
    resume: false,
    invocationDelayMs: 0,
    buildConcurrency: 1,
    executionMode: 'per-task',
    waveControl: {
      waveSize: 3,
      maxConvergenceIterations: 3,
    },
    continueOnBlocked: true,
    maxBlockedTasks: 0,
    qualityPolicy: 'strict',
    maxInfraRetries: 3,
    avgTokensPerTask: 5000,
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
  copilot: z.object({
    cliCommand: z.string().default('copilot'),
    model: z.string().optional(),
    failureRecoveryModel: z.string().optional(),
    agentDir: z.string().default('.github/agents'),
    timeout: z.number().int().default(300_000),
    costOverrides: z.record(
      z.string(),
      z.object({
        input: z.number().min(0).describe('Cost per 1M input tokens in USD'),
        output: z.number().min(0).describe('Cost per 1M output tokens in USD'),
      }),
    ).optional().describe('Per-model cost overrides (USD per 1M tokens)'),
    /** Per-phase timeout overrides in milliseconds, keyed by phase number. */
    phaseTimeouts: z.record(z.coerce.number(), z.number().int()).optional(),
  }).default({
    cliCommand: 'copilot',
    agentDir: '.github/agents',
    timeout: 300_000,
  }),
  claudeCode: z.object({
    cliCommand: z.string().default('claude'),
    model: z.string().optional(),
    failureRecoveryModel: z.string().optional(),
    agentDir: z.string().default('.claude/agents'),
    timeout: z.number().int().default(300_000),
    contextWindowTokens: z.number().int().optional(),
    costOverrides: z.record(
      z.string(),
      z.object({
        input: z.number().min(0).describe('Cost per 1M input tokens in USD'),
        output: z.number().min(0).describe('Cost per 1M output tokens in USD'),
      }),
    ).optional().describe('Per-model cost overrides (USD per 1M tokens)'),
    /** Per-phase timeout overrides in milliseconds, keyed by phase number. */
    phaseTimeouts: z.record(z.coerce.number(), z.number().int()).optional(),
  }).default({
    cliCommand: 'claude',
    agentDir: '.claude/agents',
    timeout: 300_000,
  }),
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
