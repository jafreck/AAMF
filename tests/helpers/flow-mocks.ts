/**
 * Shared mock factory for flow step unit tests.
 *
 * Builds a complete MigrationFlowContext with sensible test defaults
 * and a FlowExecutionContext wrapper that step functions expect.
 */
import { join } from 'node:path';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { vi } from 'vitest';
import pLimit from 'p-limit';
import type { MigrationFlowContext, ParityResultData } from '../../src/flow/context.js';
import type { FlowExecutionContext } from '@cadre-dev/framework/flow';
import { CheckpointManager } from '../../src/core/checkpoint.js';
import { ProgressWriter } from '../../src/core/progress.js';
import { TokenTracker } from '../../src/budget/token-tracker.js';
import { CostEstimator } from '../../src/budget/cost-estimator.js';
import { MetricsCollector } from '../../src/observability/metrics-collector.js';
import { ReportGenerator } from '../../src/observability/report-generator.js';
import { buildRuntimePaths } from '../../src/core/runtime-paths.js';
import { ensureDir } from '../../src/util/fs.js';
import {
  createMockConfig,
  createMockLauncher,
  createFailingLauncher,
  createSilentLogger,
  MockAgentLauncher,
  makeTask,
} from './mocks.js';
import type { AgentInvocation, AgentResult, AgentName, MigrationTask } from '../../src/agents/types.js';

// Re-export so test files only need one import
export {
  createMockConfig,
  createMockLauncher,
  createFailingLauncher,
  createSilentLogger,
  MockAgentLauncher,
  makeTask,
};

// ─── Default Tasks ──────────────────────────────────────────────────────────

export const DEFAULT_PLANNING_TASKS: MigrationTask[] = [
  {
    id: 'task-001', name: 'User Auth Module',
    sourceFiles: ['src/task-001.py'], targetFiles: ['src/task-001.ts'],
    knowledgeBaseRef: 'kb/task-001.md', dependencies: [],
    complexity: 'moderate', description: 'Migrate auth module',
    acceptanceCriteria: ['works'], parityChecks: ['matches'],
    lineRange: { start: 1, end: 200 },
  },
  {
    id: 'task-002', name: 'Database Layer',
    sourceFiles: ['src/task-002.py'], targetFiles: ['src/task-002.ts'],
    knowledgeBaseRef: 'kb/task-002.md', dependencies: ['task-001'],
    complexity: 'moderate', description: 'Migrate database layer',
    acceptanceCriteria: ['works'], parityChecks: ['matches'],
    lineRange: { start: 1, end: 200 },
  },
];

export const SINGLE_AUTH_TASK: MigrationTask = {
  id: 'task-001', name: 'Auth Module',
  sourceFiles: ['src/auth.py'], targetFiles: ['src/auth.ts'],
  knowledgeBaseRef: 'kb/auth.md', dependencies: [],
  complexity: 'simple', description: 'Migrate auth',
  acceptanceCriteria: ['works'], parityChecks: ['matches'],
  lineRange: { start: 1, end: 200 },
};

// ─── Parity output wrappers ────────────────────────────────────────────────

export function withParityPassOutput(
  fn: (inv: AgentInvocation) => Promise<AgentResult>,
): (inv: AgentInvocation) => Promise<AgentResult> {
  return async (inv: AgentInvocation): Promise<AgentResult> => {
    const result = await fn(inv);
    if (inv.agent === 'parity-verifier' && inv.workItemId) {
      if (!result.extensions.structuredOutput || !(result.extensions.structuredOutput as any).parity) {
        result.extensions.structuredOutput = {
          ...(result.extensions.structuredOutput ?? {}),
          agent: 'parity-verifier', status: 'completed', taskId: inv.workItemId,
          parity: 'pass', issues: [],
        };
        result.extensions.outputParsed = true;
      }
    }
    if (inv.agent === 'final-parity-checker') {
      if (!result.extensions.structuredOutput || !Array.isArray((result.extensions.structuredOutput as any).fixes)) {
        result.extensions.structuredOutput = { ...(result.extensions.structuredOutput ?? {}), fixes: [] };
        result.extensions.outputParsed = true;
      }
    }
    if (inv.agent === 'idiomatic-reviewer') {
      if (!result.extensions.structuredOutput || !Array.isArray((result.extensions.structuredOutput as any).issues)) {
        result.extensions.structuredOutput = { ...(result.extensions.structuredOutput ?? {}), issues: [] };
        result.extensions.outputParsed = true;
      }
    }
    return result;
  };
}

export function withParityOutput(
  fn: (inv: AgentInvocation) => Promise<AgentResult>,
  overrides: Record<string, { parity: string; issues: Array<{ severity: string; description: string; details: string; sourceLocation: string; targetLocation?: string }> }>,
): (inv: AgentInvocation) => Promise<AgentResult> {
  return async (inv: AgentInvocation): Promise<AgentResult> => {
    const result = await fn(inv);
    if (inv.agent === 'parity-verifier' && inv.workItemId) {
      const override = overrides[inv.workItemId];
      if (override) {
        result.extensions.structuredOutput = {
          ...(result.extensions.structuredOutput ?? {}),
          agent: 'parity-verifier', status: 'completed', taskId: inv.workItemId,
          parity: override.parity, issues: override.issues,
        };
        result.extensions.outputParsed = true;
      } else if (!result.extensions.structuredOutput || !(result.extensions.structuredOutput as any).parity) {
        result.extensions.structuredOutput = {
          ...(result.extensions.structuredOutput ?? {}),
          agent: 'parity-verifier', status: 'completed', taskId: inv.workItemId,
          parity: 'pass', issues: [],
        };
        result.extensions.outputParsed = true;
      }
    }
    return result;
  };
}

// ─── File helpers ────────────────────────────────────────────────────────────

export async function writePhase3PlanningArtifacts(
  progressDir: string,
  tasks: MigrationTask[] = DEFAULT_PLANNING_TASKS,
): Promise<void> {
  const planningDir = join(progressDir, 'artifacts', 'planning');
  await mkdir(planningDir, { recursive: true });
  await writeFile(join(planningDir, 'tasks-merged.json'), JSON.stringify(tasks, null, 2));
}

export async function writeE2eTestPlan(
  outputPath: string,
  suites: Array<{ id: string; name: string; purpose?: string; framework?: string; outputLocation?: string; scenarios?: string[] }>,
): Promise<void> {
  const e2eDir = join(outputPath, 'e2e');
  await mkdir(e2eDir, { recursive: true });
  let content = '# E2E Test Plan\n\n';
  for (const suite of suites) {
    content += `### Suite: ${suite.id} - ${suite.name}\n\n`;
    content += `**Purpose:** ${suite.purpose ?? 'Test suite'}\n\n`;
    content += `**Target Files:**\n- src/${suite.id}.ts\n\n`;
    content += `**KB References:**\n- kb/${suite.id}.md\n\n`;
    content += `**Framework:** ${suite.framework ?? 'vitest'}\n\n`;
    content += `**Output Location:** ${suite.outputLocation ?? `tests/${suite.id}`}\n\n`;
    const scenarios = suite.scenarios ?? ['basic test'];
    content += `**Scenarios:**\n${scenarios.map(s => `- ${s}`).join('\n')}\n\n`;
  }
  await writeFile(join(e2eDir, 'e2e-test-plan.md'), content);
}

// ─── Mock Flow Context Builder ──────────────────────────────────────────────

export interface FlowTestEnv {
  tempDir: string;
  progressDir: string;
  ctx: MigrationFlowContext;
  flowCtx: FlowExecutionContext<MigrationFlowContext>;
  mockLauncher: MockAgentLauncher;
  logger: ReturnType<typeof createSilentLogger>;
  checkpoint: CheckpointManager;
  progress: ProgressWriter;
  cleanup: () => Promise<void>;
}

/**
 * Build a complete MigrationFlowContext and a FlowExecutionContext wrapper
 * for testing individual step functions.
 *
 * Usage:
 *   const env = await setupFlowTest(launcherFn);
 *   const result = await someStepFunction(env.flowCtx);
 *   await env.cleanup();
 */
export async function setupFlowTest(
  launcherFn: (inv: AgentInvocation) => Promise<AgentResult>,
  configOverrides?: Parameters<typeof createMockConfig>[0],
): Promise<FlowTestEnv> {
  const tempDir = await mkdtemp(join(tmpdir(), 'aamf-flow-test-'));
  const config = createMockConfig(configOverrides);
  const logger = createSilentLogger(tempDir);
  const paths = buildRuntimePaths(tempDir, config.projectName);

  // Create directory structure
  await ensureDir(paths.root);
  await ensureDir(paths.stateDir);
  await ensureDir(paths.artifactsDir);
  await ensureDir(paths.artifactsPlanningDir);
  await ensureDir(paths.artifactsContextsDir);
  await ensureDir(paths.metricsDir);
  await ensureDir(paths.logsAgentsDir);
  await ensureDir(paths.logsCommandsDir);
  await ensureDir(paths.reportsDir);
  await ensureDir(paths.reportsObservabilityDir);

  const checkpoint = new CheckpointManager(paths.root, logger);
  await checkpoint.load(config.projectName);

  const progressFile = join(paths.root, 'progress.md');
  const progress = new ProgressWriter(progressFile);
  await progress.initialize(config);

  const mockLauncher = new MockAgentLauncher(withParityPassOutput(launcherFn));
  const tokenTracker = new TokenTracker();
  const costEstimator = new CostEstimator();
  const metricsCollector = new MetricsCollector('test-run-id');
  const reportGenerator = new ReportGenerator(metricsCollector);

  // Stub ContextBuilder so it writes a real file and returns the path
  const contextBuilder = {
    buildContext: async (_agent: AgentName, _phase: number, taskId?: string, payload?: Record<string, unknown>) => {
      const contextPath = join(paths.artifactsContextsDir, `${_agent}-${taskId ?? 'main'}-${Date.now()}.json`);
      await writeFile(contextPath, JSON.stringify({
        config, payload: payload ?? {}, inputFiles: [], outputDir: config.target.outputPath,
      }, null, 2));
      return contextPath;
    },
  };

  const ctx: MigrationFlowContext = {
    config,
    projectRoot: tempDir,
    runId: 'test-run-id',
    paths,
    checkpoint,
    launcher: mockLauncher as any,
    progress,
    logger,
    tokenTracker,
    costEstimator,
    metricsCollector,
    reportGenerator,
    contextBuilder: contextBuilder as any,
    buildLimiter: pLimit(1),
    gitLimiter: pLimit(1),
    kbServer: undefined,
    embedder: undefined,
    phase1TaskGraphResult: undefined,
    peakConcurrency: 0,
    parityResults: new Map(),
    routedTaskIds: new Set(),
    escalationCostUsd: 0,
    phase5Snapshot: undefined,
    deferGitCommits: false,
  };

  // Wrap in a FlowExecutionContext
  const flowCtx: FlowExecutionContext<MigrationFlowContext> = {
    context: ctx,
    flowId: 'aamf-migration',
    nodeId: 'test-node',
    executionId: 'test-exec-id',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  const cleanup = async () => {
    await rm(tempDir, { recursive: true, force: true });
  };

  return { tempDir, progressDir: paths.root, ctx, flowCtx, mockLauncher, logger, checkpoint, progress, cleanup };
}

/**
 * Convenience: set up a flow test env with tasks pre-loaded for Phase 5+.
 */
export async function setupFlowTestWithTasks(
  launcherFn: (inv: AgentInvocation) => Promise<AgentResult>,
  tasks: MigrationTask[] = DEFAULT_PLANNING_TASKS,
  configOverrides?: Parameters<typeof createMockConfig>[0],
): Promise<FlowTestEnv> {
  const env = await setupFlowTest(launcherFn, configOverrides);

  // Write planning artifacts
  await writePhase3PlanningArtifacts(env.progressDir, tasks);

  // Populate phase1TaskGraphResult with the tasks
  env.ctx.phase1TaskGraphResult = {
    agent: 'migration-planner',
    exitCode: 0,
    success: true,
    workItemId: '',
    timedOut: false,
    duration: 0,
    stdout: '',
    stderr: '',
    tokenUsage: null,
    outputPath: join(env.progressDir, 'artifacts', 'planning', 'tasks-merged.json'),
    outputExists: true,
    extensions: {
      outputFiles: [join(env.progressDir, 'artifacts', 'planning', 'tasks-merged.json')],
      outputParsed: true,
      structuredOutput: { tasks, sccs: [], compilationUnits: [] },
    },
  };

  // Write empty kb.db so phases that check it find it
  await writeFile(env.ctx.paths.kbDbFile, '');

  return env;
}
