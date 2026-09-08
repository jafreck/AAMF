import { randomUUID } from 'node:crypto';
import { resolve, join, dirname } from 'node:path';
import { stat, readdir, readFile } from 'node:fs/promises';
import pLimit from 'p-limit';
import { loadConfig, applyOverrides } from '../config/loader.js';
import { MigrationConfig } from '../config/schema.js';
import { CheckpointManager } from './checkpoint.js';
import { AgentLauncher } from './agent-launcher.js';
import { ProgressWriter } from './progress.js';
import { Logger } from '../logging/logger.js';
import type { MigrationResult, PhaseResult } from '../agents/types.js';
import { CostEstimator } from '../budget/cost-estimator.js';
import { TokenTracker } from '../budget/token-tracker.js';
import { fileExists } from '../util/fs.js';
import { formatDuration } from '../util/format.js';
import { killAllActiveProcesses } from '../util/process.js';
import { buildRuntimePaths } from './runtime-paths.js';
import { MigrationRunLock } from './run-lock.js';
import { generateAgentDefinitions } from '../agents/generator.js';
import { ContextBuilder } from '../agents/context-builder.js';
import { MetricsCollector } from '../observability/metrics-collector.js';
import { ReportGenerator } from '../observability/report-generator.js';
import { TargetIndexer } from './target-indexer.js';
import { FlowRunner, type FlowLifecycleEvent, type FlowRunnerOptions } from '@cadre-dev/framework/flow';
import {
  createMigrationFlow,
  AamfFlowCheckpointAdapter,
  buildFlowUpToPhase,
  nodeIdToPhase,
  PHASE_BOUNDARY_NODE_IDS,
  PHASE_NAMES,
  MAX_PHASE,
} from '../flow/index.js';
import { MigrationError } from '../flow/steps/shared.js';
import type { MigrationFlowContext } from '../flow/index.js';
import { getAgentsForPhase } from '../agents/registry.js';
import { clearFreshRunArtifacts } from './run-provenance.js';
import { TargetChangeSetManager } from './target-change-set.js';

export interface RuntimeOptions {
  configPath: string;
  resume?: boolean;
  dryRun?: boolean;
  phase?: number;      // run up to and including this phase
  fromPhase?: number;  // restart from this phase, preserving earlier phases
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
  /** Initialize only checkpoint inspection/reset services; never launch or generate agents. */
  stateOnly?: boolean;
}

export interface RuntimeAgentLauncher {
  init(): Promise<void>;
  launchAgent: AgentLauncher['launchAgent'];
  getResolvedPath: AgentLauncher['getResolvedPath'];
}

export interface RuntimeDependencies {
  createAgentLauncher?: (
    config: MigrationConfig,
    projectRoot: string,
    logger: Logger,
  ) => RuntimeAgentLauncher;
  terminateActiveProcesses?: () => Promise<void>;
}

/**
 * Verify that the configured source path exists and configured entry points
 * are present before any migration phases run.
 */
export async function validateSourceAvailability(config: MigrationConfig): Promise<void> {
  const sourcePath = config.source.path;

  let sourceStat;
  try {
    sourceStat = await stat(sourcePath);
  } catch {
    throw new Error(
      `Source path does not exist: ${sourcePath}. ` +
      'Ensure the source code is downloaded/present before running migration.',
    );
  }

  if (!sourceStat.isDirectory()) {
    throw new Error(`Source path is not a directory: ${sourcePath}`);
  }

  for (const entryPoint of config.source.entryPoints ?? []) {
    const resolvedEntryPoint = resolve(sourcePath, entryPoint);
    let entryStat;
    try {
      entryStat = await stat(resolvedEntryPoint);
    } catch {
      throw new Error(
        `Configured source entry point not found: ${entryPoint} ` +
        `(resolved: ${resolvedEntryPoint})`,
      );
    }

    if (!entryStat.isFile()) {
      throw new Error(
        `Configured source entry point is not a file: ${entryPoint} ` +
        `(resolved: ${resolvedEntryPoint})`,
      );
    }
  }
}

function findMigrationError(error: unknown): MigrationError | undefined {
  const visited = new Set<unknown>();
  let current = error;
  while (current && !visited.has(current)) {
    if (current instanceof MigrationError) return current;
    visited.add(current);
    current = current instanceof Error
      ? (current as Error & { cause?: unknown }).cause
      : undefined;
  }
  return undefined;
}

export class MigrationRuntime {
  private config!: MigrationConfig;
  private logger!: Logger;
  private checkpoint!: CheckpointManager;
  private progress!: ProgressWriter;
  private launcher!: RuntimeAgentLauncher;
  private progressDir!: string;
  private paths!: ReturnType<typeof buildRuntimePaths>;
  private projectRoot!: string;
  private phase?: number;
  private fromPhase?: number;
  private runId!: string;
  /** Mutable flow context — populated during run(), used by shutdown handler. */
  private flowContext?: MigrationFlowContext;
  private abortController?: AbortController;
  private runLock?: MigrationRunLock;
  private shutdownListeners: Array<{ event: NodeJS.Signals | 'exit'; listener: (...args: any[]) => void }> = [];
  private shutdownInProgress = false;
  private resourcesCleaned = false;
  private activeFlowRun?: Promise<unknown>;

  constructor(private readonly dependencies: RuntimeDependencies = {}) {}

  private getActiveRuntimeSettings(): {
    agentDir: string;
    model?: string;
    agentFileSuffix: '.agent.md' | '.md';
    validateSchemaContract: boolean;
  } {
    if (this.config.agentBackend.runtime === 'claude-code') {
      return {
        agentDir: this.config.agentBackend.agentDir,
        model: this.config.models?.default,
        agentFileSuffix: '.md',
        validateSchemaContract: false,
      };
    }

    return {
      agentDir: this.config.agentBackend.agentDir,
      model: this.config.models?.default,
      agentFileSuffix: '.agent.md',
      validateSchemaContract: true,
    };
  }

  async initialize(options: RuntimeOptions): Promise<void> {
    // 1. Load config
    const rawConfig = await loadConfig(options.configPath);
    this.projectRoot = dirname(resolve(options.configPath));

    // Apply CLI overrides immutably
    this.config = applyOverrides(rawConfig, {
      dryRun: options.dryRun,
      resume: options.resume,
    });
    this.phase = options.phase;
    this.fromPhase = options.fromPhase;

    for (const [name, phase] of [['--phase', this.phase], ['--from-phase', this.fromPhase]] as const) {
      if (phase !== undefined && (!Number.isInteger(phase) || phase < 0 || phase > MAX_PHASE)) {
        throw new Error(`${name} must be an integer from 0 through ${MAX_PHASE}; received ${phase}`);
      }
    }

    // Validate --from-phase / --phase compatibility
    if (this.fromPhase !== undefined && this.phase !== undefined && this.fromPhase > this.phase) {
      throw new Error(
        `--from-phase ${this.fromPhase} must be <= --phase ${this.phase}`,
      );
    }

    // Fail fast if source tree or configured entry points are missing for runs.
    if (!options.stateOnly) await validateSourceAvailability(this.config);

    // 2. Setup directories
    this.paths = buildRuntimePaths(this.projectRoot, this.config.projectName);
    this.progressDir = this.paths.root;
    const logDir = this.paths.logsRuntimeDir;

    // 3. Create logger
    this.logger = new Logger({
      logDir,
      level: options.logLevel ?? 'info',
      console: true,
    });

    // 3a. Generate a stable runId for this execution
    this.runId = randomUUID();
    this.logger.setRunId(this.runId);

    // 4. Create checkpoint manager
    this.checkpoint = new CheckpointManager(this.progressDir, this.logger);

    if (options.stateOnly) {
      this.logger.info(`AAMF checkpoint services initialized for project: ${this.config.projectName}`);
      return;
    }

    // 5. Create progress writer
    this.progress = new ProgressWriter(this.paths.progressReportFile, this.config.projectName);

    // 6. Create agent launcher
    this.launcher = this.dependencies.createAgentLauncher?.(
      this.config,
      this.projectRoot,
      this.logger,
    ) ?? new AgentLauncher(this.config, this.projectRoot, this.logger);
    await this.launcher.init();

    // 7. Generate agent definition files from shared templates
    const settings = this.getActiveRuntimeSettings();
    const absAgentDir = resolve(this.projectRoot, settings.agentDir);
    const generated = await generateAgentDefinitions({
      backend: this.config.agentBackend.runtime,
      outputDir: absAgentDir,
      vars: { loreEnabled: 'true' },
    });
    this.logger.info(`Generated ${generated.length} agent definitions in ${settings.agentDir} (loreEnabled=true)`);

    // 8. Validate agent files exist
    await this.validateAgentFiles();

    this.logger.info(`AAMF Runtime initialized for project: ${this.config.projectName} (runId=${this.runId})`);
    this.logger.info(`Source: ${this.config.source.language} → Target: ${this.config.target.language}`);

  }

  async run(): Promise<MigrationResult> {
    await this.acquireRunLock();
    this.resourcesCleaned = false;
    this.setupShutdownHandlers();

    try {
    // Load or create checkpoint.
    //   --from-phase implies resume for earlier phases (load existing checkpoint).
    //   resume=false (without --from-phase) forces a fresh start.
    const impliedResume = this.fromPhase !== undefined;
    let startupTargetChanges: TargetChangeSetManager | undefined;
    let recoveredBeforeLoad: import('./target-change-set.js').TargetChangeRecovery | undefined;
    if (!this.config.options.dryRun) {
      startupTargetChanges = new TargetChangeSetManager(
        this.config.target.outputPath,
        this.paths.stateDir ?? join(this.paths.root, 'state'),
        this.logger,
      );
      recoveredBeforeLoad = await startupTargetChanges.recoverPending();
      if (recoveredBeforeLoad) {
        await new TargetIndexer(
          this.paths.kbTargetDbFile,
          this.config.target.outputPath,
          this.logger,
        ).invalidate();
        this.logger.warn(
          `Recovered pending target change set ${recoveredBeforeLoad.scopeId} before startup`,
        );
      }
    }
    if (!this.config.options.dryRun && !this.config.options.resume && !impliedResume) {
      await clearFreshRunArtifacts(this.paths);
    }
    await this.checkpoint.load(this.config.projectName, {
      fresh: !this.config.options.resume && !impliedResume,
      reuseKb: this.config.options.reuseKb,
    });
    if (recoveredBeforeLoad && (this.config.options.resume || impliedResume)) {
      await this.invalidateRecoveredChangeSet(recoveredBeforeLoad);
    }

    // Apply --from-phase reset before anything else
    if (this.fromPhase !== undefined) {
      await this.checkpoint.resetFromPhase(this.fromPhase, nodeIdToPhase);
    }

    // Initialize progress
    if (!this.config.options.resume && !impliedResume) {
      await this.progress.initialize(this.config);
    } else {
      // Reconstruct progress state from checkpoint on resume
      const state = this.checkpoint.getState();
      this.progress.reconstructFromCheckpoint(state);
    }

    // Dry run: just validate and log
    if (this.config.options.dryRun) {
      this.logger.info('Dry run mode — config validated, no migration will be performed');
      await this.progress.appendEvent('Dry run — validation only');
      return {
        success: true,
        status: 'completed',
        projectName: this.config.projectName,
        phases: [],
        totalDuration: 0,
        tokenUsage: { total: 0, byPhase: {}, byAgent: {} },
        failedTasks: [],
        blockedTasks: [],
      };
    }

    // Build the shared flow context
    const tokenTracker = new TokenTracker();
    const state = this.checkpoint.getState();
    tokenTracker.loadFromCheckpoint(state.tokenUsage);

    const metricsCollector = new MetricsCollector();
    if (state.resumeCount > 0) {
      await metricsCollector.loadFromJsonl(this.progressDir, state.metricsCount ?? 0);
    }

    const costEstimator = new CostEstimator();
    const reportGenerator = new ReportGenerator();
    const contextBuilder = new ContextBuilder(this.config, this.progressDir, this.paths);
    const bc = this.config.options.buildConcurrency ?? 1;
    const buildLimiter = pLimit(bc === 0 ? this.config.options.maxParallelAgents : bc);
    const gitLimiter = pLimit(1);
    this.abortController = new AbortController();
    const terminateActiveProcesses = this.dependencies.terminateActiveProcesses ?? killAllActiveProcesses;

    // Target codebase indexer
    const targetIndexer = new TargetIndexer(this.paths.kbTargetDbFile, this.config.target.outputPath, this.logger);
    const targetChanges = startupTargetChanges!;
    if (recoveredBeforeLoad) {
      this.progress.reconstructFromCheckpoint(this.checkpoint.getState());
      this.logger.warn(
        `Invalidated target index after recovering ${recoveredBeforeLoad.scopeId}`,
      );
    }

    // If the target DB already exists (resume), mark the indexer as built.
    if (await fileExists(this.paths.kbTargetDbFile)) {
      targetIndexer.markBuilt();
    }

    const flowContext: MigrationFlowContext = {
      config: this.config,
      projectRoot: this.projectRoot,
      runId: this.runId,
      paths: this.paths,
      maxPhase: this.phase,
      signal: this.abortController.signal,
      checkpoint: this.checkpoint,
      launcher: this.launcher,
      progress: this.progress,
      logger: this.logger,
      tokenTracker,
      costEstimator,
      metricsCollector,
      reportGenerator,
      contextBuilder,
      buildLimiter,
      gitLimiter,
      targetChanges,
      terminateActiveProcesses,
      targetIndexer,
      peakConcurrency: 0,
      parityResults: new Map(),
      routedTaskIds: new Set(),
      escalationCostUsd: 0,
      deferGitCommits: false,
    };
    this.flowContext = flowContext;

    // Lazy-start the target KB server after the first target index build.
    targetIndexer.setOnFirstBuild(async () => {
      if (!flowContext.targetKbServer) {
        const { startTargetKbServer } = await import('../flow/steps/kb-server-lifecycle.js');
        await startTargetKbServer(flowContext);
      }
    });

    this.logger.event({ type: 'migration-started', projectName: this.config.projectName });
    await this.progress.appendEvent('Migration started');

    // Ensure git is ready before flow execution
    const { ensureGitRepositoryReady } = await import('../flow/steps/shared.js');
    await ensureGitRepositoryReady(flowContext);

    // Start KB server for resume if Phase 0 already completed
    const resumePoint = this.checkpoint.getResumePoint();
    if (resumePoint.phase > 0 && (await fileExists(this.paths.kbDbFile))) {
      const { startKbServer } = await import('../flow/steps/kb-server-lifecycle.js');
      await startKbServer(flowContext);
    }

    const startTime = Date.now();
    const phaseResultsByPhase = new Map<number, PhaseResult>();
    const phaseStartedAt = new Map<number, number>();
    let aborted = false;
    let flowTerminalStatus: 'completed' | 'failed' | 'cancelled' | 'timed-out' = 'completed';

    // Select the flow definition — truncate if --phase was specified
    const fullFlow = createMigrationFlow();
    const flow = this.phase != null
      ? buildFlowUpToPhase(this.phase, fullFlow)
      : fullFlow;
    if (this.phase != null) {
      this.logger.info(`Running phases 0–${this.phase} (--phase ${this.phase})`);
    }

    // Run the flow
    const checkpointAdapter = new AamfFlowCheckpointAdapter(this.checkpoint);
    const runner = new FlowRunner<MigrationFlowContext>();

    try {
      const runnerOptions: FlowRunnerOptions<MigrationFlowContext> = {
        checkpoint: checkpointAdapter,
        signal: this.abortController.signal,
        hooks: {
          onEvent: async (event: FlowLifecycleEvent<MigrationFlowContext>) => {
            const phase = nodeIdToPhase(event.nodeId);
            if (phase < 0) return;
            if (event.type === 'node-start') {
              if (!phaseStartedAt.has(phase)) phaseStartedAt.set(phase, Date.parse(event.startedAt));
              await this.progress.updatePhase(phase, 'in-progress');
              return;
            }
            if (event.type === 'node-failed' || event.type === 'node-cancelled') {
              const migrationError = findMigrationError(event.error);
              const failedResult: PhaseResult = migrationError?.result ?? {
                phase,
                name: PHASE_NAMES[phase] ?? `Phase ${phase}`,
                success: false,
                duration: event.durationMs ?? 0,
                error: event.error?.message ?? event.reason ?? 'Node failed',
              };
              phaseResultsByPhase.set(phase, failedResult);
              await this.progress.updatePhase(
                phase,
                event.type === 'node-cancelled' ? 'pending' : 'failed',
                event.error?.message,
              );
              return;
            }
            const boundaryPhase = PHASE_BOUNDARY_NODE_IDS.indexOf(event.nodeId);
            if (boundaryPhase < 0) return;
            if (event.type === 'node-skipped') {
              phaseResultsByPhase.set(boundaryPhase, {
                phase: boundaryPhase,
                name: PHASE_NAMES[boundaryPhase] ?? `Phase ${boundaryPhase}`,
                success: true,
                duration: 0,
                outputPath: this.checkpoint.getState().phaseOutputs[boundaryPhase],
              });
              return;
            }
            if (event.type !== 'node-complete') return;

            const startedAtMs = phaseStartedAt.get(boundaryPhase) ?? Date.parse(event.startedAt);
            const finishedAtMs = event.finishedAt ? Date.parse(event.finishedAt) : Date.now();
            const phaseResult: PhaseResult = {
              phase: boundaryPhase,
              name: PHASE_NAMES[boundaryPhase] ?? `Phase ${boundaryPhase}`,
              success: true,
              duration: Math.max(0, finishedAtMs - startedAtMs),
            };
            phaseResultsByPhase.set(boundaryPhase, phaseResult);
            await this.checkpoint.completePhase(boundaryPhase, '');
            await this.progress.updatePhase(boundaryPhase, 'completed');
            this.logger.event({
              type: 'phase-completed', phase: boundaryPhase,
              name: phaseResult.name, success: true, duration: phaseResult.duration,
            });
            if (boundaryPhase === 4 && flowContext.phase4Snapshot) {
              flowContext.phase4Snapshot.phase4DurationMs = phaseResult.duration;
              metricsCollector.setPhase4Snapshot(flowContext.phase4Snapshot);
            }
            this.progress.setTokenUsage(tokenTracker.toCheckpointData());
          },
        },
      };

      const activeFlowRun = runner.run(flow, flowContext, runnerOptions);
      this.activeFlowRun = activeFlowRun;
      const flowResult = await activeFlowRun;

      // Process phase results from execution outputs
      for (const output of Object.values(flowResult.executionOutputs ?? {})) {
        const phaseResult = output as PhaseResult | undefined;
        if (phaseResult && typeof phaseResult === 'object' && 'phase' in phaseResult) {
          phaseResultsByPhase.set(phaseResult.phase, {
            ...phaseResultsByPhase.get(phaseResult.phase),
            ...phaseResult,
          });
        }
      }

      // Status may be 'failed', 'cancelled', or 'timed-out' in newer framework versions
      const status = flowResult.status as string;
      aborted = status === 'failed' || status === 'cancelled' || status === 'timed-out';
      if (aborted) flowTerminalStatus = status as typeof flowTerminalStatus;
    } catch (err) {
      // Record the failed phase result if this was a MigrationError
      if (err instanceof MigrationError) {
        const failedResult = err.result;
        phaseResultsByPhase.set(failedResult.phase, failedResult);
        const truncatedStderr = failedResult.stderr ? failedResult.stderr.slice(0, 2000) : undefined;
        await this.progress.updatePhase(failedResult.phase, 'failed', failedResult.error, failedResult.exitCode, truncatedStderr);
        this.logger.event({ type: 'phase-failed', phase: failedResult.phase, name: failedResult.name, error: failedResult.error ?? 'unknown', exitCode: failedResult.exitCode, stderr: truncatedStderr });
        await this.progress.appendEvent(`Migration aborted: Phase ${failedResult.phase} (${failedResult.name}) failed`);
      } else {
        this.logger.error(`Flow execution failed: ${err instanceof Error ? err.message : String(err)}`);
        const migrationError = findMigrationError(err);
        if (migrationError) {
          phaseResultsByPhase.set(migrationError.result.phase, migrationError.result);
        }
      }
      aborted = true;
      flowTerminalStatus = this.abortController.signal.aborted ? 'cancelled' : 'failed';
    } finally {
      this.activeFlowRun = undefined;
      // Run-scoped resources are released by the outer lifecycle guard.
    }

    const totalDuration = Date.now() - startTime;
    const finalState = this.checkpoint.getState();
    const cumulativeDurationMs = (finalState.cumulativeDurationMs ?? 0) + totalDuration;
    finalState.cumulativeDurationMs = cumulativeDurationMs;
    await this.checkpoint.save(finalState);

    // Filter stale entries
    const completedSet = new Set(finalState.completedTasks);
    const filteredFailed = finalState.failedTasks.filter(f => !completedSet.has(f.taskId));
    const filteredBlocked = finalState.blockedTasks.filter(id => !completedSet.has(id));

    const migrationResult: MigrationResult = {
      success: !aborted && [...phaseResultsByPhase.values()].every(r => r.success),
      status: flowTerminalStatus,
      projectName: this.config.projectName,
      phases: [...phaseResultsByPhase.values()].sort((left, right) => left.phase - right.phase),
      totalDuration,
      cumulativeDuration: cumulativeDurationMs,
      tokenUsage: tokenTracker.toCheckpointData(),
      failedTasks: filteredFailed.map(f => f.taskId),
      blockedTasks: filteredBlocked,
    };

    this.logger.event({ type: 'migration-completed', projectName: this.config.projectName, success: migrationResult.success, duration: totalDuration });
    this.progress.setCumulativeDuration(cumulativeDurationMs);
    await this.progress.finalize(migrationResult);

    // Write observability reports
    try {
      await metricsCollector.writeSummary(this.progressDir, flowContext.peakConcurrency);
      const aggregates = metricsCollector.getAggregates(flowContext.peakConcurrency);
      await reportGenerator.generate(
        this.paths.metricsDir, this.paths.reportsObservabilityDir,
        metricsCollector.getMetrics(), aggregates,
      );
    } catch (err) {
      this.logger.warn(`Failed to write observability report: ${err instanceof Error ? err.message : String(err)}`);
    }

    await this.logger.flush();
    this.printSummary(migrationResult);
    return migrationResult;
    } finally {
      await this.cleanupRuntimeResources();
      this.flowContext = undefined;
      this.abortController = undefined;
      this.disposeShutdownHandlers();
      try { await this.logger.flush(); } catch { /* best effort */ }
      await this.releaseRunLock();
    }
  }

  /** Request cancellation of the active Cadre run without sending a process signal. */
  async cancel(): Promise<void> {
    this.abortController?.abort();
    await (this.dependencies.terminateActiveProcesses ?? killAllActiveProcesses)();
  }

  /** Release any resources owned by this runtime instance. Safe to call repeatedly. */
  async dispose(): Promise<void> {
    this.abortController?.abort();
    await this.cleanupRuntimeResources();
    this.flowContext = undefined;
    this.abortController = undefined;
    this.disposeShutdownHandlers();
    await this.releaseRunLock();
    try { await this.logger?.flush(); } catch { /* best effort */ }
  }

  async getStatus(): Promise<string> {
    const state = await this.checkpoint.peek();
    if (!state) return `\nNo checkpoint found for project: ${this.config.projectName}\n`;
    // Format status from checkpoint state
    let status = `\nProject: ${state.projectName}\n`;
    status += `Phase: ${state.currentPhase}/${MAX_PHASE}\n`;
    status += `Completed Phases: ${state.completedPhases.join(', ') || 'none'}\n`;
    status += `Completed Tasks: ${state.completedTasks.length}\n`;
    status += `Failed Tasks: ${state.failedTasks.length}\n`;
    status += `Blocked Tasks: ${state.blockedTasks.length}\n`;
    status += `Token Usage: ${state.tokenUsage.total.toLocaleString()}\n`;
    status += `Started: ${state.startedAt}\n`;
    status += `Last Checkpoint: ${state.lastCheckpoint}\n`;
    status += `Resume Count: ${state.resumeCount}\n`;
    return status;
  }

  async reset(fromPhase?: number): Promise<void> {
    if (!await this.checkpoint.peek()) {
      this.logger.info(`No migration checkpoint exists for project ${this.config.projectName}; nothing to reset`);
      return;
    }
    await this.checkpoint.load(this.config.projectName, { readOnly: true });
    if (fromPhase !== undefined) {
      await this.checkpoint.resetFromPhase(fromPhase, nodeIdToPhase, {
        requirePrerequisites: false,
        maxPhase: MAX_PHASE,
      });
    } else {
      await this.checkpoint.resetAll(this.config.projectName);
    }
  }

  private async acquireRunLock(): Promise<void> {
    this.runLock = new MigrationRunLock(
      this.paths.runLockFile,
      this.logger,
      this.config.projectName,
      this.runId,
    );
    await this.runLock.acquire();
  }

  private async releaseRunLock(): Promise<void> {
    if (!this.runLock) return;

    const lock = this.runLock;
    this.runLock = undefined;
    try {
      await lock.release();
    } catch (err) {
      this.logger.warn(`Failed to release migration run lock: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private releaseRunLockSync(): void {
    if (!this.runLock) return;

    const lock = this.runLock;
    this.runLock = undefined;
    try {
      lock.releaseSync();
    } catch {
      // Best-effort
    }
  }

  private printSummary(result: MigrationResult): void {
    console.log('\n' + '='.repeat(60));
    console.log(result.success ? '✅ Migration Complete' : '❌ Migration Failed');
    console.log('='.repeat(60));
    console.log(`Project: ${result.projectName}`);
    console.log(`Duration: ${formatDuration(result.totalDuration)}`);
    if (result.cumulativeDuration !== undefined && result.cumulativeDuration > result.totalDuration) {
      console.log(`Total (all runs): ${formatDuration(result.cumulativeDuration)}`);
    }
    console.log(`Token Usage: ${result.tokenUsage.total.toLocaleString()}`);
    
    const runtimeSettings = this.getActiveRuntimeSettings();
    const model = runtimeSettings.model ?? 'claude-sonnet-4';
    const estimator = new CostEstimator();
    const cost = estimator.estimateFromTotal(model, result.tokenUsage.total);
    console.log(`Estimated Cost: ${CostEstimator.formatCost(cost.total)}`);

    console.log('\nPhases:');
    for (const phase of result.phases) {
      const icon = phase.success ? '✅' : '❌';
      console.log(`  ${icon} Phase ${phase.phase}: ${phase.name} (${formatDuration(phase.duration)})`);
    }

    if (result.failedTasks.length > 0) {
      console.log(`\nFailed Tasks: ${result.failedTasks.join(', ')}`);
    }
    if (result.blockedTasks.length > 0) {
      console.log(`Blocked Tasks: ${result.blockedTasks.join(', ')}`);
    }
    console.log('='.repeat(60) + '\n');
  }



  private async validateAgentFiles(): Promise<void> {
    const runtimeSettings = this.getActiveRuntimeSettings();
    const { agentDir, agentFileSuffix, validateSchemaContract } = runtimeSettings;
    const allAgents = [...new Set(Array.from({ length: 10 }, (_, i) => i).flatMap(p => getAgentsForPhase(p)))];
    const missing: string[] = [];
    const invalid: string[] = [];

    for (const agent of allAgents) {
      const agentPath = join(agentDir, `${agent}${agentFileSuffix}`);
      if (!(await fileExists(agentPath))) {
        missing.push(agentPath);
      }
    }

    if (missing.length > 0) {
      throw new Error(
        `Missing agent file(s) — migration cannot proceed:\n${missing.map(p => `  - ${p}`).join('\n')}`,
      );
    }

    if (validateSchemaContract) {
      const entries = await readdir(agentDir, { withFileTypes: true });
      const agentFiles = entries
        .filter(e => e.isFile() && e.name.endsWith(agentFileSuffix))
        .map(e => join(agentDir, e.name));

      for (const agentPath of agentFiles) {
        const content = await readFile(agentPath, 'utf-8');
        const contractError = this.validateSchemaContract(content);
        if (contractError) {
          invalid.push(`${agentPath}: ${contractError}`);
        }
      }
    }

    if (invalid.length > 0) {
      throw new Error(
        `Invalid agent schema contract(s) — each ${agentFileSuffix} file must define required input/output schemas:\n${invalid.map(p => `  - ${p}`).join('\n')}`,
      );
    }
  }

  private validateSchemaContract(content: string): string | undefined {
    const inputError = this.validateSchemaSection(content, 'Input Schema');
    if (inputError) return `Input Schema ${inputError}`;

    const outputError = this.validateSchemaSection(content, 'Output Schema');
    if (outputError) return `Output Schema ${outputError}`;

    return undefined;
  }

  private validateSchemaSection(content: string, sectionTitle: 'Input Schema' | 'Output Schema'): string | undefined {
    const headingRegex = new RegExp(`^##\\s+${sectionTitle}(?:\\s*\\(Required\\))?\\s*$`, 'im');
    const headingMatch = headingRegex.exec(content);
    if (!headingMatch || headingMatch.index === undefined) {
      return 'section is missing';
    }

    const afterHeading = content.slice(headingMatch.index + headingMatch[0].length);
    const nextHeadingIndex = afterHeading.search(/^##\s+/m);
    const sectionBody = nextHeadingIndex >= 0 ? afterHeading.slice(0, nextHeadingIndex) : afterHeading;

    const jsonBlockMatch = sectionBody.match(/```json\r?\n([\s\S]*?)```/m);
    if (!jsonBlockMatch) {
      return 'must include a JSON schema code block (```json ... ```)';
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonBlockMatch[1]!.trim());
    } catch (err) {
      return `contains invalid JSON (${err instanceof Error ? err.message : String(err)})`;
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return 'must be a JSON object schema';
    }

    const schema = parsed as { type?: unknown; required?: unknown };
    if (schema.type !== 'object') {
      return 'must declare "type": "object"';
    }

    if (!Array.isArray(schema.required) || schema.required.length === 0) {
      return 'must declare a non-empty "required" array';
    }

    if (!schema.required.every((k) => typeof k === 'string' && k.length > 0)) {
      return 'must declare "required" as an array of non-empty strings';
    }

    return undefined;
  }

  private setupShutdownHandlers(): void {
    this.disposeShutdownHandlers();
    this.shutdownInProgress = false;
    const handler = async (signal: string) => {
      if (this.shutdownInProgress) return;
      this.shutdownInProgress = true;
      this.logger.warn(`Received ${signal} — shutting down gracefully`);

      // Kill child processes FIRST — the orchestrator holds references to
      // the KB server (clangd LSP) and embedding provider (Python/PyTorch).
      // Without this, interrupted runs leave orphaned processes that each
      // consume 2-4 GB of RAM, leading to 60+ GB memory spikes when
      // multiple interrupted runs accumulate.
      //
      // Use a timeout so we don't hang if a child process is stuck
      // (e.g. Python mid-model-download).  After 5s, force-exit.
      const shutdownTimeout = setTimeout(() => {
        process.exit(signal === 'SIGINT' ? 130 : 143);
      }, 5_000);
      shutdownTimeout.unref(); // don't prevent exit

      try {
        this.abortController?.abort();
        await (this.dependencies.terminateActiveProcesses ?? killAllActiveProcesses)();
        if (this.activeFlowRun) {
          await Promise.race([
            this.activeFlowRun.then(() => undefined, () => undefined),
            new Promise<void>(resolve => setTimeout(resolve, 3_000)),
          ]);
        }
        await this.cleanupRuntimeResources(3_000);
      } catch {
        // Best-effort child process cleanup
      }
      try {
        await this.logger.flush();
        await this.checkpoint.save(this.checkpoint.getState());
        await this.progress.appendEvent(`Migration interrupted by ${signal}`);
      } catch {
        // Best-effort save
      }
      await this.releaseRunLock();
      this.disposeShutdownHandlers();
      clearTimeout(shutdownTimeout);
      process.exit(signal === 'SIGINT' ? 130 : 143);
    };

    const register = (event: NodeJS.Signals | 'exit', listener: (...args: any[]) => void): void => {
      process.on(event, listener);
      this.shutdownListeners.push({ event, listener });
    };
    register('SIGINT', () => void handler('SIGINT'));
    register('SIGTERM', () => void handler('SIGTERM'));
    register('SIGHUP', () => void handler('SIGHUP'));
    register('exit', () => {
      this.releaseRunLockSync();
    });
  }

  private disposeShutdownHandlers(): void {
    for (const { event, listener } of this.shutdownListeners) {
      process.off(event, listener);
    }
    this.shutdownListeners = [];
  }

  private async cleanupRuntimeResources(timeoutMs?: number): Promise<void> {
    if (this.resourcesCleaned || !this.flowContext) return;
    this.resourcesCleaned = true;
    const settle = async (operation: () => void | Promise<void>): Promise<void> => {
      try {
        if (timeoutMs === undefined) {
          await operation();
        } else {
          await Promise.race([
            Promise.resolve(operation()),
            new Promise<void>(resolve => setTimeout(resolve, timeoutMs)),
          ]);
        }
      } catch {
        // Cleanup is best-effort and continues in reverse acquisition order.
      }
    };

    const context = this.flowContext;

    // Agent/command processes must stop mutating files before servers or
    // embedders begin teardown.
    await settle(
      context.terminateActiveProcesses
        ?? this.dependencies.terminateActiveProcesses
        ?? killAllActiveProcesses,
    );

    const targetServer = context.targetKbServer;
    context.targetKbServer = undefined;
    if (targetServer) await settle(() => targetServer.stop());

    const sourceServer = context.kbServer;
    context.kbServer = undefined;
    if (sourceServer) await settle(() => sourceServer.stop());

    const embedder = context.embedder;
    context.embedder = undefined;
    if (embedder) await settle(() => embedder.dispose());

    const recoveredChangeSet = await context.targetChanges?.recoverPending().catch(() => undefined);
    if (recoveredChangeSet) {
      if (context.targetIndexer) await settle(() => context.targetIndexer!.invalidate());
      await settle(() => this.invalidateRecoveredChangeSet(recoveredChangeSet));
    }
  }

  private async invalidateRecoveredChangeSet(
    recovery: import('./target-change-set.js').TargetChangeRecovery,
  ): Promise<void> {
    const { scopeId } = recovery;
    if (scopeId.startsWith('phase-4-') || recovery.taskIds.length > 0) {
      await this.checkpoint.invalidatePhase4Tasks(recovery.taskIds, nodeIdToPhase);
      return;
    }
    const phase = scopeId.startsWith('phase-7-') ? 7
      : scopeId.startsWith('phase-6-') ? 6
        : scopeId.startsWith('phase-5-') ? 5
          : scopeId.startsWith('phase-4-') ? 4
            : scopeId.startsWith('phase-3-') ? 3
              : 4;
    await this.checkpoint.invalidateExecutionFromPhase(phase, nodeIdToPhase);
  }
}
