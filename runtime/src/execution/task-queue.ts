import { MigrationTask } from '../agents/types.js';

/** Progress statistics for the task queue. */
export interface TaskProgress {
  total: number;
  completed: number;
  blocked: number;
  remaining: number;
}

/**
 * Dependency-aware task queue for Phase 4 execution.
 *
 * Tracks task completion and blocked status, and determines which tasks
 * are ready based on dependency satisfaction. Supports checkpoint resume
 * and topological sorting with cycle detection.
 */
export class TaskQueue {
  private tasks: Map<string, MigrationTask> = new Map();
  private completed: Set<string> = new Set();
  private blocked: Set<string> = new Set();

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

  /** Mark a task as completed. */
  complete(taskId: string): void {
    this.completed.add(taskId);
  }

  /** Get tasks that are ready to execute (all dependencies satisfied). */
  getReady(): MigrationTask[] {
    const ready: MigrationTask[] = [];
    for (const [id, task] of this.tasks) {
      if (this.completed.has(id) || this.blocked.has(id)) continue;
      const depsOk = task.dependencies.every(dep => this.completed.has(dep) || this.blocked.has(dep));
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

  /** Get all task IDs. */
  getAllTaskIds(): string[] {
    return [...this.tasks.keys()];
  }

  /** Get a task by ID. */
  getTask(id: string): MigrationTask | undefined {
    return this.tasks.get(id);
  }
}
