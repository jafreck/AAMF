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
import { generateAgentDefinitions } from '../agents/generator.js';
import { ContextBuilder } from '../agents/context-builder.js';
import { MetricsCollector } from '../observability/metrics-collector.js';
import { ReportGenerator } from '../observability/report-generator.js';
import { FlowRunner } from '@cadre-dev/framework/flow';
import { migrationFlow, AamfFlowCheckpointAdapter, buildFlowUpToPhase, nodeIdToPhase } from '../flow/index.js';
import { MigrationError } from '../flow/steps/shared.js';
import type { MigrationFlowContext } from '../flow/index.js';
import { getAgentsForPhase } from '../agents/registry.js';

export interface RuntimeOptions {
  configPath: string;
  resume?: boolean;
  dryRun?: boolean;
  phase?: number;   // run up to and including this phase
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
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

export class MigrationRuntime {
  private config!: MigrationConfig;
  private logger!: Logger;
  private checkpoint!: CheckpointManager;
  private progress!: ProgressWriter;
  private launcher!: AgentLauncher;
  private progressDir!: string;
  private paths!: ReturnType<typeof buildRuntimePaths>;
  private projectRoot!: string;
  private phase?: number;
  private runId!: string;
  /** Mutable flow context — populated during run(), used by shutdown handler. */
  private flowContext?: MigrationFlowContext;
  private abortController?: AbortController;

  private getActiveRuntimeSettings(): {
    agentDir: string;
    model?: string;
    agentFileSuffix: '.agent.md' | '.md';
    validateSchemaContract: boolean;
  } {
    if (this.config.agentBackend.runtime === 'claude-code') {
      return {
        agentDir: this.config.agentBackend.agentDir,
        model: this.config.agentBackend.model,
        agentFileSuffix: '.md',
        validateSchemaContract: false,
      };
    }

    return {
      agentDir: this.config.agentBackend.agentDir,
      model: this.config.agentBackend.model,
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

    // Fail fast if source tree or configured entry points are missing.
    await validateSourceAvailability(this.config);

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

    // 5. Create progress writer
    this.progress = new ProgressWriter(this.paths.progressReportFile, this.config.projectName);

    // 6. Create agent launcher
    this.launcher = new AgentLauncher(this.config, this.projectRoot, this.logger);
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

    // 9. Setup graceful shutdown
    this.setupShutdownHandlers();
  }

  async run(): Promise<MigrationResult> {
    // Load or create checkpoint. resume=false always forces a fresh start.
    await this.checkpoint.load(this.config.projectName, { fresh: !this.config.options.resume });

    // Initialize progress
    if (!this.config.options.resume) {
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

    const flowContext: MigrationFlowContext = {
      config: this.config,
      projectRoot: this.projectRoot,
      runId: this.runId,
      paths: this.paths,
      maxPhase: this.phase,
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
      peakConcurrency: 0,
      parityResults: new Map(),
      routedTaskIds: new Set(),
      escalationCostUsd: 0,
      deferGitCommits: false,
    };
    this.flowContext = flowContext;

    this.logger.event({ type: 'migration-started', projectName: this.config.projectName });
    await this.progress.appendEvent('Migration started');

    // Ensure git is ready before flow execution
    const { ensureGitRepositoryReady } = await import('../flow/steps/shared.js');
    await ensureGitRepositoryReady(flowContext);

    // Start KB server for resume if Phase 0 already completed
    const resumePoint = this.checkpoint.getResumePoint();
    if (resumePoint.phase > 0 && (await fileExists(this.paths.kbDbFile))) {
      await this.startKbServer(flowContext);
    }

    const startTime = Date.now();
    const phaseResults: PhaseResult[] = [];
    let aborted = false;

    // Select the flow definition — truncate if --phase was specified
    const flow = this.phase != null
      ? buildFlowUpToPhase(this.phase)
      : migrationFlow;
    if (this.phase != null) {
      this.logger.info(`Running phases 0–${this.phase} (--phase ${this.phase})`);
    }

    // Run the flow
    this.abortController = new AbortController();
    const checkpointAdapter = new AamfFlowCheckpointAdapter(this.checkpoint);
    const runner = new FlowRunner<MigrationFlowContext>();

    try {
      // FlowRunnerOptions in @cadre-dev/framework@0.1.0 lacks hooks/signal.
      // These properties exist in the runtime implementation; cast until 0.2.0.
      const runnerOptions: Record<string, unknown> = {
        checkpoint: checkpointAdapter,
        signal: this.abortController.signal,
        hooks: {
          onNodeStart: async (nodeId: string) => {
            this.logger.setPhase(nodeIdToPhase(nodeId));
          },
          onNodeComplete: async (nodeId: string, _node: unknown, output: unknown) => {
            const phaseResult = output as PhaseResult | undefined;
            if (phaseResult && typeof phaseResult === 'object' && 'phase' in phaseResult) {
              phaseResults.push(phaseResult);

              // Start KB server after Phase 0
              if (phaseResult.phase === 0 && phaseResult.success && !flowContext.kbServer) {
                await this.startKbServer(flowContext);
              }

              // All phases are critical — success is asserted inside the step.
              // If we reach onNodeComplete, the step succeeded.
              await this.checkpoint.completePhase(phaseResult.phase, phaseResult.outputPath ?? '');
              await this.progress.updatePhase(phaseResult.phase, 'completed');
              this.logger.event({ type: 'phase-completed', phase: phaseResult.phase, name: phaseResult.name, success: true, duration: phaseResult.duration });

              // Token usage sync
              this.progress.setTokenUsage(tokenTracker.toCheckpointData());
            }
          },
          onNodeSkip: async (nodeId: string) => {
            this.logger.info(`Flow node skipped (checkpoint resume): ${nodeId}`);
          },
        },
      };

      const flowResult = await runner.run(flow, flowContext, runnerOptions as any);

      // Status may be 'failed', 'cancelled', or 'timed-out' in newer framework versions
      const status = flowResult.status as string;
      aborted = status === 'failed' || status === 'cancelled' || status === 'timed-out';
    } catch (err) {
      // Record the failed phase result if this was a MigrationError
      if (err instanceof MigrationError) {
        const failedResult = err.result;
        phaseResults.push(failedResult);
        const truncatedStderr = failedResult.stderr ? failedResult.stderr.slice(0, 2000) : undefined;
        await this.progress.updatePhase(failedResult.phase, 'failed', failedResult.error, failedResult.exitCode, truncatedStderr);
        this.logger.event({ type: 'phase-failed', phase: failedResult.phase, name: failedResult.name, error: failedResult.error ?? 'unknown', exitCode: failedResult.exitCode, stderr: truncatedStderr });
        await this.progress.appendEvent(`Migration aborted: Phase ${failedResult.phase} (${failedResult.name}) failed`);
      } else {
        this.logger.error(`Flow execution failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      aborted = true;
    } finally {
      // Always clean up
      if (flowContext.kbServer) {
        try { await flowContext.kbServer.stop(); this.logger.info('KB server stopped'); } catch { /* ignore */ }
        flowContext.kbServer = undefined;
      }
      if (flowContext.embedder) {
        try { await flowContext.embedder.dispose(); } catch { /* ignore */ }
        flowContext.embedder = undefined;
      }
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
      success: !aborted && phaseResults.every(r => r.success),
      projectName: this.config.projectName,
      phases: phaseResults,
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

    this.flowContext = undefined;
    this.abortController = undefined;
    await this.logger.flush();
    this.printSummary(migrationResult);
    return migrationResult;
  }

  async getStatus(): Promise<string> {
    const state = await this.checkpoint.load(this.config.projectName);
    // Format status from checkpoint state
    let status = `\nProject: ${state.projectName}\n`;
    status += `Phase: ${state.currentPhase}/7\n`;
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
    // Implementation: if fromPhase specified, reset that phase and later.
    // Otherwise reset everything.
    const state = await this.checkpoint.load(this.config.projectName);
    if (fromPhase) {
      state.completedPhases = state.completedPhases.filter(p => p < fromPhase);
      state.currentPhase = fromPhase;
      state.currentTask = null;
      // Remove phase outputs for reset phases
      for (let p = fromPhase; p <= 7; p++) {
        delete state.phaseOutputs[p];
      }
      this.logger.info(`Reset migration from Phase ${fromPhase} onward`);
    } else {
      state.currentPhase = 1;
      state.currentTask = null;
      state.completedPhases = [];
      state.completedTasks = [];
      state.failedTasks = [];
      state.blockedTasks = [];
      state.phaseOutputs = {};
      state.tokenUsage = { total: 0, byPhase: {}, byAgent: {} };
      this.logger.info('Reset all migration state');
    }
    await this.checkpoint.save(state);
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
    const handler = async (signal: string) => {
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
        if (this.flowContext) {
          const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T | void> =>
            Promise.race([p, new Promise<void>(r => setTimeout(r, ms))]);
          if (this.flowContext.kbServer) {
            await withTimeout(this.flowContext.kbServer.stop(), 3_000);
            this.flowContext.kbServer = undefined;
          }
          if (this.flowContext.embedder) {
            try { await withTimeout(this.flowContext.embedder.dispose(), 3_000); } catch { /* ignore */ }
            this.flowContext.embedder = undefined;
          }
        }
        // Signal the flow runner to cancel
        if (this.abortController) {
          this.abortController.abort();
        }
      } catch {
        // Best-effort child process cleanup
      }
      // Kill any in-flight agent processes spawned via spawnWithTimeout.
      // These are detached (own process group) so they survive parent exit
      // unless explicitly killed.
      try {
        await killAllActiveProcesses();
      } catch {
        // Best-effort
      }
      try {
        await this.logger.flush();
        await this.checkpoint.save(this.checkpoint.getState());
        await this.progress.appendEvent(`Migration interrupted by ${signal}`);
      } catch {
        // Best-effort save
      }
      clearTimeout(shutdownTimeout);
      process.exit(signal === 'SIGINT' ? 130 : 143);
    };
    
    process.on('SIGINT', () => void handler('SIGINT'));
    process.on('SIGTERM', () => void handler('SIGTERM'));
  }

  /**
   * Start the KB MCP server, attaching it to the given flow context.
   * Used both on resume (before flow starts) and after Phase 0 completes.
   */
  private async startKbServer(flowContext: MigrationFlowContext): Promise<void> {
    try {
      const { KbServerProcess } = await import('./kb-server-process.js');
      const lore = await import('@jafreck/lore');
      const loreLogLevel = this.config.options.kbIndex?.logLevel ?? 'debug';
      flowContext.kbServer = new KbServerProcess(this.paths.kbDbFile, flowContext.embedder, (obs) => {
        this.logger.debug(
          `lore_search: query=${JSON.stringify(obs.query)} mode=${obs.requestedMode}→${obs.modeUsed} results=${obs.resultCount} topScore=${obs.topScore} latency=${obs.latencyMs}ms`,
        );
      }, {
        level: lore.LOG_LEVEL_NAMES[loreLogLevel] ?? lore.LogLevel.DEBUG,
        logFile: this.paths.loreLogFile,
      });
      await flowContext.kbServer.start();
      this.logger.info(`KB server started (lore log: ${this.paths.loreLogFile})`);
    } catch (err) {
      this.logger.warn(`KB server failed to start: ${err instanceof Error ? err.message : String(err)}`);
      flowContext.kbServer = undefined;
    }
  }
}
