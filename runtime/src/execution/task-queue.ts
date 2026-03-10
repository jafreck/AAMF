import { MigrationTask } from '../agents/types.js';

/** Progress statistics for the task queue. */
export interface TaskProgress {
  total: number;
  completed: number;
  blocked: number;
  remaining: number;
}

/** Result from executing a single task in the pipelined pool. */
export interface PipelinedTaskResult<T> {
  task: MigrationTask;
  result: T;
}

/**
 * Dependency-aware task queue for Phase 5 execution.
 *
 * Tracks task completion and blocked status, and determines which tasks
 * are ready based on dependency satisfaction. Supports checkpoint resume
 * and topological sorting with cycle detection.
 */
export class TaskQueue {
  private tasks: Map<string, MigrationTask> = new Map();
  private completed: Set<string> = new Set();
  private blocked: Set<string> = new Set();
  /** SCC membership: taskId → set of other task IDs in the same SCC. */
  private sccMembers: Map<string, Set<string>> = new Map();

  constructor(tasks: MigrationTask[]) {
    for (const task of tasks) {
      this.tasks.set(task.id, task);
    }
  }

  /**
   * Register strongly-connected components.
   *
   * SCC-internal dependencies are treated as pre-satisfied by {@link getReady}
   * — all members of an SCC become ready once their *external* dependencies
   * are complete.
   */
  setSCCs(sccs: string[][]): void {
    for (const scc of sccs) {
      const memberSet = new Set(scc);
      for (const id of scc) {
        this.sccMembers.set(id, memberSet);
      }
    }
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

  /** Get tasks that are ready to execute (all dependencies satisfied).
   *  SCC-internal deps are treated as pre-satisfied (members released together). */
  getReady(): MigrationTask[] {
    const ready: MigrationTask[] = [];
    for (const [id, task] of this.tasks) {
      if (this.completed.has(id) || this.blocked.has(id)) continue;
      const sccSet = this.sccMembers.get(id);
      const depsOk = task.dependencies.every(dep => {
        if (this.completed.has(dep)) return true;
        // SCC-internal deps are pre-satisfied
        if (sccSet && sccSet.has(dep)) return true;
        return false;
      });
      if (depsOk) ready.push(task);
    }
    return ready;
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
   * Tasks are considered overlapping when they share a target file.
   */
  static selectNonOverlappingBatch(
    readyTasks: MigrationTask[],
    maxBatchSize: number,
  ): MigrationTask[] {
    const batch: MigrationTask[] = [];
    const claimedFiles = new Set<string>();

    for (const task of readyTasks) {
      if (batch.length >= maxBatchSize) break;

      const hasFileOverlap = task.targetFiles.some(f => claimedFiles.has(f));
      if (hasFileOverlap) continue;

      batch.push(task);
      for (const f of task.targetFiles) claimedFiles.add(f);
    }

    return batch;
  }

  /**
   * Execute all tasks in a wave using pipelined concurrency.
   *
   * Tasks launch as soon as a concurrency slot is free AND none of their
   * target files are held by an in-flight task.  This gives true pipelining:
   * task C (which conflicts only with task A) starts the moment A finishes,
   * even while B/D/E are still running.
   *
   * @param waveTasks    All tasks in this wave (full topological frontier).
   * @param concurrency  Max simultaneous in-flight tasks (`maxParallelAgents`).
   * @param executor     Async function that runs a single task.
   * @returns            Results for every task, in completion order.
   */
  static async executePipelined<T>(
    waveTasks: MigrationTask[],
    concurrency: number,
    executor: (task: MigrationTask) => Promise<T>,
  ): Promise<PipelinedTaskResult<T>[]> {
    const results: PipelinedTaskResult<T>[] = [];
    const errors: unknown[] = [];
    const inFlightFiles = new Set<string>();
    const inFlightPromises = new Set<Promise<void>>();
    const pending = [...waveTasks];

    // Resolvers waiting for a slot or file release.
    const waiters: Array<() => void> = [];

    const wake = () => {
      while (waiters.length > 0) waiters.shift()!();
    };

    const waitForRelease = (): Promise<void> =>
      new Promise<void>(resolve => { waiters.push(resolve); });

    const canLaunch = (task: MigrationTask): boolean =>
      inFlightPromises.size < concurrency &&
      !task.targetFiles.some(f => inFlightFiles.has(f));

    const launch = (task: MigrationTask): void => {
      for (const f of task.targetFiles) inFlightFiles.add(f);
      const p = executor(task).then(
        result => { results.push({ task, result }); },
        error => { errors.push(error); },
      ).finally(() => {
        for (const f of task.targetFiles) inFlightFiles.delete(f);
        inFlightPromises.delete(p);
        wake();
      });
      inFlightPromises.add(p);
    };

    while (pending.length > 0 || inFlightPromises.size > 0) {
      // Launch everything we can right now.
      let launched = false;
      let i = 0;
      while (i < pending.length) {
        const task = pending[i]!;
        if (canLaunch(task)) {
          pending.splice(i, 1);
          launch(task);
          launched = true;
        } else {
          i++;
        }
        // Re-check concurrency cap after each launch.
        if (inFlightPromises.size >= concurrency) break;
      }

      // If there are errors, stop launching and let in-flight tasks drain.
      if (errors.length > 0) {
        if (inFlightPromises.size > 0) {
          await Promise.allSettled([...inFlightPromises]);
        }
        throw errors[0];
      }

      // Wait for at least one task to finish before trying again.
      if ((pending.length > 0 || inFlightPromises.size > 0) && !launched) {
        await waitForRelease();
      }
    }

    if (errors.length > 0) throw errors[0];
    return results;
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
