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
    largeFileThreshold: z.number().int().default(500),
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
    /**
     * Maximum infrastructure-error retries before invoking failure-recovery.
     * Infrastructure errors (file locks, timeouts, disk-full, OOM) are
     * retried with simple backoff — they don't consume `maxRetriesPerTask`
     * budget and don't invoke the failure-recovery agent.
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
    }).optional(),
  }).default({}),
  copilot: z.object({
    cliCommand: z.string().default('copilot'),
    model: z.string().optional(),
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
  }).default({}),
  claudeCode: z.object({
    cliCommand: z.string().default('claude'),
    model: z.string().optional(),
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
  }).default({}),
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
  }).default({}),
});

export type MigrationConfig = z.infer<typeof MigrationConfigSchema>;
