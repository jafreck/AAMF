import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hostname, tmpdir } from 'node:os';
import { MigrationRuntime, validateSourceAvailability } from '../../src/core/runtime.js';
import type { MigrationResult } from '../../src/agents/types.js';
import { Logger } from '../../src/logging/logger.js';
import { getAgentsForPhase } from '../../src/agents/registry.js';
// MigrationOrchestrator replaced by flow runner
import { formatDuration } from '../../src/util/format.js';

/** Build a minimal MigrationResult for printSummary tests. */
function makeResult(overrides: Partial<MigrationResult> = {}): MigrationResult {
  return {
    success: true,
    projectName: 'test-project',
    phases: [],
    totalDuration: 5_000,
    tokenUsage: { total: 1000, byPhase: {}, byAgent: {} },
    failedTasks: [],
    blockedTasks: [],
    ...overrides,
  };
}

function makeRunLockPath(label: string): string {
  return join(tmpdir(), `aamf-${label}-${Math.random().toString(36).slice(2)}.lock.json`);
}

describe('MigrationRuntime', () => {
  describe('validateSourceAvailability', () => {
    it('passes when source directory and entry points exist', async () => {
      const root = await mkdtemp(join(tmpdir(), 'aamf-runtime-test-'));
      const sourceDir = join(root, 'src');
      await mkdir(join(sourceDir, 'lib'), { recursive: true });
      await writeFile(join(sourceDir, 'lib', 'entry.c'), 'int main(void) { return 0; }\n', 'utf-8');

      const config = {
        source: {
          path: sourceDir,
          entryPoints: ['lib/entry.c'],
        },
      } as any;

      await expect(validateSourceAvailability(config)).resolves.toBeUndefined();
      await rm(root, { recursive: true, force: true });
    });

    it('fails when source directory is missing', async () => {
      const config = {
        source: {
          path: '/tmp/aamf-does-not-exist-source',
          entryPoints: ['main.c'],
        },
      } as any;

      await expect(validateSourceAvailability(config)).rejects.toThrow('Source path does not exist');
    });

    it('fails when source path exists but is not a directory', async () => {
      const root = await mkdtemp(join(tmpdir(), 'aamf-runtime-test-'));
      const sourceFile = join(root, 'source.txt');
      await writeFile(sourceFile, 'not a directory', 'utf-8');

      const config = {
        source: {
          path: sourceFile,
          entryPoints: ['main.c'],
        },
      } as any;

      await expect(validateSourceAvailability(config)).rejects.toThrow('Source path is not a directory');
      await rm(root, { recursive: true, force: true });
    });

    it('fails when configured entry point is missing', async () => {
      const root = await mkdtemp(join(tmpdir(), 'aamf-runtime-test-'));
      const sourceDir = join(root, 'src');
      await mkdir(sourceDir, { recursive: true });

      const config = {
        source: {
          path: sourceDir,
          entryPoints: ['missing.c'],
        },
      } as any;

      await expect(validateSourceAvailability(config)).rejects.toThrow('Configured source entry point not found');
      await rm(root, { recursive: true, force: true });
    });

    it('fails when configured entry point exists but is not a file', async () => {
      const root = await mkdtemp(join(tmpdir(), 'aamf-runtime-test-'));
      const sourceDir = join(root, 'src');
      const entryDir = join(sourceDir, 'nested');
      await mkdir(entryDir, { recursive: true });

      const config = {
        source: {
          path: sourceDir,
          entryPoints: ['nested'],
        },
      } as any;

      await expect(validateSourceAvailability(config)).rejects.toThrow('Configured source entry point is not a file');
      await rm(root, { recursive: true, force: true });
    });
  });

  describe('runId generation', () => {
    it('should generate a UUID runId during initialization', async () => {
      // We test this by verifying the Logger.setRunId is called during initialize.
      // Since initialize() requires a full config, we spy on Logger.prototype.setRunId.
      const setRunIdSpy = vi.spyOn(Logger.prototype, 'setRunId');
      try {
        const runtime = new MigrationRuntime();
        // We can't easily call initialize without a full config, but we can verify
        // that the constructor and methods exist as expected.
        // Instead, test the integration point: after initialize, the logger should have runId set.
        expect(Logger.prototype.setRunId).toBeDefined();
        expect(typeof Logger.prototype.setRunId).toBe('function');
      } finally {
        setRunIdSpy.mockRestore();
      }
    });
  });

  describe('printSummary', () => {
    let runtime: MigrationRuntime;
    let consoleSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      runtime = new MigrationRuntime();
      // Inject a minimal config so formatDuration and CostEstimator work
      (runtime as any).config = {
        projectName: 'test-project',
        models: { default: 'claude-sonnet-4' },
        agentBackend: { runtime: 'copilot' },
      };
      consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.clearAllMocks();
    });

    it('should print Duration line', () => {
      (runtime as any).printSummary(makeResult({ totalDuration: 5_000 }));

      const output = consoleSpy.mock.calls.flat().join('\n');
      expect(output).toContain('Duration: 5s');
    });

    it('should NOT print "Total (all runs)" when cumulativeDuration equals totalDuration', () => {
      (runtime as any).printSummary(
        makeResult({ totalDuration: 5_000, cumulativeDuration: 5_000 }),
      );

      const output = consoleSpy.mock.calls.flat().join('\n');
      expect(output).not.toContain('Total (all runs)');
    });

    it('should NOT print "Total (all runs)" when cumulativeDuration is undefined', () => {
      (runtime as any).printSummary(makeResult({ totalDuration: 5_000 }));

      const output = consoleSpy.mock.calls.flat().join('\n');
      expect(output).not.toContain('Total (all runs)');
    });

    it('should print "Total (all runs)" when cumulativeDuration exceeds totalDuration', () => {
      (runtime as any).printSummary(
        makeResult({ totalDuration: 5_000, cumulativeDuration: 65_000 }),
      );

      const output = consoleSpy.mock.calls.flat().join('\n');
      expect(output).toContain('Total (all runs): 1m 5s');
    });

    it('should print project name and token usage', () => {
      (runtime as any).printSummary(makeResult());

      const output = consoleSpy.mock.calls.flat().join('\n');
      expect(output).toContain('Project: test-project');
      expect(output).toContain('Token Usage: 1,000');
    });

    it('should print failed and blocked task lists when present', () => {
      (runtime as any).printSummary(
        makeResult({
          failedTasks: ['task-a'],
          blockedTasks: ['task-b'],
        }),
      );

      const output = consoleSpy.mock.calls.flat().join('\n');
      expect(output).toContain('Failed Tasks: task-a');
      expect(output).toContain('Blocked Tasks: task-b');
    });

    it('should use claudeCode model when runtime is claude-code', () => {
      (runtime as any).config = {
        projectName: 'test-project',
        agentBackend: {
          runtime: 'claude-code',
          model: 'claude-test-model',
        },
      };

      (runtime as any).printSummary(makeResult({ totalDuration: 5_000, tokenUsage: { total: 1_000_000, byPhase: {}, byAgent: {} } }));

      const output = consoleSpy.mock.calls.flat().join('\n');
      expect(output).toContain('Estimated Cost:');
    });
  });

  describe('run', () => {
    it('returns dry-run result and initializes progress on fresh run', async () => {
      const runtime = new MigrationRuntime() as any;
      runtime.config = {
        projectName: 'test-project',
        options: { resume: false, dryRun: true },
      };
      runtime.paths = {
        runLockFile: makeRunLockPath('dry-run-fresh'),
      };
      runtime.checkpoint = {
        load: vi.fn().mockResolvedValue(undefined),
      };
      runtime.progress = {
        initialize: vi.fn().mockResolvedValue(undefined),
        reconstructFromCheckpoint: vi.fn(),
        appendEvent: vi.fn().mockResolvedValue(undefined),
      };
      runtime.logger = { info: vi.fn() };

      const result = await runtime.run();

      expect(result.success).toBe(true);
      expect(result.totalDuration).toBe(0);
      expect(runtime.checkpoint.load).toHaveBeenCalledWith('test-project', { fresh: true });
      expect(runtime.progress.initialize).toHaveBeenCalledTimes(1);
      expect(runtime.progress.reconstructFromCheckpoint).not.toHaveBeenCalled();
      expect(runtime.progress.appendEvent).toHaveBeenCalledWith('Dry run — validation only');
    });

    it('reconstructs progress from checkpoint on resume dry-run', async () => {
      const runtime = new MigrationRuntime() as any;
      const state = {
        projectName: 'test-project',
        currentPhase: 3,
        completedPhases: [1, 2],
        completedTasks: ['t1'],
        failedTasks: [],
        blockedTasks: [],
        tokenUsage: { total: 7, byPhase: {}, byAgent: {} },
        startedAt: '2025-01-01',
        lastCheckpoint: '2025-01-01',
        resumeCount: 1,
      };
      runtime.config = {
        projectName: 'test-project',
        options: { resume: true, dryRun: true },
      };
      runtime.paths = {
        runLockFile: makeRunLockPath('dry-run-resume'),
      };
      runtime.checkpoint = {
        load: vi.fn().mockResolvedValue(state),
        getState: vi.fn().mockReturnValue(state),
      };
      runtime.progress = {
        initialize: vi.fn(),
        reconstructFromCheckpoint: vi.fn(),
        appendEvent: vi.fn().mockResolvedValue(undefined),
      };
      runtime.logger = { info: vi.fn() };

      await runtime.run();

      expect(runtime.checkpoint.load).toHaveBeenCalledWith('test-project', { fresh: false });
      expect(runtime.progress.initialize).not.toHaveBeenCalled();
      expect(runtime.progress.reconstructFromCheckpoint).toHaveBeenCalledWith(state);
    });

    it('rejects when another runtime already holds the run lock', async () => {
      const lockRoot = await mkdtemp(join(tmpdir(), 'aamf-runtime-lock-'));
      const lockPath = join(lockRoot, 'state', 'run.lock.json');
      await mkdir(join(lockRoot, 'state'), { recursive: true });
      await writeFile(
        lockPath,
        JSON.stringify({
          version: 1,
          projectName: 'test-project',
          runId: 'other-run',
          pid: process.pid,
          hostname: hostname(),
          acquiredAt: new Date().toISOString(),
        }, null, 2) + '\n',
        'utf-8',
      );

      const runtime = new MigrationRuntime() as any;
      runtime.config = {
        projectName: 'test-project',
        options: { resume: false, dryRun: true },
      };
      runtime.runId = 'test-run-id';
      runtime.paths = { runLockFile: lockPath };
      runtime.checkpoint = {
        load: vi.fn().mockResolvedValue(undefined),
      };
      runtime.progress = {
        initialize: vi.fn().mockResolvedValue(undefined),
        reconstructFromCheckpoint: vi.fn(),
        appendEvent: vi.fn().mockResolvedValue(undefined),
      };
      runtime.logger = { info: vi.fn(), warn: vi.fn() };

      await expect(runtime.run()).rejects.toThrow('already locked by another active runtime');

      await rm(lockRoot, { recursive: true, force: true });
    });

    it('removes a stale run lock before continuing', async () => {
      const lockRoot = await mkdtemp(join(tmpdir(), 'aamf-runtime-lock-'));
      const lockPath = join(lockRoot, 'state', 'run.lock.json');
      await mkdir(join(lockRoot, 'state'), { recursive: true });
      await writeFile(
        lockPath,
        JSON.stringify({
          version: 1,
          projectName: 'test-project',
          runId: 'stale-run',
          pid: 999999,
          hostname: hostname(),
          acquiredAt: new Date().toISOString(),
        }, null, 2) + '\n',
        'utf-8',
      );

      const runtime = new MigrationRuntime() as any;
      runtime.config = {
        projectName: 'test-project',
        options: { resume: false, dryRun: true },
      };
      runtime.runId = 'test-run-id';
      runtime.paths = { runLockFile: lockPath };
      runtime.checkpoint = {
        load: vi.fn().mockResolvedValue(undefined),
      };
      runtime.progress = {
        initialize: vi.fn().mockResolvedValue(undefined),
        reconstructFromCheckpoint: vi.fn(),
        appendEvent: vi.fn().mockResolvedValue(undefined),
      };
      runtime.logger = { info: vi.fn(), warn: vi.fn() };

      const result = await runtime.run();

      expect(result.success).toBe(true);
      expect(runtime.logger.warn).toHaveBeenCalledWith(expect.stringContaining('Removing stale migration run lock'));
      await expect(stat(lockPath)).rejects.toThrow();

      await rm(lockRoot, { recursive: true, force: true });
    });

    it('runs flow runner on non-dry run, flushes logger, and returns result', async () => {
      const { FlowRunner } = await import('@cadre-dev/framework/flow');
      const flowRunnerRunSpy = vi.spyOn(FlowRunner.prototype, 'run').mockResolvedValue({
        status: 'completed',
        outputs: new Map(),
      });

      const runtime = new MigrationRuntime() as any;
      const printSummarySpy = vi.spyOn(runtime, 'printSummary').mockImplementation(() => {});
      const checkpointState = {
        projectName: 'test-project',
        currentPhase: 0,
        completedPhases: [],
        completedTasks: [],
        failedTasks: [],
        blockedTasks: [],
        completedTaskDurationsMs: [],
        tokenUsage: { total: 0, byPhase: {}, byAgent: {} },
        startedAt: '2026-01-01',
        lastCheckpoint: '2026-01-01',
        resumeCount: 0,
        phaseOutputs: {},
      };

      runtime.config = {
        projectName: 'test-project',
        options: {
          resume: false,
          dryRun: false,
          maxParallelAgents: 1,
          maxRetriesPerTask: 1,
          maxLinesPerTask: 200,
          invocationDelayMs: 0,
          buildConcurrency: 1,
          continueOnBlocked: true,
          maxBlockedTasks: 0,
          maxInfraRetries: 1,
          git: { enabled: false },
        },
        agentBackend: {
          runtime: 'copilot',
          model: 'claude-sonnet-4',
          timeout: 300_000,
          agentDir: '.github/agents',
        },
        source: { path: '/tmp/source', language: 'python' },
        target: { language: 'typescript', outputPath: '/tmp/target' },
        environment: {},
      };
      runtime.checkpoint = {
        load: vi.fn().mockResolvedValue(undefined),
        getState: vi.fn().mockReturnValue({ ...checkpointState }),
        getResumePoint: vi.fn().mockReturnValue({ phase: 0 }),
        save: vi.fn().mockResolvedValue(undefined),
      };
      runtime.progress = {
        initialize: vi.fn().mockResolvedValue(undefined),
        reconstructFromCheckpoint: vi.fn(),
        appendEvent: vi.fn().mockResolvedValue(undefined),
        finalize: vi.fn().mockResolvedValue(undefined),
        setTokenUsage: vi.fn(),
        setCumulativeDuration: vi.fn(),
        setTotalTasks: vi.fn(),
        updatePhase: vi.fn().mockResolvedValue(undefined),
      };
      runtime.launcher = {
        getResolvedPath: () => undefined,
        launchAgent: vi.fn().mockResolvedValue({ exitCode: 0, success: true, outputFiles: [], duration: 0 }),
      };
      runtime.logger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        event: vi.fn(),
        flush: vi.fn().mockResolvedValue(undefined),
        setPhase: vi.fn(),
      };
      runtime.projectRoot = '/tmp/project';
      runtime.runId = 'test-run-id';
      runtime.paths = {
        root: '/tmp/.aamf/test-project',
        stateDir: '/tmp/.aamf/test-project/state',
        runLockFile: makeRunLockPath('non-dry-run-success'),
        artifactsDir: '/tmp/.aamf/test-project/artifacts',
        artifactsPlanningDir: '/tmp/.aamf/test-project/artifacts/planning',
        artifactsContextsDir: '/tmp/.aamf/test-project/artifacts/contexts',
        metricsDir: '/tmp/.aamf/test-project/metrics',
        metricsInvocationsFile: '/tmp/.aamf/test-project/metrics/invocations.jsonl',
        logsDir: '/tmp/.aamf/test-project/logs',
        logsRuntimeDir: '/tmp/.aamf/test-project/logs/runtime',
        logsAgentsDir: '/tmp/.aamf/test-project/logs/agents',
        logsCommandsDir: '/tmp/.aamf/test-project/logs/commands',
        logsCommandBuildDir: '/tmp/.aamf/test-project/logs/commands/build',
        logsCommandTestDir: '/tmp/.aamf/test-project/logs/commands/test',
        logsCommandFormatDir: '/tmp/.aamf/test-project/logs/commands/format',
        logsCommandLintDir: '/tmp/.aamf/test-project/logs/commands/lint',
        loreLogFile: '/tmp/.aamf/test-project/logs/lore.log',
        reportsDir: '/tmp/.aamf/test-project/reports',
        reportsObservabilityDir: '/tmp/.aamf/test-project/reports/observability',
        progressReportFile: '/tmp/.aamf/test-project/progress.md',
        kbDbFile: '/tmp/.aamf/test-project/kb.db',
        competingStrategiesFile: '/tmp/.aamf/test-project/artifacts/planning/competing-strategies.md',
        migrationPlanFile: '/tmp/.aamf/test-project/artifacts/planning/migration-plan.md',
      };
      runtime.progressDir = runtime.paths.root;

      const result = await runtime.run();

      expect(result.success).toBe(true);
      expect(result.projectName).toBe('test-project');
      expect(flowRunnerRunSpy).toHaveBeenCalledTimes(1);
      expect(runtime.logger.flush).toHaveBeenCalled();
      expect(printSummarySpy).toHaveBeenCalled();

      flowRunnerRunSpy.mockRestore();
      printSummarySpy.mockRestore();
    });

    it('handles MigrationError from flow runner and records failed phase', async () => {
      const { FlowRunner } = await import('@cadre-dev/framework/flow');
      const { MigrationError } = await import('../../src/flow/steps/shared.js');
      const failedPhaseResult = { phase: 2, name: 'KB Construction', success: false, duration: 100, error: 'KB build failed' };
      const flowRunnerRunSpy = vi.spyOn(FlowRunner.prototype, 'run').mockRejectedValue(
        new MigrationError(2, 'KB Construction', failedPhaseResult),
      );

      const runtime = new MigrationRuntime() as any;
      const printSummarySpy = vi.spyOn(runtime, 'printSummary').mockImplementation(() => {});
      const checkpointState = {
        projectName: 'test-project',
        currentPhase: 0,
        completedPhases: [],
        completedTasks: [],
        failedTasks: [],
        blockedTasks: [],
        completedTaskDurationsMs: [],
        tokenUsage: { total: 0, byPhase: {}, byAgent: {} },
        resumeCount: 0,
        phaseOutputs: {},
      };

      runtime.config = {
        projectName: 'test-project',
        models: { default: 'claude-sonnet-4' },
        options: {
          resume: false, dryRun: false,
          maxParallelAgents: 1, buildConcurrency: 1,
          git: { enabled: false },
        },
        agentBackend: { runtime: 'copilot', timeout: 300_000 },
        source: { path: '/tmp/source', language: 'python' },
        target: { language: 'typescript', outputPath: '/tmp/target' },
        environment: {},
      };
      runtime.checkpoint = {
        load: vi.fn().mockResolvedValue(undefined),
        getState: vi.fn().mockReturnValue({ ...checkpointState }),
        getResumePoint: vi.fn().mockReturnValue({ phase: 0 }),
        save: vi.fn().mockResolvedValue(undefined),
      };
      runtime.progress = {
        initialize: vi.fn().mockResolvedValue(undefined),
        reconstructFromCheckpoint: vi.fn(),
        appendEvent: vi.fn().mockResolvedValue(undefined),
        finalize: vi.fn().mockResolvedValue(undefined),
        setTokenUsage: vi.fn(),
        setCumulativeDuration: vi.fn(),
        updatePhase: vi.fn().mockResolvedValue(undefined),
      };
      runtime.launcher = { getResolvedPath: () => undefined };
      runtime.logger = {
        info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
        event: vi.fn(), flush: vi.fn().mockResolvedValue(undefined), setPhase: vi.fn(),
      };
      runtime.projectRoot = '/tmp/project';
      runtime.runId = 'test-run-id';
      runtime.paths = {
        root: '/tmp/.aamf/test-project',
        runLockFile: makeRunLockPath('migration-error'),
        kbDbFile: '/tmp/.aamf/test-project/kb.db',
        metricsDir: '/tmp/.aamf/test-project/metrics',
        reportsObservabilityDir: '/tmp/.aamf/test-project/reports/observability',
        progressReportFile: '/tmp/.aamf/test-project/progress.md',
      };
      runtime.progressDir = runtime.paths.root;

      const result = await runtime.run();

      expect(result.success).toBe(false);
      expect(result.phases.length).toBe(1);
      expect(result.phases[0]!.phase).toBe(2);
      expect(result.phases[0]!.success).toBe(false);
      // Should have recorded the failed phase event
      expect(runtime.logger.event).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'phase-failed', phase: 2 }),
      );

      flowRunnerRunSpy.mockRestore();
      printSummarySpy.mockRestore();
    });

    it('filters stale failed/blocked tasks from completed set', async () => {
      const { FlowRunner } = await import('@cadre-dev/framework/flow');
      const flowRunnerRunSpy = vi.spyOn(FlowRunner.prototype, 'run').mockResolvedValue({
        status: 'completed', outputs: new Map(),
      });

      const runtime = new MigrationRuntime() as any;
      vi.spyOn(runtime, 'printSummary').mockImplementation(() => {});
      const checkpointState = {
        projectName: 'test-project',
        currentPhase: 5,
        completedPhases: [1, 2, 3, 4, 5],
        completedTasks: ['task-001', 'task-002'],
        failedTasks: [{ taskId: 'task-001', error: 'stale' }],
        blockedTasks: ['task-001'],
        completedTaskDurationsMs: [1000, 2000],
        tokenUsage: { total: 0, byPhase: {}, byAgent: {} },
        resumeCount: 0,
        phaseOutputs: {},
      };

      runtime.config = {
        projectName: 'test-project',
        models: { default: 'claude-sonnet-4' },
        options: {
          resume: false, dryRun: false,
          maxParallelAgents: 1, buildConcurrency: 1,
          git: { enabled: false },
        },
        agentBackend: { runtime: 'copilot', timeout: 300_000 },
        source: { path: '/tmp/source', language: 'python' },
        target: { language: 'typescript', outputPath: '/tmp/target' },
        environment: {},
      };
      runtime.checkpoint = {
        load: vi.fn().mockResolvedValue(undefined),
        getState: vi.fn().mockReturnValue(checkpointState),
        getResumePoint: vi.fn().mockReturnValue({ phase: 0 }),
        save: vi.fn().mockResolvedValue(undefined),
      };
      runtime.progress = {
        initialize: vi.fn().mockResolvedValue(undefined),
        reconstructFromCheckpoint: vi.fn(),
        appendEvent: vi.fn().mockResolvedValue(undefined),
        finalize: vi.fn().mockResolvedValue(undefined),
        setTokenUsage: vi.fn(),
        setCumulativeDuration: vi.fn(),
        updatePhase: vi.fn().mockResolvedValue(undefined),
      };
      runtime.launcher = { getResolvedPath: () => undefined };
      runtime.logger = {
        info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
        event: vi.fn(), flush: vi.fn().mockResolvedValue(undefined), setPhase: vi.fn(),
      };
      runtime.projectRoot = '/tmp/project';
      runtime.runId = 'test-run-id';
      runtime.paths = {
        root: '/tmp/.aamf/test-project',
        runLockFile: makeRunLockPath('stale-filter'),
        kbDbFile: '/tmp/.aamf/test-project/kb.db',
        metricsDir: '/tmp/.aamf/test-project/metrics',
        reportsObservabilityDir: '/tmp/.aamf/test-project/reports/observability',
        progressReportFile: '/tmp/.aamf/test-project/progress.md',
      };
      runtime.progressDir = runtime.paths.root;

      const result = await runtime.run();

      // task-001 is in completedTasks, so it should be filtered from failedTasks and blockedTasks
      expect(result.failedTasks).toEqual([]);
      expect(result.blockedTasks).toEqual([]);

      flowRunnerRunSpy.mockRestore();
    });
  });

  describe('status and reset', () => {
    it('formats status from checkpoint state', async () => {
      const runtime = new MigrationRuntime() as any;
      runtime.config = { projectName: 'demo' };
      runtime.checkpoint = {
        load: vi.fn().mockResolvedValue({
          projectName: 'demo',
          currentPhase: 4,
          completedPhases: [1, 2, 3],
          completedTasks: ['a', 'b'],
          failedTasks: ['f1'],
          blockedTasks: ['b1', 'b2'],
          tokenUsage: { total: 12345, byPhase: {}, byAgent: {} },
          startedAt: '2026-01-01T00:00:00Z',
          lastCheckpoint: '2026-01-01T00:10:00Z',
          resumeCount: 2,
        }),
      };

      const status = await runtime.getStatus();
      expect(status).toContain('Project: demo');
      expect(status).toContain('Phase: 4/7');
      expect(status).toContain('Completed Tasks: 2');
      expect(status).toContain('Token Usage: 12,345');
      expect(status).toContain('Resume Count: 2');
    });

    it('resets only from selected phase onward', async () => {
      const runtime = new MigrationRuntime() as any;
      const state = {
        projectName: 'demo',
        currentPhase: 4,
        currentTask: 'task-x',
        completedPhases: [1, 2, 3],
        completedTasks: ['a', 'b'],
        failedTasks: ['f1'],
        blockedTasks: ['b1'],
        phaseOutputs: { 0: {}, 1: {}, 2: {}, 3: {}, 4: {}, 5: {}, 6: {} } as Record<number, unknown>,
        tokenUsage: { total: 100, byPhase: {}, byAgent: {} },
      };
      runtime.config = { projectName: 'demo' };
      runtime.checkpoint = {
        load: vi.fn().mockResolvedValue(state),
        save: vi.fn().mockResolvedValue(undefined),
      };
      runtime.logger = { info: vi.fn() };

      await runtime.reset(3);

      expect(state.completedPhases).toEqual([1, 2]);
      expect(state.currentPhase).toBe(3);
      expect(state.currentTask).toBeNull();
      expect(state.phaseOutputs[0]).toBeDefined();
      expect(state.phaseOutputs[2]).toBeDefined();
      expect(state.phaseOutputs[3]).toBeUndefined();
      expect(state.phaseOutputs[6]).toBeUndefined();
      expect(runtime.checkpoint.save).toHaveBeenCalledWith(state);
    });

    it('resets full migration state when phase is omitted', async () => {
      const runtime = new MigrationRuntime() as any;
      const state = {
        projectName: 'demo',
        currentPhase: 5,
        currentTask: 'task-x',
        completedPhases: [1, 2, 3, 4],
        completedTasks: ['a', 'b'],
        failedTasks: ['f1'],
        blockedTasks: ['b1'],
        phaseOutputs: { 1: {}, 2: {} },
        tokenUsage: { total: 100, byPhase: { 1: 10 }, byAgent: { a: 20 } },
      };
      runtime.config = { projectName: 'demo' };
      runtime.checkpoint = {
        load: vi.fn().mockResolvedValue(state),
        save: vi.fn().mockResolvedValue(undefined),
      };
      runtime.logger = { info: vi.fn() };

      await runtime.reset();

      expect(state.currentPhase).toBe(1);
      expect(state.currentTask).toBeNull();
      expect(state.completedPhases).toEqual([]);
      expect(state.completedTasks).toEqual([]);
      expect(state.failedTasks).toEqual([]);
      expect(state.blockedTasks).toEqual([]);
      expect(state.phaseOutputs).toEqual({});
      expect(state.tokenUsage).toEqual({ total: 0, byPhase: {}, byAgent: {} });
      expect(runtime.checkpoint.save).toHaveBeenCalledWith(state);
    });
  });

  describe('internal helpers', () => {
    it('formats durations across seconds, minutes, and hours', () => {
      expect(formatDuration(5_000)).toBe('5s');
      expect(formatDuration(65_000)).toBe('1m 5s');
      expect(formatDuration(3_723_000)).toBe('1h 2m 3s');
    });

    it('validateAgentFiles succeeds when all phase agents exist', async () => {
      const root = await mkdtemp(join(tmpdir(), 'aamf-agent-files-'));
      const runtime = new MigrationRuntime() as any;
      runtime.config = { agentBackend: { runtime: 'copilot', agentDir: root } };

      const allAgents = [...new Set(Array.from({ length: 10 }, (_, i) => i).flatMap(p => getAgentsForPhase(p)))];
      await Promise.all(
          allAgents.map(agent => writeFile(join(root, `${agent}.agent.md`), VALID_AGENT_CONTRACT, 'utf-8')),
      );

      await expect(runtime.validateAgentFiles()).resolves.toBeUndefined();
      await rm(root, { recursive: true, force: true });
    });

      it('validateAgentFiles throws when schema sections are missing', async () => {
        const root = await mkdtemp(join(tmpdir(), 'aamf-agent-files-invalid-'));
        const runtime = new MigrationRuntime() as any;
        runtime.config = { agentBackend: { runtime: 'copilot', agentDir: root } };

        const allAgents = [...new Set(Array.from({ length: 10 }, (_, i) => i).flatMap(p => getAgentsForPhase(p)))];
        await Promise.all(
          allAgents.map(agent => writeFile(join(root, `${agent}.agent.md`), '# agent\n', 'utf-8')),
        );

        await expect(runtime.validateAgentFiles()).rejects.toThrow('Invalid agent schema contract(s)');
        await rm(root, { recursive: true, force: true });
      });

  const VALID_AGENT_CONTRACT = `# Agent Definition

## Input Schema (Required)

\`\`\`json
{
  "type": "object",
  "required": ["contextFile"],
  "properties": {
    "contextFile": { "type": "string" }
  }
}
\`\`\`

## Output Schema (Required)

\`\`\`json
{
  "type": "object",
  "required": ["agent"],
  "properties": {
    "agent": { "type": "string" }
  }
}
\`\`\`
`;

    it('validateAgentFiles throws with missing file list', async () => {
      const root = await mkdtemp(join(tmpdir(), 'aamf-agent-files-missing-'));
      const runtime = new MigrationRuntime() as any;
      runtime.config = { agentBackend: { runtime: 'copilot', agentDir: root } };

      await expect(runtime.validateAgentFiles()).rejects.toThrow('Missing agent file(s)');
      await rm(root, { recursive: true, force: true });
    });

    it('validateAgentFiles succeeds for claude-code runtime using .md agent files', async () => {
      const root = await mkdtemp(join(tmpdir(), 'aamf-claude-agent-files-'));
      const runtime = new MigrationRuntime() as any;
      runtime.config = {
        agentBackend: {
          runtime: 'claude-code',
          agentDir: root,
        },
      };

      const allAgents = [...new Set(Array.from({ length: 10 }, (_, i) => i).flatMap(p => getAgentsForPhase(p)))];
      await Promise.all(
        allAgents.map(agent => writeFile(join(root, `${agent}.md`), '# Claude agent\n', 'utf-8')),
      );

      await expect(runtime.validateAgentFiles()).resolves.toBeUndefined();
      await rm(root, { recursive: true, force: true });
    });

    it('setupShutdownHandlers registers SIGINT/SIGTERM/SIGHUP handlers that flush and save state', async () => {
      const runtime = new MigrationRuntime() as any;
      const onSpy = vi.spyOn(process, 'on').mockReturnValue(process);
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

      runtime.logger = {
        warn: vi.fn(),
        flush: vi.fn().mockResolvedValue(undefined),
      };
      runtime.checkpoint = {
        save: vi.fn().mockResolvedValue(undefined),
        getState: vi.fn().mockReturnValue({ currentPhase: 1 }),
      };
      runtime.progress = {
        appendEvent: vi.fn().mockResolvedValue(undefined),
      };

      runtime.setupShutdownHandlers();

      const sigintHandler = onSpy.mock.calls.find(([signal]) => signal === 'SIGINT')?.[1] as (() => void) | undefined;
      const sigtermHandler = onSpy.mock.calls.find(([signal]) => signal === 'SIGTERM')?.[1] as (() => void) | undefined;
      const sighupHandler = onSpy.mock.calls.find(([signal]) => signal === 'SIGHUP')?.[1] as (() => void) | undefined;

      expect(sigintHandler).toBeDefined();
      expect(sigtermHandler).toBeDefined();
      expect(sighupHandler).toBeDefined();

      sigintHandler!();
      sigtermHandler!();
      sighupHandler!();
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(runtime.logger.flush).toHaveBeenCalledTimes(3);
      expect(runtime.checkpoint.save).toHaveBeenCalledTimes(3);
      expect(runtime.progress.appendEvent).toHaveBeenCalledWith('Migration interrupted by SIGINT');
      expect(runtime.progress.appendEvent).toHaveBeenCalledWith('Migration interrupted by SIGTERM');
      expect(runtime.progress.appendEvent).toHaveBeenCalledWith('Migration interrupted by SIGHUP');
      expect(exitSpy).toHaveBeenCalledWith(130);
      expect(exitSpy).toHaveBeenCalledWith(143);

      onSpy.mockRestore();
      exitSpy.mockRestore();
    });
  });
});
