import { MigrationTask } from '../agents/types.js';

/** Progress statistics for the task queue. */
export interface TaskProgress {
  total: number;
  completed: number;
  blocked: number;
  replanned: number;
  remaining: number;
}

/**
 * Dependency-aware task queue for Phase 4 execution.
 *
 * Tracks task completion, blocked status, and replanned status, and
 * determines which tasks are ready based on dependency satisfaction.
 * Supports checkpoint resume and topological sorting with cycle detection.
 */
export class TaskQueue {
  private tasks: Map<string, MigrationTask> = new Map();
  private completed: Set<string> = new Set();
  private blocked: Set<string> = new Set();
  private replanned: Set<string> = new Set();
  /** Maps a replanned parent ID to the IDs of its replacement sub-tasks. */
  private subtaskMap: Map<string, string[]> = new Map();

  constructor(tasks: MigrationTask[]) {
    for (const task of tasks) {
      this.tasks.set(task.id, task);
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

  /** Mark a task as replanned (from checkpoint resume). */
  markReplanned(taskId: string): void {
    this.replanned.add(taskId);
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

  /** Check whether a task has been replanned into sub-tasks. */
  isTaskReplanned(taskId: string): boolean {
    return this.replanned.has(taskId);
  }

  /**
   * Check whether a dependency is satisfied.
   *
   * A completed or blocked dependency is satisfied immediately.
   * A replanned dependency is satisfied only when ALL of its replacement
   * sub-tasks have completed (or been blocked).
   */
  private isDepSatisfied(depId: string): boolean {
    if (this.completed.has(depId) || this.blocked.has(depId)) return true;
    if (this.replanned.has(depId)) {
      const subtaskIds = this.subtaskMap.get(depId);
      if (!subtaskIds || subtaskIds.length === 0) return true;
      return subtaskIds.every(id => this.completed.has(id) || this.blocked.has(id));
    }
    return false;
  }

  /** Get tasks that are ready to execute (all dependencies satisfied). */
  getReady(): MigrationTask[] {
    const ready: MigrationTask[] = [];
    for (const [id, task] of this.tasks) {
      if (this.completed.has(id) || this.blocked.has(id) || this.replanned.has(id)) continue;
      const depsOk = task.dependencies.every(dep => this.isDepSatisfied(dep));
      if (depsOk) ready.push(task);
    }
    return ready;
  }

  /** Check if all tasks are done (completed, blocked, or fully-replanned). */
  isComplete(): boolean {
    for (const id of this.tasks.keys()) {
      if (this.completed.has(id) || this.blocked.has(id)) continue;
      if (this.replanned.has(id)) continue; // parent itself is terminal
      return false;
    }
    return true;
  }

  /** Get progress stats. */
  getProgress(): TaskProgress {
    const total = this.tasks.size;
    const completed = this.completed.size;
    const blocked = this.blocked.size;
    const replanned = this.replanned.size;
    return { total, completed, blocked, replanned, remaining: total - completed - blocked - replanned };
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
   * a target directory.
   */
  static selectNonOverlappingBatch(
    readyTasks: MigrationTask[],
    maxBatchSize: number,
  ): MigrationTask[] {
    const batch: MigrationTask[] = [];
    const claimedFiles = new Set<string>();
    const claimedDirs = new Set<string>();

    for (const task of readyTasks) {
      if (batch.length >= maxBatchSize) break;

      const hasFileOverlap = task.targetFiles.some(f => claimedFiles.has(f));
      if (hasFileOverlap) continue;

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

  /**
   * Replace a parent task with sub-tasks during replanning.
   *
   * The parent is marked as replanned (skipped by `getReady()`, treated
   * as terminal by `isComplete()`). Dependency satisfaction for the parent
   * is deferred until ALL sub-tasks are completed or blocked.
   *
   * The sub-tasks are injected into the active task map.
   */
  replaceWithSubtasks(parentId: string, subtasks: MigrationTask[]): void {
    this.replanned.add(parentId);
    const subtaskIds: string[] = [];
    for (const subtask of subtasks) {
      this.tasks.set(subtask.id, subtask);
      subtaskIds.push(subtask.id);
    }
    this.subtaskMap.set(parentId, subtaskIds);
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
