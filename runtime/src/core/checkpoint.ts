import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { atomicWrite, ensureDir, fileExists, readJson, writeJson } from '../util/fs.js';
import { Logger } from '../logging/logger.js';

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
  /** IDs of module groups whose task-decomposer has completed successfully. */
  completedPhase3Groups?: string[];
  /** Number of JSONL metric records written; used to skip on resume. */
  metricsCount: number;
  /** Source fingerprint from last successful Phase 0 build; used to skip re-indexing on resume. */
  phase0Fingerprint?: string;
}

export interface CheckpointFailedTask {
  taskId: string;
  attempts: number;
  lastError: string;
  recoveryAttempted: boolean;
}

const CHECKPOINT_VERSION = 1;
const CHECKPOINT_FILE = 'checkpoint.json';
const CHECKPOINT_BACKUP = 'checkpoint.backup.json';

export class CheckpointManager {
  private state: CheckpointState | null = null;
  private readonly checkpointPath: string;
  private readonly backupPath: string;

  constructor(private readonly progressDir: string, private readonly logger: Logger) {
    this.checkpointPath = join(progressDir, CHECKPOINT_FILE);
    this.backupPath = join(progressDir, CHECKPOINT_BACKUP);
  }

  /** Read the current checkpoint, or create initial state */
  async load(projectName: string): Promise<CheckpointState> {
    await ensureDir(this.progressDir);

    if (await fileExists(this.checkpointPath)) {
      try {
        this.state = await readJson<CheckpointState>(this.checkpointPath);
        this.state.resumeCount += 1;
        this.state.cumulativeDurationMs ??= 0;
        this.state.completedTaskDurationsMs ??= [];
        this.state.phase3aComplete ??= false;
        this.state.completedPhase3Groups ??= [];
        this.state.metricsCount ??= 0;
        this.state.phase0Fingerprint ??= undefined;
        this.logger.info(`Loaded checkpoint: Phase ${this.state.currentPhase}, ${this.state.completedTasks.length} tasks completed, resume #${this.state.resumeCount}`);
        await this.save(this.state);
        return this.state;
      } catch (err) {
        this.logger.warn(`Failed to read checkpoint, trying backup: ${(err as Error).message}`);
        // Try backup
        if (await fileExists(this.backupPath)) {
          try {
            this.state = await readJson<CheckpointState>(this.backupPath);
            this.state.resumeCount += 1;
            this.state.cumulativeDurationMs ??= 0;
            this.state.completedTaskDurationsMs ??= [];
            this.state.phase3aComplete ??= false;
            this.state.completedPhase3Groups ??= [];
            this.state.metricsCount ??= 0;
            this.state.phase0Fingerprint ??= undefined;
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
    this.state = {
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
      completedPhase3Groups: [],
      metricsCount: 0,
    };
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
    state.currentPhase = phase + 1;
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
    await this.save(state);
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

  /**
   * Mark Phase 3 step 3a (migration-planner) as complete.
   * Subsequent resumes will skip re-running the migration-planner and jump
   * directly to step 3b (task-decomposer fan-out).
   */
  async completePhase3a(): Promise<void> {
    const state = this.getState();
    state.phase3aComplete = true;
    state.completedPhase3Groups ??= [];
    await this.save(state);
  }

  /**
   * Record that the task-decomposer for a specific module group finished
   * successfully.  On resume, completed groups are skipped so only failed
   * ones are retried.
   */
  async completePhase3Group(groupId: string): Promise<void> {
    const state = this.getState();
    state.completedPhase3Groups ??= [];
    if (!state.completedPhase3Groups.includes(groupId)) {
      state.completedPhase3Groups.push(groupId);
    }
    await this.save(state);
  }

  /** Determine what phase/task to resume from */
  getResumePoint(): { phase: number; taskId: string | null } {
    const state = this.getState();
    return { phase: state.currentPhase, taskId: state.currentTask };
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
}
