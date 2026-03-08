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
 * A strongly connected component (SCC) in the task dependency graph.
 *
 * Tasks within an SCC have mutual dependencies and cannot be topologically
 * ordered relative to each other.  The orchestrator handles SCCs with a
 * two-pass approach: scaffold first (type stubs/signatures), then full
 * implementation once all mutual dependencies are available.
 */
export interface SCCInfo {
  /** Unique SCC identifier (index in the SCC list). */
  id: number;
  /** Task IDs that form this SCC. */
  members: string[];
}

/** Execution phase for SCC tasks. */
export type SCCPhase = 'scaffold' | 'implement';

/**
 * Dependency-aware task queue for Phase 4 execution.
 *
 * Tracks task completion and blocked status, and determines which tasks
 * are ready based on dependency satisfaction. Supports checkpoint resume,
 * topological sorting with SCC handling for cyclic dependencies,
 * group-barrier enforcement for cross-group ordering, and two-pass SCC
 * execution.
 */
export class TaskQueue {
  private tasks: Map<string, MigrationTask> = new Map();
  private completed: Set<string> = new Set();
  private blocked: Set<string> = new Set();
  private groupBarrier?: GroupBarrier;

  /** Maps task ID to SCC info for tasks in multi-member SCCs. */
  private sccMembership: Map<string, SCCInfo> = new Map();

  /** Tracks which SCCs have completed their scaffold pass. */
  private sccScaffoldDone: Set<number> = new Set();

  /** All SCCs with >1 member (the ones that need two-pass execution). */
  private sccs: SCCInfo[] = [];

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

  /**
   * Register SCC information computed during the topological sort.
   * The orchestrator needs this to execute SCCs with the two-pass approach.
   */
  setSCCs(sccs: SCCInfo[]): void {
    this.sccs = sccs;
    this.sccMembership.clear();
    for (const scc of sccs) {
      for (const id of scc.members) {
        this.sccMembership.set(id, scc);
      }
    }
  }

  /** Get all multi-member SCCs. */
  getSCCs(): SCCInfo[] {
    return this.sccs;
  }

  /** Get the SCC a task belongs to (undefined if not in a multi-member SCC). */
  getSCC(taskId: string): SCCInfo | undefined {
    return this.sccMembership.get(taskId);
  }

  /** Mark an SCC's scaffold pass as complete. */
  markSCCScaffoldDone(sccId: number): void {
    this.sccScaffoldDone.add(sccId);
  }

  /** Check if an SCC's scaffold pass is complete. */
  isSCCScaffoldDone(sccId: number): boolean {
    return this.sccScaffoldDone.has(sccId);
  }

  /**
   * Get the current execution phase for a task in an SCC.
   * Returns undefined for tasks not in an SCC.
   */
  getSCCPhase(taskId: string): SCCPhase | undefined {
    const scc = this.sccMembership.get(taskId);
    if (!scc) return undefined;
    return this.sccScaffoldDone.has(scc.id) ? 'implement' : 'scaffold';
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

      // SCC gate: for tasks in an SCC, check external dependencies only
      // (deps on tasks outside the SCC). Internal SCC deps are always
      // considered satisfied since the SCC executes as an atomic unit.
      const scc = this.sccMembership.get(id);
      let depsOk: boolean;
      if (scc) {
        const sccMembers = new Set(scc.members);
        depsOk = task.dependencies.every(dep =>
          sccMembers.has(dep) || this.completed.has(dep),
        );
      } else {
        depsOk = task.dependencies.every(dep => this.completed.has(dep));
      }
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
   * Perform a topological sort of all tasks, handling cycles via SCC condensation.
   *
   * 1. Finds all strongly connected components (Tarjan's algorithm)
   * 2. Condenses the graph: each SCC becomes a single node
   * 3. Topologically sorts the condensed DAG (always acyclic)
   * 4. Expands back: tasks within an SCC are grouped together
   *
   * When no cycles exist, falls back to the standard DFS sort for efficiency.
   */
  static topologicalSort(tasks: MigrationTask[]): MigrationTask[] {
    return TaskQueue.topologicalSortWithSCCs(tasks).sorted;
  }

  /**
   * Extended topological sort that also returns SCC information.
   * The orchestrator uses this to detect and handle cyclic task groups.
   */
  static topologicalSortWithSCCs(tasks: MigrationTask[]): {
    sorted: MigrationTask[];
    sccs: SCCInfo[];
  } {
    const allSCCs = TaskQueue.findSCCs(tasks);
    const multiMemberSCCs = allSCCs.filter(scc => scc.members.length > 1);

    if (multiMemberSCCs.length === 0) {
      return { sorted: TaskQueue.standardTopoSort(tasks), sccs: [] };
    }

    return {
      sorted: TaskQueue.condensedTopoSort(tasks, allSCCs),
      sccs: multiMemberSCCs,
    };
  }

  /**
   * Standard DFS topological sort — throws on cycles.
   * Used as fast path when no SCCs exist.
   */
  private static standardTopoSort(tasks: MigrationTask[]): MigrationTask[] {
    const taskMap = new Map(tasks.map(t => [t.id, t]));
    const visited = new Set<string>();
    const result: MigrationTask[] = [];
    const visiting = new Set<string>();

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
   * SCC-condensed topological sort.
   * Groups SCC members together and sorts the condensed DAG.
   */
  private static condensedTopoSort(
    tasks: MigrationTask[],
    sccs: SCCInfo[],
  ): MigrationTask[] {
    const taskMap = new Map(tasks.map(t => [t.id, t]));

    // Map each task to its SCC index
    const taskToSCC = new Map<string, number>();
    for (const scc of sccs) {
      for (const id of scc.members) {
        taskToSCC.set(id, scc.id);
      }
    }

    // Build condensed adjacency: SCC → Set<SCC> (external deps only)
    const sccAdj = new Map<number, Set<number>>();
    for (const scc of sccs) {
      sccAdj.set(scc.id, new Set());
    }
    for (const task of tasks) {
      const fromSCC = taskToSCC.get(task.id)!;
      for (const dep of task.dependencies) {
        const toSCC = taskToSCC.get(dep);
        if (toSCC !== undefined && toSCC !== fromSCC) {
          sccAdj.get(fromSCC)!.add(toSCC);
        }
      }
    }

    // Topo-sort the condensed DAG (guaranteed acyclic)
    const visited = new Set<number>();
    const sortedSCCIds: number[] = [];

    function visitSCC(sccId: number): void {
      if (visited.has(sccId)) return;
      visited.add(sccId);
      for (const dep of sccAdj.get(sccId) ?? []) {
        visitSCC(dep);
      }
      sortedSCCIds.push(sccId);
    }

    for (const scc of sccs) visitSCC(scc.id);

    // Expand: replace each SCC index with its member tasks
    const sccById = new Map(sccs.map(s => [s.id, s]));
    const result: MigrationTask[] = [];
    for (const sccId of sortedSCCIds) {
      const scc = sccById.get(sccId)!;
      for (const id of scc.members) {
        const task = taskMap.get(id);
        if (task) result.push(task);
      }
    }
    return result;
  }

  /**
   * Find all strongly connected components using Tarjan's algorithm.
   *
   * Returns every SCC including singletons.  Multi-member SCCs represent
   * cycles that need two-pass (scaffold → implement) execution.
   */
  static findSCCs(tasks: MigrationTask[]): SCCInfo[] {
    const taskMap = new Map(tasks.map(t => [t.id, t]));

    let index = 0;
    const indices = new Map<string, number>();
    const lowlinks = new Map<string, number>();
    const onStack = new Set<string>();
    const stack: string[] = [];
    const sccs: SCCInfo[] = [];
    let sccCounter = 0;

    function strongconnect(v: string): void {
      indices.set(v, index);
      lowlinks.set(v, index);
      index++;
      stack.push(v);
      onStack.add(v);

      const task = taskMap.get(v);
      if (task) {
        for (const w of task.dependencies) {
          if (!taskMap.has(w)) continue; // skip orphan deps
          if (!indices.has(w)) {
            strongconnect(w);
            lowlinks.set(v, Math.min(lowlinks.get(v)!, lowlinks.get(w)!));
          } else if (onStack.has(w)) {
            lowlinks.set(v, Math.min(lowlinks.get(v)!, indices.get(w)!));
          }
        }
      }

      // If v is a root node, pop the SCC
      if (lowlinks.get(v) === indices.get(v)) {
        const members: string[] = [];
        let w: string;
        do {
          w = stack.pop()!;
          onStack.delete(w);
          members.push(w);
        } while (w !== v);
        sccs.push({ id: sccCounter++, members });
      }
    }

    for (const task of tasks) {
      if (!indices.has(task.id)) {
        strongconnect(task.id);
      }
    }

    return sccs;
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

  /** Get all task IDs. */
  getAllTaskIds(): string[] {
    return [...this.tasks.keys()];
  }

  /** Get a task by ID. */
  getTask(id: string): MigrationTask | undefined {
    return this.tasks.get(id);
  }
}
