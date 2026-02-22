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
  }).default({}),
  copilot: z.object({
    cliCommand: z.string().default('copilot'),
    model: z.string().optional(),
    agentDir: z.string().default('.github/agents'),
    timeout: z.number().int().default(300_000),
  }).default({}),
});

export type MigrationConfig = z.infer<typeof MigrationConfigSchema>;
