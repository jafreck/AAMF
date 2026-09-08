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
import { MigrationConfig, MigrationConfigSchema } from '../../src/config/schema.js';
import { Logger } from '../../src/logging/logger.js';

export type DeepPartial<T> = T extends readonly (infer Item)[]
  ? DeepPartial<Item>[]
  : T extends object
    ? { [Key in keyof T]?: DeepPartial<T[Key]> }
    : T;

export type MockConfigOverrides = DeepPartial<MigrationConfig>;

// ─── Mock Launcher Utilities ─────────────────────────────────────────────────

export type AgentResultOverrides =
  Partial<Omit<AgentResult, 'extensions'>> & {
    extensions?: Partial<AgentResult['extensions']>;
  };

/** Create a complete AgentResult using the current runtime contract. */
export function makeAgentResult(overrides: AgentResultOverrides = {}): AgentResult {
  const { extensions, ...resultOverrides } = overrides;
  return {
    agent: 'code-migrator',
    workItemId: 'task-001',
    exitCode: 0,
    success: true,
    timedOut: false,
    duration: 100,
    stdout: '',
    stderr: '',
    tokenUsage: { input: 500, output: 200 },
    outputPath: '',
    outputExists: false,
    ...resultOverrides,
    extensions: {
      outputFiles: [],
      outputParsed: false,
      ...extensions,
    },
  };
}

/** Create a mock launcher function that returns success by default. */
export function createMockLauncher(
  overrides?:
    | Partial<Record<AgentName, Partial<AgentResult>>>
    | ((inv: AgentInvocation) => Partial<AgentResult>),
): (inv: AgentInvocation) => Promise<AgentResult> {
  return async (inv: AgentInvocation): Promise<AgentResult> => {
    let invocationOverrides: Partial<AgentResult> = {};
    if (typeof overrides === 'function') {
      invocationOverrides = overrides(inv);
    } else {
      const agentOverrides = overrides?.[inv.agent];
      if (agentOverrides) invocationOverrides = agentOverrides;
    }

    return makeAgentResult({
      agent: inv.agent,
      workItemId: inv.workItemId,
      outputPath: inv.outputPath,
      ...invocationOverrides,
      extensions: invocationOverrides.extensions,
    });
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
  constructor(public fn: (inv: AgentInvocation) => Promise<AgentResult>) {}
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

/**
 * Returns a valid MigrationConfig object for testing.
 * Parses through MigrationConfigSchema to ensure runtime parity and
 * exercise all Zod defaults/transforms.
 */
export function createMockConfig(overrides?: MockConfigOverrides): MigrationConfig {
  const raw = {
    projectName: overrides?.projectName ?? 'test-project',
    ...(overrides?.guidance !== undefined ? { guidance: overrides.guidance } : {}),
    source: {
      path: '/tmp/source',
      language: 'python',
      excludePatterns: ['node_modules', '.git', 'dist', 'build', '__pycache__'],
      ...(overrides?.source ?? {}),
    },
    target: {
      language: 'typescript',
      framework: 'express',
      outputPath: '/tmp/target',
      ...(overrides?.target ?? {}),
    },
    models: {
      ...(overrides?.models ?? {}),
    },
    options: {
      maxParallelAgents: 3,
      maxRetriesPerTask: 3,
      maxLinesPerTask: 1000,
      dryRun: false,
      resume: false,
      invocationDelayMs: 0,
      buildConcurrency: 1,
      continueOnBlocked: true,
      maxBlockedTasks: 0,
      qualityPolicy: 'strict',
      maxInfraRetries: 3,
      git: {
        enabled: false,
        autoInit: true,
        commitPerTask: true,
        authorName: 'AAMF Migration Bot',
        authorEmail: 'aamf@local.invalid',
        ...(overrides?.options?.git ?? {}),
      },
      ...(overrides?.options ?? {}),
    },
    agentBackend: {
      runtime: 'copilot',
      cliCommand: 'copilot',
      agentDir: '.github/agents',
      timeout: 300_000,
      ...(overrides?.agentBackend ?? {}),
    },
    environment: {
      inheritShellPath: false,
      extraPath: [],
      ...(overrides?.environment ?? {}),
    },
  };

  return MigrationConfigSchema.parse(raw);
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
