import { join, resolve } from 'node:path';
import { readdir } from 'node:fs/promises';
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
  ModuleGroup,
  PhaseResult,
} from '../agents/types.js';
import { ContextBuilder } from '../agents/context-builder.js';
import { ResultParser } from '../agents/result-parser.js';
import { MigrationConfig } from '../config/schema.js';
import { ParallelExecutor } from '../execution/parallel-executor.js';
import { TaskQueue } from '../execution/task-queue.js';
import { RetryExecutor } from '../execution/retry.js';
import { TokenTracker } from '../budget/token-tracker.js';
import { CostEstimator } from '../budget/cost-estimator.js';
import { Logger } from '../logging/logger.js';
import { fileExists, countFileLines, atomicWrite, readJson, ensureDir } from '../util/fs.js';
import { spawnWithTimeout } from '../util/process.js';
import { IndexBuilder } from '../indexer/index.js';
import { SentenceTransformersProvider, type EmbeddingProvider } from '../indexer/embedder.js';
import { ensurePythonDeps } from '../indexer/ensure-python-deps.js';
import { KbServerProcess } from './kb-server-process.js';
import { z } from 'zod';

// ─── Infrastructure Error Detection ──────────────────────────────────────────

/**
 * Language/build-system-agnostic patterns that indicate a transient
 * infrastructure failure rather than a code-quality problem.
 *
 * These errors should be retried with simple backoff — they don't benefit
 * from the expensive failure-recovery agent pipeline.
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

/** Format a duration in ms as a human-readable string (e.g., "1h 2m 3s", "5m 30s", "45s"). */
function formatDuration(ms: number): string {
  const totalSecs = Math.round(ms / 1000);
  const hours = Math.floor(totalSecs / 3600);
  const mins = Math.floor((totalSecs % 3600) / 60);
  const secs = totalSecs % 60;
  if (hours > 0) return `${hours}h ${mins}m ${secs}s`;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
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

const TaskFileSchema = z.array(
  z.object({
    id: z.string().regex(/^task-\d+$/),
    name: z.string().min(1),
    sourceFiles: z.array(z.string().min(1)).min(1),
    targetFiles: z.array(z.string().min(1)).min(1),
    knowledgeBaseRef: z.string().min(1),
    dependencies: z.array(z.string().regex(/^task-\d+$/)),
    complexity: z.enum(['simple', 'moderate', 'complex']),
    description: z.string().min(1),
    acceptanceCriteria: z.array(z.string().min(1)).min(1),
    parityChecks: z.array(z.string().min(1)).min(1),
    lineRange: z
      .object({
        start: z.number().int().min(1),
        end: z.number().int().min(1),
      })
      .optional(),
  }).strict(),
);

/**
 * The main orchestrator that sequences all 7 migration phases.
 *
 * Mirrors the logic in `migration-orchestrator.agent.md` but as executable
 * TypeScript rather than a prompt — the orchestrator manages processes, files,
 * checkpoints, and budgets while agents do the actual reasoning.
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
  /** Stores the migration-planner AgentResult from Phase 3 for Phase 4 to consume. */
  private phase3PlanResult?: AgentResult;
  /**
   * Semaphore that limits concurrent build/test command executions.
   * Separate from `maxParallelAgents` so that agent code-generation can
   * proceed in full parallel while verification commands that share a
   * build artifact directory (Cargo target/, .NET bin/, Go cache, etc.)
   * are serialised to avoid file-lock contention.
   */
  private readonly buildLimiter: ReturnType<typeof pLimit>;

  constructor(
    private readonly config: MigrationConfig,
    private readonly checkpoint: CheckpointManager,
    private readonly launcher: AgentLauncher,
    private readonly progress: ProgressWriter,
    private readonly logger: Logger,
    projectRoot: string,
    singlePhase?: number,
  ) {
    this.projectRoot = projectRoot;
    this.progressDir = join(projectRoot, '.aamf', 'migration', config.projectName);
    this.contextBuilder = new ContextBuilder(config, this.progressDir);
    this.tokenTracker = new TokenTracker();
    this.singlePhase = singlePhase;
    this.kbDbPath = join(this.progressDir, 'kb.db');

    const bc = config.options.buildConcurrency ?? 1;
    // 0 means unlimited → use maxParallelAgents
    this.buildLimiter = pLimit(bc === 0 ? config.options.maxParallelAgents : bc);
  }

  // ─── Public API ──────────────────────────────────────────────────────

  async run(): Promise<MigrationResult> {
    const startTime = Date.now();
    const state = this.checkpoint.getState();
    const resumePoint = this.checkpoint.getResumePoint();

    // Restore token usage from checkpoint
    this.tokenTracker.loadFromCheckpoint(state.tokenUsage);

    this.logger.event({ type: 'migration-started', projectName: this.config.projectName });
    await this.progress.appendEvent('Migration started');

    const phaseResults: PhaseResult[] = [];
    let aborted = false;

    // Determine which phases to execute
    const phasesToRun = this.singlePhase != null
      ? PHASES.filter(p => p.id === this.singlePhase)
      : PHASES;

    if (this.singlePhase != null) {
      this.logger.info(`Running single phase: ${this.singlePhase}`);
    }

    const kbEnabled =
      this.config.options.kbIndex?.enabled ||
      process.env['AAMF_USE_KB_INDEX'] === '1';

    const phase0InSelection = phasesToRun.some((p) => p.id === 0);
    const phase0SkippedByResume =
      this.singlePhase == null &&
      phase0InSelection &&
      resumePoint.phase > 0 &&
      !kbEnabled;

    // If this invocation won't execute Phase 0 (for example: resume from later
    // checkpoint or run a later single phase), but KB indexing is enabled and a
    // previously built kb.db exists, start the KB server up-front so downstream
    // phases/agents retain KB access.
    if (kbEnabled && (phase0SkippedByResume || !phase0InSelection)) {
      if (await fileExists(this.kbDbPath)) {
        await this.startKbServer();
      } else {
        this.logger.warn(
          `KB indexing is enabled, but ${this.kbDbPath} is missing. ` +
          'Run Phase 0 first to enable KB access for resumed/later phases.',
        );
      }
    }

    try {
      for (const phase of phasesToRun) {
        // Skip optional Phase 0 (KB Indexing) unless enabled via config or env var
        if (phase.optional && phase.id === 0 &&
            !this.config.options.kbIndex?.enabled &&
            process.env['AAMF_USE_KB_INDEX'] !== '1') {
          this.logger.info(`Skipping optional Phase 0 (KB Indexing) — set options.kbIndex.enabled or AAMF_USE_KB_INDEX=1 to enable`);
          continue;
        }

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
        // requesting a single phase via --phase).
        if (
          this.singlePhase == null &&
          phase.id < resumePoint.phase &&
          !(phase.id === 0 && kbEnabled)
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

        this.progress.setTokenUsage(this.tokenTracker.getTotal());
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

    const migrationResult: MigrationResult = {
      success: !aborted && phaseResults.every((r) => r.success),
      projectName: this.config.projectName,
      phases: phaseResults,
      totalDuration,
      cumulativeDuration: cumulativeDurationMs,
      tokenUsage: this.tokenTracker.toCheckpointData(),
      failedTasks: finalState.failedTasks.map((f) => f.taskId),
      blockedTasks: finalState.blockedTasks,
    };

    this.logger.event({
      type: 'migration-completed',
      projectName: this.config.projectName,
      success: migrationResult.success,
      duration: totalDuration,
    });
    this.progress.setCumulativeDuration(cumulativeDurationMs);
    await this.progress.finalize(migrationResult);
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

    // Optionally set up the embedding provider for semantic search.
    const embCfg = this.config.options.kbIndex?.embeddings;
    if (embCfg?.enabled) {
      const pythonBin = embCfg.pythonBin ?? 'python3';
      const model = embCfg.model ?? 'Qwen/Qwen3-Embedding-0.6B';
      this.logger.info(`Embeddings enabled — ensuring Python deps (python: ${pythonBin}, model: ${model})`);
      try {
        await ensurePythonDeps(pythonBin);
      } catch (err) {
        this.logger.warn(
          `Failed to install Python embedding deps — embeddings will be skipped: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      this.embedder = new SentenceTransformersProvider(model, pythonBin);
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

    const builder = new IndexBuilder(this.kbDbPath, { rootDir: sourceRoot }, this.embedder);

    const maxAttempts = this.config.options.maxRetriesPerTask;
    const timeout =
      this.config.copilot.phaseTimeouts?.[0] ??
      this.config.claudeCode?.phaseTimeouts?.[0] ??
      DEFAULT_INDEX_TIMEOUT_MS;

    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await Promise.race([
          builder.build(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('KB index timeout')), timeout),
          ),
        ]);
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
    this.kbServer = new KbServerProcess(this.kbDbPath, this.embedder);
    try {
      await this.kbServer.start();
      this.logger.info('KB server started and ready');
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

  // ─── Phase 1: Impact Assessment ──────────────────────────────────────

  private async executePhase1(start: number): Promise<PhaseResult> {
    const contextFile = await this.contextBuilder.buildContext('impact-assessor', 1);
    const inv = this.buildInvocation('impact-assessor', contextFile, 1);
    const result = await this.launcher.launchAgent(inv);
    this.recordTokens(result, 1);

    const outputPath = join(this.progressDir, 'impact-assessment.md');
    return {
      phase: 1,
      name: 'Impact Assessment',
      success: result.success,
      outputPath,
      duration: Date.now() - start,
      error: result.error,
      exitCode: result.success ? undefined : result.exitCode,
      stderr: result.success ? undefined : result.stderr,
    };
  }

  // ─── Phase 2: Knowledge Base Construction ────────────────────────────

  private async executePhase2(start: number): Promise<PhaseResult> {
    // 1. Launch knowledge-builder
    const kbContext = await this.contextBuilder.buildContext('knowledge-builder', 2);
    const kbInv = this.buildInvocation('knowledge-builder', kbContext, 2);
    const kbResult = await this.launcher.launchAgent(kbInv);
    this.recordTokens(kbResult, 2);

    if (!kbResult.success) {
      return {
        phase: 2,
        name: 'Knowledge Base Construction',
        success: false,
        duration: Date.now() - start,
        error: kbResult.error,
        exitCode: kbResult.exitCode,
        stderr: kbResult.stderr,
      };
    }

    const outputPath = join(this.progressDir, 'knowledge-base');
    return {
      phase: 2,
      name: 'Knowledge Base Construction',
      success: true,
      outputPath,
      duration: Date.now() - start,
    };
  }

  // ─── Phase 3: Migration Planning ─────────────────────────────────────

  private async executePhase3(start: number): Promise<PhaseResult> {
    const planningDir = join(this.progressDir, 'planning');
    const groupsFile = join(planningDir, 'groups.json');
    const strategyFile = join(planningDir, 'strategy.md');
    const mergedTasksFile = join(planningDir, 'tasks-merged.json');

    // ── Step 3a: migration-planner (fast, serial) ──────────────────────────
    //   Reads the knowledge base and emits planning/groups.json +
    //   planning/strategy.md.  Expected to take ~5-10 min.
    //   Pre-create the planning directory so the agent can write files into it
    //   (migration-planner does not have shell/execute access to mkdir itself).
    await ensureDir(planningDir);
    const checkpointState = this.checkpoint.getState();
    if (!checkpointState.phase3aComplete) {
      const planContext = await this.contextBuilder.buildContext('migration-planner', 3);
      const planInv = this.buildInvocation('migration-planner', planContext, 3);
      const planResult = await this.launcher.launchAgent(planInv);
      this.recordTokens(planResult, 3);

      if (!planResult.success) {
        return {
          phase: 3,
          name: 'Migration Planning',
          success: false,
          duration: Date.now() - start,
          error: planResult.error,
          exitCode: planResult.exitCode,
          stderr: planResult.stderr,
        };
      }

      // Adjudicator runs before task decomposition when competing strategies
      // were written to disk by the migration-planner.
      const adjudicationFile = join(this.progressDir, 'competing-strategies.md');
      if (await fileExists(adjudicationFile)) {
        const adjCtx = await this.contextBuilder.buildContext('adjudicator', 3, undefined, {
          competingStrategiesFile: adjudicationFile,
          decisionType: 'migration-strategy',
        });
        const adjInv = this.buildInvocation('adjudicator', adjCtx, 3);
        const adjResult = await this.launcher.launchAgent(adjInv);
        this.recordTokens(adjResult, 3);
      } else {
        // Helpful diagnostics: if strategy variant artifacts exist without the
        // canonical competing-strategies.md trigger file, adjudication is
        // skipped and planning continues.
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

      // Checkpoint after step 3a.  If step 3b fails partway through, the
      // next resume run skips the migration-planner and retries only the
      // task-decomposer invocations that did not yet complete.
      await this.checkpoint.completePhase3a();
      this.logger.info(
        'Step 3a complete: migration-planner wrote planning/groups.json and planning/strategy.md',
      );
    } else {
      this.logger.info('Resuming Phase 3 — step 3a already complete, skipping migration-planner');
    }

    // ── Step 3b: parallel task-decomposer × N (one per module group) ──────
    //   Each invocation reads strategy.md + its group's analysis files and
    //   emits planning/tasks-<group>.json.  Completed groups are tracked in
    //   the checkpoint so partial failures can be retried cheaply on resume.
    if (!(await fileExists(groupsFile))) {
      return {
        phase: 3,
        name: 'Migration Planning',
        success: false,
        duration: Date.now() - start,
        error: 'planning/groups.json not found — migration-planner did not emit module groups',
      };
    }

    const groups = await readJson<ModuleGroup[]>(groupsFile);
    const completedGroups = new Set(this.checkpoint.getState().completedPhase3Groups ?? []);
    const remainingGroups = groups.filter(g => !completedGroups.has(g.id));

    if (remainingGroups.length > 0) {
      this.logger.info(
        `Step 3b: running task-decomposer for ${remainingGroups.length} of ${groups.length} ` +
        `module group(s) in parallel (${completedGroups.size} already complete)`,
      );

      const invocations: AgentInvocation[] = [];
      for (const group of remainingGroups) {
        const ctx = await this.contextBuilder.buildContext('task-decomposer', 3, group.id, {
          groupId: group.id,
          groupName: group.name,
          strategyFile,
          analysisFiles: group.analysisFiles,
        });
        invocations.push(this.buildInvocation('task-decomposer', ctx, 3, group.id));
      }

      const parallel = new ParallelExecutor(
        this.config.options.maxParallelAgents,
        async (inv) => {
          const retryExec = new RetryExecutor(
            (attemptInv) => this.launcher.launchAgent(attemptInv),
            this.logger,
          );
          return retryExec.executeWithRetry(inv, {
            maxAttempts: this.config.options.maxRetriesPerTask,
            onRetry: async (attempt, error) => {
              this.logger.warn(
                `Retry ${attempt} for task-decomposer${inv.taskId ? ` (${inv.taskId})` : ''}: ${error}`,
              );
            },
          });
        },
        this.logger,
      );
      const results = await parallel.executeAll(invocations);

      const failedGroups: Array<{ id: string; reason: string; attempts: number }> = [];
      for (const [i, r] of results.entries()) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const group = remainingGroups[i]!;
        const attempts =
          'attempts' in r && typeof (r as { attempts?: unknown }).attempts === 'number'
            ? (r as { attempts: number }).attempts
            : 1;
        this.recordTokens(r, 3);
        if (r.success) {
          await this.checkpoint.completePhase3Group(group.id);
          if (attempts > 1) {
            this.logger.info(
              `task-decomposer recovered for group "${group.id}" after ${attempts} attempt(s)`,
            );
          }
        } else {
          const reason = r.error ?? r.parseError ?? 'unknown';
          failedGroups.push({ id: group.id, reason, attempts });
          this.logger.error(
            `task-decomposer failed for group "${group.id}" after ${attempts} attempt(s): ${reason}`,
          );
        }
      }

      if (failedGroups.length > 0) {
        const failedGroupIds = failedGroups.map(f => f.id);
        const details = failedGroups
          .map(f => `${f.id} (${f.reason}; attempts=${f.attempts})`)
          .join('; ');
        return {
          phase: 3,
          name: 'Migration Planning',
          success: false,
          duration: Date.now() - start,
          error:
            `task-decomposer failed for ${failedGroupIds.length} group(s): ${failedGroupIds.join(', ')}. ` +
            `Details: ${details}`,
        };
      }
    } else {
      this.logger.info('Step 3b: all module groups already task-decomposed, proceeding to merge');
    }

    // ── Merge all tasks-<group>.json → planning/tasks-merged.json ─────────
    //   The orchestrator reassembles individual group task lists into a single
    //   ordered array.  Phase 4 reads this via structuredOutput (preferred)
    //   or by loading the file directly (fallback on resume without in-memory
    //   state).
    const allTasks: MigrationTask[] = [];
    for (const group of groups) {
      const taskFile = join(planningDir, `tasks-${group.id}.json`);
      if (await fileExists(taskFile)) {
        const groupTasksRaw = await readJson<unknown>(taskFile);
        const parsed = TaskFileSchema.safeParse(groupTasksRaw);
        if (!parsed.success) {
          const issueSummary = parsed.error.issues
            .slice(0, 5)
            .map((issue) => {
              const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
              return `${path}: ${issue.message}`;
            })
            .join('; ');
          const validationError =
            `Invalid task-decomposer output for group "${group.id}" at ${taskFile}. ` +
            `Schema validation failed: ${issueSummary}`;
          this.logger.error(validationError);
          return {
            phase: 3,
            name: 'Migration Planning',
            success: false,
            duration: Date.now() - start,
            error: validationError,
          };
        }
        allTasks.push(...parsed.data);
      } else {
        this.logger.warn(
          `Expected task file not found for group "${group.id}": ${taskFile}`,
        );
      }
    }

    this.logger.info(
      `Merged ${allTasks.length} task(s) across ${groups.length} module group(s) → ${mergedTasksFile}`,
    );
    await atomicWrite(mergedTasksFile, JSON.stringify(allTasks, null, 2));

    // Make merged tasks available to Phase 4 via the in-memory structuredOutput
    // path (avoids a redundant file read when phases run back-to-back).
    this.phase3PlanResult = {
      agent: 'task-decomposer',
      exitCode: 0,
      success: true,
      outputFiles: [mergedTasksFile],
      duration: Date.now() - start,
      outputParsed: true,
      structuredOutput: { tasks: allTasks },
    };

    return {
      phase: 3,
      name: 'Migration Planning',
      success: true,
      outputPath: mergedTasksFile,
      duration: Date.now() - start,
    };
  }

  // ─── Phase 4: Iterative Migration ────────────────────────────────────

  private async executePhase4(start: number): Promise<PhaseResult> {
    const planPath = join(this.progressDir, 'migration-plan.md');

    // 1. Parse migration plan — prefer structuredOutput from Phase 3, fall back to file
    let tasks: MigrationTask[];
    if (this.phase3PlanResult?.outputParsed && Array.isArray(this.phase3PlanResult.structuredOutput?.['tasks'])) {
      tasks = this.phase3PlanResult.structuredOutput['tasks'] as MigrationTask[];
    } else {
      if (!(await fileExists(planPath))) {
        // Also check for the newer planning/tasks-merged.json produced by the
        // two-step Phase 3 (migration-planner + parallel task-decomposer).
        const mergedPlanPath = join(this.progressDir, 'planning', 'tasks-merged.json');
        if (await fileExists(mergedPlanPath)) {
          this.logger.warn(
            'Phase 3 structured output unavailable — falling back to planning/tasks-merged.json',
          );
          tasks = await readJson<MigrationTask[]>(mergedPlanPath);
        } else {
          return {
            phase: 4,
            name: 'Iterative Migration',
            success: false,
            duration: Date.now() - start,
            error: 'migration-plan.md and planning/tasks-merged.json not found — Phase 3 may not have completed',
          };
        }
      } else {
        this.logger.warn(
          'Phase 3 structured output unavailable — falling back to ResultParser.parseMigrationPlan',
        );
        tasks = await ResultParser.parseMigrationPlan(planPath);
      }
    }
    if (tasks.length === 0) {
      this.logger.warn('No tasks found in migration plan');
      return {
        phase: 4,
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
    const estimatedTotalTokens = taskCount * this.config.options.avgTokensPerTask * agentMultiplier;
    const model = this.config.copilot.model ?? 'claude-sonnet-4';
    const estimator = new CostEstimator(this.config.copilot.costOverrides);
    const projected = estimator.estimateFromTotal(model, estimatedTotalTokens);

    this.logger.info(
      `Phase 4: ${taskCount} tasks, estimated ~${estimatedTotalTokens.toLocaleString()} tokens, ` +
      `projected cost: ${CostEstimator.formatCost(projected.total)} (${model})`,
    );
    await this.progress.appendEvent(
      `Phase 4 projection: ${taskCount} tasks, ~${CostEstimator.formatCost(projected.total)} estimated`,
    );

    // Check if projected usage would exceed budget
    if (this.config.options.tokenBudget) {
      const currentUsage = this.tokenTracker.getTotal();
      if (currentUsage + estimatedTotalTokens > this.config.options.tokenBudget) {
        this.logger.warn(
          `Projected Phase 4 usage (${estimatedTotalTokens.toLocaleString()}) plus current usage ` +
          `(${currentUsage.toLocaleString()}) exceeds budget (${this.config.options.tokenBudget.toLocaleString()})`,
        );
      }
    }

    // 2. Topological sort
    const sortedTasks = TaskQueue.topologicalSort(tasks);

    // 3. Build queue, apply checkpoint
    const queue = new TaskQueue(sortedTasks);
    const checkpointState = this.checkpoint.getState();
    queue.markCompleted(checkpointState.completedTasks);
    this.progress.setTotalTasks(sortedTasks.length);
    const completedDurationsMs: number[] = [...checkpointState.completedTaskDurationsMs];

    // 4. Process tasks
    const retryExec = new RetryExecutor(
      (inv) => this.launcher.launchAgent(inv),
      this.logger,
    );

    const continueOnBlocked = this.config.options.continueOnBlocked ?? true;
    const maxBlockedTasks = this.config.options.maxBlockedTasks ?? 0; // 0 = unlimited

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
      const batch = MigrationOrchestrator.selectNonOverlappingBatch(
        readyTasks,
        this.config.options.maxParallelAgents,
      );

      this.logger.info(`Executing batch of ${batch.length} task(s) in parallel (${readyTasks.length} ready)`);

      // Execute batch concurrently
      const batchPromises = batch.map(task => this.executeTask(task, retryExec, queue, completedDurationsMs));
      await Promise.allSettled(batchPromises);

      // Check blocked-task policy
      const progress = queue.getProgress();
      if (progress.blocked > 0) {
        if (!continueOnBlocked) {
          this.logger.error(
            `${progress.blocked} task(s) blocked after max retries — halting Phase 4 (continueOnBlocked=false)`,
          );
          break;
        }
        if (maxBlockedTasks > 0 && progress.blocked >= maxBlockedTasks) {
          this.logger.error(
            `${progress.blocked} task(s) blocked — reached maxBlockedTasks (${maxBlockedTasks}), halting Phase 4`,
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
    return {
      phase: 4,
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

  // ─── Phase 4 Helpers ─────────────────────────────────────────────────

  /**
   * Select a batch of tasks from the ready list that don't share target files
   * or target directories.
   *
   * Tasks sharing target files must run sequentially to avoid write conflicts.
   * Tasks sharing a common output directory are also considered overlapping
   * because build systems (Cargo, MSBuild, Go, Gradle, etc.) typically hold
   * directory-level locks on artifact/build-cache paths.
   */
  private static selectNonOverlappingBatch(
    readyTasks: MigrationTask[],
    maxBatchSize: number,
  ): MigrationTask[] {
    const batch: MigrationTask[] = [];
    const claimedFiles = new Set<string>();
    const claimedDirs = new Set<string>();

    for (const task of readyTasks) {
      if (batch.length >= maxBatchSize) break;

      // Check file-level overlap
      const hasFileOverlap = task.targetFiles.some(f => claimedFiles.has(f));
      if (hasFileOverlap) continue;

      // Check directory-level overlap: extract parent dir from each target file
      const taskDirs = new Set(
        task.targetFiles.map(f => {
          const lastSlash = f.lastIndexOf('/');
          return lastSlash >= 0 ? f.substring(0, lastSlash) : '.';
        }),
      );
      const hasDirOverlap = [...taskDirs].some(d => claimedDirs.has(d));
      if (hasDirOverlap) continue;

      batch.push(task);
      for (const f of task.targetFiles) claimedFiles.add(f);
      for (const d of taskDirs) claimedDirs.add(d);
    }

    return batch;
  }

  private async executeTask(
    task: MigrationTask,
    retryExec: RetryExecutor,
    queue: TaskQueue,
    completedDurationsMs: number[],
  ): Promise<void> {
    this.logger.event({ type: 'task-started', taskId: task.id, name: task.name });
    await this.checkpoint.setCurrentTask(task.id);
    await this.progress.updateTask(task.id, 'in-progress');

    const taskStartMs = Date.now();

    // a. Code migration with retry
    const migratorCtx = await this.contextBuilder.buildContext(
      'code-migrator',
      4,
      task.id,
      {
        sourceFiles: task.sourceFiles,
        targetFiles: task.targetFiles,
        kbEntry: task.knowledgeBaseRef,
      },
    );
    const migratorInv = this.buildInvocation('code-migrator', migratorCtx, 4, task.id);

    const migratorResult = await retryExec.executeWithRetry(migratorInv, {
      maxAttempts: this.config.options.maxRetriesPerTask,
      onRetry: async (attempt, error) => {
        this.logger.warn(`Retry ${attempt} for ${task.id}: ${error}`);
        await this.checkpoint.failTask(task.id, error, attempt, false);
      },
      onExhausted: async (taskId, lastError) => {
        // Escalate to failure-recovery agent
        const recoveryCtx = await this.contextBuilder.buildContext(
          'failure-recovery',
          4,
          taskId,
          {
            failureReport: lastError,
            sourceFile: task.sourceFiles[0],
            targetFile: task.targetFiles[0],
            kbEntry: task.knowledgeBaseRef,
            attemptNumber: this.config.options.maxRetriesPerTask,
          },
        );
        return this.buildInvocation('failure-recovery', recoveryCtx, 4, taskId);
      },
    });

    this.recordTokens(migratorResult, 4);

    if (!migratorResult.success) {
      queue.markBlocked(task.id);
      await this.checkpoint.blockTask(task.id);
      await this.progress.updateTask(task.id, 'blocked', {
        error: migratorResult.error,
      });
      this.logger.event({
        type: 'task-blocked',
        taskId: task.id,
        name: task.name,
        reason: migratorResult.error ?? 'max retries exceeded',
      });
      return;
    }

    // b–c. Parity + test-writer in parallel
    const parityCtx = await this.contextBuilder.buildContext(
      'parity-verifier',
      4,
      task.id,
      {
        sourceFile: task.sourceFiles[0],
        targetFile: task.targetFiles[0],
      },
    );
    const testCtx = await this.contextBuilder.buildContext(
      'test-writer',
      4,
      task.id,
      {
        targetFile: task.targetFiles[0],
        kbEntry: task.knowledgeBaseRef,
        testType: 'unit',
      },
    );

    const parallel = new ParallelExecutor(
      2,
      (inv) => this.launcher.launchAgent(inv),
      this.logger,
    );
    const [parityResult, testResult] = await parallel.executeAll([
      this.buildInvocation('parity-verifier', parityCtx, 4, task.id),
      this.buildInvocation('test-writer', testCtx, 4, task.id),
    ]);
    if (parityResult) this.recordTokens(parityResult, 4);
    if (testResult) this.recordTokens(testResult, 4);

    // b2. Check parity result and retry if non-minor issues found
    const maxParityRetries = this.config.options.maxRetriesPerTask;
    let parityPassed = await this.checkParityResult(task.id);

    if (!parityPassed) {
      for (let attempt = 1; attempt <= maxParityRetries; attempt++) {
        this.logger.warn(
          `Parity check failed for ${task.id}, recovery attempt ${attempt}/${maxParityRetries}`,
        );

        // Launch failure-recovery with parity report
        const parityReportPath = join(
          this.progressDir,
          'parity-reports',
          `${task.id}.md`,
        );
        const recoveryCtx = await this.contextBuilder.buildContext(
          'failure-recovery',
          4,
          task.id,
          {
            failureReport: parityReportPath,
            sourceFile: task.sourceFiles[0],
            targetFile: task.targetFiles[0],
            kbEntry: task.knowledgeBaseRef,
            attemptNumber: attempt,
          },
        );
        const recoveryInv = this.buildInvocation('failure-recovery', recoveryCtx, 4, task.id);
        const recoveryResult = await this.launcher.launchAgent(recoveryInv);
        this.recordTokens(recoveryResult, 4);

        if (!recoveryResult.success) {
          this.logger.warn(`Failure-recovery failed for ${task.id} on attempt ${attempt}`);
          continue;
        }

        // Re-run code-migrator with the recovery context
        const reMigrateCtx = await this.contextBuilder.buildContext(
          'code-migrator',
          4,
          task.id,
          {
            sourceFiles: task.sourceFiles,
            targetFiles: task.targetFiles,
            kbEntry: task.knowledgeBaseRef,
          },
        );
        const reMigrateInv = this.buildInvocation('code-migrator', reMigrateCtx, 4, task.id);
        const reMigrateResult = await this.launcher.launchAgent(reMigrateInv);
        this.recordTokens(reMigrateResult, 4);

        if (!reMigrateResult.success) {
          this.logger.warn(`Re-migration failed for ${task.id} on attempt ${attempt}`);
          continue;
        }

        // Re-run parity-verifier
        const reParityCtx = await this.contextBuilder.buildContext(
          'parity-verifier',
          4,
          task.id,
          {
            sourceFile: task.sourceFiles[0],
            targetFile: task.targetFiles[0],
          },
        );
        const reParityInv = this.buildInvocation('parity-verifier', reParityCtx, 4, task.id);
        const reParityResult = await this.launcher.launchAgent(reParityInv);
        this.recordTokens(reParityResult, 4);

        parityPassed = await this.checkParityResult(task.id);
        if (parityPassed) {
          this.logger.info(`Parity recovered for ${task.id} on attempt ${attempt}`);
          break;
        }
      }

      // After exhausting retries, check if only minor issues remain
      if (!parityPassed) {
        const hasBlockingIssues = await this.hasNonMinorParityIssues(task.id);
        if (hasBlockingIssues) {
          queue.markBlocked(task.id);
          await this.checkpoint.blockTask(task.id);
          await this.progress.updateTask(task.id, 'blocked', {
            error: 'parity check failed with critical/major issues after max retries',
          });
          this.logger.event({
            type: 'task-blocked',
            taskId: task.id,
            name: task.name,
            reason: 'parity verification failed with non-minor issues',
          });
          return;
        }
        this.logger.info(
          `Parity for ${task.id} has only minor issues after retries, proceeding`,
        );
      }
    }

    // c2. Run build command if configured
    if (this.config.target.buildCommand) {
      const buildOk = await this.runCommandWithRecovery(
        'build', this.config.target.buildCommand, task, queue,
      );
      if (!buildOk) return;
    }

    // c3. Run test command if configured
    if (this.config.target.testCommand) {
      const testOk = await this.runCommandWithRecovery(
        'test', this.config.target.testCommand, task, queue,
      );
      if (!testOk) return;
    }

    // d. Complete task
    const durationMs = Date.now() - taskStartMs;
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
      duration: migratorResult.duration,
    });
    let progressMsg = `Task progress: ${progress.completed}/${progress.total} (${progress.blocked} blocked)`;
    if (completedDurationsMs.length >= 2) {
      const avgMs = completedDurationsMs.reduce((a, b) => a + b, 0) / completedDurationsMs.length;
      const etaMs = progress.remaining * avgMs;
      progressMsg += ` — avg ${formatDuration(avgMs)}/task, ~${formatDuration(etaMs)} remaining`;
    }
    this.logger.info(progressMsg);
  }

  // ─── Phase 5: Final Parity Verification ──────────────────────────────

  private async executePhase5(start: number): Promise<PhaseResult> {
    const MAX_LOOPBACK = 2;

    for (let iteration = 0; iteration <= MAX_LOOPBACK; iteration++) {
      const ctx = await this.contextBuilder.buildContext('final-parity-checker', 5);
      const inv = this.buildInvocation('final-parity-checker', ctx, 5);
      const result = await this.launcher.launchAgent(inv);
      this.recordTokens(result, 5);

      if (!result.success) {
        return {
          phase: 5,
          name: 'Final Parity Verification',
          success: false,
          duration: Date.now() - start,
          error: result.error,
          exitCode: result.exitCode,
          stderr: result.stderr,
        };
      }

      // Parse report for required fixes — prefer structuredOutput, fall back to file
      let fixes: Array<{ description: string; sourceFile: string; targetFile: string }>;
      if (result.outputParsed && Array.isArray(result.structuredOutput?.['fixes'])) {
        fixes = result.structuredOutput['fixes'] as Array<{ description: string; sourceFile: string; targetFile: string }>;
      } else {
        const reportPath = join(this.progressDir, 'final-parity-report.md');
        if (!(await fileExists(reportPath))) break;
        this.logger.warn('Final-parity-checker structured output unavailable — falling back to ResultParser.parseFinalParityReport');
        fixes = await ResultParser.parseFinalParityReport(reportPath);
      }
      if (fixes.length === 0) break;

      if (iteration < MAX_LOOPBACK) {
        this.logger.info(
          `Final parity found ${fixes.length} issue(s), loop-back iteration ${iteration + 1}`,
        );
        // Create targeted fix tasks and re-migrate
        for (const fix of fixes) {
          const fixCtx = await this.contextBuilder.buildContext(
            'code-migrator',
            5,
            `fix-${iteration}-${fixes.indexOf(fix)}`,
            {
              sourceFiles: fix.sourceFile ? [fix.sourceFile] : [],
              targetFiles: fix.targetFile ? [fix.targetFile] : [],
              description: fix.description,
            },
          );
          const fixInv = this.buildInvocation(
            'code-migrator',
            fixCtx,
            5,
            `fix-${iteration}-${fixes.indexOf(fix)}`,
          );
          const fixResult = await this.launcher.launchAgent(fixInv);
          this.recordTokens(fixResult, 5);
        }
      } else {
        this.logger.warn('Max loop-back iterations reached, proceeding with remaining issues');
      }
    }

    const outputPath = join(this.progressDir, 'final-parity-report.md');
    return {
      phase: 5,
      name: 'Final Parity Verification',
      success: true,
      outputPath,
      duration: Date.now() - start,
    };
  }

  // ─── Phase 6: E2E Testing & Documentation ────────────────────────────

  private async executePhase6(start: number): Promise<PhaseResult> {
    const e2eCtx = await this.contextBuilder.buildContext('e2e-test-crafter', 6);
    const docCtx = await this.contextBuilder.buildContext('documentation-writer', 6);

    const parallel = new ParallelExecutor(
      2,
      (inv) => this.launcher.launchAgent(inv),
      this.logger,
    );

    const results = await parallel.executeAll([
      this.buildInvocation('e2e-test-crafter', e2eCtx, 6),
      this.buildInvocation('documentation-writer', docCtx, 6),
    ]);

    for (const r of results) this.recordTokens(r, 6);

    const allSuccess = results.every((r) => r.success);
    const errors = results.filter((r) => !r.success).map((r) => r.error);

    return {
      phase: 6,
      name: 'E2E Testing & Documentation',
      success: allSuccess,
      outputPath: this.config.target.outputPath,
      duration: Date.now() - start,
      error: errors.length > 0 ? errors.join('; ') : undefined,
    };
  }

  // ─── Phase 7: Completion ─────────────────────────────────────────────

  private async executePhase7(start: number): Promise<PhaseResult> {
    await this.progress.appendEvent('Migration pipeline complete — finalizing');
    this.logger.info('All phases complete');

    return {
      phase: 7,
      name: 'Completion',
      success: true,
      outputPath: this.progressDir,
      duration: Date.now() - start,
    };
  }

  // ─── Phase 8: Idiomatic Refactor ─────────────────────────────────────

  private async executePhase8(start: number): Promise<PhaseResult> {
    const maxIterations = this.config.options.idiomaticRefactor?.maxIterations ?? 2;

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      const reviewCtx = await this.contextBuilder.buildContext('idiomatic-reviewer', 8);
      const reviewInv = this.buildInvocation('idiomatic-reviewer', reviewCtx, 8);
      const reviewResult = await this.launcher.launchAgent(reviewInv);
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

      // Parse idiomatic issues
      const reportPath = join(this.progressDir, 'idiomatic-review-report.md');
      let issues: Array<{ file: string; issue: string; suggestion: string }>;
      if (reviewResult.outputParsed && Array.isArray(reviewResult.structuredOutput?.['issues'])) {
        issues = reviewResult.structuredOutput['issues'] as Array<{ file: string; issue: string; suggestion: string }>;
      } else {
        this.logger.warn('Idiomatic-reviewer structured output unavailable — falling back to ResultParser.parseIdiomaticReport');
        issues = await ResultParser.parseIdiomaticReport(reportPath);
      }

      if (issues.length === 0) break;

      if (iteration < maxIterations - 1) {
        this.logger.info(
          `Idiomatic review found ${issues.length} issue(s), refactor iteration ${iteration + 1}`,
        );
        for (const issue of issues) {
          const refactorCtx = await this.contextBuilder.buildContext('idiomatic-refactorer', 8, undefined, {
            targetFile: issue.file,
            idiomaticReport: reportPath,
          });
          const refactorInv = this.buildInvocation('idiomatic-refactorer', refactorCtx, 8);
          const refactorResult = await this.launcher.launchAgent(refactorInv);
          this.recordTokens(refactorResult, 8);
          if (!refactorResult.success) {
            return {
              phase: 8,
              name: 'Idiomatic Refactor',
              success: false,
              outputPath: reportPath,
              duration: Date.now() - start,
            };
          }
        }
      } else {
        this.logger.warn('Max idiomatic refactor iterations reached, proceeding with remaining issues');
      }
    }

    const outputPath = join(this.progressDir, 'idiomatic-review-report.md');
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
  ): Promise<{ success: boolean; error?: string; infraError?: string }> {
    return this.buildLimiter(async () => {
      const timeout = this.config.copilot.timeout;
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
        const logPath = join(this.progressDir, 'logs', `${label}-${taskId}-${timestamp}.log`);
        const logContent = `=== COMMAND: ${command} ===\n=== EXIT CODE: ${result.exitCode} ===\n\n=== STDOUT ===\n${result.stdout}\n\n=== STDERR ===\n${result.stderr}\n`;
        await atomicWrite(logPath, logContent);

        if (result.exitCode !== 0 || result.killed) {
          const errorText = result.killed
            ? `${label} command timed out after ${timeout}ms`
            : `${label} command failed (exit code ${result.exitCode}): ${result.stderr.slice(0, 500)}`;
          this.logger.error(errorText);

          // Classify the error: infrastructure vs. code quality
          const combinedOutput = `${result.stdout}\n${result.stderr}`;
          const infraLabel = classifyError(combinedOutput);

          return { success: false, error: errorText, infraError: infraLabel };
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
   * budget or invoke the expensive failure-recovery agent.
   *
   * Genuine code-quality failures go through the full recovery pipeline:
   * `failure-recovery` → `code-migrator` → re-run command.
   *
   * After exhausting all retry budgets the task is marked blocked.
   *
   * Returns `true` if the command eventually passes, `false` if blocked.
   */
  private async runCommandWithRecovery(
    label: string,
    command: string,
    task: MigrationTask,
    queue: TaskQueue,
  ): Promise<boolean> {
    const maxAttempts = this.config.options.maxRetriesPerTask;
    const maxInfraRetries = this.config.options.maxInfraRetries ?? 3;

    // Initial attempt
    let cmdResult = await this.runCommand(label, command, task.id);
    if (cmdResult.success) return true;

    // Infrastructure retry loop — simple backoff, no recovery agent
    let infraAttempt = 0;
    while (cmdResult.infraError && infraAttempt < maxInfraRetries) {
      infraAttempt++;
      const backoffMs = Math.min(1000 * Math.pow(2, infraAttempt - 1), 30_000);
      this.logger.warn(
        `${label} failed for ${task.id} with infrastructure error "${cmdResult.infraError}", ` +
        `infra retry ${infraAttempt}/${maxInfraRetries} (backoff ${backoffMs}ms)`,
      );
      await new Promise(resolve => setTimeout(resolve, backoffMs));

      cmdResult = await this.runCommand(label, command, task.id);
      if (cmdResult.success) {
        this.logger.info(
          `${label} recovered for ${task.id} after infra retry ${infraAttempt}`,
        );
        return true;
      }
    }

    // If we're still failing with an infra error after exhausting infra retries,
    // fall through to the code-quality recovery loop (it may still help).
    if (cmdResult.success) return true;

    // Code-quality recovery loop — full failure-recovery → code-migrator pipeline
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      this.logger.warn(
        `${label} failed for ${task.id}, recovery attempt ${attempt}/${maxAttempts}: ${cmdResult.error}`,
      );

      // 1. Launch failure-recovery with the error output
      const recoveryCtx = await this.contextBuilder.buildContext(
        'failure-recovery',
        4,
        task.id,
        {
          failureReport: cmdResult.error,
          failureType: label,
          sourceFile: task.sourceFiles[0],
          targetFile: task.targetFiles[0],
          kbEntry: task.knowledgeBaseRef,
          attemptNumber: attempt,
        },
      );
      const recoveryInv = this.buildInvocation('failure-recovery', recoveryCtx, 4, task.id);
      const recoveryResult = await this.launcher.launchAgent(recoveryInv);
      this.recordTokens(recoveryResult, 4);

      if (!recoveryResult.success) {
        this.logger.warn(`Failure-recovery agent failed for ${task.id} on attempt ${attempt}`);
        continue;
      }

      // 2. Re-migrate with the fixed context
      const reMigrateCtx = await this.contextBuilder.buildContext(
        'code-migrator',
        4,
        task.id,
        {
          sourceFiles: task.sourceFiles,
          targetFiles: task.targetFiles,
          kbEntry: task.knowledgeBaseRef,
        },
      );
      const reMigrateInv = this.buildInvocation('code-migrator', reMigrateCtx, 4, task.id);
      const reMigrateResult = await this.launcher.launchAgent(reMigrateInv);
      this.recordTokens(reMigrateResult, 4);

      if (!reMigrateResult.success) {
        this.logger.warn(`Re-migration failed for ${task.id} on ${label} recovery attempt ${attempt}`);
        continue;
      }

      // 3. Re-run the command
      cmdResult = await this.runCommand(label, command, task.id);
      if (cmdResult.success) {
        this.logger.info(`${label} recovered for ${task.id} on attempt ${attempt}`);
        return true;
      }
    }

    // Exhausted retries — block the task
    queue.markBlocked(task.id);
    await this.checkpoint.blockTask(task.id);
    await this.progress.updateTask(task.id, 'blocked', {
      error: cmdResult.error,
    });
    this.logger.event({
      type: 'task-blocked',
      taskId: task.id,
      name: task.name,
      reason: cmdResult.error ?? `${label} command failed after ${maxAttempts} recovery attempts`,
    });
    return false;
  }

  // ─── Helpers ─────────────────────────────────────────────────────────

  /**
   * Check if the parity-verifier sidecar result indicates a pass.
   * Returns `true` if parity is 'pass', or if no sidecar file exists (assume pass).
   */
  private async checkParityResult(taskId: string): Promise<boolean> {
    const result = await ResultParser.readTaskResultJson(
      this.progressDir,
      'parity-verifier',
      taskId,
    );
    if (!result) return true; // No sidecar → assume pass
    if (result.parity === 'pass') return true;
    if (result.parity === 'partial') {
      // Partial is a pass if all issues are minor
      return result.issues.every((i) => i.severity === 'minor');
    }
    return false;
  }

  /**
   * Check if the parity sidecar has any non-minor (critical/major) issues.
   * Returns `false` if no sidecar exists or all issues are minor.
   */
  private async hasNonMinorParityIssues(taskId: string): Promise<boolean> {
    const result = await ResultParser.readTaskResultJson(
      this.progressDir,
      'parity-verifier',
      taskId,
    );
    if (!result) return false;
    return result.issues.some((i) => i.severity !== 'minor');
  }

  private buildInvocation(
    agent: AgentName,
    contextFile: string,
    phase: number,
    taskId?: string,
  ): AgentInvocation {
    const phaseTimeouts = this.config.copilot.phaseTimeouts;
    const timeout = phaseTimeouts?.[phase] ?? this.config.copilot.timeout;

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
      'failure-recovery',
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

    return {
      agent,
      contextFile,
      progressDir: this.progressDir,
      phase,
      taskId,
      timeout,
      ...(mcpConfig ? { mcpConfig } : {}),
      ...(kbDbPath ? { kbDbPath } : {}),
    };
  }

  private recordTokens(result: AgentResult, phase: number): void {
    if (result.tokenUsage) {
      this.tokenTracker.record(result.agent, phase, result.tokenUsage.total, result.tokenUsage.cachedInput);
    }
  }
}
