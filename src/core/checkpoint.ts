import { readFile } from 'node:fs/promises';
import { atomicWrite, ensureDir, fileExists, readJson, writeJson } from '../util/fs.js';
import { Logger } from '../logging/logger.js';
import type { FlowCheckpointSnapshot } from '@cadre-dev/framework/flow';
import type { TerminalReasonCode } from '../agents/types.js';

export interface TerminalExhaustionState {
  reasonCode: TerminalReasonCode;
  wave?: number;
  taskId?: string;
  check?: string;
  summary?: string;
}

export interface Phase4TaskSubstepState {
  completedSubsteps: string[];
  lastSuccessfulStep?: string;
}

export interface Phase4Cursor {
  tasks: Record<string, Phase4TaskSubstepState>;
}

export interface Phase5Cursor {
  iteration: number;
  fixIndex: number;
  lastSuccessfulStep?: string;
  hadUnresolvedFixes?: boolean;
}

export interface Phase6Cursor {
  completedAgents: string[];
  completedSuites?: string[];
  lastSuccessfulStep?: string;
}

export interface Phase7Cursor {
  iteration: number;
  issueIndex: number;
  currentFile?: string;
  lastSuccessfulStep?: string;
}

export interface PhaseCursorMap {
  '4'?: Phase4Cursor;
  '5'?: Phase5Cursor;
  '6'?: Phase6Cursor;
  '7'?: Phase7Cursor;
}

export interface CheckpointState {
  projectName: string;
  version: number;                          // schema version for forward compat (currently 1)
  currentPhase: number;                     // 1-7
  currentTask: string | null;
  completedPhases: number[];
  completedTasks: string[];
  failedTasks: CheckpointFailedTask[];
  blockedTasks: string[];                   // tasks that hit max retries
  phaseOutputs: Record<number, string>;     // phase → output file path
  tokenUsage: {
    total: number;
    byPhase: Record<number, number>;
    byAgent: Record<string, number>;
  };
  startedAt: string;                        // ISO timestamp
  lastCheckpoint: string;                   // ISO timestamp
  resumeCount: number;
  cumulativeDurationMs: number;             // total wall-clock ms across all resume runs
  completedTaskDurationsMs: number[];       // wall-clock ms per completed task, in order
  /** True once the migration-planner (step 3a) finishes successfully. */
  phase3aComplete?: boolean;
  /** True once the target-repo scaffold has been generated from compilation units. */
  scaffoldComplete?: boolean;
  completedPhase2Groups?: string[];
  /** Number of JSONL metric records written; used to skip on resume. */
  metricsCount: number;
  /** Source fingerprint from last successful Phase 0 build; used to skip re-indexing on resume. */
  phase0Fingerprint?: string;
  /** Terminal Phase 4 exhaustion metadata, when execution stopped fail-fast. */
  terminalExhaustion?: TerminalExhaustionState;
  /** Persisted waiver records for adjudicated false-positive findings. */
  adjudicationWaivers?: AdjudicationWaiverRecord[];
  /** Auditable adjudication event history across retries/resume. */
  adjudicationEvents?: AdjudicationEventRecord[];
  /** Per-phase deterministic resume cursors for mid-stage checkpointing. */
  phaseCursors?: PhaseCursorMap;
  /** Top-level flow checkpoint snapshot (managed by AamfFlowCheckpointAdapter). */
  __flowCheckpoint?: unknown;
  /** Phase 4 nested flow checkpoint snapshot (managed by Phase4CheckpointAdapter). */
  __phase4FlowCheckpoint?: unknown;
}

export interface CheckpointFailedTask {
  taskId: string;
  attempts: number;
  lastError: string;
  recoveryAttempted: boolean;
}

export interface AdjudicationWaiverRecord {
  issueFingerprint: string;
  decision: 'fixed' | 'false_positive' | 'real_gap' | 'inconclusive';
  scope?: string;
  expiresAt?: string;
  taskId?: string;
  createdAt: string;
}

export interface AdjudicationEventRecord {
  decision: 'fixed' | 'false_positive' | 'real_gap' | 'inconclusive';
  issueFingerprint?: string;
  scope?: string;
  expiresAt?: string;
  taskId?: string;
  rationale?: string;
  confidence?: string;
  evidence?: string[];
  createdAt: string;
}

const CHECKPOINT_VERSION = 1;

export class CheckpointManager {
  private state: CheckpointState | null = null;
  private readonly checkpointPath: string;
  private readonly backupPath: string;
  private readonly stateDir: string;

  constructor(private readonly progressDir: string, private readonly logger: Logger) {
    this.stateDir = `${progressDir}/state`;
    this.checkpointPath = `${this.stateDir}/checkpoint.json`;
    this.backupPath = `${this.stateDir}/checkpoint.backup.json`;
  }

  /** Read the current checkpoint, or create initial state */
  async load(projectName: string, options: { fresh?: boolean; reuseKb?: boolean } = {}): Promise<CheckpointState> {
    await ensureDir(this.stateDir);

    if (options.fresh) {
      if (options.reuseKb) {
        // Preserve KB-related state from the prior run while resetting everything else.
        const prior = await this.loadPriorState();
        this.state = this.buildInitialState(projectName);
        if (prior) {
          // Carry forward early-phase completion markers so Phases 0-2 can skip.
          const kbPhases = [0, 1, 2];
          this.state.completedPhases = prior.completedPhases.filter(p => kbPhases.includes(p));
          this.state.currentPhase = this.state.completedPhases.length > 0
            ? Math.max(...this.state.completedPhases) + 1 : 0;
          if (prior.phase0Fingerprint) this.state.phase0Fingerprint = prior.phase0Fingerprint;
          // Preserve phase outputs for KB phases so artifact paths remain valid.
          for (const p of kbPhases) {
            if (prior.phaseOutputs?.[p]) this.state.phaseOutputs[p] = prior.phaseOutputs[p]!;
          }
          // Preserve scaffold state so Phase 4 doesn't re-scaffold.
          if (prior.scaffoldComplete) this.state.scaffoldComplete = prior.scaffoldComplete;
          // Carry the flow checkpoint forward so the flow runner knows which
          // steps are already done.  We filter its completedExecutionIds to
          // only retain KB-related node completions.
          if (prior.__flowCheckpoint && typeof prior.__flowCheckpoint === 'object') {
            const fc = prior.__flowCheckpoint as Record<string, unknown>;
            const KB_STEP_IDS = ['kb-index', 'task-graph-construction', 'kb-construction', 'budget-check-2'];
            const priorCompleted = (fc.completedExecutionIds ?? []) as string[];
            const kbCompleted = priorCompleted.filter(id => KB_STEP_IDS.some(s => id.endsWith('/' + s)));
            if (kbCompleted.length > 0) {
              this.state.__flowCheckpoint = {
                ...fc,
                completedExecutionIds: kbCompleted,
                status: 'running',
                outputs: {},
                executionOutputs: {},
                error: undefined,
              };
            }
          }
          this.logger.info(
            `Fresh start with reuseKb — preserved phases [${this.state.completedPhases.join(', ')}], ` +
            `resuming from Phase ${this.state.currentPhase}`,
          );
        } else {
          this.logger.info('Fresh start with reuseKb — no prior checkpoint found, starting from scratch');
        }
      } else {
        this.logger.info('Fresh start requested (resume=false) — ignoring prior checkpoint state');
        this.state = this.buildInitialState(projectName);
      }
      await this.save(this.state);
      return this.state;
    }

    const checkpointToRead = await this.resolveCheckpointReadPath();
    const backupToRead = await this.resolveBackupReadPath();

    if (checkpointToRead) {
      try {
        this.state = await readJson<CheckpointState>(checkpointToRead);
        this.applyBackwardCompatibleDefaults(this.state);
        this.prepareForResume(this.state);
        this.state.resumeCount += 1;
        this.logger.info(`Loaded checkpoint: Phase ${this.state.currentPhase}, ${this.state.completedTasks.length} tasks completed, resume #${this.state.resumeCount}`);
        await this.save(this.state);
        return this.state;
      } catch (err) {
        this.logger.warn(`Failed to read checkpoint, trying backup: ${(err as Error).message}`);
        // Try backup
        if (backupToRead) {
          try {
            this.state = await readJson<CheckpointState>(backupToRead);
            this.applyBackwardCompatibleDefaults(this.state);
            this.prepareForResume(this.state);
            this.state.resumeCount += 1;
            this.logger.info(`Loaded backup checkpoint: Phase ${this.state.currentPhase}`);
            await this.save(this.state);
            return this.state;
          } catch {
            this.logger.error('Backup checkpoint also corrupted, creating fresh state');
          }
        }
      }
    }

    // Create initial state
    this.state = this.buildInitialState(projectName);
    await this.save(this.state);
    return this.state;
  }

  /** Get current state (throws if not loaded) */
  getState(): CheckpointState {
    if (!this.state) throw new Error('Checkpoint not loaded. Call load() first.');
    return this.state;
  }

  /** Atomically write checkpoint (backup old, write to .tmp then rename) */
  async save(state: CheckpointState): Promise<void> {
    this.state = state;
    state.lastCheckpoint = new Date().toISOString();

    // Backup current checkpoint before overwriting
    if (await fileExists(this.checkpointPath)) {
      try {
        const existing = await readFile(this.checkpointPath, 'utf-8');
        await atomicWrite(this.backupPath, existing);
      } catch {
        // Backup failed — continue anyway
      }
    }

    await writeJson(this.checkpointPath, state);
    this.logger.debug('Checkpoint saved');
  }

  /** Mark a phase as complete and checkpoint */
  async completePhase(phase: number, outputPath: string): Promise<void> {
    const state = this.getState();
    if (!state.completedPhases.includes(phase)) {
      state.completedPhases.push(phase);
    }
    state.phaseOutputs[phase] = outputPath;
    // Never regress the resume pointer — a re-run of an earlier phase (e.g.
    // Phase 0 fingerprint check on resume) must not overwrite a more-advanced
    // currentPhase saved by a previous run.
    state.currentPhase = Math.max(state.currentPhase, phase + 1);
    state.currentTask = null;
    this.logger.event({ type: 'checkpoint-saved', phase });
    await this.save(state);
  }

  /** Mark a task as complete and checkpoint */
  async completeTask(taskId: string, durationMs?: number): Promise<void> {
    const state = this.getState();
    if (!state.completedTasks.includes(taskId)) {
      state.completedTasks.push(taskId);
    }
    if (durationMs !== undefined) {
      state.completedTaskDurationsMs.push(durationMs);
    }
    state.currentTask = null;
    // Remove from failed if it was there
    state.failedTasks = state.failedTasks.filter(f => f.taskId !== taskId);
    // Remove from blocked if it was there
    state.blockedTasks = state.blockedTasks.filter(id => id !== taskId);
    state.phaseCursors ??= {};
    state.phaseCursors['4'] ??= { tasks: {} };
    state.phaseCursors['4'].tasks[taskId] ??= { completedSubsteps: [] };
    if (!state.phaseCursors['4'].tasks[taskId].completedSubsteps.includes('completed')) {
      state.phaseCursors['4'].tasks[taskId].completedSubsteps.push('completed');
    }
    state.phaseCursors['4'].tasks[taskId].lastSuccessfulStep = 'completed';
    await this.save(state);
  }

  /** Remove a task from failedTasks (e.g. after a retry succeeds). */
  async clearFailedTask(taskId: string): Promise<void> {
    const state = this.getState();
    const before = state.failedTasks.length;
    state.failedTasks = state.failedTasks.filter(f => f.taskId !== taskId);
    if (state.failedTasks.length < before) {
      await this.save(state);
    }
  }

  /** Record a task failure */
  async failTask(taskId: string, error: string, attempt: number, recoveryAttempted: boolean): Promise<void> {
    const state = this.getState();
    const existing = state.failedTasks.find(f => f.taskId === taskId);
    if (existing) {
      existing.attempts = attempt;
      existing.lastError = error;
      existing.recoveryAttempted = recoveryAttempted;
    } else {
      state.failedTasks.push({ taskId, attempts: attempt, lastError: error, recoveryAttempted });
    }
    await this.save(state);
  }

  /** Persist an adjudication waiver for future fingerprint reuse checks. */
  async recordAdjudicationWaiver(waiver: Omit<AdjudicationWaiverRecord, 'createdAt'> & { createdAt?: string }): Promise<void> {
    const state = this.getState();
    state.adjudicationWaivers ??= [];
    state.adjudicationWaivers.push({
      ...waiver,
      createdAt: waiver.createdAt ?? new Date().toISOString(),
    });
    await this.save(state);
  }

  /** Append an auditable adjudication event. */
  async appendAdjudicationEvent(event: Omit<AdjudicationEventRecord, 'createdAt'> & { createdAt?: string }): Promise<void> {
    const state = this.getState();
    state.adjudicationEvents ??= [];
    state.adjudicationEvents.push({
      ...event,
      createdAt: event.createdAt ?? new Date().toISOString(),
    });
    await this.save(state);
  }

  /** Block a task (max retries exceeded) */
  async blockTask(taskId: string): Promise<void> {
    const state = this.getState();
    if (!state.blockedTasks.includes(taskId)) {
      state.blockedTasks.push(taskId);
    }
    await this.save(state);
  }

  /** Set current task being worked on */
  async setCurrentTask(taskId: string): Promise<void> {
    const state = this.getState();
    state.currentTask = taskId;
    await this.save(state);
  }

  /** Persist terminal exhaustion metadata for fail-fast Phase 4 exits. */
  async setTerminalExhaustion(terminalExhaustion: TerminalExhaustionState): Promise<void> {
    const state = this.getState();
    state.terminalExhaustion = terminalExhaustion;
    await this.save(state);
  }

  /**
   * Mark Phase 3 migration strategy (migration-planner) as complete.
   * Subsequent resumes will skip re-running the migration-planner.
   */
  async completePhase3a(): Promise<void> {
    const state = this.getState();
    state.phase3aComplete = true;
    state.completedPhase2Groups ??= [];
    await this.save(state);
  }

  /**
   * Mark the target-repo scaffold as generated.
   * Subsequent resumes will skip re-running scaffold generation.
   */
  async completeScaffold(): Promise<void> {
    const state = this.getState();
    state.scaffoldComplete = true;
    await this.save(state);
  }

  /** Record that a specific module group finished successfully. On resume, completed groups are skipped. */
  async completePhase3Group(groupId: string): Promise<void> {
    const state = this.getState();
    state.completedPhase2Groups ??= [];
    if (!state.completedPhase2Groups.includes(groupId)) {
      state.completedPhase2Groups.push(groupId);
    }
    await this.save(state);
  }

  /** Determine what phase/task to resume from */
  getResumePoint(): { phase: number; taskId: string | null } {
    const state = this.getState();
    return { phase: state.currentPhase, taskId: state.currentTask };
  }

  /**
   * Reset all checkpoint state from `fromPhase` onward, preserving earlier phases.
   * Used by `--from-phase N` to restart from a fixed phase boundary.
   *
   * @param fromPhase  The phase number to restart from (0-8).
   * @param nodeIdToPhase  Maps flow node IDs to phase numbers (returns -1 for unknown).
   *
   * Requires that all phases 0..fromPhase-1 are already completed (or fromPhase === 0).
   * Throws if the prerequisite phases are missing.
   */
  async resetFromPhase(fromPhase: number, nodeIdToPhase: (id: string) => number): Promise<void> {
    const state = this.getState();

    // Validate prerequisites: all phases before fromPhase must be completed
    if (fromPhase > 0) {
      const missing: number[] = [];
      for (let p = 0; p < fromPhase; p++) {
        if (!state.completedPhases.includes(p)) {
          missing.push(p);
        }
      }
      if (missing.length > 0) {
        throw new Error(
          `Cannot --from-phase ${fromPhase}: prerequisite phase(s) ${missing.join(', ')} ` +
          `not completed. Completed phases: [${state.completedPhases.sort((a, b) => a - b).join(', ')}]`,
        );
      }
    }

    // 1. completedPhases — keep only < fromPhase
    state.completedPhases = state.completedPhases.filter(p => p < fromPhase);

    // 2. currentPhase — set to fromPhase
    state.currentPhase = fromPhase;

    // 3. currentTask — clear
    state.currentTask = null;

    // 4. phaseOutputs — remove keys >= fromPhase
    for (const key of Object.keys(state.phaseOutputs)) {
      if (Number(key) >= fromPhase) {
        delete state.phaseOutputs[Number(key)];
      }
    }

    // 5. Phase-specific state
    if (fromPhase <= 0) {
      state.phase0Fingerprint = undefined;
    }
    if (fromPhase <= 2) {
      state.completedPhase2Groups = [];
    }
    if (fromPhase <= 3) {
      state.phase3aComplete = false;
      state.scaffoldComplete = false;
    }
    if (fromPhase <= 4) {
      state.completedTasks = [];
      state.failedTasks = [];
      state.blockedTasks = [];
      state.completedTaskDurationsMs = [];
      state.terminalExhaustion = undefined;
      state.adjudicationWaivers = [];
      state.adjudicationEvents = [];
      state.phaseCursors ??= {};
      state.phaseCursors['4'] = { tasks: {} };
      state.__phase4FlowCheckpoint = undefined;
    }
    if (fromPhase <= 5) {
      state.phaseCursors ??= {};
      state.phaseCursors['5'] = { iteration: 0, fixIndex: 0 };
    }
    if (fromPhase <= 6) {
      state.phaseCursors ??= {};
      state.phaseCursors['6'] = { completedAgents: [], completedSuites: [] };
    }
    if (fromPhase <= 7) {
      state.phaseCursors ??= {};
      state.phaseCursors['7'] = { iteration: 0, issueIndex: 0 };
    }

    // 6. Flow checkpoint — remove completedExecutionIds for phases >= fromPhase
    //    and reset status so the runner re-enters from the correct point.
    if (state.__flowCheckpoint && typeof state.__flowCheckpoint === 'object') {
      const fc = state.__flowCheckpoint as FlowCheckpointSnapshot<unknown> & { error?: unknown };
      if (Array.isArray(fc.completedExecutionIds)) {
        fc.completedExecutionIds = fc.completedExecutionIds.filter((id: string) => {
          // Execution IDs are namespaced: "<flowId>/<nodeId>".
          // Strip the prefix to get the bare node ID for phase lookup.
          const slashIdx = id.indexOf('/');
          const bareId = slashIdx >= 0 ? id.slice(slashIdx + 1) : id;
          const phase = nodeIdToPhase(bareId);
          // Keep nodes that belong to phases before fromPhase.
          // Keep unknown nodes (phase === -1) to be safe — they may be
          // internal framework nodes not mapped to any phase.
          return phase === -1 || phase < fromPhase;
        });
      }
      // Reset status so the Cadre runner re-enters from the correct point.
      if (fc.status === 'failed' || fc.status === 'completed') {
        fc.status = 'running';
        fc.error = undefined;
      }
    }

    this.logger.info(`Reset checkpoint from phase ${fromPhase} onward — preserving phases [${state.completedPhases.join(', ')}]`);
    await this.save(state);
  }

  /** Add token usage */
  async addTokenUsage(agent: string, phase: number, tokens: number): Promise<void> {
    const state = this.getState();
    state.tokenUsage.total += tokens;
    state.tokenUsage.byPhase[phase] = (state.tokenUsage.byPhase[phase] ?? 0) + tokens;
    state.tokenUsage.byAgent[agent] = (state.tokenUsage.byAgent[agent] ?? 0) + tokens;
    await this.save(state);
  }

  /** Check if token budget is exceeded */
  isBudgetExceeded(budget?: number): boolean {
    if (budget === undefined) return false;
    return this.getState().tokenUsage.total > budget;
  }

  private buildInitialState(projectName: string): CheckpointState {
    return {
      projectName,
      version: CHECKPOINT_VERSION,
      currentPhase: 0,
      currentTask: null,
      completedPhases: [],
      completedTasks: [],
      failedTasks: [],
      blockedTasks: [],
      phaseOutputs: {},
      tokenUsage: { total: 0, byPhase: {}, byAgent: {} },
      startedAt: new Date().toISOString(),
      lastCheckpoint: new Date().toISOString(),
      resumeCount: 0,
      cumulativeDurationMs: 0,
      completedTaskDurationsMs: [],
      phase3aComplete: false,
      scaffoldComplete: false,
      completedPhase2Groups: [],
      metricsCount: 0,
      terminalExhaustion: undefined,
      adjudicationWaivers: [],
      adjudicationEvents: [],
      phaseCursors: {},
    };
  }

  /**
   * Prepare checkpoint state for a resume run.
   *
   * Clears transient failure markers so previously-exhausted tasks get fresh
   * retry budgets instead of immediately failing again:
   *
   * 1. **terminalExhaustion** — cleared so the parity-gate loop re-enters
   *    instead of raising TerminalExhaustionError on the same task.
   * 2. **failedTasks** — retry counters reset so code-migrator and
   *    parity-failure-resolver get fresh attempts.
   * 3. **Phase 4 flow checkpoint** — completedExecutionIds are filtered to
   *    only retain substeps for fully-completed tasks. Failed/in-flight tasks
   *    are removed so they re-enter the scheduling pool from scratch (fresh
   *    code-migrator run, not just parity retry).
   * 4. **Flow checkpoint status** — both top-level and Phase 4 subflow
   *    checkpoints are reset from 'failed' to 'running' so the Cadre runner
   *    re-enters the Phase 4 subflow.
   * 5. **Phase 4 cursors** — per-task substep tracking is cleared for
   *    non-completed tasks.
   * 6. **Blocked tasks** — cleared so previously-blocked tasks re-enter the pool.
   */
  private prepareForResume(state: CheckpointState): void {
    // 1. Clear terminal exhaustion so the run doesn't immediately re-fail.
    if (state.terminalExhaustion) {
      this.logger.info(
        `Clearing terminal exhaustion from prior run: ${state.terminalExhaustion.reasonCode}` +
        (state.terminalExhaustion.taskId ? ` (task=${state.terminalExhaustion.taskId})` : ''),
      );
      state.terminalExhaustion = undefined;
    }

    // 2. Reset failed task retry counters so they get fresh attempts.
    if (state.failedTasks.length > 0) {
      this.logger.info(`Resetting retry counters for ${state.failedTasks.length} failed task(s)`);
      state.failedTasks = [];
    }

    // 2b. Clear blocked tasks so they re-enter the pool.
    if (state.blockedTasks.length > 0) {
      this.logger.info(`Unblocking ${state.blockedTasks.length} blocked task(s)`);
      state.blockedTasks = [];
    }

    // 3. Filter Phase 4 flow checkpoint to only keep substeps for completed tasks.
    //    Failed/in-flight tasks re-enter the pool from scratch.
    this.filterPhase4CompletedExecutionIds(state);

    // 4. Reset flow checkpoint statuses from 'failed' → 'running' so the
    //    Cadre runner re-enters failed nodes while skipping completed ones.
    this.resetFlowCheckpointStatus(state, '__flowCheckpoint');
    this.resetFlowCheckpointStatus(state, '__phase4FlowCheckpoint');

    // 5. Clear Phase 4 per-task cursor state for non-completed tasks.
    if (state.phaseCursors?.['4']?.tasks) {
      const completedSet = new Set(state.completedTasks);
      const cursorTasks = Object.keys(state.phaseCursors['4'].tasks);
      let removed = 0;
      for (const taskId of cursorTasks) {
        if (!completedSet.has(taskId)) {
          delete state.phaseCursors['4'].tasks[taskId];
          removed++;
        }
      }
      if (removed > 0) {
        this.logger.info(`Cleared Phase 4 cursor state for ${removed} non-completed task(s)`);
      }
    }
  }

  /**
   * Filter `__phase4FlowCheckpoint.completedExecutionIds` to only retain
   * entries for tasks listed in `completedTasks`.
   *
   * Execution IDs for task substeps follow the pattern:
   *   `{flowId}/.../{taskId}/{taskId}/{substep}`
   * Non-task entries (epoch starts, sync points) are always kept.
   */
  private filterPhase4CompletedExecutionIds(state: CheckpointState): void {
    const fc = state.__phase4FlowCheckpoint;
    if (!fc || typeof fc !== 'object') return;

    const snapshot = fc as Record<string, unknown>;
    const ids = snapshot.completedExecutionIds;
    if (!Array.isArray(ids) || ids.length === 0) return;

    const completedSet = new Set(state.completedTasks);
    if (completedSet.size === ids.length) return; // all tasks completed, nothing to filter

    const filtered = ids.filter((id: string) => {
      // Task substep IDs contain the task ID as a path segment.
      // Detect by checking for known substep suffixes.
      const lastSlash = id.lastIndexOf('/');
      const substep = lastSlash >= 0 ? id.slice(lastSlash + 1) : id;
      const TASK_SUBSTEPS = ['migrate', 'commit', 'target-index', 'parity', 'parity-gate', 'minor-repass'];
      if (!TASK_SUBSTEPS.includes(substep)) return true; // not a task substep, keep

      // Extract the task ID: it's the segment before the substep's parent.
      // Pattern: .../{taskId}/{taskId}/{substep}
      const segments = id.split('/');
      // The task ID is at segments[segments.length - 3] (branch key)
      const taskId = segments.length >= 3 ? segments[segments.length - 3] : undefined;
      if (!taskId) return true; // can't extract task ID, keep to be safe

      return completedSet.has(taskId);
    });

    const removed = ids.length - filtered.length;
    if (removed > 0) {
      snapshot.completedExecutionIds = filtered;
      // Also clear executionOutputs for removed tasks
      if (snapshot.executionOutputs && typeof snapshot.executionOutputs === 'object') {
        const outputs = snapshot.executionOutputs as Record<string, unknown>;
        for (const key of Object.keys(outputs)) {
          const lastSlash = key.lastIndexOf('/');
          const substep = lastSlash >= 0 ? key.slice(lastSlash + 1) : key;
          const TASK_SUBSTEPS = ['migrate', 'commit', 'target-index', 'parity', 'parity-gate', 'minor-repass'];
          if (!TASK_SUBSTEPS.includes(substep)) continue;
          const segments = key.split('/');
          const taskId = segments.length >= 3 ? segments[segments.length - 3] : undefined;
          if (taskId && !completedSet.has(taskId)) {
            delete outputs[key];
          }
        }
      }
      this.logger.info(
        `Removed ${removed} Phase 4 execution ID(s) for non-completed tasks ` +
        `(keeping ${filtered.length} for ${completedSet.size} completed task(s))`,
      );
    }
  }

  /** Reset a stored flow checkpoint's status from 'failed' to 'running', preserving completedExecutionIds. */
  private resetFlowCheckpointStatus(state: CheckpointState, key: '__flowCheckpoint' | '__phase4FlowCheckpoint'): void {
    const fc = state[key];
    if (fc && typeof fc === 'object') {
      const snapshot = fc as Record<string, unknown>;
      if (snapshot.status === 'failed') {
        snapshot.status = 'running';
        snapshot.error = undefined;
        this.logger.info(`Reset ${key} status from 'failed' to 'running'`);
      }
    }
  }

  private applyBackwardCompatibleDefaults(state: CheckpointState): void {
    state.cumulativeDurationMs ??= 0;
    state.completedTaskDurationsMs ??= [];
    state.phase3aComplete ??= false;
    state.scaffoldComplete ??= false;
    state.completedPhase2Groups ??= [];
    state.metricsCount ??= 0;
    state.phase0Fingerprint ??= undefined;
    state.terminalExhaustion ??= undefined;
    state.adjudicationWaivers ??= [];
    state.adjudicationEvents ??= [];
    state.phaseCursors ??= {};
    state.phaseCursors['4'] ??= { tasks: {} };
    state.phaseCursors['5'] ??= { iteration: 0, fixIndex: 0 };
    state.phaseCursors['6'] ??= { completedAgents: [] };
    state.phaseCursors['7'] ??= { iteration: 0, issueIndex: 0 };
    state.phaseCursors['4'].tasks ??= {};
    state.phaseCursors['6'].completedAgents ??= [];
    state.phaseCursors['6'].completedSuites ??= [];
  }

  private async resolveCheckpointReadPath(): Promise<string | undefined> {
    if (await fileExists(this.checkpointPath)) {
      return this.checkpointPath;
    }
    return undefined;
  }

  private async resolveBackupReadPath(): Promise<string | undefined> {
    if (await fileExists(this.backupPath)) {
      return this.backupPath;
    }
    return undefined;
  }

  /** Attempt to load the prior checkpoint state without modifying this.state. */
  private async loadPriorState(): Promise<CheckpointState | undefined> {
    const path = await this.resolveCheckpointReadPath()
      ?? await this.resolveBackupReadPath();
    if (!path) return undefined;
    try {
      const state = await readJson<CheckpointState>(path);
      this.applyBackwardCompatibleDefaults(state);
      return state;
    } catch {
      return undefined;
    }
  }
}
