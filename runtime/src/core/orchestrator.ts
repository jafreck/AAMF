import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { readdir, readFile, unlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import pLimit from 'p-limit';
import { PHASES, PhaseDefinition } from './phase-registry.js';
import { CheckpointManager } from './checkpoint.js';
import { AgentLauncher } from './agent-launcher.js';
import { ProgressWriter } from './progress.js';
import {
  AgentInvocation,
  AgentResult,
  AgentName,
  MigrationResult,
  MigrationTask,
  CompilationUnit,
  PhaseResult,
  RoutingDecision,
  ModelTier,
  RemediationContext,
  toAgentRemediationContext,
  TerminalReasonCode,
  E2eSuiteBrief,
} from '../agents/types.js';
import { ContextBuilder } from '../agents/context-builder.js';
import { parseMigrationPlan, parseE2eTestPlan } from '../agents/plan-parser.js';
import { MigrationConfig } from '../config/schema.js';
import { ParallelExecutor } from '../execution/parallel-executor.js';
import { TaskQueue } from '../execution/task-queue.js';
import { RetryExecutor } from '../execution/retry.js';
import { TokenTracker } from '../budget/token-tracker.js';
import { CostEstimator } from '../budget/cost-estimator.js';
import { Logger } from '../logging/logger.js';
import { fileExists, countFileLines, atomicWrite, readJson, ensureDir } from '../util/fs.js';
import { spawnWithTimeout } from '../util/process.js';
import { gitignoreForLanguage } from '../util/gitignore-templates.js';
import type { EmbeddingProvider } from '@aamf/lore';
import type { KbServerProcess } from './kb-server-process.js';
import { MetricsCollector } from '../observability/metrics-collector.js';
import type { Phase4MetricsSnapshot } from '../observability/metrics-collector.js';
import { ReportGenerator } from '../observability/report-generator.js';
import type { InvocationMetric } from '../agents/types.js';
import { buildRuntimePaths } from './runtime-paths.js';
import { buildTaskGraph, buildDependencySummary, findSCCs } from './task-graph-builder.js';

const loadLore = () => import('@aamf/lore');
const loadKbServerProcess = () => import('./kb-server-process.js');

/** Hardcoded average token estimate per migration task for cost projections. */
const AVG_TOKENS_PER_TASK = 100_000;
/** Hardcoded retry-overhead multiplier for aggregate Phase 5 cost projections. */
const RETRY_OVERHEAD_MULTIPLIER = 1.25;

type LoreModule = Awaited<ReturnType<typeof loadLore>>;

function computeSourceFingerprintCompat(
  lore: LoreModule,
  rootDir: string,
  walkerConfig: { includeGlobs?: string[]; excludeGlobs?: string[] },
  embeddingModel?: string,
): string {
  const computeSourceFingerprint = (lore as { computeSourceFingerprint?: (...args: any[]) => string }).computeSourceFingerprint;
  if (typeof computeSourceFingerprint === 'function') {
    return computeSourceFingerprint(rootDir, walkerConfig, embeddingModel);
  }

  const data = JSON.stringify({
    rootDir,
    includeGlobs: walkerConfig.includeGlobs ?? [],
    excludeGlobs: walkerConfig.excludeGlobs ?? [],
    embeddingModel: embeddingModel ?? '',
  });
  return createHash('sha256').update(data).digest('hex');
}

function getKbFingerprintCompat(lore: LoreModule, db: unknown): string | undefined {
  // Prefer getLoreMeta (>=0.2.4), fall back to getKbFingerprint / getKbMeta.
  const getLoreMeta = (lore as { getLoreMeta?: (db: unknown, key: string) => string | undefined }).getLoreMeta;
  if (typeof getLoreMeta === 'function') {
    return getLoreMeta(db, 'source_fingerprint');
  }
  const getKbFingerprint = (lore as { getKbFingerprint?: (...args: any[]) => string | undefined }).getKbFingerprint;
  if (typeof getKbFingerprint === 'function') {
    return getKbFingerprint(db);
  }
  const getKbMeta = (lore as { getKbMeta?: (...args: any[]) => string | undefined }).getKbMeta;
  if (typeof getKbMeta === 'function') {
    return getKbMeta(db, 'source_fingerprint');
  }
  return undefined;
}

// ─── Infrastructure Error Detection ──────────────────────────────────────────

/**
 * Language/build-system-agnostic patterns that indicate a transient
 * infrastructure failure rather than a code-quality problem.
 *
 * These errors should be retried with simple backoff — they don't benefit
 * from the expensive parity-failure-resolver agent pipeline.
 */
const INFRASTRUCTURE_ERROR_PATTERNS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  // File lock contention (Cargo, NuGet, Gradle, pip, npm, generic)
  { pattern: /blocking waiting for file lock/i, label: 'file-lock' },
  { pattern: /could not acquire lock/i, label: 'file-lock' },
  { pattern: /lock file .* is locked/i, label: 'file-lock' },
  { pattern: /ELOCK|ELOCKED/i, label: 'file-lock' },
  // Process killed / out of memory
  { pattern: /signal:\s*killed|SIGKILL|killed by signal 9/i, label: 'process-killed' },
  { pattern: /out of memory|OOM|Cannot allocate memory/i, label: 'oom' },
  // Disk / filesystem errors
  { pattern: /no space left on device|ENOSPC/i, label: 'disk-full' },
  { pattern: /read-only file system|EROFS/i, label: 'fs-readonly' },
  // Network / download errors (package registries)
  { pattern: /network error|connection (refused|reset|timed out)/i, label: 'network' },
  { pattern: /could not resolve host|DNS resolution failed/i, label: 'network' },
  { pattern: /failed to download|registry .* unavailable/i, label: 'network' },
  // Model/API transport failures
  { pattern: /HTTP\/2 GOAWAY|connection_error|\b503\b|service unavailable/i, label: 'network' },
  // Timeout
  { pattern: /timed? ?out|deadline exceeded/i, label: 'timeout' },
  // Permission errors (typically environment misconfiguration)
  { pattern: /permission denied|EACCES/i, label: 'permission' },
];

/**
 * Check whether an error string matches known infrastructure failure patterns.
 * Returns the label of the matched pattern, or `undefined` for code-quality errors.
 */
export function classifyError(errorOutput: string): string | undefined {
  for (const { pattern, label } of INFRASTRUCTURE_ERROR_PATTERNS) {
    if (pattern.test(errorOutput)) return label;
  }
  return undefined;
}

import { formatDuration } from '../util/format.js';

type QualityGateMode = 'enforce' | 'advisory' | 'skip';

/** Parity result data extracted from parity-verifier aamf-json output. */
interface ParityResultData {
  parity: 'pass' | 'partial' | 'fail';
  issues: Array<{
    severity: 'critical' | 'major' | 'minor';
    description: string;
    details: string;
    sourceLocation: string;
    targetLocation?: string;
  }>;
}

interface RetryTargetDetails {
  scope: 'task' | 'parity' | 'command' | 'wave';
  attempt: number;
  maxAttempts: number;
  taskId?: string;
  wave?: number;
  check?: string;
  summary: string;
}

interface TerminalExhaustionDetails {
  reasonCode: TerminalReasonCode;
  taskId?: string;
  wave?: number;
  check?: string;
  summary: string;
}

type CommandExecutionResult = {
  success: boolean;
  error?: string;
  infraError?: string;
  rawError?: string;
  logPath?: string;
};

interface WaveValidationResult {
  success: boolean;
  failedLabel?: 'build' | 'test';
  failedCommand?: string;
  failure?: CommandExecutionResult;
}

class TerminalExhaustionError extends Error {
  constructor(public readonly details: TerminalExhaustionDetails) {
    const locationParts = [
      details.taskId ? `task=${details.taskId}` : undefined,
      details.wave !== undefined ? `wave=${details.wave}` : undefined,
      details.check ? `check=${details.check}` : undefined,
    ].filter((part): part is string => !!part);
    const location = locationParts.length > 0 ? ` (${locationParts.join(', ')})` : '';
    super(`Phase 5 terminal exhaustion: ${details.reasonCode}${location} - ${details.summary}`);
    this.name = 'TerminalExhaustionError';
  }
}

/** Error thrown when a critical phase fails. */
export class MigrationError extends Error {
  constructor(
    public readonly phase: PhaseDefinition,
    public readonly result: PhaseResult,
  ) {
    super(`Phase ${phase.id} (${phase.name}) failed: ${result.error ?? 'unknown error'}`);
    this.name = 'MigrationError';
  }
}

/** Default timeout for the KB indexing phase when no phaseTimeouts[0] is configured (5 minutes). */
const DEFAULT_INDEX_TIMEOUT_MS = 5 * 60_000;

/**
 * The main orchestrator that sequences all 10 migration phases (0–9).
 *
 * Phases 0–1 are deterministic (KB indexing + task graph construction).
 * Phases 2–9 are agentic (impact assessment through completion).
 */
export class MigrationOrchestrator {
  private readonly contextBuilder: ContextBuilder;
  private readonly tokenTracker: TokenTracker;
  private readonly progressDir: string;
  private readonly projectRoot: string;
  private readonly singlePhase?: number;
  private readonly kbDbPath: string;
  private kbServer?: KbServerProcess;
  /** Live embedding provider created during Phase 0 and disposed on shutdown. */
  private embedder?: EmbeddingProvider;
  /** Stores the task graph result from Phase 1 for Phase 5 to consume. */
  private phase1TaskGraphResult?: AgentResult;
  /**
   * Semaphore that limits concurrent build/test command executions.
   * Separate from `maxParallelAgents` so that agent code-generation can
   * proceed in full parallel while verification commands that share a
   * build artifact directory (Cargo target/, .NET bin/, Go cache, etc.)
   * are serialised to avoid file-lock contention.
   */
  private readonly buildLimiter: ReturnType<typeof pLimit>;
  /** Serializes git mutations to keep commits deterministic. */
  private readonly gitLimiter: ReturnType<typeof pLimit>;
  private readonly metricsCollector: MetricsCollector;
  private readonly costEstimatorInstance: CostEstimator;
  private readonly reportGenerator: ReportGenerator;
  private readonly runId: string;
  private readonly paths: ReturnType<typeof buildRuntimePaths>;
  /** Tracks the maximum concurrency observed across all ParallelExecutor instances. */
  private _peakConcurrency = 0;
  /** In-memory cache of parity-verifier results parsed from aamf-json output. */
  private readonly _parityResults = new Map<string, ParityResultData>();
  /** Unique task IDs that have consumed routed-task budget (heavy/critical). */
  private readonly _routedTaskIds = new Set<string>();
  /** Cumulative projected escalation cost (USD) for this run. */
  private _escalationCostUsd = 0;
  /** Phase 5 observability counters (set while Phase 5 is active). */
  private phase5Snapshot?: Phase4MetricsSnapshot;
  /**
   * When true, per-task/per-agent git commits inside `executeTask` are
   * suppressed.  The wave-barrier loop performs a single commit per wave
   * after convergence succeeds instead.
   */
  private _deferGitCommits = false;

  private getConfiguredRuntimeModel(): string {
    return this.config.agentBackend.model ?? 'claude-sonnet-4';
  }

  private getRuntimeTimeout(): number {
    return this.config.agentBackend.timeout;
  }

  private getPhaseTimeout(phase: number): number {
    return this.config.agentBackend.phaseTimeouts?.[phase] ?? this.getRuntimeTimeout();
  }

  constructor(
    private readonly config: MigrationConfig,
    private readonly checkpoint: CheckpointManager,
    private readonly launcher: AgentLauncher,
    private readonly progress: ProgressWriter,
    private readonly logger: Logger,
    projectRoot: string,
    runId: string,
    singlePhase?: number,
  ) {
    this.projectRoot = projectRoot;
    this.paths = buildRuntimePaths(projectRoot, config.projectName);
    this.progressDir = this.paths.root;
    this.contextBuilder = new ContextBuilder(config, this.progressDir, this.paths);
    this.tokenTracker = new TokenTracker();
    this.singlePhase = singlePhase;
    this.kbDbPath = this.paths.kbDbFile;

    const bc = config.options.buildConcurrency ?? 1;
    // 0 means unlimited → use maxParallelAgents
    this.buildLimiter = pLimit(bc === 0 ? config.options.maxParallelAgents : bc);
    this.gitLimiter = pLimit(1);
    this.metricsCollector = new MetricsCollector();
    const overrides = undefined; // costOverrides removed from config
    this.costEstimatorInstance = new CostEstimator(overrides);
    this.reportGenerator = new ReportGenerator();
    this.runId = runId;
  }

  // ─── Public API ──────────────────────────────────────────────────────

  async run(): Promise<MigrationResult> {
    const startTime = Date.now();
    const state = this.checkpoint.getState();
    const resumePoint = this.checkpoint.getResumePoint();

    // Restore token usage from checkpoint
    this.tokenTracker.loadFromCheckpoint(state.tokenUsage);

    // Restore metrics from JSONL if resuming
    if (state.resumeCount > 0) {
      await this.metricsCollector.loadFromJsonl(this.progressDir, state.metricsCount ?? 0);
    }

    this.logger.event({ type: 'migration-started', projectName: this.config.projectName });
    await this.progress.appendEvent('Migration started');

    await this.ensureGitRepositoryReady();

    const phaseResults: PhaseResult[] = [];
    let aborted = false;

    // Determine which phases to execute
    const phasesToRun = this.singlePhase != null
      ? PHASES.filter(p => p.id === this.singlePhase)
      : PHASES;

    if (this.singlePhase != null) {
      this.logger.info(`Running single phase: ${this.singlePhase}`);
    }

    const phase0InSelection = phasesToRun.some((p) => p.id === 0);

    // If this invocation won't execute Phase 0 (for example: resume from later
    // checkpoint or running a later single phase), but a previously built
    // kb.db exists, start the KB server up-front so downstream phases/agents
    // retain KB access.
    const phase0SkippedByResume =
      this.singlePhase == null &&
      phase0InSelection &&
      resumePoint.phase > 0;

    if (phase0SkippedByResume || !phase0InSelection) {
      if (await fileExists(this.kbDbPath)) {
        await this.startKbServer();
      } else if (!phase0InSelection) {
        this.logger.warn(
          `${this.kbDbPath} is missing and Phase 0 is not in the run selection. ` +
          'Run Phase 0 first to build the KB.',
        );
      }
    }

    try {
      for (const phase of phasesToRun) {

        // Skip optional phases that are not enabled
        if (phase.optional && phase.id === 8 && !this.config.options.idiomaticRefactor?.enabled) {
          this.logger.info(`Skipping optional Phase 8 (idiomaticRefactor not enabled)`);
          phaseResults.push({
            phase: phase.id,
            name: phase.name,
            success: true,
            outputPath: undefined,
            duration: 0,
          });
          continue;
        }

        // Skip already-completed phases on resume (but not when explicitly
        // requesting a single phase via --phase).  Phase 0 (KB Indexing)
        // always re-runs to ensure the KB is up to date.
        if (
          this.singlePhase == null &&
          phase.id < resumePoint.phase &&
          phase.id !== 0
        ) {
          phaseResults.push({
            phase: phase.id,
            name: phase.name,
            success: true,
            outputPath: state.phaseOutputs[phase.id],
            duration: 0,
          });
          continue;
        }

        await this.progress.updatePhase(phase.id, 'in-progress');
        this.logger.event({ type: 'phase-started', phase: phase.id, name: phase.name });
        this.logger.setPhase(phase.id);

        const phaseStart = Date.now();
        let result: PhaseResult;

        try {
          result = await this.executePhase(phase);
        } catch (err) {
          result = {
            phase: phase.id,
            name: phase.name,
            success: false,
            duration: Date.now() - phaseStart,
            error: err instanceof Error ? err.message : String(err),
          };
        }

        phaseResults.push(result);

        // After Phase 0 completes, start the KB server so agents in subsequent phases can use it
        if (phase.id === 0 && result.success) {
          await this.startKbServer();
        }

        if (result.success) {
          await this.checkpoint.completePhase(phase.id, result.outputPath ?? '');
          await this.progress.updatePhase(phase.id, 'completed');
          this.logger.event({
            type: 'phase-completed',
            phase: phase.id,
            name: phase.name,
            success: true,
            duration: result.duration,
          });
        } else {
          const truncatedStderr = result.stderr ? result.stderr.slice(0, 2000) : undefined;
          await this.progress.updatePhase(phase.id, 'failed', result.error, result.exitCode, truncatedStderr);
          this.logger.event({
            type: 'phase-failed',
            phase: phase.id,
            name: phase.name,
            error: result.error ?? 'unknown',
            exitCode: result.exitCode,
            stderr: truncatedStderr,
          });

          if (phase.critical) {
            aborted = true;
            await this.progress.appendEvent(`Migration aborted: Phase ${phase.id} failed`);
            break;
          }
        }

        // Budget check
        if (this.config.options.tokenBudget) {
          const threshold = this.tokenTracker.checkThreshold(this.config.options.tokenBudget);
          if (threshold === 'exceeded') {
            this.logger.event({
              type: 'budget-exceeded',
              usage: this.tokenTracker.getTotal(),
              budget: this.config.options.tokenBudget,
            });
            await this.progress.appendEvent('Token budget exceeded — pausing migration');
            aborted = true;
            break;
          }
          if (threshold === 'warning') {
            const pct = Math.round(
              (this.tokenTracker.getTotal() / this.config.options.tokenBudget) * 100,
            );
            this.logger.event({
              type: 'budget-warning',
              usage: this.tokenTracker.getTotal(),
              budget: this.config.options.tokenBudget,
              percentage: pct,
            });
          }
        }

        this.progress.setTokenUsage(this.tokenTracker.toCheckpointData());
      }
    } finally {
      // Always stop the KB server and dispose the embedder, whether migration succeeded, failed, or was aborted
      await this.stopKbServer();
      if (this.embedder) {
        try { await this.embedder.dispose(); } catch { /* ignore */ }
        this.embedder = undefined;
      }
    }

    const totalDuration = Date.now() - startTime;
    const finalState = this.checkpoint.getState();

    // Accumulate cumulativeDurationMs across all resume runs
    const cumulativeDurationMs = (finalState.cumulativeDurationMs ?? 0) + totalDuration;
    finalState.cumulativeDurationMs = cumulativeDurationMs;
    await this.checkpoint.save(finalState);

    // Invariant: completed tasks must not appear in failed or blocked lists.
    // Filter out stale entries that survived prior checkpoint writes.
    const completedSet = new Set(finalState.completedTasks);
    const filteredFailed = finalState.failedTasks.filter((f) => !completedSet.has(f.taskId));
    const filteredBlocked = finalState.blockedTasks.filter((id) => !completedSet.has(id));
    const staleCount =
      (finalState.failedTasks.length - filteredFailed.length) +
      (finalState.blockedTasks.length - filteredBlocked.length);
    if (staleCount > 0) {
      this.logger.warn(
        `Removed ${staleCount} stale entries from failedTasks/blockedTasks that were already in completedTasks`,
      );
    }

    const migrationResult: MigrationResult = {
      success: !aborted && phaseResults.every((r) => r.success),
      projectName: this.config.projectName,
      phases: phaseResults,
      totalDuration,
      cumulativeDuration: cumulativeDurationMs,
      tokenUsage: this.tokenTracker.toCheckpointData(),
      failedTasks: filteredFailed.map((f) => f.taskId),
      blockedTasks: filteredBlocked,
    };

    this.logger.event({
      type: 'migration-completed',
      projectName: this.config.projectName,
      success: migrationResult.success,
      duration: totalDuration,
    });
    this.progress.setCumulativeDuration(cumulativeDurationMs);
    await this.progress.finalize(migrationResult);

    // Write observability metrics summary and report
    try {
      await this.metricsCollector.writeSummary(this.progressDir, this._peakConcurrency);
      const metricsDir = this.paths.metricsDir;
      const reportDir = this.paths.reportsObservabilityDir;
      const aggregates = this.metricsCollector.getAggregates(this._peakConcurrency);
      await this.reportGenerator.generate(
        metricsDir,
        reportDir,
        this.metricsCollector.getMetrics(),
        aggregates,
      );
    } catch (err) {
      this.logger.warn(`Failed to write observability report: ${err instanceof Error ? err.message : String(err)}`);
    }

    return migrationResult;
  }

  // ─── Phase Router ────────────────────────────────────────────────────

  private async executePhase(phase: PhaseDefinition): Promise<PhaseResult> {
    const start = Date.now();
    switch (phase.id) {
      case 0:
        return this.executePhase0(start);
      case 1:
        return this.executePhase1(start);
      case 2:
        return this.executePhase2(start);
      case 3:
        return this.executePhase3(start);
      case 4:
        return this.executePhase4(start);
      case 5:
        return this.executePhase5(start);
      case 6:
        return this.executePhase6(start);
      case 7:
        return this.executePhase7(start);
      case 8:
        return this.executePhase8(start);
      case 9:
        return this.executePhase9(start);
      default:
        throw new Error(`Unknown phase: ${phase.id}`);
    }
  }

  // ─── Phase 0: KB Indexing ─────────────────────────────────────────────

  /**
   * Execute Phase 0: build the local knowledge-base SQLite index from the
   * source directory. Wraps the build in retry logic and a timeout.
   */
  async executePhase0(start: number = Date.now()): Promise<PhaseResult> {
    const sourceRoot = resolve(this.projectRoot, this.config.source.path);
    this.logger.info(`Building KB index at ${this.kbDbPath} (source: ${sourceRoot})`);
    const lore = await loadLore();

    // ── Fingerprint guard: skip re-indexing if the KB already matches ──
    // Perform this check BEFORE the expensive embedding initialisation so
    // that resume runs that already have a valid KB exit in milliseconds
    // rather than spending time loading Python / ML models.
    const embCfg = this.config.options.kbIndex?.embeddings;
    const embeddingModelName = embCfg?.enabled
      ? (embCfg.model ?? 'Qwen/Qwen3-Embedding-0.6B')
      : undefined;
    const walkerConfig = { rootDir: sourceRoot };
    const currentFingerprint = computeSourceFingerprintCompat(
      lore,
      sourceRoot,
      walkerConfig as { includeGlobs?: string[]; excludeGlobs?: string[] },
      embeddingModelName,
    );
    if (await fileExists(this.kbDbPath)) {
      try {
        const db = lore.openDb(this.kbDbPath);
        try {
          const storedFingerprint = getKbFingerprintCompat(lore, db);
          if (storedFingerprint && storedFingerprint === currentFingerprint) {
            this.logger.info('Phase 0 reused/skipped — KB fingerprint matches current config');
            const checkpointState = this.checkpoint.getState();
            checkpointState.phase0Fingerprint = currentFingerprint;
            await this.checkpoint.save(checkpointState);
            return {
              phase: 0,
              name: 'KB Indexing',
              success: true,
              outputPath: this.kbDbPath,
              duration: Date.now() - start,
            };
          }
        } finally {
          db.close();
        }
      } catch {
        // DB exists but unreadable/corrupt — fall through to rebuild
      }
    }

    this.logger.info('Phase 0 rebuilt — source fingerprint changed or no existing KB');

    // Optionally set up the embedding provider for semantic search.
    // Only initialised when we actually need to rebuild the index.
    if (embCfg?.enabled) {
      const pythonBin = embCfg.pythonBin ?? 'python3';
      const model = embeddingModelName!;
      this.logger.info(`Embeddings enabled — ensuring Python deps (python: ${pythonBin}, model: ${model})`);
      try {
        await lore.ensurePythonDeps(pythonBin);
      } catch (err) {
        this.logger.warn(
          `Failed to install Python embedding deps — embeddings will be skipped: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      this.embedder = new lore.SentenceTransformersProvider(model, pythonBin);
      try {
        await this.embedder.init();
        this.logger.info(`Embedding model loaded — dims: ${this.embedder.dims}`);
      } catch (err) {
        this.logger.warn(
          `Failed to initialise embedding model — embeddings will be skipped: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        try { await this.embedder.dispose(); } catch { /* ignore */ }
        this.embedder = undefined;
      }
    }

    // Build LSP settings from config if enabled
    const lspConfig = this.config.options.kbIndex?.lsp;
    const lspSettings = lspConfig?.enabled ? {
      enabled: true as const,
      requestTimeoutMs: lspConfig.requestTimeoutMs ?? 5000,
      servers: lspConfig.servers
        ? Object.fromEntries(
            Object.entries(lspConfig.servers).map(([lang, srv]) => [
              lang, { command: srv.command, args: srv.args ?? [] },
            ]),
          )
        : {},
    } : undefined;

    if (lspSettings) {
      this.logger.info(
        `LSP integration enabled (timeout: ${lspSettings.requestTimeoutMs}ms` +
        (Object.keys(lspSettings.servers).length > 0
          ? `, servers: ${Object.keys(lspSettings.servers).join(', ')}`
          : '') + ')',
      );

      // Pre-flight: validate LSP server commands are available
      for (const [lang, srv] of Object.entries(lspSettings.servers)) {
        try {
          execFileSync('which', [srv.command], { stdio: 'pipe' });
        } catch {
          this.logger.warn(
            `LSP server '${srv.command}' for language '${lang}' was not found on PATH — ` +
            `LSP enrichment for ${lang} will fail. Install it or set lsp.enabled=false.`,
          );
        }
      }
    }

    // Initialise the Lore-internal logger so the index build writes progress
    // (walk, LSP enrichment, embedding, final stats) to lore.log.
    const loreLogLevel = this.config.options.kbIndex?.logLevel ?? 'debug';
    lore.initLogger({
      level: lore.LOG_LEVEL_NAMES[loreLogLevel] ?? lore.LogLevel.DEBUG,
      logFile: this.paths.loreLogFile,
    });

    const builder = new lore.IndexBuilder(
      this.kbDbPath, walkerConfig, this.embedder,
      { lsp: lspSettings },
    );

    const maxAttempts = this.config.options.maxRetriesPerTask;
    const timeout =
      this.config.agentBackend.phaseTimeouts?.[0] ??
      DEFAULT_INDEX_TIMEOUT_MS;

    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Remove the stale DB before each attempt.  vec0 virtual tables
      // (symbol_embeddings) do not support INSERT OR REPLACE — inserting a
      // duplicate rowid raises a UNIQUE constraint error.  Deleting the file is
      // the simplest guarantee that each attempt starts from a clean slate.
      if (await fileExists(this.kbDbPath)) {
        try {
          await unlink(this.kbDbPath);
          // Also remove WAL / SHM sidecar files if present.
          await unlink(this.kbDbPath + '-wal').catch(() => {});
          await unlink(this.kbDbPath + '-shm').catch(() => {});
          this.logger.info('Removed stale KB database before rebuild');
        } catch (err) {
          this.logger.warn(
            `Failed to remove stale KB database: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // Progress heartbeat — warn when the build is taking long so it's
      // clear the process hasn't crashed, and hint at what may be blocking.
      const heartbeatTimers: ReturnType<typeof setTimeout>[] = [];
      const halfTimeout = Math.round(timeout / 2);
      heartbeatTimers.push(
        setTimeout(() => {
          this.logger.warn(
            `KB index build still running after ${Math.round(halfTimeout / 1000)}s ` +
            `(timeout: ${Math.round(timeout / 1000)}s)` +
            (lspSettings ? ' — the LSP server may still be indexing the project. ' +
              'Consider increasing phaseTimeouts[0] or disabling LSP (lsp.enabled=false) to use tree-sitter only.'
              : ''),
          );
        }, halfTimeout),
      );
      const clearHeartbeat = () => heartbeatTimers.forEach(t => clearTimeout(t));

      try {
        await Promise.race([
          builder.build().finally(clearHeartbeat),
          new Promise<never>((_, reject) =>
            setTimeout(() => {
              clearHeartbeat();
              const msg = lspSettings
                ? `KB index timed out after ${Math.round(timeout / 1000)}s — the LSP server may be stalled. ` +
                  `Verify the LSP server can index the project, increase phaseTimeouts[0], ` +
                  `or set lsp.enabled=false to fall back to tree-sitter-only indexing.`
                : `KB index timed out after ${Math.round(timeout / 1000)}s`;
              reject(new Error(msg));
            }, timeout),
          ),
        ]);
        const checkpointState = this.checkpoint.getState();
        checkpointState.phase0Fingerprint = currentFingerprint;
        await this.checkpoint.save(checkpointState);
        return {
          phase: 0,
          name: 'KB Indexing',
          success: true,
          outputPath: this.kbDbPath,
          duration: Date.now() - start,
        };
      } catch (err) {
        lastErr = err;
        if (attempt < maxAttempts) {
          this.logger.warn(`KB index attempt ${attempt} failed, retrying: ${err instanceof Error ? err.message : String(err)}`);
          await new Promise(r => setTimeout(r, 1_000 * attempt));
        }
      }
    }

    return {
      phase: 0,
      name: 'KB Indexing',
      success: false,
      duration: Date.now() - start,
      error: lastErr instanceof Error ? lastErr.message : String(lastErr),
    };
  }

  // ─── KB Server Lifecycle ──────────────────────────────────────────────

  /** Start the KB MCP server (HTTP transport). */
  private async startKbServer(): Promise<void> {
    const { KbServerProcess } = await loadKbServerProcess();
    const lore = await loadLore();

    // Build Lore-internal logger options from config (defaults to debug).
    const loreLogLevel = this.config.options.kbIndex?.logLevel ?? 'debug';
    const loreLoggerOpts: import('@aamf/lore').LoreLoggerOptions = {
      level: lore.LOG_LEVEL_NAMES[loreLogLevel] ?? lore.LogLevel.DEBUG,
      logFile: this.paths.loreLogFile,
    };

    this.kbServer = new KbServerProcess(this.kbDbPath, this.embedder, (obs) => {
      this.logger.debug(
        `lore_search: query=${JSON.stringify(obs.query)} mode=${obs.requestedMode}→${obs.modeUsed} results=${obs.resultCount} topScore=${obs.topScore} latency=${obs.latencyMs}ms`,
      );
    }, loreLoggerOpts);
    try {
      await this.kbServer.start();
      this.logger.info(`KB server started and ready (lore log: ${this.paths.loreLogFile}, level: ${loreLogLevel})`);
    } catch (err) {
      this.logger.warn(
        `KB server failed to start — agents will run without KB access: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.kbServer = undefined;
    }
  }

  /** Stop the KB MCP server if it is running. */
  private async stopKbServer(): Promise<void> {
    if (this.kbServer) {
      try {
        await this.kbServer.stop();
        this.logger.info('KB server stopped');
      } catch {
        // Ignore errors on shutdown
      }
      this.kbServer = undefined;
    }
  }

  /**
   * Emergency cleanup for use by the SIGINT/SIGTERM handler.
   *
   * Kills the KB server and disposes the embedding provider (which holds
   * a long-running Python child process).  Without this, interrupted runs
   * leave orphaned clangd / Python processes that consume GBs of RAM.
   *
   * Uses a 3-second timeout per operation so we never hang waiting for a
   * stuck child process (e.g. Python mid-model-download).
   */
  async shutdown(): Promise<void> {
    const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T | void> =>
      Promise.race([p, new Promise<void>(r => setTimeout(r, ms))]);

    await withTimeout(this.stopKbServer(), 3_000);
    if (this.embedder) {
      try { await withTimeout(this.embedder.dispose(), 3_000); } catch { /* ignore */ }
      this.embedder = undefined;
    }
  }

  // ─── Phase 1: Task Graph Construction (deterministic) ─────────────────

  private async executePhase1(start: number): Promise<PhaseResult> {
    const planningDir = this.paths.artifactsPlanningDir;
    const mergedTasksFile = join(planningDir, 'tasks-merged.json');

    await ensureDir(planningDir);

    // Resume path: tasks-merged.json already exists from a prior run
    if (await fileExists(mergedTasksFile)) {
      this.logger.info('Phase 1: loading existing tasks-merged.json (prior run)');
      const allTasks = await readJson<MigrationTask[]>(mergedTasksFile);
      let taskGraphSCCs: string[][] = [];
      const sccsFile = join(planningDir, 'sccs.json');
      if (await fileExists(sccsFile)) {
        try { taskGraphSCCs = await readJson<string[][]>(sccsFile); } catch { /* ignore */ }
      }
      let compilationUnits: CompilationUnit[] = [];
      const compilationUnitsFile = join(planningDir, 'compilation-units.json');
      if (await fileExists(compilationUnitsFile)) {
        try { compilationUnits = await readJson<CompilationUnit[]>(compilationUnitsFile); } catch { /* ignore */ }
      }
      this.phase1TaskGraphResult = {
        agent: 'migration-planner',
        exitCode: 0,
        success: true,
        outputFiles: [mergedTasksFile],
        duration: Date.now() - start,
        outputParsed: true,
        structuredOutput: { tasks: allTasks, sccs: taskGraphSCCs, compilationUnits },
      };
      return {
        phase: 1,
        name: 'Task Graph Construction',
        success: true,
        outputPath: mergedTasksFile,
        duration: Date.now() - start,
      };
    }

    // Build the task graph deterministically from the Lore symbol graph.
    if (!(await fileExists(this.kbDbPath))) {
      return {
        phase: 1,
        name: 'Task Graph Construction',
        success: false,
        duration: Date.now() - start,
        error: 'Lore KB database (kb.db) not found — Phase 0 (KB Indexing) must complete before Phase 1',
      };
    }

    // Pre-compute the dependency summary from Lore KB.
    const depSummaryFile = join(planningDir, 'dependency-summary.json');
    if (!(await fileExists(depSummaryFile))) {
      this.logger.info('Computing dependency summary from Lore KB…');
      try {
        const depSummary = await buildDependencySummary(
          this.kbDbPath,
          this.config.options.maxLinesPerTask,
        );
        await atomicWrite(depSummaryFile, JSON.stringify(depSummary, null, 2));
        this.logger.info(
          `Dependency summary: ${depSummary.fileCount} files, ${depSummary.totalLines} lines, ` +
          `${depSummary.connectedComponents.length} connected component(s), ${depSummary.sccs.length} SCC(s)`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Failed to compute dependency summary: ${msg} — proceeding without it`);
      }
    }

    this.logger.info('Phase 1: building task graph from Lore KB (deterministic symbol-graph analysis)');
    try {
      const graphResult = await buildTaskGraph({
        kbDbPath: this.kbDbPath,
        sourceRoot: this.config.source.path,
        maxLinesPerTask: this.config.options.maxLinesPerTask,
        targetLanguage: this.config.target.language,
        outputPath: this.config.target.outputPath,
      });
      const allTasks = graphResult.tasks;
      const taskGraphSCCs = graphResult.sccs;
      const compilationUnits = graphResult.compilationUnits;

      if (taskGraphSCCs.length > 0) {
        this.logger.info(
          `Detected ${taskGraphSCCs.length} SCC(s) with cyclic deps — will use two-pass scaffold execution`,
        );
      }
      this.logger.info(
        `Task graph built: ${allTasks.length} task(s) from Lore KB with ${allTasks.reduce((n, t) => n + t.dependencies.length, 0)} dependency edge(s)`,
      );

      await atomicWrite(mergedTasksFile, JSON.stringify(allTasks, null, 2));

      // Persist SCC information to disk so Phase 5 can recover it on resume.
      const sccsFile = join(planningDir, 'sccs.json');
      if (taskGraphSCCs.length > 0) {
        await atomicWrite(sccsFile, JSON.stringify(taskGraphSCCs, null, 2));
        this.logger.info(`Persisted ${taskGraphSCCs.length} SCC(s) → ${sccsFile}`);
      }

      // Persist compilation units so Phase 5 can use them for wave boundaries.
      const compilationUnitsFile = join(planningDir, 'compilation-units.json');
      if (compilationUnits.length > 0) {
        await atomicWrite(compilationUnitsFile, JSON.stringify(compilationUnits, null, 2));
        this.logger.info(`Persisted ${compilationUnits.length} compilation unit(s) → ${compilationUnitsFile}`);
      }

      // Make output available to Phase 5 via in-memory path.
      this.phase1TaskGraphResult = {
        agent: 'migration-planner',
        exitCode: 0,
        success: true,
        outputFiles: [mergedTasksFile],
        duration: Date.now() - start,
        outputParsed: true,
        structuredOutput: { tasks: allTasks, sccs: taskGraphSCCs, compilationUnits },
      };

      return {
        phase: 1,
        name: 'Task Graph Construction',
        success: true,
        outputPath: mergedTasksFile,
        duration: Date.now() - start,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to build task graph from Lore KB: ${msg}`);
      return {
        phase: 1,
        name: 'Task Graph Construction',
        success: false,
        duration: Date.now() - start,
        error: `Lore task-graph build failed: ${msg}`,
      };
    }
  }

  // ─── Phase 2: Impact Assessment ──────────────────────────────────────

  private async executePhase2(start: number): Promise<PhaseResult> {
    const checkpointState = this.checkpoint.getState();
    if (checkpointState.completedPhases.includes(2)) {
      this.logger.info('Phase 2 skipped on resume — impact assessment already complete');
      return {
        phase: 2,
        name: 'Impact Assessment',
        success: true,
        outputPath: this.paths.impactAssessmentFile,
        duration: Date.now() - start,
      };
    }

    const contextFile = await this.contextBuilder.buildContext('impact-assessor', 2);
    const inv = this.buildInvocation('impact-assessor', contextFile, 2);
    const result = await this.launchAgentWithEvents(inv);
    this.recordTokens(result, 2);

    const outputPath = this.paths.impactAssessmentFile;
    return {
      phase: 2,
      name: 'Impact Assessment',
      success: result.success,
      outputPath,
      duration: Date.now() - start,
      error: result.error,
      exitCode: result.success ? undefined : result.exitCode,
      stderr: result.success ? undefined : result.stderr,
    };
  }

  // ─── Phase 3: Knowledge Base Construction ────────────────────────────

  private async executePhase3(start: number): Promise<PhaseResult> {
    const outputPath = this.paths.knowledgeBaseDir;

    const checkpointState = this.checkpoint.getState();
    if (checkpointState.completedPhases.includes(3)) {
      this.logger.info('Phase 3 skipped on resume — knowledge base already built');
      return {
        phase: 3,
        name: 'Knowledge Base Construction',
        success: true,
        outputPath,
        duration: Date.now() - start,
      };
    }

    // 1. Launch knowledge-builder
    const kbContext = await this.contextBuilder.buildContext('knowledge-builder', 3);
    const kbInv = this.buildInvocation('knowledge-builder', kbContext, 3);
    const kbResult = await this.launchAgentWithEvents(kbInv);
    this.recordTokens(kbResult, 3);

    if (!kbResult.success) {
      return {
        phase: 3,
        name: 'Knowledge Base Construction',
        success: false,
        duration: Date.now() - start,
        error: kbResult.error,
        exitCode: kbResult.exitCode,
        stderr: kbResult.stderr,
      };
    }

    return {
      phase: 3,
      name: 'Knowledge Base Construction',
      success: true,
      outputPath,
      duration: Date.now() - start,
    };
  }

  // ─── Phase 4: Migration Strategy (agentic) ────────────────────────────

  private async executePhase4(start: number): Promise<PhaseResult> {
    const planningDir = this.paths.artifactsPlanningDir;
    await ensureDir(planningDir);

    const checkpointState = this.checkpoint.getState();
    if (!checkpointState.phase3aComplete) {
      const planContext = await this.contextBuilder.buildContext('migration-planner', 4);
      const planInv = this.buildInvocation('migration-planner', planContext, 4);
      const planResult = await this.launchAgentWithEvents(planInv);
      this.recordTokens(planResult, 4);

      if (!planResult.success) {
        return {
          phase: 4,
          name: 'Migration Strategy',
          success: false,
          duration: Date.now() - start,
          error: planResult.error,
          exitCode: planResult.exitCode,
          stderr: planResult.stderr,
        };
      }

      // Adjudicator runs when competing strategies were written to disk.
      const adjudicationFile = this.paths.competingStrategiesFile;
      if (await fileExists(adjudicationFile)) {
        const adjCtx = await this.contextBuilder.buildContext('adjudicator', 4, undefined, {
          competingStrategiesFile: adjudicationFile,
          decisionType: 'migration-strategy',
        });
        const adjInv = this.buildInvocation('adjudicator', adjCtx, 4);
        const adjResult = await this.launchAgentWithEvents(adjInv);
        this.recordTokens(adjResult, 4);
      } else {
        try {
          const planningEntries = await readdir(planningDir);
          const progressEntries = await readdir(this.progressDir);
          const hasVariantArtifacts = [...planningEntries, ...progressEntries]
            .some((name) => /^strategy-[a-z0-9_-]+\.md$/i.test(name));

          if (hasVariantArtifacts) {
            this.logger.warn(
              'Detected strategy-* markdown artifacts but missing competing-strategies.md; ' +
              'skipping adjudicator. If multiple viable strategies exist, write ' +
              'competing-strategies.md in the phase progress directory.',
            );
          } else {
            this.logger.info(
              'No competing-strategies.md found; adjudicator not invoked (single strategy assumed).',
            );
          }
        } catch {
          this.logger.info(
            'No competing-strategies.md found; adjudicator not invoked (single strategy assumed).',
          );
        }
      }

      await this.checkpoint.completePhase3a();
      this.logger.info(
        'Phase 4 complete: migration-planner wrote planning/strategy.md',
      );
    } else {
      this.logger.info('Resuming Phase 4 — strategy already complete, skipping migration-planner');
    }

    return {
      phase: 4,
      name: 'Migration Strategy',
      success: true,
      outputPath: join(planningDir, 'strategy.md'),
      duration: Date.now() - start,
    };
  }

  // ─── Phase 5: Iterative Migration ────────────────────────────────────

  private async executePhase5(start: number): Promise<PhaseResult> {
    const planPath = this.paths.migrationPlanFile;

    // 1. Parse migration plan — prefer structuredOutput from Phase 1, fall back to file
    let tasks: MigrationTask[];
    if (this.phase1TaskGraphResult?.outputParsed && Array.isArray(this.phase1TaskGraphResult.structuredOutput?.['tasks'])) {
      tasks = this.phase1TaskGraphResult.structuredOutput['tasks'] as MigrationTask[];
    } else {
      if (!(await fileExists(planPath))) {
        // Also check for the newer planning/tasks-merged.json produced by the
        // Phase 1 task graph (migration-planner + parallel task-decomposer).
        const mergedPlanPath = join(this.paths.artifactsPlanningDir, 'tasks-merged.json');
        if (await fileExists(mergedPlanPath)) {
          this.logger.warn(
            'Phase 1 structured output unavailable — falling back to tasks-merged.json artifact',
          );
          tasks = await readJson<MigrationTask[]>(mergedPlanPath);
        } else {
          return {
            phase: 5,
            name: 'Iterative Migration',
            success: false,
            duration: Date.now() - start,
            error: 'migration-plan.md and tasks-merged.json not found — Phase 1 may not have completed',
          };
        }
      } else {
        this.logger.warn(
          'Phase 1 structured output unavailable — falling back to parseMigrationPlan',
        );
        tasks = await parseMigrationPlan(planPath);
      }
    }
    if (tasks.length === 0) {
      this.logger.warn('No tasks found in migration plan');
      return {
        phase: 5,
        name: 'Iterative Migration',
        success: true,
        outputPath: this.config.target.outputPath,
        duration: Date.now() - start,
      };
    }

    // 1b. Validate maxLinesPerTask
    const maxLines = this.config.options.maxLinesPerTask;
    for (const task of tasks) {
      if (task.lineRange) continue;
      for (const src of task.sourceFiles) {
        try {
          const fullPath = join(this.config.source.path, src);
          const lineCount = await countFileLines(fullPath);
          if (lineCount > maxLines) {
            this.logger.warn(
              `Task "${task.id}" source file "${src}" has ${lineCount} lines, exceeding maxLinesPerTask (${maxLines})`,
            );
          }
        } catch {
          // File may not exist; skip silently
        }
      }
    }

    // 1c. Cost projection
    const taskCount = tasks.length;
    const agentMultiplier = this.config.target.testCommand ? 3 : 2; // migrator + parity (+ test-writer if testCommand set)
    const estimatedTotalTokens = taskCount * AVG_TOKENS_PER_TASK * agentMultiplier * RETRY_OVERHEAD_MULTIPLIER;
    const model = this.getConfiguredRuntimeModel();
    const projected = this.costEstimatorInstance.estimateFromTotal(model, estimatedTotalTokens);

    this.logger.info(
      `Phase 5: ${taskCount} tasks, estimated ~${estimatedTotalTokens.toLocaleString()} tokens, ` +
      `projected cost: ${CostEstimator.formatCost(projected.total)} (${model}, retry overhead: ${RETRY_OVERHEAD_MULTIPLIER}x)`,
    );
    await this.progress.appendEvent(
      `Phase 5 projection: ${taskCount} tasks, ~${CostEstimator.formatCost(projected.total)} estimated`,
    );

    // Check if projected usage would exceed budget
    if (this.config.options.tokenBudget) {
      const currentUsage = this.tokenTracker.getTotal();
      if (currentUsage + estimatedTotalTokens > this.config.options.tokenBudget) {
        this.logger.warn(
          `Projected Phase 5 usage (${estimatedTotalTokens.toLocaleString()}) plus current usage ` +
          `(${currentUsage.toLocaleString()}) exceeds budget (${this.config.options.tokenBudget.toLocaleString()})`,
        );
      }
    }

    // 2. Topological sort — SCC-aware when Lore produced cycle groups
    //    For tasks with cyclic dependencies (SCCs), we collapse SCC-internal
    //    edges before sorting to avoid the "circular dependency" error.
    //    SCC members share external deps and are released together.
    let sccs: string[][] =
      (this.phase1TaskGraphResult?.structuredOutput?.['sccs'] as string[][] | undefined) ?? [];

    // On resume, phase1TaskGraphResult is not available (Phase 1 was skipped).
    // Recover persisted SCC information from disk.
    if (sccs.length === 0) {
      const sccsFile = join(this.paths.artifactsPlanningDir, 'sccs.json');
      if (await fileExists(sccsFile)) {
        try {
          sccs = await readJson<string[][]>(sccsFile);
          this.logger.info(`Recovered ${sccs.length} SCC(s) from ${sccsFile} (resume path)`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.warn(`Failed to parse sccs.json: ${msg} — proceeding without SCC awareness`);
        }
      }
    }
    const sccMembership = new Map<string, string[]>(); // taskId → SCC members
    for (const scc of sccs) {
      for (const id of scc) sccMembership.set(id, scc);
    }

    let sortedTasks: MigrationTask[];
    if (sccs.length > 0) {
      // Remove SCC-internal edges before sorting
      const tasksForSort = tasks.map(t => {
        const myScc = sccMembership.get(t.id);
        if (!myScc) return t;
        const sccSet = new Set(myScc);
        return { ...t, dependencies: t.dependencies.filter(d => !sccSet.has(d)) };
      });
      sortedTasks = TaskQueue.topologicalSort(tasksForSort);
      // Restore original dependency arrays (queue uses them for getReady)
      const origMap = new Map(tasks.map(t => [t.id, t]));
      sortedTasks = sortedTasks.map(t => origMap.get(t.id) ?? t);
    } else {
      sortedTasks = TaskQueue.topologicalSort(tasks);
    }

    // 3. Build queue, apply checkpoint, register SCCs
    const queue = new TaskQueue(sortedTasks);
    if (sccs.length > 0) {
      queue.setSCCs(sccs);
    }
    const checkpointState = this.checkpoint.getState();
    queue.markCompleted(checkpointState.completedTasks);
    this.progress.setTotalTasks(sortedTasks.length);
    const completedDurationsMs: number[] = [...checkpointState.completedTaskDurationsMs];

    // 4. Process tasks
    const retryExec = new RetryExecutor(
      (inv) => this.launchAgentWithEvents(inv),
      this.logger,
    );

    const continueOnBlocked = this.config.options.continueOnBlocked ?? true;
    const maxBlockedTasks = this.config.options.maxBlockedTasks ?? 1; // 0 = unlimited
    const executionMode = this.config.options.executionMode ?? 'per-task';
    const waveControl = this.config.options.waveControl ?? { waveSize: 3, maxConvergenceIterations: 3 };
    // In wave-barrier mode, wave-level commits replace per-task commits, so
    // we can safely run multiple tasks in parallel even when git is enabled.
    // In per-task mode, git commits happen inside executeTask so we must
    // serialize to avoid concurrent git mutations.
    const phase4Parallelism =
      this.isGitAutomationEnabled() && executionMode !== 'wave-barrier'
        ? 1
        : this.config.options.maxParallelAgents;
    this.phase5Snapshot = {
      executionMode,
      phase4DurationMs: 0,
      completedTaskCount: 0,
      waveCount: 0,
      waveValidationRuns: 0,
      waveConvergenceIterations: 0,
      waveConvergenceFailures: 0,
      waveConvergenceLimitHits: 0,
      buildCommandRuns: 0,
      testCommandRuns: 0,
      formatCommandRuns: 0,
      lintCommandRuns: 0,
      commandRecoveryAttempts: 0,
      commandInfraRetries: 0,
      recoveryLoopTimeMs: 0,
    };

    if (executionMode === 'wave-barrier') {
      try {
        return await this.executePhase5WaveBarrier(
          start,
          queue,
          retryExec,
          completedDurationsMs,
          continueOnBlocked,
          maxBlockedTasks,
          Math.max(1, Math.min(waveControl.waveSize, phase4Parallelism)),
          waveControl.maxConvergenceIterations,
        );
      } catch (error) {
        this._deferGitCommits = false;
        if (error instanceof TerminalExhaustionError) {
          return this.buildPhase5TerminalResult(start, queue, error);
        }
        throw error;
      }
    }

    while (!queue.isComplete()) {
      const readyTasks = queue.getReady();
      if (readyTasks.length === 0) {
        const progress = queue.getProgress();
        if (progress.blocked > 0 && progress.remaining > 0) {
          this.logger.error(
            `Deadlock: ${progress.remaining} task(s) remain but none are ready ` +
            `(${progress.blocked} blocked — their dependents cannot proceed)`,
          );
        } else if (progress.remaining > 0) {
          this.logger.error('Deadlock: no tasks are ready but queue is not complete');
        }
        break;
      }

      // Select non-overlapping batch for parallel execution
      const batch = TaskQueue.selectNonOverlappingBatch(
        readyTasks,
        phase4Parallelism,
      );

      this.logger.info(`Executing batch of ${batch.length} task(s) in parallel (${readyTasks.length} ready)`);

      // Execute batch concurrently
      const batchPromises = batch.map(task => this.executeTask(task, retryExec, queue, completedDurationsMs));
      const batchResults = await Promise.allSettled(batchPromises);
      const terminalExhaustion = batchResults.find(
        (result): result is PromiseRejectedResult =>
          result.status === 'rejected' && result.reason instanceof TerminalExhaustionError,
      );
      if (terminalExhaustion) {
        return this.buildPhase5TerminalResult(start, queue, terminalExhaustion.reason);
      }

      // Check blocked-task policy
      const progress = queue.getProgress();
      if (progress.blocked > 0) {
        if (!continueOnBlocked) {
          this.logger.error(
            `${progress.blocked} task(s) blocked after max retries — halting Phase 5 (continueOnBlocked=false)`,
          );
          break;
        }
        if (maxBlockedTasks > 0 && progress.blocked >= maxBlockedTasks) {
          this.logger.error(
            `${progress.blocked} task(s) blocked — reached maxBlockedTasks (${maxBlockedTasks}), halting Phase 5`,
          );
          break;
        }
        this.logger.warn(
          `${progress.blocked} task(s) blocked, continuing with remaining ready tasks`,
        );
      }
    }

    const finalProgress = queue.getProgress();
    const deadlocked = finalProgress.remaining > 0;
    if (this.phase5Snapshot) {
      this.phase5Snapshot.phase4DurationMs = Date.now() - start;
      this.phase5Snapshot.completedTaskCount = finalProgress.completed;
      this.metricsCollector.setPhase4Snapshot(this.phase5Snapshot);
      this.phase5Snapshot = undefined;
    }

    let waveEndGateError: string | undefined;
    const gateMode = this.getQualityGateMode();
    if (!deadlocked && finalProgress.blocked === 0 && gateMode !== 'enforce') {
      const completedWaveTasks = queue.getAllTaskIds()
        .filter(id => queue.isTaskCompleted(id))
        .map(id => queue.getTask(id)!)
        .filter(Boolean);
      waveEndGateError = await this.runWaveEndQualityGates(completedWaveTasks);
    }
    return {
      phase: 5,
      name: 'Iterative Migration',
      success: finalProgress.blocked === 0 && !deadlocked && !waveEndGateError,
      outputPath: this.config.target.outputPath,
      duration: Date.now() - start,
      error:
        deadlocked
          ? `${finalProgress.remaining} task(s) deadlocked — unresolvable dependencies`
          : finalProgress.blocked > 0
            ? `${finalProgress.blocked} task(s) blocked after max retries`
            : waveEndGateError
              ? waveEndGateError
            : undefined,
    };
  }

  // ─── Phase 5 Helpers ─────────────────────────────────────────────────

  private getPhaseCursors() {
    const state = this.checkpoint.getState();
    state.phaseCursors ??= {};
    return state.phaseCursors;
  }

  private getPhase5TaskState(taskId: string): { completedSubsteps: string[]; lastSuccessfulStep?: string } {
    const phaseCursors = this.getPhaseCursors();
    phaseCursors['5'] ??= { tasks: {} };
    phaseCursors['5'].tasks ??= {};
    phaseCursors['5'].tasks[taskId] ??= { completedSubsteps: [] };
    return phaseCursors['5'].tasks[taskId];
  }

  private hasPhase5Substep(taskId: string, substep: string): boolean {
    const taskState = this.getPhase5TaskState(taskId);
    return taskState.completedSubsteps.includes(substep);
  }

  private async markPhase5Substep(taskId: string, substep: string): Promise<void> {
    const taskState = this.getPhase5TaskState(taskId);
    if (!taskState.completedSubsteps.includes(substep)) {
      taskState.completedSubsteps.push(substep);
    }
    taskState.lastSuccessfulStep = substep;
    await this.checkpoint.save(this.checkpoint.getState());
  }

  private getPhase6Cursor(): { iteration: number; fixIndex: number; lastSuccessfulStep?: string; hadUnresolvedFixes?: boolean } {
    const phaseCursors = this.getPhaseCursors();
    phaseCursors['6'] ??= { iteration: 0, fixIndex: 0 };
    phaseCursors['6'].iteration ??= 0;
    phaseCursors['6'].fixIndex ??= 0;
    phaseCursors['6'].hadUnresolvedFixes ??= false;
    return phaseCursors['6'];
  }

  private async savePhase6Cursor(cursor: { iteration: number; fixIndex: number; lastSuccessfulStep?: string; hadUnresolvedFixes?: boolean }): Promise<void> {
    const phaseCursors = this.getPhaseCursors();
    phaseCursors['6'] = cursor;
    await this.checkpoint.save(this.checkpoint.getState());
  }

  private getPhase7Cursor(): { completedAgents: string[]; completedSuites: string[]; lastSuccessfulStep?: string } {
    const phaseCursors = this.getPhaseCursors();
    phaseCursors['7'] ??= { completedAgents: [] };
    phaseCursors['7'].completedAgents ??= [];
    phaseCursors['7'].completedSuites ??= [];
    return phaseCursors['7'] as { completedAgents: string[]; completedSuites: string[]; lastSuccessfulStep?: string };
  }

  private async savePhase7Cursor(cursor: { completedAgents: string[]; completedSuites?: string[]; lastSuccessfulStep?: string }): Promise<void> {
    const phaseCursors = this.getPhaseCursors();
    phaseCursors['7'] = cursor;
    await this.checkpoint.save(this.checkpoint.getState());
  }

  private getPhase8Cursor(): { iteration: number; issueIndex: number; currentFile?: string; lastSuccessfulStep?: string } {
    const phaseCursors = this.getPhaseCursors();
    phaseCursors['8'] ??= { iteration: 0, issueIndex: 0 };
    phaseCursors['8'].iteration ??= 0;
    phaseCursors['8'].issueIndex ??= 0;
    return phaseCursors['8'];
  }

  private async savePhase8Cursor(cursor: {
    iteration: number;
    issueIndex: number;
    currentFile?: string;
    lastSuccessfulStep?: string;
  }): Promise<void> {
    const phaseCursors = this.getPhaseCursors();
    phaseCursors['8'] = cursor;
    await this.checkpoint.save(this.checkpoint.getState());
  }

  private normalizeFailureSummary(summary: string): string {
    return summary.replace(/\s+/g, ' ').trim().slice(0, 240);
  }

  private buildRemediationContext(input: {
    failureKind: string;
    failureSummary: string;
    taskId?: string;
    wave?: number;
    check?: string;
    artifactPaths: string[];
    expectedSuccessCondition: string;
  }): RemediationContext {
    return {
      failureKind: input.failureKind,
      failureSummary: this.normalizeFailureSummary(input.failureSummary),
      failureTarget: {
        taskId: input.taskId,
        wave: input.wave,
        check: input.check,
      },
      artifactPaths: Array.from(new Set(input.artifactPaths.filter(Boolean))),
      expectedSuccessCondition: input.expectedSuccessCondition,
    };
  }

  /**
   * Extract the task-scope fields (description, acceptanceCriteria, parityChecks)
   * from a {@link MigrationTask} as a payload fragment.  Every task-scoped agent
   * (code-migrator, parity-verifier, test-writer, parity-failure-resolver) receives
   * this so it can calibrate its work to the task's intended scope rather than
   * assuming full source↔target equivalence.
   */
  private taskScopePayload(task: MigrationTask): Record<string, unknown> {
    return {
      taskScope: {
        description: task.description,
        acceptanceCriteria: task.acceptanceCriteria,
        parityChecks: task.parityChecks,
        ...(task.lineRange ? { lineRange: task.lineRange } : {}),
      },
    };
  }

  private formatFailureTarget(details: Pick<RetryTargetDetails, 'taskId' | 'wave' | 'check'>): string {
    const parts = [
      details.taskId ? `task=${details.taskId}` : undefined,
      details.wave !== undefined ? `wave=${details.wave}` : undefined,
      details.check ? `check=${details.check}` : undefined,
    ].filter((part): part is string => !!part);
    return parts.length > 0 ? parts.join(', ') : 'unscoped';
  }

  private async recordRetryTarget(details: RetryTargetDetails): Promise<void> {
    const normalizedSummary = this.normalizeFailureSummary(details.summary);
    const target = this.formatFailureTarget(details);
    this.logger.warn(
      `Recovery retry ${details.attempt}/${details.maxAttempts} targeting ${details.scope} (${target}): ${normalizedSummary}`,
    );
    await this.progress.appendRetryTarget({
      ...details,
      summary: normalizedSummary,
    });
  }

  private async raiseTerminalExhaustion(details: TerminalExhaustionDetails): Promise<never> {
    const normalizedSummary = this.normalizeFailureSummary(details.summary);
    const normalized: TerminalExhaustionDetails = {
      ...details,
      summary: normalizedSummary,
    };
    this.logger.event({
      type: 'terminal-exhaustion',
      reasonCode: normalized.reasonCode,
      wave: normalized.wave,
      taskId: normalized.taskId,
      check: normalized.check,
    });
    await this.checkpoint.setTerminalExhaustion(normalized);
    await this.progress.setTerminalExhaustion(normalized);
    await this.progress.appendEvent(
      `Terminal exhaustion (${normalized.reasonCode}): ${normalizedSummary}`,
    );
    throw new TerminalExhaustionError(normalized);
  }

  private buildPhase5TerminalResult(
    start: number,
    queue: TaskQueue,
    error: TerminalExhaustionError,
  ): PhaseResult {
    const finalProgress = queue.getProgress();
    if (this.phase5Snapshot) {
      this.phase5Snapshot.phase4DurationMs = Date.now() - start;
      this.phase5Snapshot.completedTaskCount = finalProgress.completed;
      this.metricsCollector.setPhase4Snapshot(this.phase5Snapshot);
      this.phase5Snapshot = undefined;
    }
    return {
      phase: 5,
      name: 'Iterative Migration',
      success: false,
      outputPath: this.config.target.outputPath,
      duration: Date.now() - start,
      error: error.message,
    };
  }

  private async executePhase5WaveBarrier(
    start: number,
    queue: TaskQueue,
    retryExec: RetryExecutor,
    completedDurationsMs: number[],
    continueOnBlocked: boolean,
    maxBlockedTasks: number,
    waveSize: number,
    maxConvergenceIterations: number,
  ): Promise<PhaseResult> {
    let wave = 0;
    const taskStartTimes = new Map<string, number>();

    // In wave-barrier mode, per-task/per-agent commits are replaced by a
    // single commit per wave created after convergence succeeds.
    const deferGit = this.isGitAutomationEnabled();
    if (deferGit) {
      this._deferGitCommits = true;
    }

    while (!queue.isComplete()) {
      const readyTasks = queue.getReady();
      if (readyTasks.length === 0) {
        const progress = queue.getProgress();
        if (progress.blocked > 0 && progress.remaining > 0) {
          this.logger.error(
            `Deadlock: ${progress.remaining} task(s) remain but none are ready ` +
            `(${progress.blocked} blocked — their dependents cannot proceed)`,
          );
        } else if (progress.remaining > 0) {
          this.logger.error('Deadlock: no tasks are ready but queue is not complete');
        }
        break;
      }

      const blockedAtWaveStart = queue.getProgress().blocked;
      const waveTasks = TaskQueue.selectNonOverlappingBatch(readyTasks, waveSize);
      wave++;
      if (this.phase5Snapshot) {
        this.phase5Snapshot.waveCount++;
      }
      const waveStart = Date.now();

      const taskIds = waveTasks.map(t => t.id);
      this.logger.info(`Wave ${wave}: migrating ${waveTasks.length} task(s) (${readyTasks.length} ready)`);
      this.logger.event({ type: 'wave-started', wave, taskIds });
      await this.progress.appendWaveLifecycle({ wave, milestone: 'started' });

      let migrationResults: Array<{ task: MigrationTask; result: { migrated: boolean; durationMs?: number } }>;
      try {
        migrationResults = await Promise.all(
          waveTasks.map(async task => {
            if (!taskStartTimes.has(task.id)) {
              taskStartTimes.set(task.id, Date.now());
            }
            const result = await this.executeTask(task, retryExec, queue, completedDurationsMs, 'wave-migration');
            return { task, result };
          }),
        );
      } catch (error) {
        if (error instanceof TerminalExhaustionError) {
          if (deferGit) this._deferGitCommits = false;
          return this.buildPhase5TerminalResult(start, queue, error);
        }
        throw error;
      }

      // Re-enable per-task commits now that the parallel section is done.
      this._deferGitCommits = false;

      this.logger.event({ type: 'wave-completed', wave, taskIds, duration: Date.now() - waveStart });
      await this.progress.appendWaveLifecycle({ wave, milestone: 'completed' });
      this.logger.event({ type: 'wave-barrier-entered', wave });
      await this.progress.appendWaveLifecycle({ wave, milestone: 'barrier-entered' });

      let waveCandidates = migrationResults
        .filter(r => r.result.migrated)
        .map(r => r.task)
        .filter(t => !queue.isTaskBlocked(t.id));

      const barrierStart = Date.now();
      let converged = waveCandidates.length > 0;
      let remainingFailures = 0;

      if (waveCandidates.length > 0) {
        for (let iteration = 1; iteration <= maxConvergenceIterations; iteration++) {
          if (this.phase5Snapshot) {
            this.phase5Snapshot.waveConvergenceIterations++;
          }
          const validation = await this.runWaveValidation(wave);
          if (validation.success) {
            this.logger.event({
              type: 'wave-convergence-status',
              wave,
              iteration,
              converged: true,
              remainingFailures: 0,
            });
            await this.progress.appendWaveLifecycle({
              wave,
              milestone: 'convergence',
              iteration,
              converged: true,
              remainingFailures: 0,
            });
            converged = true;
            remainingFailures = 0;
            break;
          }

          converged = false;
          remainingFailures = waveCandidates.length;
          const failedCheck = validation.failedLabel ?? 'wave-validation';
          const failureSummary =
            validation.failure?.error ?? `Wave ${wave} ${failedCheck} validation failed`;
          if (this.phase5Snapshot) {
            this.phase5Snapshot.waveConvergenceFailures++;
          }
          this.logger.event({
            type: 'wave-convergence-status',
            wave,
            iteration,
            converged: false,
            remainingFailures,
          });
          await this.progress.appendWaveLifecycle({
            wave,
            milestone: 'convergence',
            iteration,
            converged: false,
            remainingFailures,
          });

          if (iteration >= maxConvergenceIterations) {
            break;
          }

          this.logger.warn(
            `Wave ${wave} validation failed, running fix wave iteration ${iteration}/${maxConvergenceIterations}`,
          );

          for (const task of waveCandidates) {
            await this.recordRetryTarget({
              scope: 'wave',
              attempt: iteration,
              maxAttempts: maxConvergenceIterations,
              taskId: task.id,
              wave,
              check: failedCheck,
              summary: failureSummary,
            });
          }

          try {
            const recovered = await this.recoverWaveValidationFailure(
              wave,
              waveCandidates,
              queue,
              validation,
            );
            if (!recovered) {
              this.logger.warn(
                `Wave ${wave} ${failedCheck} recovery attempt did not converge on iteration ${iteration}`,
              );
            }
          } catch (error) {
            if (error instanceof TerminalExhaustionError) {
              if (deferGit) this._deferGitCommits = false;
              return this.buildPhase5TerminalResult(start, queue, error);
            }
            throw error;
          }

          waveCandidates = waveCandidates.filter((task) => !queue.isTaskBlocked(task.id));

          if (waveCandidates.length === 0) {
            remainingFailures = 0;
            break;
          }
        }
      }

      if (!converged && waveCandidates.length > 0) {
        if (this.phase5Snapshot) {
          this.phase5Snapshot.waveConvergenceLimitHits++;
        }
        this.logger.event({
          type: 'wave-convergence-limit-reached',
          wave,
          maxIterations: maxConvergenceIterations,
          remainingFailures,
        });
        await this.raiseTerminalExhaustion({
          reasonCode: 'wave-convergence-exhausted',
          wave,
          check: 'wave-validation',
          summary: `Wave ${wave} failed to converge after ${maxConvergenceIterations} iteration(s)`,
        });
      } else {
        // Commit all wave output in a single git commit before marking tasks complete.
        const completedIds = waveCandidates
          .filter(t => !queue.isTaskCompleted(t.id) && !queue.isTaskBlocked(t.id))
          .map(t => t.id);
        if (completedIds.length > 0) {
          await this.commitForWave(wave, completedIds);
        }

        // Re-defer so that completePhase5Task's commitForTask is suppressed.
        if (deferGit) {
          this._deferGitCommits = true;
        }

        for (const task of waveCandidates) {
          if (queue.isTaskCompleted(task.id) || queue.isTaskBlocked(task.id)) continue;
          const startedAt = taskStartTimes.get(task.id) ?? waveStart;
          const durationMs = Date.now() - startedAt;
          await this.completePhase5Task(task, queue, completedDurationsMs, durationMs);
        }
      }

      this.logger.event({ type: 'wave-barrier-released', wave, duration: Date.now() - barrierStart });
      await this.progress.appendWaveLifecycle({ wave, milestone: 'barrier-released' });

      const progress = queue.getProgress();
      const blockedThisWave = progress.blocked - blockedAtWaveStart;
      if (blockedThisWave > 0) {
        if (!continueOnBlocked) {
          this.logger.error(
            `${progress.blocked} task(s) blocked after wave ${wave} — halting Phase 5 (continueOnBlocked=false)`,
          );
          break;
        }
        if (maxBlockedTasks > 0 && progress.blocked >= maxBlockedTasks) {
          this.logger.error(
            `${progress.blocked} task(s) blocked — reached maxBlockedTasks (${maxBlockedTasks}), halting Phase 5`,
          );
          break;
        }
        this.logger.warn(
          `${progress.blocked} task(s) blocked after wave ${wave}, continuing with remaining ready tasks`,
        );
      }
    }

    const finalProgress = queue.getProgress();
    const deadlocked = finalProgress.remaining > 0;
    if (deferGit) this._deferGitCommits = false;
    if (this.phase5Snapshot) {
      this.phase5Snapshot.phase4DurationMs = Date.now() - start;
      this.phase5Snapshot.completedTaskCount = finalProgress.completed;
      this.metricsCollector.setPhase4Snapshot(this.phase5Snapshot);
      this.phase5Snapshot = undefined;
    }
    return {
      phase: 5,
      name: 'Iterative Migration',
      success: finalProgress.blocked === 0 && !deadlocked,
      outputPath: this.config.target.outputPath,
      duration: Date.now() - start,
      error:
        deadlocked
          ? `${finalProgress.remaining} task(s) deadlocked — unresolvable dependencies`
          : finalProgress.blocked > 0
            ? `${finalProgress.blocked} task(s) blocked after max retries`
            : undefined,
    };
  }

  private async executeTask(
    task: MigrationTask,
    retryExec: RetryExecutor,
    queue: TaskQueue,
    completedDurationsMs: number[],
    mode: 'per-task' | 'wave-migration' = 'per-task',
    remediationContext?: RemediationContext,
  ): Promise<{ migrated: boolean; durationMs?: number }> {
    this.logger.event({ type: 'task-started', taskId: task.id, name: task.name });
    await this.checkpoint.setCurrentTask(task.id);
    await this.progress.updateTask(task.id, 'in-progress');

    const taskStartMs = Date.now();
    const taskCursor = this.getPhase5TaskState(task.id);
    if (taskCursor.lastSuccessfulStep) {
      this.logger.info(
        `Resuming ${task.id} from Phase 5 substep: ${taskCursor.lastSuccessfulStep}`,
      );
    }
    let completionEventDurationMs = Date.now() - taskStartMs;

    // a. Code migration with retry
    if (!this.hasPhase5Substep(task.id, 'migrator')) {
      const migratorCtx = await this.contextBuilder.buildContext(
        'code-migrator',
        5,
        task.id,
        {
          sourceFiles: task.sourceFiles,
          targetFiles: task.targetFiles,
          kbEntry: task.knowledgeBaseRef,
          ...this.taskScopePayload(task),
          ...(remediationContext ? { remediationContext: toAgentRemediationContext(remediationContext) } : {}),
        },
      );
      const migratorInv = this.buildInvocation('code-migrator', migratorCtx, 5, task.id, task);
      const fallbackModel = this.getFailureRecoveryModel();

      // Capture the initial routing decision for retry-aware escalation.
      const initialRoutingDecision = this.config.options.modelRouting?.enabled
        ? this.selectModelForInvocation(task, 'code-migrator')
        : undefined;

      const migratorResult = await retryExec.executeWithRetry(migratorInv, {
        maxAttempts: this.config.options.maxRetriesPerTask,
        onRetry: async (attempt, error) => {
          await this.recordRetryTarget({
            scope: remediationContext?.failureKind === 'wave-convergence' ? 'wave' : 'task',
            attempt,
            maxAttempts: this.config.options.maxRetriesPerTask,
            taskId: task.id,
            wave: remediationContext?.failureTarget.wave,
            check: remediationContext?.failureTarget.check ?? 'code-migrator',
            summary: error,
          });
          // Existing transient-failure fallback runs first
          if (fallbackModel && this.isTransientModelFailure(error) && migratorInv.modelOverride !== fallbackModel) {
            migratorInv.modelOverride = fallbackModel;
            this.logger.warn(
              `Switching ${task.id} code-migrator retries to fallback model: ${fallbackModel}`,
            );
          } else if (initialRoutingDecision) {
            // Retry-aware model escalation
            const routing = this.config.options.modelRouting!;
            const escalateAt = routing.escalateOnRetryAttempt ?? 2;
            if (attempt >= escalateAt) {
              // Promote to next-higher tier: normal→heavy, heavy→critical, critical stays critical
              const targetTier: ModelTier = initialRoutingDecision.tier === 'normal'
                ? 'heavy'
                : initialRoutingDecision.tier === 'heavy'
                  ? 'critical'
                  : 'critical';

              const escalatedModel = targetTier === 'critical'
                ? (routing.criticalModel ?? routing.heavyModel)
                : routing.heavyModel;

              if (escalatedModel) {
                const retryDecision = this.applyRoutingCaps({
                  ...initialRoutingDecision,
                  tier: targetTier,
                  selectedModel: escalatedModel,
                  reason: `${initialRoutingDecision.reason}:retry-escalation`,
                  escalated: true,
                }, task.id);

                if (retryDecision.tier !== 'normal') {
                  migratorInv.modelOverride = retryDecision.selectedModel;
                  migratorInv.routingTier = retryDecision.tier;
                  migratorInv.routingReason = retryDecision.reason;

                  if (!this._routedTaskIds.has(task.id)) {
                    this._routedTaskIds.add(task.id);
                  }
                  const defaultModel = this.getDefaultRoutingModel();
                  const avgTokens = AVG_TOKENS_PER_TASK;
                  const projectedCost = this.costEstimatorInstance.projectCost(retryDecision.selectedModel, avgTokens).total;
                  const baseCost = this.costEstimatorInstance.projectCost(defaultModel, avgTokens).total;
                  this._escalationCostUsd += Math.max(0, projectedCost - baseCost);

                  this.logger.warn(
                    `Escalating ${task.id} to ${retryDecision.selectedModel} after ${attempt} retries`,
                  );
                } else {
                  this.logger.warn(
                    `Retry escalation skipped for ${task.id}: ${retryDecision.reason}`,
                  );
                }
              }
            }
          }
          await this.checkpoint.failTask(task.id, error, attempt, false);
        },
        onExhausted: async (taskId, lastError) => {
          const retryExhaustionRemediation = this.buildRemediationContext({
            failureKind: remediationContext?.failureKind ?? 'task-retry',
            failureSummary: lastError,
            taskId,
            wave: remediationContext?.failureTarget.wave,
            check: remediationContext?.failureTarget.check ?? 'code-migrator',
            artifactPaths: [...task.sourceFiles, ...task.targetFiles],
            expectedSuccessCondition: `code-migrator succeeds for ${taskId}`,
          });

          const retryContext = await this.contextBuilder.buildContext(
            'code-migrator',
            5,
            task.id,
            {
              sourceFiles: task.sourceFiles,
              targetFiles: task.targetFiles,
              kbEntry: task.knowledgeBaseRef,
              ...this.taskScopePayload(task),
              remediationContext: toAgentRemediationContext(retryExhaustionRemediation),
            },
          );
          migratorInv.contextFile = retryContext;

          // Escalate to parity-failure-resolver agent
          const recoveryCtx = await this.contextBuilder.buildContext(
            'parity-failure-resolver',
            5,
            taskId,
            {
              failureReport: lastError,
              sourceFile: task.sourceFiles[0],
              targetFile: task.targetFiles[0],
              kbEntry: task.knowledgeBaseRef,
              attemptNumber: this.config.options.maxRetriesPerTask,
              ...this.taskScopePayload(task),
              remediationContext: toAgentRemediationContext(retryExhaustionRemediation),
            },
          );
          return this.buildInvocation('parity-failure-resolver', recoveryCtx, 5, taskId);
        },
      });

      this.recordTokens(migratorResult, 5);

      if (!migratorResult.success) {
        await this.raiseTerminalExhaustion({
          reasonCode: 'task-retries-exhausted',
          taskId: task.id,
          check: remediationContext?.failureTarget.check ?? 'code-migrator',
          wave: remediationContext?.failureTarget.wave,
          summary: migratorResult.error ?? `code-migrator failed after ${this.config.options.maxRetriesPerTask} retries`,
        });
      }

      completionEventDurationMs = migratorResult.duration;
      await this.markPhase5Substep(task.id, 'migrator');
    }

    if (!this.hasPhase5Substep(task.id, 'migrator-commit')) {
      await this.commitForAgent('code-migrator', 5, task.id, task.name);
      await this.markPhase5Substep(task.id, 'migrator-commit');
    }

    // b–c. Parity + test-writer in parallel
    if (!this.hasPhase5Substep(task.id, 'parity-tests')) {
      const parityCtx = await this.contextBuilder.buildContext(
        'parity-verifier',
        5,
        task.id,
        {
          sourceFile: task.sourceFiles[0],
          targetFile: task.targetFiles[0],
          ...this.taskScopePayload(task),
        },
      );
      const testCtx = await this.contextBuilder.buildContext(
        'test-writer',
        5,
        task.id,
        {
          targetFile: task.targetFiles[0],
          kbEntry: task.knowledgeBaseRef,
          testType: 'unit',
          ...this.taskScopePayload(task),
        },
      );

      const parallel = new ParallelExecutor(
        2,
        (inv) => this.launchAgentWithEvents(inv),
        this.logger,
      );
      const [parityResult, testResult] = await parallel.executeAll([
        this.buildInvocation('parity-verifier', parityCtx, 5, task.id),
        this.buildInvocation('test-writer', testCtx, 5, task.id),
      ]);
      this._peakConcurrency = Math.max(this._peakConcurrency, parallel.peakConcurrency);
      if (parityResult) {
        this.recordTokens(parityResult, 5);
        this.storeParityResult(parityResult, task.id);
      }
      if (testResult) this.recordTokens(testResult, 5);
      if (testResult?.success) {
        await this.commitForAgent('test-writer', 5, task.id, task.name);
      }
      await this.markPhase5Substep(task.id, 'parity-tests');
    }

    const gateMode = this.getQualityGateMode();

    // b2. Check parity result and retry if non-minor issues found
    if (gateMode !== 'skip' && !this.hasPhase5Substep(task.id, 'parity-gate')) {
      const maxParityRetries = this.config.options.maxRetriesPerTask;
      let parityPassed = this.checkParityResult(task.id);

      if (!parityPassed && gateMode === 'enforce') {
        const priorAttempts: Array<{ attempt: number; issueCount: number; unresolvedIssues: string[] }> = [];

        for (let attempt = 1; attempt <= maxParityRetries; attempt++) {
          // Build an enriched failure summary from the actual parity result
          const issueSummary = this.getParityIssueSummary(task.id);
          const enrichedSummary = issueSummary
            ? `Parity verification failed for ${task.id}: ${issueSummary}`
            : `Parity verification failed for ${task.id}`;

          // Get structured parity issues for the remediation context
          const storedParityResult = this._parityResults.get(task.id);
          const parityIssues = storedParityResult?.issues ?? [];

          const parityRemediation = this.buildRemediationContext({
            failureKind: 'parity',
            failureSummary: enrichedSummary,
            taskId: task.id,
            check: 'parity-verifier',
            artifactPaths: [...task.sourceFiles, ...task.targetFiles],
            expectedSuccessCondition: `Parity checks pass (or only minor issues) for ${task.id}`,
          });

          // Attach structured parity issues and prior attempt history
          parityRemediation.parityIssues = parityIssues;
          if (priorAttempts.length > 0) {
            parityRemediation.priorAttempts = [...priorAttempts];
          }

          await this.recordRetryTarget({
            scope: 'parity',
            attempt,
            maxAttempts: maxParityRetries,
            taskId: task.id,
            check: 'parity-verifier',
            summary: enrichedSummary,
          });

          const recoveryCtx = await this.contextBuilder.buildContext(
            'parity-failure-resolver',
            5,
            task.id,
            {
              failureReport: enrichedSummary,
              sourceFile: task.sourceFiles[0],
              targetFile: task.targetFiles[0],
              kbEntry: task.knowledgeBaseRef,
              attemptNumber: attempt,
              ...this.taskScopePayload(task),
              remediationContext: toAgentRemediationContext(parityRemediation),
            },
          );
          const recoveryInv = this.buildInvocation('parity-failure-resolver', recoveryCtx, 5, task.id);
          const recoveryResult = await this.launchAgentWithEvents(recoveryInv);
          this.recordTokens(recoveryResult, 5);

          if (!recoveryResult.success) {
            this.logger.warn(`Parity-failure-resolver failed for ${task.id} on attempt ${attempt}`);
            continue;
          }

          // If the resolver determined all remaining issues are outside the
          // task's declared scope, accept the verdict and stop the retry loop.
          if (this.resolverReducedScope(recoveryResult)) {
            this.logger.info(
              `Parity-failure-resolver adjudicated remaining issues as out-of-scope for ${task.id} — accepting verdict`,
            );
            parityPassed = true;
            break;
          }

          // Commit any fixes the resolver applied, then re-verify parity
          await this.commitForAgent('parity-failure-resolver', 5, task.id, task.name);

          // Re-run parity-verifier
          const reParityCtx = await this.contextBuilder.buildContext(
            'parity-verifier',
            5,
            task.id,
            {
              sourceFile: task.sourceFiles[0],
              targetFile: task.targetFiles[0],
              ...this.taskScopePayload(task),
            },
          );
          const reParityInv = this.buildInvocation('parity-verifier', reParityCtx, 5, task.id);
          const reParityResult = await this.launchAgentWithEvents(reParityInv);
          this.recordTokens(reParityResult, 5);
          this.storeParityResult(reParityResult, task.id);

          parityPassed = this.checkParityResult(task.id);
          if (parityPassed) {
            this.logger.info(`Parity recovered for ${task.id} on attempt ${attempt}`);
            break;
          }

          // Record this attempt's outcome for next iteration's context
          const storedResult = this._parityResults.get(task.id);
          const unresolvedIssues = (storedResult?.issues ?? [])
            .filter((i) => i.severity !== 'minor')
            .map((i) => i.description);
          priorAttempts.push({
            attempt,
            issueCount: storedResult?.issues?.length ?? 0,
            unresolvedIssues,
          });
        }

        // After exhausting retries, check if only minor issues remain
        if (!parityPassed) {
          const hasBlockingIssues = this.hasNonMinorParityIssues(task.id);
          if (hasBlockingIssues) {
            await this.raiseTerminalExhaustion({
              reasonCode: 'parity-non-minor-exhausted',
              taskId: task.id,
              check: 'parity-verifier',
              summary: `Parity verification still has non-minor issues after ${maxParityRetries} attempt(s)`,
            });
          }
          this.logger.info(
            `Parity for ${task.id} has only minor issues after retries, proceeding`,
          );
        }
      } else if (!parityPassed) {
        this.logger.warn(
          `Parity check failed for ${task.id}, deferring strict enforcement to wave-end/final gates (qualityPolicy=${this.config.options.qualityPolicy})`,
        );
      }
      await this.markPhase5Substep(task.id, 'parity-gate');
    }

    // b3. Minor-issue re-pass — run code-migrator one more time when only minor issues remain
    if (gateMode !== 'skip' && !this.hasPhase5Substep(task.id, 'minor-parity-repass')) {
      const currentResult = this._parityResults.get(task.id);
      if (
        currentResult &&
        currentResult.issues.length > 0 &&
        currentResult.issues.every((i) => i.severity === 'minor')
      ) {
        this.logger.info(
          `${task.id} has ${currentResult.issues.length} minor parity issue(s) — running code-migrator once more to address them`,
        );

        const minorIssueDescriptions = currentResult.issues.map((i) => i.description).join('; ');
        const minorRemediation = this.buildRemediationContext({
          failureKind: 'parity-minor',
          failureSummary: `Minor parity issues remain for ${task.id}: ${minorIssueDescriptions}`,
          taskId: task.id,
          check: 'parity-verifier',
          artifactPaths: [...task.sourceFiles, ...task.targetFiles],
          expectedSuccessCondition: `All minor parity issues resolved for ${task.id}`,
        });

        const repassCtx = await this.contextBuilder.buildContext(
          'code-migrator',
          5,
          task.id,
          {
            sourceFiles: task.sourceFiles,
            targetFiles: task.targetFiles,
            kbEntry: task.knowledgeBaseRef,
            ...this.taskScopePayload(task),
            remediationContext: toAgentRemediationContext(minorRemediation),
          },
        );
        const repassInv = this.buildInvocation('code-migrator', repassCtx, 5, task.id);
        const repassResult = await this.launchAgentWithEvents(repassInv);
        this.recordTokens(repassResult, 5);

        if (repassResult.success) {
          await this.commitForAgent('code-migrator', 5, task.id, task.name);

          // Re-run parity-verifier to check if minor issues were resolved
          const reParityCtx = await this.contextBuilder.buildContext(
            'parity-verifier',
            5,
            task.id,
            {
              sourceFile: task.sourceFiles[0],
              targetFile: task.targetFiles[0],
              ...this.taskScopePayload(task),
            },
          );
          const reParityInv = this.buildInvocation('parity-verifier', reParityCtx, 5, task.id);
          const reParityResult = await this.launchAgentWithEvents(reParityInv);
          this.recordTokens(reParityResult, 5);
          this.storeParityResult(reParityResult, task.id);

          const repassParity = this._parityResults.get(task.id);
          if (repassParity?.parity === 'pass' || (repassParity && repassParity.issues.length === 0)) {
            this.logger.info(`Minor parity issues fully resolved for ${task.id}`);
          } else if (repassParity && repassParity.issues.every((i) => i.severity === 'minor')) {
            this.logger.info(
              `${task.id} still has ${repassParity.issues.length} minor issue(s) after re-pass — accepting as non-blocking`,
            );
          } else {
            // Re-pass unexpectedly introduced non-minor issues; restore the
            // original minor-only result so the task is not blocked.
            this.logger.warn(
              `${task.id} re-pass introduced non-minor issues — reverting to prior minor-only result`,
            );
            this._parityResults.set(task.id, currentResult);
          }
        } else {
          this.logger.warn(
            `Code-migrator re-pass failed for ${task.id} — proceeding with existing minor issues`,
          );
        }
      }
      await this.markPhase5Substep(task.id, 'minor-parity-repass');
    }

    if (mode === 'wave-migration') {
      return { migrated: true, durationMs: Date.now() - taskStartMs };
    }

    // c2. Run format command if configured (deterministic — always enforced)
    if (this.config.target.formatCommand) {
      if (!this.hasPhase5Substep(task.id, 'format')) {
        const formatResult = await this.runCommand('format', this.config.target.formatCommand, task.id);
        if (!formatResult.success) {
          this.logger.warn(
            `Format command failed for ${task.id}: ${formatResult.error ?? 'unknown error'}`,
          );
        }
        await this.markPhase5Substep(task.id, 'format');
      }
    }

    // c3. Run build command if configured
    //     When compilation units are in use, build checks only run once all
    //     tasks in the same unit are complete (the build can only succeed
    //     when the entire compilation unit is finished).
    if (this.config.target.buildCommand) {
      if (!this.hasPhase5Substep(task.id, 'build')) {
        const shouldBuild = this.shouldRunBuildCheck(task, queue);
        if (shouldBuild) {
          if (gateMode === 'enforce') {
            const buildOk = await this.runCommandWithRecovery(
              'build', this.config.target.buildCommand, task, queue,
            );
            if (!buildOk) return { migrated: false };
            await this.markPhase5Substep(task.id, 'build');
          } else if (gateMode === 'advisory') {
            const buildResult = await this.runCommand('build', this.config.target.buildCommand, task.id);
            if (!buildResult.success) {
              this.logger.warn(
                `Build check failed for ${task.id}, deferring strict enforcement to wave-end gate (qualityPolicy=${this.config.options.qualityPolicy}): ${buildResult.error ?? 'unknown error'}`,
              );
            }
            await this.markPhase5Substep(task.id, 'build');
          }
        } else {
          this.logger.info(
            `Deferring build check for ${task.id} — compilation unit "${task.compilationUnit}" has remaining tasks`,
          );
          await this.markPhase5Substep(task.id, 'build');
        }
      }
    }

    // c4. Run test command if configured
    if (this.config.target.testCommand) {
      if (!this.hasPhase5Substep(task.id, 'test')) {
        if (gateMode === 'enforce') {
          const testOk = await this.runCommandWithRecovery(
            'test', this.config.target.testCommand, task, queue,
          );
          if (!testOk) return { migrated: false };
          await this.markPhase5Substep(task.id, 'test');
        } else if (gateMode === 'advisory') {
          const testResult = await this.runCommand('test', this.config.target.testCommand, task.id);
          if (!testResult.success) {
            this.logger.warn(
              `Test check failed for ${task.id}, deferring strict enforcement to wave-end gate (qualityPolicy=${this.config.options.qualityPolicy}): ${testResult.error ?? 'unknown error'}`,
            );
          }
          await this.markPhase5Substep(task.id, 'test');
        }
      }
    }

    // d. Complete task
    const durationMs = Date.now() - taskStartMs;
    await this.completePhase5Task(task, queue, completedDurationsMs, durationMs, completionEventDurationMs);
    return { migrated: true, durationMs };
  }

  private buildWaveRecoveryTask(wave: number, waveCandidates: MigrationTask[]): MigrationTask {
    const sourceFiles = Array.from(new Set(waveCandidates.flatMap((task) => task.sourceFiles)));
    const targetFiles = Array.from(new Set(waveCandidates.flatMap((task) => task.targetFiles)));
    const representative = waveCandidates[0];
    return {
      id: `wave-${wave}`,
      name: `Wave ${wave} validation recovery`,
      sourceFiles,
      targetFiles,
      knowledgeBaseRef: representative?.knowledgeBaseRef ?? `wave-${wave}`,
      dependencies: [],
      complexity: 'moderate',
      description: `Recover wave ${wave} validation failure`,
      acceptanceCriteria: [`Wave ${wave} build/test validation passes`],
      parityChecks: ['wave-validation'],
      lineRange: representative?.lineRange,
    };
  }

  private async recoverWaveValidationFailure(
    wave: number,
    waveCandidates: MigrationTask[],
    queue: TaskQueue,
    validation: WaveValidationResult,
  ): Promise<boolean> {
    if (validation.success) return true;
    const failedLabel = validation.failedLabel;
    const failedCommand = validation.failedCommand;
    const failure = validation.failure;
    if (!failedLabel || !failedCommand || !failure || failure.success) return false;

    const waveTask = this.buildWaveRecoveryTask(wave, waveCandidates);
    const artifactPaths = Array.from(
      new Set(waveCandidates.flatMap((task) => [...task.sourceFiles, ...task.targetFiles])),
    );

    return this.runCommandWithRecovery(
      failedLabel,
      failedCommand,
      waveTask,
      queue,
      {
        initialFailure: failure,
        wave,
        retryScope: 'wave',
        artifactPaths,
        suppressTerminalOnExhaustion: true,
        failureSummary: failure.error ?? `Wave ${wave} ${failedLabel} validation failed`,
        expectedSuccessCondition: `Wave ${wave} ${failedLabel} validation passes`,
      },
    );
  }

  private async runWaveValidation(wave: number): Promise<WaveValidationResult> {
    if (this.phase5Snapshot) {
      this.phase5Snapshot.waveValidationRuns++;
    }
    const waveTaskId = `wave-${wave}`;

    // Format first — normalize code before build/test/lint
    if (this.config.target.formatCommand) {
      const format = await this.runCommand('format', this.config.target.formatCommand, waveTaskId);
      if (!format.success) {
        this.logger.warn(`Wave ${wave} format command failed (non-gating): ${format.error ?? 'unknown'}`);
      }
    }

    if (this.config.target.buildCommand) {
      const build = await this.runCommand('build', this.config.target.buildCommand, waveTaskId);
      if (!build.success) {
        return {
          success: false,
          failedLabel: 'build',
          failedCommand: this.config.target.buildCommand,
          failure: build,
        };
      }
    }

    if (this.config.target.testCommand) {
      const test = await this.runCommand('test', this.config.target.testCommand, waveTaskId);
      if (!test.success) {
        return {
          success: false,
          failedLabel: 'test',
          failedCommand: this.config.target.testCommand,
          failure: test,
        };
      }
    }

    return { success: true };
  }

  private async blockWaveTask(
    task: MigrationTask,
    queue: TaskQueue,
    reason: string,
  ): Promise<void> {
    if (queue.isTaskBlocked(task.id) || queue.isTaskCompleted(task.id)) return;
    queue.markBlocked(task.id);
    await this.checkpoint.blockTask(task.id);
    await this.progress.updateTask(task.id, 'blocked', { error: reason });
    this.logger.event({
      type: 'task-blocked',
      taskId: task.id,
      name: task.name,
      reason,
    });
  }

  private async completePhase5Task(
    task: MigrationTask,
    queue: TaskQueue,
    completedDurationsMs: number[],
    durationMs: number,
    eventDurationMs: number = durationMs,
  ): Promise<void> {
    queue.complete(task.id);
    await this.checkpoint.completeTask(task.id, durationMs);
    completedDurationsMs.push(durationMs);

    const progress = queue.getProgress();
    await this.progress.updateTask(task.id, 'completed', {
      sourceFiles: task.sourceFiles,
      targetFiles: task.targetFiles,
    });
    this.logger.event({
      type: 'task-completed',
      taskId: task.id,
      name: task.name,
      duration: eventDurationMs,
    });

    let progressMsg = `Task progress: ${progress.completed}/${progress.total} (${progress.blocked} blocked)`;
    if (completedDurationsMs.length >= 2) {
      const avgMs = completedDurationsMs.reduce((a, b) => a + b, 0) / completedDurationsMs.length;
      const etaMs = progress.remaining * avgMs;
      progressMsg += ` — avg ${formatDuration(avgMs)}/task, ~${formatDuration(etaMs)} remaining`;
    }
    this.logger.info(progressMsg);

    await this.commitForTask(task);
  }

  // ─── Phase 6: Final Parity Verification ──────────────────────────────

  private async executePhase6(start: number): Promise<PhaseResult> {
    const MAX_LOOPBACK = 2;
    const phase6Cursor = this.getPhase6Cursor();
    if (phase6Cursor.lastSuccessfulStep === 'complete' || phase6Cursor.iteration > MAX_LOOPBACK) {
      const outputPath = this.config.target.outputPath;
      if (phase6Cursor.hadUnresolvedFixes) {
        return {
          phase: 6,
          name: 'Final Parity Verification',
          success: false,
          outputPath,
          duration: Date.now() - start,
          error: 'Phase 6 previously completed with unresolved parity fixes',
        };
      }
      return {
        phase: 6,
        name: 'Final Parity Verification',
        success: true,
        outputPath,
        duration: Date.now() - start,
      };
    }
    const startIteration = Math.min(phase6Cursor.iteration, MAX_LOOPBACK);
    let lastIterationFixes: Array<{ description: string; sourceFile: string; targetFile: string }> = [];
    let loopBrokeEarly = false;

    for (let iteration = startIteration; iteration <= MAX_LOOPBACK; iteration++) {
      if (iteration !== phase6Cursor.iteration) {
        await this.savePhase6Cursor({
          iteration,
          fixIndex: 0,
          lastSuccessfulStep: 'iteration-started',
        });
      }
      const ctx = await this.contextBuilder.buildContext('final-parity-checker', 6);
      const inv = this.buildInvocation('final-parity-checker', ctx, 6);
      const result = await this.launchAgentWithEvents(inv);
      this.recordTokens(result, 6);

      if (!result.success) {
        return {
          phase: 6,
          name: 'Final Parity Verification',
          success: false,
          duration: Date.now() - start,
          error: result.error,
          exitCode: result.exitCode,
          stderr: result.stderr,
        };
      }

      // Parse report for required fixes — must come from structuredOutput
      let fixes: Array<{ description: string; sourceFile: string; targetFile: string }>;
      if (result.outputParsed && Array.isArray(result.structuredOutput?.['fixes'])) {
        fixes = result.structuredOutput['fixes'] as Array<{ description: string; sourceFile: string; targetFile: string }>;
      } else {
        this.logger.warn('Final-parity-checker structured output unavailable — treating as agent failure');
        return {
          phase: 6,
          name: 'Final Parity Verification',
          success: false,
          duration: Date.now() - start,
          error: 'Final-parity-checker did not produce structured aamf-json output with fixes array',
        };
      }
      if (fixes.length === 0) {
        lastIterationFixes = fixes;
        loopBrokeEarly = true;
        await this.savePhase6Cursor({
          iteration: iteration + 1,
          fixIndex: 0,
          lastSuccessfulStep: 'no-fixes',
        });
        break;
      }
      lastIterationFixes = fixes;

      if (iteration < MAX_LOOPBACK) {
        this.logger.info(
          `Final parity found ${fixes.length} issue(s), loop-back iteration ${iteration + 1}`,
        );
        const resumeFixIndex =
          iteration === phase6Cursor.iteration ? Math.max(0, phase6Cursor.fixIndex) : 0;
        // Create targeted fix tasks and re-migrate
        for (let fixIndex = resumeFixIndex; fixIndex < fixes.length; fixIndex++) {
          const fix = fixes[fixIndex]!;
          const fixTaskId = `fix-${iteration}-${fixIndex}`;
          await this.savePhase6Cursor({
            iteration,
            fixIndex,
            lastSuccessfulStep: 'fix-started',
          });
          const fixRemediation = this.buildRemediationContext({
            failureKind: 'parity',
            failureSummary: fix.description,
            taskId: fixTaskId,
            check: 'final-parity-checker',
            artifactPaths: [
              ...(fix.sourceFile ? [fix.sourceFile] : []),
              ...(fix.targetFile ? [fix.targetFile] : []),
            ],
            expectedSuccessCondition: `Parity issue resolved: ${fix.description}`,
          });

          const fixCtx = await this.contextBuilder.buildContext(
            'code-migrator',
            5,
            fixTaskId,
            {
              sourceFiles: fix.sourceFile ? [fix.sourceFile] : [],
              targetFiles: fix.targetFile ? [fix.targetFile] : [],
              taskScope: {
                description: `Fix parity issue: ${fix.description}`,
                acceptanceCriteria: [fix.description],
                parityChecks: [fix.description],
              },
              remediationContext: toAgentRemediationContext(fixRemediation),
            },
          );
          const fixInv = this.buildInvocation(
            'code-migrator',
            fixCtx,
            6,
            fixTaskId,
          );
          const fixResult = await this.launchAgentWithEvents(fixInv);
          this.recordTokens(fixResult, 6);
          if (fixResult.success) {
            await this.commitForAgent('code-migrator', 6, fixTaskId);
            await this.savePhase6Cursor({
              iteration,
              fixIndex: fixIndex + 1,
              lastSuccessfulStep: 'fix-applied',
            });
          }
        }
        await this.savePhase6Cursor({
          iteration: iteration + 1,
          fixIndex: 0,
          lastSuccessfulStep: 'iteration-complete',
        });
      } else {
        this.logger.warn('Max loop-back iterations reached, proceeding with remaining issues');
      }
    }

    const hadUnresolvedFixes = !loopBrokeEarly && lastIterationFixes.length > 0;

    await this.savePhase6Cursor({
      iteration: MAX_LOOPBACK + 1,
      fixIndex: 0,
      lastSuccessfulStep: 'complete',
      hadUnresolvedFixes,
    });

    const outputPath = join(this.paths.artifactsParityDir, 'final-parity-report.md');

    if (hadUnresolvedFixes) {
      const summary = lastIterationFixes
        .slice(0, 5)
        .map((f) => f.description)
        .join('; ');
      return {
        phase: 6,
        name: 'Final Parity Verification',
        success: false,
        outputPath,
        duration: Date.now() - start,
        error: `${lastIterationFixes.length} unresolved parity fix(es) after ${MAX_LOOPBACK + 1} iterations: ${summary}`,
      };
    }

    return {
      phase: 6,
      name: 'Final Parity Verification',
      success: true,
      outputPath,
      duration: Date.now() - start,
    };
  }

  // ─── Phase 7: E2E Testing & Documentation ────────────────────────────

  private async executePhase7(start: number): Promise<PhaseResult> {
    const phase7Cursor = this.getPhase7Cursor();
    const completedAgents = new Set(phase7Cursor.completedAgents);
    const completedSuites = new Set(phase7Cursor.completedSuites);

    const results: AgentResult[] = [];

    const skipAsCompleted = (agent: AgentName): AgentResult => ({
      agent,
      exitCode: 0,
      success: true,
      outputFiles: [],
      duration: 0,
      outputParsed: false,
    });

    const saveCursor = async (step: string): Promise<void> => {
      await this.savePhase7Cursor({
        completedAgents: Array.from(completedAgents),
        completedSuites: Array.from(completedSuites),
        lastSuccessfulStep: step,
      });
    };

    // ─── Stage 1: Invoke e2e-test-crafter in plan-only mode ───
    if (completedAgents.has('e2e-test-crafter')) {
      results.push(skipAsCompleted('e2e-test-crafter'));
    } else {
      const e2eCtx = await this.contextBuilder.buildContext(
        'e2e-test-crafter', 6, undefined, { planOnly: true },
      );
      const crafterResult = await this.launchAgentWithEvents(
        this.buildInvocation('e2e-test-crafter', e2eCtx, 7),
      );
      results.push(crafterResult);
      this.recordTokens(crafterResult, 7);

      if (crafterResult.success) {
        if (this.isGitAutomationEnabled()) {
          await this.commitForAgent('e2e-test-crafter', 7);
        }
        completedAgents.add('e2e-test-crafter');
        await saveCursor('completed-e2e-test-crafter');
      } else {
        return {
          phase: 7,
          name: 'E2E Testing & Documentation',
          success: false,
          outputPath: this.config.target.outputPath,
          duration: Date.now() - start,
          error: crafterResult.error ?? 'e2e-test-crafter failed',
        };
      }
    }

    // ─── Stage 2: Parse e2e-test-plan.md into suites ───
    const planPath = join(this.config.target.outputPath, 'e2e', 'e2e-test-plan.md');
    let suites: E2eSuiteBrief[] = [];
    if (await fileExists(planPath)) {
      suites = await parseE2eTestPlan(planPath);
    } else {
      this.logger.warn('No e2e-test-plan.md found; skipping suite fan-out');
    }

    // ─── Stage 3: Fan out test-writer per suite ───
    // When git is disabled, doc-writer runs in parallel with suite fan-out (Stage 3+4 combined).
    // When git is enabled, doc-writer runs sequentially after suites (Stage 4).
    let docWriterHandled = false;

    if (suites.length === 0) {
      this.logger.warn('E2E test plan contains zero suites — skipping test-writer fan-out');
    } else {
      const pendingSuites = suites.filter((s) => !completedSuites.has(s.id));

      if (pendingSuites.length === 0) {
        // All suites already done (resume scenario)
        this.logger.info('All E2E suites already completed — skipping fan-out');
      } else if (suites.length === 1) {
        // Single suite: direct invocation (backwards compat, no ParallelExecutor overhead)
        const suite = pendingSuites[0]!;
        const suiteResult = await this.executeSuiteWithRetry(suite, completedAgents, completedSuites);
        results.push(suiteResult);
      } else if (this.isGitAutomationEnabled()) {
        // Multi-suite with git: sequential to avoid concurrent git mutations
        for (const suite of pendingSuites) {
          if (this.isSuiteBudgetExceeded(suite.id)) break;
          const suiteResult = await this.executeSuiteWithRetry(suite, completedAgents, completedSuites);
          results.push(suiteResult);
        }
      } else {
        // Multi-suite without git: parallel fan-out with doc-writer running concurrently
        const suitePromise = this.executeParallelSuiteFanOut(
          pendingSuites, suites, results, completedAgents, completedSuites,
        );
        const docPromise = this.executeDocumentationWriter(
          completedAgents, results, skipAsCompleted, saveCursor,
        );
        await Promise.all([suitePromise, docPromise]);
        docWriterHandled = true;
      }
    }

    // ─── Stage 4: Documentation writer (sequential when git enabled or non-parallel paths) ───
    if (!docWriterHandled) {
      await this.executeDocumentationWriter(completedAgents, results, skipAsCompleted, saveCursor);
    }

    const allSuccess = results.every((r) => r.success);
    const errors = results.filter((r) => !r.success).map((r) => r.error);

    if (allSuccess) {
      await saveCursor('complete');
    }

    return {
      phase: 7,
      name: 'E2E Testing & Documentation',
      success: allSuccess,
      outputPath: this.config.target.outputPath,
      duration: Date.now() - start,
      error: errors.length > 0 ? errors.join('; ') : undefined,
    };
  }

  /**
   * Execute a single E2E test suite with retry and per-suite checkpointing.
   * On success, commits (when git enabled), updates the cursor, and records tokens.
   */
  private async executeSuiteWithRetry(
    suite: E2eSuiteBrief,
    completedAgents: Set<string>,
    completedSuites: Set<string>,
  ): Promise<AgentResult> {
    if (this.isSuiteBudgetExceeded(suite.id)) {
      return {
        agent: 'test-writer',
        taskId: suite.id,
        exitCode: 1,
        success: false,
        outputFiles: [],
        duration: 0,
        outputParsed: false,
        error: `Token budget exceeded before suite ${suite.id}`,
      };
    }

    const suiteCtx = await this.contextBuilder.buildContext(
      'test-writer', 6, suite.id, { e2eSuiteBrief: suite },
    );
    const retryExec = new RetryExecutor(
      (inv) => this.launchAgentWithEvents(inv),
      this.logger,
    );
    const suiteResult = await retryExec.executeWithRetry(
      this.buildInvocation('test-writer', suiteCtx, 7, suite.id),
      { maxAttempts: this.config.options.maxRetriesPerTask },
    );
    this.recordTokens(suiteResult, 7);

    if (suiteResult.success) {
      if (this.isGitAutomationEnabled()) {
        await this.commitForAgent('test-writer', 7, suite.id, suite.name);
      }
      completedSuites.add(suite.id);
      await this.savePhase7Cursor({
        completedAgents: Array.from(completedAgents),
        completedSuites: Array.from(completedSuites),
        lastSuccessfulStep: `completed-suite-${suite.id}`,
      });
    }

    return suiteResult;
  }

  /** Check whether the token budget has been exceeded before launching a suite. */
  private isSuiteBudgetExceeded(suiteId: string): boolean {
    if (!this.config.options.tokenBudget) return false;
    const threshold = this.tokenTracker.checkThreshold(this.config.options.tokenBudget);
    if (threshold === 'exceeded') {
      this.logger.warn(`Token budget exceeded before suite ${suiteId} — skipping remaining suites`);
      return true;
    }
    return false;
  }

  /**
   * Multi-suite parallel fan-out using ParallelExecutor with per-suite retry.
   * Used when git automation is disabled, allowing concurrent execution.
   */
  private async executeParallelSuiteFanOut(
    pendingSuites: E2eSuiteBrief[],
    allSuites: E2eSuiteBrief[],
    results: AgentResult[],
    completedAgents: Set<string>,
    completedSuites: Set<string>,
  ): Promise<void> {
    // Pre-flight budget check: skip suites that can't start
    const budgetFilteredSuites = pendingSuites.filter((s) => !this.isSuiteBudgetExceeded(s.id));
    if (budgetFilteredSuites.length === 0) return;

    const invocations: AgentInvocation[] = [];
    for (const suite of budgetFilteredSuites) {
      const suiteCtx = await this.contextBuilder.buildContext(
        'test-writer', 6, suite.id, { e2eSuiteBrief: suite },
      );
      invocations.push(this.buildInvocation('test-writer', suiteCtx, 7, suite.id));
    }

    const retryExec = new RetryExecutor(
      (inv) => this.launchAgentWithEvents(inv),
      this.logger,
    );
    const parallel = new ParallelExecutor(
      Math.min(this.config.options.maxE2eSuiteConcurrency ?? this.config.options.maxParallelAgents, budgetFilteredSuites.length),
      (inv) => retryExec.executeWithRetry(inv, {
        maxAttempts: this.config.options.maxRetriesPerTask,
      }),
      this.logger,
    );

    const parallelResults = await parallel.executeAll(invocations);
    this._peakConcurrency = Math.max(this._peakConcurrency, parallel.peakConcurrency);

    for (let i = 0; i < parallelResults.length; i++) {
      const suite = budgetFilteredSuites[i]!;
      const result = parallelResults[i]!;
      results.push(result);
      this.recordTokens(result, 7);
      if (result.success) {
        completedSuites.add(suite.id);
      }
    }

    await this.savePhase7Cursor({
      completedAgents: Array.from(completedAgents),
      completedSuites: Array.from(completedSuites),
      lastSuccessfulStep: completedSuites.size === allSuites.length
        ? 'all-suites-complete'
        : `completed-${completedSuites.size}-of-${allSuites.length}-suites`,
    });
  }

  /** Run documentation-writer, recording tokens and committing if git enabled. */
  private async executeDocumentationWriter(
    completedAgents: Set<string>,
    results: AgentResult[],
    skipAsCompleted: (agent: AgentName) => AgentResult,
    saveCursor: (step: string) => Promise<void>,
  ): Promise<void> {
    if (completedAgents.has('documentation-writer')) {
      results.push(skipAsCompleted('documentation-writer'));
      return;
    }
    const docCtx = await this.contextBuilder.buildContext('documentation-writer', 7);
    const docResult = await this.launchAgentWithEvents(
      this.buildInvocation('documentation-writer', docCtx, 7),
    );
    results.push(docResult);
    this.recordTokens(docResult, 7);
    if (docResult.success) {
      if (this.isGitAutomationEnabled()) {
        await this.commitForAgent('documentation-writer', 7);
      }
      completedAgents.add('documentation-writer');
      await saveCursor('completed-documentation-writer');
    }
  }

  // ─── Phase 9: Completion ─────────────────────────────────────────────

  private async executePhase9(start: number): Promise<PhaseResult> {
    await this.progress.appendEvent('Migration pipeline complete — finalizing');
    this.logger.info('All phases complete');

    return {
      phase: 9,
      name: 'Completion',
      success: true,
      outputPath: this.progressDir,
      duration: Date.now() - start,
    };
  }

  // ─── Phase 8: Idiomatic Refactor ─────────────────────────────────────

  private async executePhase8(start: number): Promise<PhaseResult> {
    const maxIterations = this.config.options.idiomaticRefactor?.maxIterations ?? 2;
    const phase8Cursor = this.getPhase8Cursor();
    if (phase8Cursor.lastSuccessfulStep === 'complete' || phase8Cursor.iteration >= maxIterations) {
      return {
        phase: 8,
        name: 'Idiomatic Refactor',
        success: true,
        outputPath: this.config.target.outputPath,
        duration: Date.now() - start,
      };
    }
    const startIteration = Math.min(phase8Cursor.iteration, Math.max(0, maxIterations - 1));

    for (let iteration = startIteration; iteration < maxIterations; iteration++) {
      if (iteration !== phase8Cursor.iteration) {
        await this.savePhase8Cursor({
          iteration,
          issueIndex: 0,
          lastSuccessfulStep: 'iteration-started',
        });
      }
      const reviewCtx = await this.contextBuilder.buildContext('idiomatic-reviewer', 8);
      const reviewInv = this.buildInvocation('idiomatic-reviewer', reviewCtx, 8);
      const reviewResult = await this.launchAgentWithEvents(reviewInv);
      this.recordTokens(reviewResult, 8);

      if (!reviewResult.success) {
        return {
          phase: 8,
          name: 'Idiomatic Refactor',
          success: false,
          duration: Date.now() - start,
          error: reviewResult.error,
          exitCode: reviewResult.exitCode,
          stderr: reviewResult.stderr,
        };
      }

      // Parse idiomatic issues — must come from structuredOutput
      let issues: Array<{ file: string; location: string; issue: string; suggestion: string; details: string }>;
      if (reviewResult.outputParsed && Array.isArray(reviewResult.structuredOutput?.['issues'])) {
        issues = reviewResult.structuredOutput['issues'] as Array<{ file: string; location: string; issue: string; suggestion: string; details: string }>;
      } else {
        this.logger.warn('Idiomatic-reviewer structured output unavailable — treating as agent failure');
        return {
          phase: 8,
          name: 'Idiomatic Refactor',
          success: false,
          duration: Date.now() - start,
          error: 'Idiomatic-reviewer did not produce structured aamf-json output with issues array',
        };
      }

      if (issues.length === 0) {
        await this.savePhase8Cursor({
          iteration: iteration + 1,
          issueIndex: 0,
          lastSuccessfulStep: 'no-issues',
        });
        break;
      }

      if (iteration < maxIterations - 1) {
        this.logger.info(
          `Idiomatic review found ${issues.length} issue(s), refactor iteration ${iteration + 1}`,
        );
        const resumeIssueIndex =
          iteration === phase8Cursor.iteration ? Math.max(0, phase8Cursor.issueIndex) : 0;
        for (let issueIndex = resumeIssueIndex; issueIndex < issues.length; issueIndex++) {
          const issue = issues[issueIndex]!;
          await this.savePhase8Cursor({
            iteration,
            issueIndex,
            currentFile: issue.file,
            lastSuccessfulStep: 'refactor-started',
          });
          const refactorCtx = await this.contextBuilder.buildContext('idiomatic-refactorer', 8, undefined, {
            targetFile: issue.file,
            issue, // structured: { file, location, issue, suggestion, details }
          });
          const refactorInv = this.buildInvocation('idiomatic-refactorer', refactorCtx, 8);
          const refactorResult = await this.launchAgentWithEvents(refactorInv);
          this.recordTokens(refactorResult, 8);
          if (refactorResult.success) {
            // Format after refactor to normalize code style
            if (this.config.target.formatCommand) {
              const fmtResult = await this.runCommand('format', this.config.target.formatCommand, `phase8-${issue.file}`);
              if (!fmtResult.success) {
                this.logger.warn(`Phase 8 format failed for ${issue.file}: ${fmtResult.error ?? 'unknown'}`);
              }
            }
            await this.commitForAgent('idiomatic-refactorer', 8, issue.file);
            // Lint after refactor — failure is gating in Phase 8
            if (this.config.target.lintCommand) {
              const lintResult = await this.runCommand('lint', this.config.target.lintCommand, `phase8-${issue.file}`);
              if (!lintResult.success) {
                this.logger.warn(`Phase 8 lint failed after refactoring ${issue.file}: ${lintResult.error ?? 'unknown'}`);
              }
            }
            await this.savePhase8Cursor({
              iteration,
              issueIndex: issueIndex + 1,
              lastSuccessfulStep: 'refactor-complete',
            });
          }
          if (!refactorResult.success) {
            return {
              phase: 8,
              name: 'Idiomatic Refactor',
              success: false,
              duration: Date.now() - start,
            };
          }
        }
        await this.savePhase8Cursor({
          iteration: iteration + 1,
          issueIndex: 0,
          lastSuccessfulStep: 'iteration-complete',
        });
      } else {
        this.logger.warn('Max idiomatic refactor iterations reached, proceeding with remaining issues');
      }
    }

    await this.savePhase8Cursor({
      iteration: maxIterations,
      issueIndex: 0,
      lastSuccessfulStep: 'complete',
    });

    const outputPath = this.config.target.outputPath;
    return {
      phase: 8,
      name: 'Idiomatic Refactor',
      success: true,
      outputPath,
      duration: Date.now() - start,
    };
  }

  /**
   * Run an external command (build or test) and return success/failure.
   * Logs output to the agent log directory.
   *
   * The command is executed through the build semaphore so that concurrent
   * build/test invocations don't exceed `buildConcurrency`.
   */
  private async runCommand(
    label: string,
    command: string,
    taskId: string,
  ): Promise<CommandExecutionResult> {
    if (this.phase5Snapshot) {
      if (label === 'build') this.phase5Snapshot.buildCommandRuns++;
      if (label === 'test') this.phase5Snapshot.testCommandRuns++;
      if (label === 'format') this.phase5Snapshot.formatCommandRuns++;
      if (label === 'lint') this.phase5Snapshot.lintCommandRuns++;
    }
    return this.buildLimiter(async () => {
      const timeout = this.getRuntimeTimeout();
      this.logger.info(`Running ${label} command for task ${taskId}: ${command}`);

      try {
        // Use shell mode to handle complex commands
        const resolvedPath = this.launcher.getResolvedPath();
        const result = await spawnWithTimeout('sh', ['-c', command], {
          cwd: this.config.target.outputPath,
          timeout,
          env: {
            ...process.env,
            ...(resolvedPath ? { PATH: resolvedPath } : {}),
          },
        });

        // Log the output
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const commandLogDir = {
          build: this.paths.logsCommandBuildDir,
          test: this.paths.logsCommandTestDir,
          format: this.paths.logsCommandFormatDir,
          lint: this.paths.logsCommandLintDir,
        }[label] ?? this.paths.logsCommandBuildDir;
        await ensureDir(commandLogDir);
        const logPath = join(commandLogDir, `${taskId}-${timestamp}.log`);
        const logContent = `=== COMMAND: ${command} ===\n=== EXIT CODE: ${result.exitCode} ===\n\n=== STDOUT ===\n${result.stdout}\n\n=== STDERR ===\n${result.stderr}\n`;
        await atomicWrite(logPath, logContent);

        if (result.exitCode !== 0 || result.killed) {
          const combinedOutput = `${result.stdout}\n${result.stderr}`;
          const errorText = result.killed
            ? `${label} failed (timed out after ${timeout}ms). See full output: ${logPath}`
            : `${label} failed (exit code ${result.exitCode}). See full output: ${logPath}`;
          this.logger.error(errorText);

          // Classify the error: infrastructure vs. code quality
          const infraLabel = classifyError(combinedOutput);

          return {
            success: false,
            error: errorText,
            infraError: infraLabel,
            rawError: combinedOutput,
            logPath,
          };
        }

        this.logger.info(`${label} command succeeded for task ${taskId}`);
        return { success: true };
      } catch (err) {
        const errorText = `${label} command error: ${err instanceof Error ? err.message : String(err)}`;
        this.logger.error(errorText);
        const infraLabel = classifyError(errorText);
        return { success: false, error: errorText, infraError: infraLabel };
      }
    });
  }

  /**
   * Run a build or test command with a recovery loop.
   *
   * Infrastructure errors (file locks, OOM, network, etc.) are retried with
   * simple exponential backoff and do **not** consume the `maxRetriesPerTask`
   * budget or invoke the expensive parity-failure-resolver agent.
   *
   * Genuine code-quality failures go through the full recovery pipeline:
   * `parity-failure-resolver` → `code-migrator` → re-run command.
   *
   * After exhausting all retry budgets Phase 5 fails fast with a terminal reason.
   *
   * Returns `true` if the command eventually passes.
   */
  private async runCommandWithRecovery(
    label: string,
    command: string,
    task: MigrationTask,
    queue: TaskQueue,
    options?: {
      initialFailure?: CommandExecutionResult;
      wave?: number;
      retryScope?: RetryTargetDetails['scope'];
      artifactPaths?: string[];
      failureSummary?: string;
      expectedSuccessCondition?: string;
      suppressTerminalOnExhaustion?: boolean;
    },
  ): Promise<boolean> {
    const maxAttempts = this.config.options.maxRetriesPerTask;
    const maxInfraRetries = this.config.options.maxInfraRetries ?? 3;
    const retryScope = options?.retryScope ?? 'command';
    const artifactPaths = options?.artifactPaths ?? [...task.sourceFiles, ...task.targetFiles];
    const expectedSuccessCondition = options?.expectedSuccessCondition ?? `${label} command succeeds for ${task.id}`;

    // Initial attempt
    let cmdResult = options?.initialFailure ?? await this.runCommand(label, command, task.id);
    if (cmdResult.success) return true;
    const recoveryLoopStartedAt = Date.now();

    // Infrastructure retry loop — simple backoff, no recovery agent
    let infraAttempt = 0;
    while (cmdResult.infraError && infraAttempt < maxInfraRetries) {
      infraAttempt++;
      if (this.phase5Snapshot) {
        this.phase5Snapshot.commandInfraRetries++;
      }
      const backoffMs = Math.min(1000 * Math.pow(2, infraAttempt - 1), 30_000);
      this.logger.warn(
        `${label} failed for ${task.id} with infrastructure error "${cmdResult.infraError}", ` +
        `infra retry ${infraAttempt}/${maxInfraRetries} (backoff ${backoffMs}ms)`,
      );
      await new Promise(resolve => setTimeout(resolve, backoffMs));

      cmdResult = await this.runCommand(label, command, task.id);
      if (cmdResult.success) {
        if (this.phase5Snapshot) {
          this.phase5Snapshot.recoveryLoopTimeMs += Date.now() - recoveryLoopStartedAt;
        }
        this.logger.info(
          `${label} recovered for ${task.id} after infra retry ${infraAttempt}`,
        );
        return true;
      }
    }

    // If we're still failing with an infra error after exhausting infra retries,
    // fall through to the code-quality recovery loop (it may still help).
    if (cmdResult.success) return true;

    // Code-quality recovery loop — full parity-failure-resolver → code-migrator pipeline
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (this.phase5Snapshot) {
        this.phase5Snapshot.commandRecoveryAttempts++;
      }
      await this.recordRetryTarget({
        scope: retryScope,
        attempt,
        maxAttempts,
        taskId: task.id,
        wave: options?.wave,
        check: label,
        summary: options?.failureSummary ?? cmdResult.error ?? `${label} command failed`,
      });

      const remediationContext = this.buildRemediationContext({
        failureKind: label,
        failureSummary: options?.failureSummary ?? cmdResult.error ?? `${label} command failed`,
        taskId: task.id,
        wave: options?.wave,
        check: label,
        artifactPaths,
        expectedSuccessCondition,
      });

      // 1. Launch parity-failure-resolver with the error output
      const recoveryCtx = await this.contextBuilder.buildContext(
        'parity-failure-resolver',
        5,
        task.id,
        {
          failureReport: cmdResult.logPath ?? cmdResult.rawError ?? cmdResult.error,
          failureType: label,
          sourceFile: task.sourceFiles[0],
          targetFile: task.targetFiles[0],
          kbEntry: task.knowledgeBaseRef,
          attemptNumber: attempt,
          ...this.taskScopePayload(task),
          remediationContext: toAgentRemediationContext(remediationContext),
        },
      );
      const recoveryInv = this.buildInvocation('parity-failure-resolver', recoveryCtx, 5, task.id);
      const recoveryResult = await this.launchAgentWithEvents(recoveryInv);
      this.recordTokens(recoveryResult, 5);

      if (!recoveryResult.success) {
        this.logger.warn(`Parity-failure-resolver agent failed for ${task.id} on attempt ${attempt}`);
        continue;
      }

      // 2. Re-migrate with the fixed context
      const reMigrateCtx = await this.contextBuilder.buildContext(
        'code-migrator',
        5,
        task.id,
        {
          sourceFiles: task.sourceFiles,
          targetFiles: task.targetFiles,
          kbEntry: task.knowledgeBaseRef,
          ...this.taskScopePayload(task),
          remediationContext: toAgentRemediationContext(remediationContext),
        },
      );
      const reMigrateInv = this.buildInvocation('code-migrator', reMigrateCtx, 5, task.id);
      const reMigrateResult = await this.launchAgentWithEvents(reMigrateInv);
      this.recordTokens(reMigrateResult, 5);

      if (!reMigrateResult.success) {
        this.logger.warn(`Re-migration failed for ${task.id} on ${label} recovery attempt ${attempt}`);
        continue;
      }

      await this.commitForAgent('code-migrator', 5, task.id, task.name);

      // 3. Re-run the command
      cmdResult = await this.runCommand(label, command, task.id);
      if (cmdResult.success) {
        if (this.phase5Snapshot) {
          this.phase5Snapshot.recoveryLoopTimeMs += Date.now() - recoveryLoopStartedAt;
        }
        this.logger.info(`${label} recovered for ${task.id} on attempt ${attempt}`);
        return true;
      }
    }

    if (this.phase5Snapshot) {
      this.phase5Snapshot.recoveryLoopTimeMs += Date.now() - recoveryLoopStartedAt;
    }

    if (options?.suppressTerminalOnExhaustion) {
      this.logger.warn(
        `${label} recovery exhausted for ${task.id} after ${maxAttempts} attempt(s); ` +
        'deferring to wave convergence limits',
      );
      return false;
    }

    await this.raiseTerminalExhaustion({
      reasonCode: 'command-recovery-exhausted',
      taskId: task.id,
      check: label,
      summary: cmdResult.error ?? `${label} command failed after ${maxAttempts} recovery attempts`,
    });
    return false;
  }

  private getQualityGateMode(): QualityGateMode {
    const policy = this.config.options.qualityPolicy;
    if (policy === 'strict') return 'enforce';
    if (policy === 'balanced') return 'advisory';
    if (policy === 'deferred-strict') return 'advisory';
    return 'skip';
  }

  /**
   * Determine whether a build check should run after completing `task`.
   *
   * - If the task has no `compilationUnit`, always run the build check.
   * - If it does, only run when all other tasks in the same compilation unit
   *   are already completed in the queue.  This ensures the build sees a
   *   complete compilation unit rather than failing on missing symbols.
   */
  private shouldRunBuildCheck(task: MigrationTask, queue: TaskQueue): boolean {
    if (!task.compilationUnit) return true;

    // Check if all tasks in the same compilation unit are completed
    const allIds = queue.getAllTaskIds();
    for (const id of allIds) {
      if (id === task.id) continue;
      const other = queue.getTask(id);
      if (other?.compilationUnit === task.compilationUnit && !queue.isTaskCompleted(id)) {
        return false;
      }
    }
    return true;
  }

  private async runWaveEndQualityGates(waveTasks: MigrationTask[] = [], waveNumber?: number): Promise<string | undefined> {
    const policy = this.config.options.qualityPolicy;
    this.logger.info(
      `Running wave-end strict quality gates (qualityPolicy=${policy})`,
    );

    if (this.config.target.buildCommand) {
      const buildResult = await this.runCommand('build', this.config.target.buildCommand, 'wave-end');
      if (!buildResult.success) {
        return `wave-end build gate failed (${policy}): ${buildResult.error ?? 'unknown error'}`;
      }
    }

    if (this.config.target.testCommand) {
      const testResult = await this.runCommand('test', this.config.target.testCommand, 'wave-end');
      if (!testResult.success) {
        return `wave-end test gate failed (${policy}): ${testResult.error ?? 'unknown error'}`;
      }
    }

    // Deferred-strict: collect and evaluate parity results for all wave tasks
    if (policy === 'deferred-strict' && waveTasks.length > 0) {
      const maxRetries = this.config.options.maxRetriesPerTask;

      // Identify tasks with non-minor parity issues
      let failingTasks: MigrationTask[] = [];
      for (const task of waveTasks) {
        const hasNonMinor = this.hasNonMinorParityIssues(task.id);
        if (hasNonMinor) failingTasks.push(task);
      }

      if (failingTasks.length === 0) return undefined;

      this.logger.info(
        `Wave-end parity gate: ${failingTasks.length}/${waveTasks.length} task(s) have non-minor parity issues`,
      );

      // Batched remediation loop
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        await Promise.all(failingTasks.map(async (task) => {
          const issueSummary = this.getParityIssueSummary(task.id);
          const enrichedSummary = issueSummary
            ? `Parity verification failed for ${task.id}: ${issueSummary}`
            : `Parity verification failed for ${task.id}`;

          // Get structured parity issues for the remediation context
          const storedParityResult = this._parityResults.get(task.id);
          const parityIssues = storedParityResult?.issues ?? [];

          const parityRemediation = this.buildRemediationContext({
            failureKind: 'parity',
            failureSummary: enrichedSummary,
            taskId: task.id,
            wave: waveNumber,
            check: 'parity-verifier',
            artifactPaths: [...task.sourceFiles, ...task.targetFiles],
            expectedSuccessCondition: `Parity checks pass (or only minor issues) for ${task.id}`,
          });
          parityRemediation.parityIssues = parityIssues;

          // parity-failure-resolver
          const recoveryCtx = await this.contextBuilder.buildContext(
            'parity-failure-resolver',
            5,
            task.id,
            {
              failureReport: enrichedSummary,
              sourceFile: task.sourceFiles[0],
              targetFile: task.targetFiles[0],
              kbEntry: task.knowledgeBaseRef,
              attemptNumber: attempt,
              ...this.taskScopePayload(task),
              remediationContext: toAgentRemediationContext(parityRemediation),
            },
          );
          const recoveryInv = this.buildInvocation('parity-failure-resolver', recoveryCtx, 5, task.id);
          const recoveryResult = await this.launchAgentWithEvents(recoveryInv);
          this.recordTokens(recoveryResult, 5);

          if (!recoveryResult.success) return;

          // code-migrator
          const reMigrateCtx = await this.contextBuilder.buildContext(
            'code-migrator',
            5,
            task.id,
            {
              sourceFiles: task.sourceFiles,
              targetFiles: task.targetFiles,
              kbEntry: task.knowledgeBaseRef,
              ...this.taskScopePayload(task),
              remediationContext: toAgentRemediationContext(parityRemediation),
            },
          );
          const reMigrateInv = this.buildInvocation('code-migrator', reMigrateCtx, 5, task.id);
          const reMigrateResult = await this.launchAgentWithEvents(reMigrateInv);
          this.recordTokens(reMigrateResult, 5);

          if (!reMigrateResult.success) return;

          // parity-verifier re-run
          const reParityCtx = await this.contextBuilder.buildContext(
            'parity-verifier',
            5,
            task.id,
            {
              sourceFile: task.sourceFiles[0],
              targetFile: task.targetFiles[0],
              ...this.taskScopePayload(task),
            },
          );
          const reParityInv = this.buildInvocation('parity-verifier', reParityCtx, 5, task.id);
          const reParityResult = await this.launchAgentWithEvents(reParityInv);
          this.recordTokens(reParityResult, 5);
          this.storeParityResult(reParityResult, task.id);
        }));

        // Re-evaluate: filter to tasks that still have non-minor issues
        const stillFailing: MigrationTask[] = [];
        for (const task of failingTasks) {
          const hasNonMinor = this.hasNonMinorParityIssues(task.id);
          if (hasNonMinor) stillFailing.push(task);
        }
        failingTasks = stillFailing;

        if (failingTasks.length === 0) {
          this.logger.info(`Wave-end parity remediation converged on attempt ${attempt}`);
          return undefined;
        }
      }

      // Exhausted retries — raise terminal exhaustion for the first remaining failing task
      const firstFailing = failingTasks[0];
      if (firstFailing) {
        await this.raiseTerminalExhaustion({
          reasonCode: 'parity-non-minor-exhausted',
          taskId: firstFailing.id,
          wave: waveNumber,
          check: 'parity-verifier',
          summary: `Wave-end parity verification still has non-minor issues for ${failingTasks.length} task(s) after ${maxRetries} attempt(s)`,
        });
      }
    }

    return undefined;
  }

  // ─── Helpers ─────────────────────────────────────────────────────────

  /**
   * Check whether the parity-failure-resolver determined that remaining
   * parity issues are out of the task's declared scope (`scopeReduced: true`).
   *
   * When the resolver applies scope-based adjudication it intentionally
   * makes no code changes, so re-running parity-verifier would only
   * re-discover the same out-of-scope gaps.
   */
  private resolverReducedScope(result: AgentResult): boolean {
    if (!result.outputParsed || !result.structuredOutput) return false;
    return (result.structuredOutput as Record<string, unknown>).scopeReduced === true;
  }

  /**
   * Extract parity data from a parity-verifier AgentResult and store it
   * in the in-memory map. If the aamf-json output was missing or malformed,
   * nothing is stored and checkParityResult will return false (fail-closed).
   */
  private storeParityResult(agentResult: AgentResult, taskId: string): void {
    if (!agentResult.outputParsed || !agentResult.structuredOutput) return;
    const out = agentResult.structuredOutput as Record<string, unknown>;
    const parity = out.parity;
    if (parity !== 'pass' && parity !== 'partial' && parity !== 'fail') return;
    const issues = Array.isArray(out.issues) ? out.issues as ParityResultData['issues'] : [];
    this._parityResults.set(taskId, { parity, issues });
  }

  /**
   * Check if the parity-verifier result indicates a pass.
   * Returns `false` (fail-closed) if no result was parsed from the agent output.
   */
  private checkParityResult(taskId: string): boolean {
    const result = this._parityResults.get(taskId) ?? this.rehydrateParityFromLog(taskId);
    if (!result) {
      this.logger.warn(`Parity result missing for ${taskId} — treating as failed (fail-closed)`);
      return false;
    }
    if (result.parity === 'pass') return true;
    if (result.parity === 'partial') {
      // Partial is a pass if all issues are minor
      return result.issues.every((i) => i.severity === 'minor');
    }
    return false;
  }

  /**
   * Check if the parity result has any non-minor (critical/major) issues.
   * Returns `true` (fail-closed) if no result exists, assuming blocking issues.
   */
  private hasNonMinorParityIssues(taskId: string): boolean {
    const result = this._parityResults.get(taskId) ?? this.rehydrateParityFromLog(taskId);
    if (!result) {
      this.logger.warn(`Parity result missing for ${taskId} — assuming blocking issues (fail-closed)`);
      return true;
    }
    return result.issues.some((i) => i.severity !== 'minor');
  }

  /**
   * Build a concise human-readable summary of parity issues.
   * Returns `undefined` if no result or no issues exist.
   */
  private getParityIssueSummary(taskId: string): string | undefined {
    const result = this._parityResults.get(taskId) ?? this.rehydrateParityFromLog(taskId);
    if (!result || result.issues.length === 0) return undefined;

    const bySeverity = { critical: 0, major: 0, minor: 0 };
    for (const issue of result.issues) {
      bySeverity[issue.severity] = (bySeverity[issue.severity] ?? 0) + 1;
    }
    const counts = Object.entries(bySeverity)
      .filter(([, n]) => n > 0)
      .map(([sev, n]) => `${n} ${sev}`)
      .join(', ');

    const nonMinor = result.issues
      .filter((i) => i.severity !== 'minor')
      .map((i) => {
        let s = i.description;
        if (i.sourceLocation) s += ` [source: ${i.sourceLocation}]`;
        if (i.targetLocation) s += ` [target: ${i.targetLocation}]`;
        return s;
      })
      .slice(0, 5); // Cap at 5 to stay within summary length

    return `${counts}: ${nonMinor.join('; ')}`;
  }

  /**
   * Rehydrate a parity result from the on-disk agent log files.
   * Used on resume when the in-memory _parityResults map is empty but
   * the parity-tests substep is already checkpointed (so the agent
   * won't be re-launched).  Scans the latest parity-verifier .log file
   * for the aamf-json block and re-parses it.
   *
   * Returns the parsed result and caches it in the map, or undefined
   * if no usable log exists.
   */
  private rehydrateParityFromLog(taskId: string): ParityResultData | undefined {
    try {
      const taskLogDir = join(this.paths.logsAgentsDir, 'parity-verifier', taskId);
      // Synchronous check: readdirSync is acceptable here because this is
      // a cold-path fallback that only fires once per task on resume.
      let entries: string[];
      try {
        entries = readdirSync(taskLogDir);
      } catch {
        return undefined; // directory doesn't exist
      }
      // Find .log files (not .live.log) and pick the latest by name (timestamp-sorted)
      const logFiles = entries
        .filter((f) => f.endsWith('.log') && !f.endsWith('.live.log'))
        .sort();
      if (logFiles.length === 0) return undefined;

      const latestLog = readFileSync(join(taskLogDir, logFiles[logFiles.length - 1]!), 'utf-8');

      // Extract the last aamf-json block from stdout
      const blockRegex = /```aamf-json\r?\n([\s\S]*?)```/g;
      let lastMatch: RegExpExecArray | null = null;
      let match: RegExpExecArray | null;
      while ((match = blockRegex.exec(latestLog)) !== null) {
        lastMatch = match;
      }
      if (!lastMatch) return undefined;

      const raw = JSON.parse(lastMatch[1]!.trim()) as Record<string, unknown>;
      const parity = raw.parity;
      if (parity !== 'pass' && parity !== 'partial' && parity !== 'fail') return undefined;
      const issues = Array.isArray(raw.issues) ? raw.issues as ParityResultData['issues'] : [];
      const data: ParityResultData = { parity, issues };
      this._parityResults.set(taskId, data);
      this.logger.info(`Rehydrated parity result for ${taskId} from agent log (${parity}, ${issues.length} issues)`);
      return data;
    } catch (err) {
      this.logger.warn(`Failed to rehydrate parity result for ${taskId} from logs: ${(err as Error).message}`);
      return undefined;
    }
  }

  private isGitAutomationEnabled(): boolean {
    return this.config.options.git?.enabled === true;
  }

  private async ensureGitRepositoryReady(): Promise<void> {
    if (!this.isGitAutomationEnabled()) return;

    const gitCfg = this.config.options.git;
    if (!gitCfg?.autoInit) return;

    await ensureDir(this.config.target.outputPath);

    const outputPath = resolve(this.config.target.outputPath);
    const probe = await this.runGit(['rev-parse', '--show-toplevel']);
    if (probe.success && resolve(probe.stdout.trim()) === outputPath) return;

    const init = await this.runGit(['init']);
    if (!init.success) {
      this.logger.warn(`Failed to initialize git repository at output path: ${init.stderr || init.stdout}`);
      return;
    }

    await this.runGit(['config', 'user.name', gitCfg.authorName]);
    await this.runGit(['config', 'user.email', gitCfg.authorEmail]);

    // Write a language-appropriate .gitignore so build artifacts are never committed.
    const gitignorePath = join(outputPath, '.gitignore');
    if (!(await fileExists(gitignorePath))) {
      const content = gitignoreForLanguage(this.config.target.language);
      await atomicWrite(gitignorePath, content);
      this.logger.info(`Wrote .gitignore for target language "${this.config.target.language}"`);
    }

    this.logger.info(`Initialized git repository at ${this.config.target.outputPath}`);
  }

  private async commitForAgent(agent: AgentName, phase: number, taskId?: string, detail?: string): Promise<void> {
    if (!this.isGitAutomationEnabled()) return;
    if (!this.config.options.git?.commitByAgent) return;
    // In wave-barrier mode, per-agent commits are deferred to a single
    // wave-level commit created after convergence succeeds.
    if (this._deferGitCommits) return;

    const scope = taskId ? `task ${taskId}` : `phase ${phase}`;
    const suffix = detail ? ` (${detail})` : '';
    const message = `aamf: ${agent} updated output for ${scope}${suffix}`;
    await this.commitIfDirty(message);
  }

  private async commitForTask(task: MigrationTask): Promise<void> {
    if (!this.isGitAutomationEnabled()) return;
    if (!this.config.options.git?.commitPerTask) return;
    // In wave-barrier mode, per-task commits are deferred to a single
    // wave-level commit created after convergence succeeds.
    if (this._deferGitCommits) return;

    const message = `aamf: complete ${task.id} - ${task.name}`;
    const allowEmpty = this.config.options.git?.allowEmptyTaskCommits ?? true;
    await this.commitIfDirty(message, allowEmpty);
  }

  /**
   * Creates a single git commit covering all output produced by the tasks
   * in a completed wave.  Called once after wave convergence succeeds,
   * replacing the many per-agent / per-task commits that would otherwise
   * be created inside {@link executeTask}.
   */
  private async commitForWave(wave: number, taskIds: string[]): Promise<void> {
    if (!this.isGitAutomationEnabled()) return;

    const taskList = taskIds.join(', ');
    const message = `aamf: wave ${wave} — ${taskIds.length} task(s) [${taskList}]`;
    await this.commitIfDirty(message);
  }

  private async commitIfDirty(message: string, allowEmpty: boolean = false): Promise<void> {
    await this.gitLimiter(async () => {
      await this.ensureGitRepositoryReady();

      const status = await this.runGit(['status', '--porcelain']);
      if (!status.success) {
        this.logger.warn(`Unable to inspect git status before commit: ${status.stderr || status.stdout}`);
        return;
      }
      const hasWorkingTreeChanges = !!status.stdout.trim();
      if (!hasWorkingTreeChanges && !allowEmpty) return;

      if (hasWorkingTreeChanges) {
        const add = await this.runGit(['add', '-A']);
        if (!add.success) {
          this.logger.warn(`Unable to stage git changes: ${add.stderr || add.stdout}`);
          return;
        }
      }

      const staged = await this.runGit(['diff', '--cached', '--name-only']);
      if (!staged.success) return;
      const stagedCount = staged.stdout.split('\n').filter(Boolean).length;
      if (stagedCount === 0 && !allowEmpty) return;

      const commitArgs = allowEmpty
        ? ['commit', '--allow-empty', '-m', message]
        : ['commit', '-m', message];
      const commit = await this.runGit(commitArgs);
      if (!commit.success) {
        this.logger.warn(`Git commit failed for message "${message}": ${commit.stderr || commit.stdout}`);
        return;
      }

      this.logger.info(`Created git commit (${stagedCount} file(s)): ${message}`);
    });
  }

  private async runGit(args: string[]): Promise<{
    success: boolean;
    stdout: string;
    stderr: string;
    exitCode: number;
  }> {
    try {
      const resolvedPath = this.launcher.getResolvedPath();
      const result = await spawnWithTimeout('git', args, {
        cwd: this.config.target.outputPath,
        timeout: this.getRuntimeTimeout(),
        env: {
          ...process.env,
          ...(resolvedPath ? { PATH: resolvedPath } : {}),
        },
      });
      return {
        success: result.exitCode === 0 && !result.killed,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      };
    } catch (err) {
      return {
        success: false,
        stdout: '',
        stderr: err instanceof Error ? err.message : String(err),
        exitCode: -1,
      };
    }
  }

  /**
   * Convert a simple glob pattern to a RegExp for task-ID matching.
   * Supports `*` (any chars) and `?` (single char).
   */
  private static globToRegex(pattern: string): RegExp {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    const regexStr = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
    return new RegExp(`^${regexStr}$`);
  }

  /**
   * Compute a complexity score (0–100) and select the appropriate model
   * tier for a task based on routing policy configuration.
   */
  private selectModelForInvocation(
    task: MigrationTask | undefined,
    agent: AgentName,
  ): RoutingDecision {
    const routing = this.config.options.modelRouting;
    const defaultModel = routing?.defaultModel
      ?? (this.config.agentBackend.model ?? 'unknown');
        (this.config.agentBackend.model ?? 'unknown');

    if (!routing?.enabled) {
      return { tier: 'normal', selectedModel: defaultModel, reason: 'routing-disabled', score: 0, escalated: false };
    }

    // Score computation (0–100)
    let score = 0;
    if (task) {
      // sourceFiles: 0–15 (capped at 10 files)
      score += Math.min(task.sourceFiles.length, 10) * 1.5;
      // targetFiles: 0–10 (capped at 10 files)
      score += Math.min(task.targetFiles.length, 10);
      // lineRange size: 0–20 (capped at 1000 lines)
      if (task.lineRange) {
        const span = task.lineRange.end - task.lineRange.start;
        score += Math.min(span / 1000, 1) * 20;
      }
      // dependencies fan-in/out: 0–15 (capped at 10 deps)
      score += Math.min(task.dependencies.length, 10) * 1.5;
      // complexity rating: simple=0, moderate=20, complex=40
      const complexityScores: Record<string, number> = { simple: 0, moderate: 20, complex: 40 };
      score += complexityScores[task.complexity] ?? 0;
    }
    score = Math.round(Math.min(score, 100));

    // Check explicit overrides: criticalTaskPatterns
    if (task && routing.criticalTaskPatterns?.length) {
      for (const pattern of routing.criticalTaskPatterns) {
        if (MigrationOrchestrator.globToRegex(pattern).test(task.id)) {
          return { tier: 'critical', selectedModel: routing.criticalModel ?? defaultModel, reason: 'critical-task-pattern', score, escalated: false };
        }
      }
    }

    // Check explicit overrides: criticalAgents
    if (routing.criticalAgents?.length && routing.criticalAgents.includes(agent)) {
      return { tier: 'critical', selectedModel: routing.criticalModel ?? defaultModel, reason: 'critical-agent', score, escalated: false };
    }

    // Threshold-based tier assignment
    if (score >= routing.criticalThreshold) {
      return { tier: 'critical', selectedModel: routing.criticalModel ?? defaultModel, reason: 'score-critical', score, escalated: false };
    }
    if (score >= routing.heavyThreshold) {
      return { tier: 'heavy', selectedModel: routing.heavyModel ?? defaultModel, reason: 'score-heavy', score, escalated: false };
    }

    return { tier: 'normal', selectedModel: defaultModel, reason: 'score-normal', score, escalated: false };
  }

  /**
   * Apply cap enforcement to a routing decision. If caps are reached,
   * downgrade the tier and return the adjusted decision.
   */
  private applyRoutingCaps(decision: RoutingDecision, taskId?: string): RoutingDecision {
    if (decision.tier === 'normal') return decision;

    const routing = this.config.options.modelRouting;
    if (!routing?.enabled) return decision;

    const defaultModel = this.getDefaultRoutingModel();

    // Enforce maxCriticalTasks cap
    const isNewRoutedTask = Boolean(taskId && !this._routedTaskIds.has(taskId));
    const routedTaskCountAfterDecision = this._routedTaskIds.size + (isNewRoutedTask ? 1 : 0);
    if (routing.maxCriticalTasks > 0 && routedTaskCountAfterDecision > routing.maxCriticalTasks) {
      return { ...decision, tier: 'normal', selectedModel: defaultModel, reason: `${decision.reason}:capped-max-tasks` };
    }

    // Enforce maxEscalationCostUsd cap
    if (routing.maxEscalationCostUsd > 0) {
      const avgTokens = AVG_TOKENS_PER_TASK;
      const projectedCost = this.costEstimatorInstance.projectCost(decision.selectedModel, avgTokens).total;
      const baseCost = this.costEstimatorInstance.projectCost(defaultModel, avgTokens).total;
      const incrementalCost = Math.max(0, projectedCost - baseCost);
      if (this._escalationCostUsd + incrementalCost > routing.maxEscalationCostUsd) {
        return { ...decision, tier: 'normal', selectedModel: defaultModel, reason: `${decision.reason}:capped-cost` };
      }
    }

    return decision;
  }

  private getDefaultRoutingModel(): string {
    const routing = this.config.options.modelRouting;
    return routing?.defaultModel
      ?? (this.config.agentBackend.model ?? 'unknown');
  }

  private buildInvocation(
    agent: AgentName,
    contextFile: string,
    phase: number,
    taskId?: string,
    task?: MigrationTask,
  ): AgentInvocation {
    const timeout = this.getPhaseTimeout(phase);

    // Agents that benefit from KB access when the KB server is running.
    // Essentially every agent that analyses or transforms source code.
    const KB_AWARE_AGENTS: AgentName[] = [
      'impact-assessor',
      'knowledge-builder',
      'migration-planner',
      'adjudicator',
      'code-migrator',
      'parity-verifier',
      'test-writer',
      'parity-failure-resolver',
      'final-parity-checker',
      'e2e-test-crafter',
      'documentation-writer',
      'idiomatic-reviewer',
      'idiomatic-refactorer',
    ];
    const mcpConfig = (KB_AWARE_AGENTS.includes(agent) && this.kbServer)
      ? this.kbServer.mcpConfig
      : undefined;

    const kbDbPath = (KB_AWARE_AGENTS.includes(agent) && this.kbServer)
      ? this.kbDbPath
      : undefined;

    // Parity-failure-resolver model override takes precedence over routing
    const failureRecoveryOverride = agent === 'parity-failure-resolver'
      ? this.getFailureRecoveryModel()
      : undefined;

    let modelOverride = failureRecoveryOverride;
    let routingTier: ModelTier | undefined;
    let routingReason: string | undefined;

    // Apply model routing when enabled and no parity-failure-resolver override
    if (!failureRecoveryOverride && this.config.options.modelRouting?.enabled) {
      const decision = this.applyRoutingCaps(
        this.selectModelForInvocation(task, agent),
        taskId,
      );

      routingTier = decision.tier;
      routingReason = decision.reason;

      if (decision.tier !== 'normal') {
        modelOverride = decision.selectedModel;

        // Track caps
        if (taskId) {
          this._routedTaskIds.add(taskId);
        }
        const defaultModel = this.getDefaultRoutingModel();
        const avgTokens = AVG_TOKENS_PER_TASK;
        const projectedCost = this.costEstimatorInstance.projectCost(decision.selectedModel, avgTokens).total;
        const baseCost = this.costEstimatorInstance.projectCost(defaultModel, avgTokens).total;
        this._escalationCostUsd += Math.max(0, projectedCost - baseCost);

        this.logger.info(
          `Model routing: ${taskId ?? agent} → ${decision.tier} (${decision.selectedModel}), ` +
          `score=${decision.score}, reason=${decision.reason}`,
        );

        this.logger.event({
          type: 'model-routing-decision',
          taskId: taskId ?? '',
          tier: decision.tier,
          selectedModel: decision.selectedModel,
          reason: decision.reason,
          score: decision.score,
        });
      }
    }

    return {
      agent,
      contextFile,
      progressDir: this.progressDir,
      phase,
      taskId,
      timeout,
      ...(modelOverride ? { modelOverride } : {}),
      ...(routingTier ? { routingTier, routingReason } : {}),
      ...(mcpConfig ? { mcpConfig } : {}),
      ...(kbDbPath ? { kbDbPath } : {}),
    };
  }

  private getFailureRecoveryModel(): string | undefined {
    return this.config.agentBackend.failureRecoveryModel;
  }

  private isTransientModelFailure(errorText: string): boolean {
    return /\b503\b|HTTP\/2 GOAWAY|connection_error|Failed to get response from the AI model|service unavailable/i
      .test(errorText);
  }

  private recordTokens(result: AgentResult, phase: number): void {
    if (result.tokenUsage) {
      this.tokenTracker.record(result.agent, phase, result.tokenUsage.total, result.tokenUsage.cachedInput);
      // Sync token snapshot to checkpoint state so the next save() persists accurate data
      const state = this.checkpoint.getState();
      state.tokenUsage = this.tokenTracker.toCheckpointData();
    }
  }

  /**
   * Wrapper around `launcher.launchAgent()` that emits agent lifecycle events
   * with invocationId correlation. All orchestrator agent launches should go
   * through this method for consistent event emission.
   */
  private async launchAgentWithEvents(invocation: AgentInvocation): Promise<AgentResult> {
    const invocationId = randomUUID();
    const taggedInvocation = { ...invocation, invocationId };
    const startTime = new Date().toISOString();

    this.logger.event({
      type: 'agent-launched',
      agent: invocation.agent,
      taskId: invocation.taskId,
      phase: invocation.phase,
      invocationId,
    });

    const result = await this.launcher.launchAgent(taggedInvocation);

    if (result.success) {
      this.logger.event({
        type: 'agent-completed',
        agent: result.agent,
        taskId: result.taskId,
        success: true,
        duration: result.duration,
        invocationId: result.invocationId,
      });
    } else {
      this.logger.event({
        type: 'agent-failed',
        agent: result.agent,
        taskId: result.taskId,
        error: result.error ?? 'unknown',
        invocationId: result.invocationId,
      });
    }

    // Record invocation metric — prefer modelOverride for correct attribution
    const endTime = new Date().toISOString();
    const configModel = this.config.agentBackend.model ?? 'unknown';
    const model = invocation.modelOverride ?? configModel;
    const tokensPrompt = result.tokenUsage?.prompt ?? 0;
    const tokensCompletion = result.tokenUsage?.completion ?? 0;
    const tokensTotal = result.tokenUsage?.total ?? 0;
    const costEstimate = this.costEstimatorInstance.estimate(
      model, tokensPrompt, tokensCompletion, result.tokenUsage?.cachedInput,
    );

    // Compute routing metadata for the metric
    const routingDecision = this.config.options.modelRouting?.enabled && invocation.routingTier
      ? (() => {
          const defaultModel = this.config.options.modelRouting!.defaultModel ?? configModel;
          const avgTokens = AVG_TOKENS_PER_TASK;
          const projectedCost = this.costEstimatorInstance.projectCost(model, avgTokens).total;
          const baseCost = this.costEstimatorInstance.projectCost(defaultModel, avgTokens).total;
          return { incrementalCost: Math.max(0, projectedCost - baseCost) };
        })()
      : undefined;

    const metric: InvocationMetric = {
      runId: this.runId,
      phase: invocation.phase ?? 0,
      taskId: invocation.taskId ?? '',
      agentType: invocation.agent,
      invocationId,
      startTime,
      endTime,
      durationMs: result.duration,
      attemptNumber: invocation.attemptNumber ?? 1,
      maxAttempts: invocation.maxAttempts ?? 1,
      wasRetry: (invocation.attemptNumber ?? 1) > 1,
      status: result.success ? 'success' : 'failed',
      model,
      tokensPrompt,
      tokensCompletion,
      tokensTotal,
      costUsd: costEstimate.total,
      ...(result.tokenUsage?.cachedInput != null ? { cachedTokens: result.tokenUsage.cachedInput } : {}),
      ...(result.tokenUsage?.premiumRequests != null ? { premiumRequests: result.tokenUsage.premiumRequests } : {}),
      ...(invocation.routingTier ? { routingTier: invocation.routingTier, routingReason: invocation.routingReason } : {}),
      ...(routingDecision ? { escalationCostUsd: routingDecision.incrementalCost } : {}),
    };

    this.metricsCollector.record(metric);
    try {
      await this.metricsCollector.writeJsonl(this.progressDir);
      const st = this.checkpoint.getState();
      st.metricsCount = (st.metricsCount ?? 0) + 1;
      await this.checkpoint.save(st);
    } catch {
      // Non-fatal: metrics persistence failure should not abort migration
    }

    return result;
  }
}
