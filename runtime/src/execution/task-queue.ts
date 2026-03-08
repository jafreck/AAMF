import { MigrationTask } from '../agents/types.js';

/** Progress statistics for the task queue. */
export interface TaskProgress {
  total: number;
  completed: number;
  blocked: number;
  remaining: number;
}

/**
 * Group barrier configuration for cross-group dependency enforcement.
 *
 * When enabled, tasks from group N+1 are not considered ready until every
 * task from groups 0..N has completed (or been blocked).  This ensures
 * correct execution order when task-decomposers run per-group and cannot
 * declare cross-group dependency edges.
 */
export interface GroupBarrier {
  /** Maps each task ID to its group index (0-based, following groups.json order). */
  taskToGroupIndex: Map<string, number>;
  /** Total number of groups (used for bounds checking). */
  groupCount: number;
}

/**
 * Dependency-aware task queue for Phase 4 execution.
 *
 * Tracks task completion and blocked status, and determines which tasks
 * are ready based on dependency satisfaction. Supports checkpoint resume,
 * topological sorting with cycle detection, and group-barrier enforcement
 * for cross-group ordering.
 */
export class TaskQueue {
  private tasks: Map<string, MigrationTask> = new Map();
  private completed: Set<string> = new Set();
  private blocked: Set<string> = new Set();
  private groupBarrier?: GroupBarrier;

  constructor(tasks: MigrationTask[]) {
    for (const task of tasks) {
      this.tasks.set(task.id, task);
    }
  }

  /**
   * Enable group-barrier execution order.
   *
   * When set, {@link getReady} additionally requires that all tasks from
   * prior groups are complete (or blocked) before releasing tasks from a
   * later group.  This enforces the planner's intended group ordering
   * without requiring cross-group dependency edges in the task graph.
   */
  setGroupBarrier(barrier: GroupBarrier): void {
    this.groupBarrier = barrier;
  }

  /** Mark tasks as already completed (from checkpoint resume). */
  markCompleted(taskIds: string[]): void {
    for (const id of taskIds) this.completed.add(id);
  }

  /** Mark a task as blocked (max retries exceeded). */
  markBlocked(taskId: string): void {
    this.blocked.add(taskId);
  }

  /** Mark a task as completed. */
  complete(taskId: string): void {
    this.completed.add(taskId);
  }

  /** Check whether a task is completed. */
  isTaskCompleted(taskId: string): boolean {
    return this.completed.has(taskId);
  }

  /** Check whether a task is blocked. */
  isTaskBlocked(taskId: string): boolean {
    return this.blocked.has(taskId);
  }

  /** Get tasks that are ready to execute (all dependencies satisfied, group barrier respected). */
  getReady(): MigrationTask[] {
    // When a group barrier is active, compute the highest group index
    // that is fully settled (all tasks completed or blocked).  Only
    // tasks from groups up to maxReadyGroup are eligible.
    let maxReadyGroup = Infinity;
    if (this.groupBarrier) {
      maxReadyGroup = this.computeMaxReadyGroup();
    }

    const ready: MigrationTask[] = [];
    for (const [id, task] of this.tasks) {
      if (this.completed.has(id) || this.blocked.has(id)) continue;
      const depsOk = task.dependencies.every(dep => this.completed.has(dep));
      if (!depsOk) continue;

      // Group barrier gate: skip tasks from groups beyond the ready frontier
      if (this.groupBarrier) {
        const groupIdx = this.groupBarrier.taskToGroupIndex.get(id) ?? 0;
        if (groupIdx > maxReadyGroup) continue;
      }

      ready.push(task);
    }
    return ready;
  }

  /**
   * Compute the highest group index whose tasks are eligible to run.
   *
   * Group G is eligible when every task from groups 0..(G-1) has been
   * completed or blocked.  Group 0 is always eligible.
   */
  private computeMaxReadyGroup(): number {
    if (!this.groupBarrier) return Infinity;

    // Build counts of unsettled tasks per group
    const unsettledByGroup = new Map<number, number>();
    for (const [id] of this.tasks) {
      if (this.completed.has(id) || this.blocked.has(id)) continue;
      const g = this.groupBarrier.taskToGroupIndex.get(id) ?? 0;
      unsettledByGroup.set(g, (unsettledByGroup.get(g) ?? 0) + 1);
    }

    // Walk groups in order.  The first group with unsettled tasks is the
    // highest group we can run — everything after it must wait.
    for (let g = 0; g < this.groupBarrier.groupCount; g++) {
      if ((unsettledByGroup.get(g) ?? 0) > 0) return g;
    }
    return this.groupBarrier.groupCount - 1;
  }

  /** Check if all tasks are done (completed or blocked). */
  isComplete(): boolean {
    for (const id of this.tasks.keys()) {
      if (!this.completed.has(id) && !this.blocked.has(id)) return false;
    }
    return true;
  }

  /** Get progress stats. */
  getProgress(): TaskProgress {
    const total = this.tasks.size;
    const completed = this.completed.size;
    const blocked = this.blocked.size;
    return { total, completed, blocked, remaining: total - completed - blocked };
  }

  /**
   * Perform a topological sort of all tasks.
   * @throws {Error} If a circular dependency is detected.
   */
  static topologicalSort(tasks: MigrationTask[]): MigrationTask[] {
    const taskMap = new Map(tasks.map(t => [t.id, t]));
    const visited = new Set<string>();
    const result: MigrationTask[] = [];
    const visiting = new Set<string>(); // for cycle detection

    function visit(id: string): void {
      if (visited.has(id)) return;
      if (visiting.has(id)) throw new Error(`Circular dependency detected involving task ${id}`);
      visiting.add(id);
      const task = taskMap.get(id);
      if (!task) return;
      for (const dep of task.dependencies) {
        visit(dep);
      }
      visiting.delete(id);
      visited.add(id);
      result.push(task);
    }

    for (const task of tasks) visit(task.id);
    return result;
  }

  /**
   * Select a non-overlapping batch from ready tasks.
   *
   * Tasks are considered overlapping when they share either a target file or
   * a target directory — **unless** both tasks declare distinct `writeRegion`
   * values for the shared file, in which case they can safely execute
   * concurrently (each writes to its own region of the output).
   */
  static selectNonOverlappingBatch(
    readyTasks: MigrationTask[],
    maxBatchSize: number,
  ): MigrationTask[] {
    const batch: MigrationTask[] = [];
    // file → Set of claimed writeRegions (empty string = whole-file claim)
    const claimedFileRegions = new Map<string, Set<string>>();
    const claimedDirs = new Set<string>();

    for (const task of readyTasks) {
      if (batch.length >= maxBatchSize) break;

      let hasConflict = false;

      for (const f of task.targetFiles) {
        const claimedRegions = claimedFileRegions.get(f);
        if (!claimedRegions) continue; // file not yet claimed

        if (!task.writeRegion || claimedRegions.has('')) {
          // Either this task has no region (whole-file), or the file was
          // already claimed as whole-file — conflict.
          hasConflict = true;
          break;
        }

        if (claimedRegions.has(task.writeRegion)) {
          // Same region already claimed — conflict.
          hasConflict = true;
          break;
        }
        // Different regions on the same file — no conflict, allow it.
      }
      if (hasConflict) continue;

      // Directory overlap check (only for tasks without writeRegion)
      if (!task.writeRegion) {
        const taskDirs = new Set(
          task.targetFiles.map(f => {
            const lastSlash = f.lastIndexOf('/');
            return lastSlash >= 0 ? f.substring(0, lastSlash) : '.';
          }),
        );
        const hasDirOverlap = [...taskDirs].some(d => claimedDirs.has(d));
        if (hasDirOverlap) continue;

        // Claim directories only for non-region tasks
        for (const d of taskDirs) claimedDirs.add(d);
      }

      batch.push(task);
      for (const f of task.targetFiles) {
        const regions = claimedFileRegions.get(f) ?? new Set<string>();
        regions.add(task.writeRegion ?? '');
        claimedFileRegions.set(f, regions);
      }
    }

    return batch;
  }

  /** Get all task IDs. */
  getAllTaskIds(): string[] {
    return [...this.tasks.keys()];
  }

  /** Get a task by ID. */
  getTask(id: string): MigrationTask | undefined {
    return this.tasks.get(id);
  }
}
