/**
 * Shared mock utilities for AAMF runtime tests.
 */
import { join } from 'node:path';
import {
  AgentInvocation,
  AgentResult,
  AgentName,
  MigrationTask,
} from '../../src/agents/types.js';
import { MigrationConfig } from '../../src/config/schema.js';
import { Logger } from '../../src/logging/logger.js';

// ─── Mock Launcher Utilities ─────────────────────────────────────────────────

/** Create a mock launcher function that returns success by default. */
export function createMockLauncher(
  overrides?:
    | Partial<Record<AgentName, Partial<AgentResult>>>
    | ((inv: AgentInvocation) => Partial<AgentResult>),
): (inv: AgentInvocation) => Promise<AgentResult> {
  return async (inv: AgentInvocation): Promise<AgentResult> => {
    const base: AgentResult = {
      agent: inv.agent,
      taskId: inv.taskId,
      exitCode: 0,
      success: true,
      outputFiles: [],
      duration: 100,
      tokenUsage: { prompt: 500, completion: 200, total: 700 },
      outputParsed: false,
    };

    if (typeof overrides === 'function') {
      return { ...base, ...overrides(inv) };
    }
    if (overrides && overrides[inv.agent]) {
      return { ...base, ...overrides[inv.agent] };
    }
    return base;
  };
}

/** Create a mock launcher that fails for specific agents. */
export function createFailingLauncher(
  failAgents: AgentName[],
  errorMessage = 'Agent failed',
): (inv: AgentInvocation) => Promise<AgentResult> {
  return createMockLauncher((inv) =>
    failAgents.includes(inv.agent)
      ? { exitCode: 1, success: false, error: errorMessage }
      : {},
  );
}

// ─── Mock AgentLauncher Class ────────────────────────────────────────────────

/** Minimal mock of AgentLauncher that delegates to a function. */
export class MockAgentLauncher {
  public invocations: AgentInvocation[] = [];
  constructor(private fn: (inv: AgentInvocation) => Promise<AgentResult>) {}
  async launchAgent(inv: AgentInvocation): Promise<AgentResult> {
    this.invocations.push(inv);
    return this.fn(inv);
  }
  /** Mock: returns undefined since tests don't resolve shell PATH. */
  getResolvedPath(): string | undefined {
    return undefined;
  }
}

// ─── Mock Config ─────────────────────────────────────────────────────────────

/** Returns a valid MigrationConfig object for testing. */
export function createMockConfig(overrides?: any): MigrationConfig {
  const base: MigrationConfig = {
    projectName: 'test-project',
    source: {
      path: '/tmp/source',
      language: 'python',
      excludePatterns: ['node_modules', '.git', 'dist', 'build', '__pycache__'],
    },
    target: {
      language: 'typescript',
      framework: 'express',
      outputPath: '/tmp/target',
    },
    options: {
      maxParallelAgents: 3,
      maxRetriesPerTask: 3,
      maxLinesPerTask: 500,
      dryRun: false,
      resume: false,
      invocationDelayMs: 0,
      buildConcurrency: 1,
      continueOnBlocked: true,
      maxBlockedTasks: 0,
      qualityPolicy: 'strict',
      maxInfraRetries: 3,
      avgTokensPerTask: 100000,
      retryOverheadMultiplier: 1.25,
      contextWindowStrategy: 'per-invocation',
      keepArtifacts: false,
      git: {
        enabled: false,
        autoInit: true,
        commitByAgent: true,
        commitPerTask: true,
        authorName: 'AAMF Migration Bot',
        authorEmail: 'aamf@local.invalid',
      },
    },
    copilot: {
      cliCommand: 'copilot',
      agentDir: '.github/agents',
      timeout: 300_000,
    },
    environment: {
      inheritShellPath: false,
      extraPath: [],
    },
  };

  return {
    ...base,
    ...overrides,
    source: {
      ...base.source,
      ...(overrides?.source ?? {}),
    },
    target: {
      ...base.target,
      ...(overrides?.target ?? {}),
    },
    options: {
      ...base.options,
      ...(overrides?.options ?? {}),
    },
    copilot: {
      ...base.copilot,
      ...(overrides?.copilot ?? {}),
    },
    environment: {
      ...base.environment,
      ...(overrides?.environment ?? {}),
    },
  } as MigrationConfig;
}

// ─── Task Factory ────────────────────────────────────────────────────────────

/** Create a MigrationTask for testing (same pattern as task-queue.test.ts). */
export function makeTask(id: string, deps: string[] = []): MigrationTask {
  return {
    id,
    name: `Task ${id}`,
    sourceFiles: [`src/${id}.py`],
    targetFiles: [`src/${id}.ts`],
    knowledgeBaseRef: `kb/${id}.md`,
    dependencies: deps,
    complexity: 'moderate',
    description: `Migrate ${id}`,
    acceptanceCriteria: ['works'],
    parityChecks: ['matches'],
    lineRange: { start: 1, end: 200 },
  };
}

// ─── Silent Logger ───────────────────────────────────────────────────────────

/** Creates a silent logger for tests. */
export function createSilentLogger(tempDir: string): Logger {
  return new Logger({ logDir: join(tempDir, 'logs'), level: 'error', console: false });
}
