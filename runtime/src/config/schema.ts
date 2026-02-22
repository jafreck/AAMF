import { z } from 'zod';

export const MigrationConfigSchema = z.object({
  projectName: z.string().min(1).regex(/^[a-z0-9-]+$/),
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
    dryRun: z.boolean().default(false),
    resume: z.boolean().default(false),
    invocationDelayMs: z.number().int().min(0).default(0),
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
