/**
 * Task graph validation and dependency inference for the Phase 3 merge step.
 *
 * Provides three layers of protection:
 *   1. **Static validation** — structural checks on the merged task graph
 *   2. **Write-region conflict detection** — ensures tasks sharing a target file
 *      have non-overlapping write regions
 *   3. **Lore-powered dependency inference** — uses the KB symbol/call graph to
 *      detect missing dependency edges and inject them before Phase 4 execution
 */
import type { MigrationTask } from '../agents/types.js';
import type { Logger } from '../logging/logger.js';

// ─── Phase 1: Static Validation ────────────────────────────────────────────

/** A single validation issue found during merge-time analysis. */
export interface TaskGraphIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  taskId?: string;
  /** Additional task ID involved (e.g., the conflicting task). */
  relatedTaskId?: string;
}

/**
 * Run static validation on the merged task list.  Returns an array of issues.
 * Callers should treat any issue with `severity: 'error'` as fatal.
 */
export function validateTaskGraph(
  tasks: MigrationTask[],
  taskGroupMap: Record<string, number>,
  groupCount: number,
): TaskGraphIssue[] {
  const issues: TaskGraphIssue[] = [];
  const taskById = new Map(tasks.map(t => [t.id, t]));

  // 1. Duplicate task ID detection
  const seenIds = new Set<string>();
  for (const task of tasks) {
    if (seenIds.has(task.id)) {
      issues.push({
        severity: 'error',
        code: 'duplicate-task-id',
        message: `Duplicate task ID "${task.id}" — each task must have a unique ID across all groups`,
        taskId: task.id,
      });
    }
    seenIds.add(task.id);
  }

  // 2. Orphan dependency detection — task references a non-existent ID
  for (const task of tasks) {
    for (const dep of task.dependencies) {
      if (!taskById.has(dep)) {
        issues.push({
          severity: 'error',
          code: 'orphan-dependency',
          message: `Task "${task.id}" depends on "${dep}" which does not exist in the merged task set`,
          taskId: task.id,
          relatedTaskId: dep,
        });
      }
    }
  }

  // 3. Cross-group forward-reference check:
  //    A task in group N should not list sourceFiles that are targetFiles of
  //    tasks in a later group (N+1 or beyond).
  const targetFileToGroup = new Map<string, { groupIdx: number; taskId: string }>();
  for (const task of tasks) {
    const groupIdx = taskGroupMap[task.id] ?? 0;
    for (const tf of task.targetFiles) {
      // Keep the earliest group for each target file
      const existing = targetFileToGroup.get(tf);
      if (!existing || groupIdx < existing.groupIdx) {
        targetFileToGroup.set(tf, { groupIdx, taskId: task.id });
      }
    }
  }
  for (const task of tasks) {
    const taskGroup = taskGroupMap[task.id] ?? 0;
    for (const sf of task.sourceFiles) {
      const producer = targetFileToGroup.get(sf);
      if (producer && producer.groupIdx > taskGroup) {
        issues.push({
          severity: 'error',
          code: 'cross-group-forward-ref',
          message:
            `Task "${task.id}" (group ${taskGroup}) reads "${sf}" which is produced by ` +
            `task "${producer.taskId}" (group ${producer.groupIdx}). ` +
            `Group ordering in groups.json must be reversed or the planner must restructure groups.`,
          taskId: task.id,
          relatedTaskId: producer.taskId,
        });
      }
    }
  }

  // 4. Cross-group backward dependency without explicit edge:
  //    If a task in group N reads a file produced by a task in group M (M < N),
  //    and there's no dependency chain connecting them, emit a warning.
  //    The group barrier enforces ordering at the group level, but missing edges
  //    within the same group can still cause issues.
  for (const task of tasks) {
    const taskGroup = taskGroupMap[task.id] ?? 0;
    for (const sf of task.sourceFiles) {
      const producer = targetFileToGroup.get(sf);
      if (producer && producer.groupIdx < taskGroup) {
        // This is expected — group barrier handles it. Only warn if they're
        // in the SAME group and there's no explicit dependency.
        continue;
      }
      if (producer && producer.groupIdx === taskGroup && producer.taskId !== task.id) {
        // Same group — check for explicit dependency
        if (!hasDependencyPath(task.id, producer.taskId, taskById)) {
          issues.push({
            severity: 'warning',
            code: 'missing-intra-group-dep',
            message:
              `Task "${task.id}" reads "${sf}" which is produced by "${producer.taskId}" ` +
              `in the same group, but there is no dependency path from "${task.id}" to "${producer.taskId}". ` +
              `Consider adding an explicit dependency.`,
            taskId: task.id,
            relatedTaskId: producer.taskId,
          });
        }
      }
    }
  }

  // 5. Write-region conflict detection for shared-file tasks
  const tasksByTargetFile = new Map<string, MigrationTask[]>();
  for (const task of tasks) {
    for (const tf of task.targetFiles) {
      const existing = tasksByTargetFile.get(tf) ?? [];
      existing.push(task);
      tasksByTargetFile.set(tf, existing);
    }
  }
  for (const [file, sharingTasks] of tasksByTargetFile) {
    if (sharingTasks.length <= 1) continue;
    const withRegion = sharingTasks.filter(t => t.writeRegion);
    const withoutRegion = sharingTasks.filter(t => !t.writeRegion);

    // Tasks sharing a file without write regions — warn about overwrite risk
    if (withoutRegion.length > 1) {
      issues.push({
        severity: 'warning',
        code: 'shared-file-no-region',
        message:
          `${withoutRegion.length} tasks target "${file}" without writeRegion: ` +
          `${withoutRegion.map(t => t.id).join(', ')}. ` +
          `Sequential execution is enforced, but later tasks may overwrite earlier work.`,
      });
    }

    // Mix of region and non-region tasks for the same file
    if (withRegion.length > 0 && withoutRegion.length > 0) {
      issues.push({
        severity: 'error',
        code: 'mixed-region-usage',
        message:
          `File "${file}" has tasks with writeRegion (${withRegion.map(t => t.id).join(', ')}) ` +
          `and without (${withoutRegion.map(t => t.id).join(', ')}). ` +
          `All tasks sharing a target file must either all use writeRegion or none.`,
      });
    }

    // Duplicate write regions for the same file
    const regionNames = new Set<string>();
    for (const t of withRegion) {
      if (t.writeRegion && regionNames.has(t.writeRegion)) {
        issues.push({
          severity: 'error',
          code: 'duplicate-write-region',
          message:
            `Write region "${t.writeRegion}" is used by multiple tasks targeting "${file}". ` +
            `Each writeRegion must be unique per target file.`,
          taskId: t.id,
        });
      }
      if (t.writeRegion) regionNames.add(t.writeRegion);
    }
  }

  return issues;
}

/**
 * Check if there is a dependency path from `from` to `to` (i.e. `to` is a
 * transitive dependency of `from`).
 */
function hasDependencyPath(
  from: string,
  to: string,
  taskMap: Map<string, MigrationTask>,
): boolean {
  const visited = new Set<string>();
  const stack = [from];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === to) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    const task = taskMap.get(current);
    if (task) {
      for (const dep of task.dependencies) stack.push(dep);
    }
  }
  return false;
}

// ─── Phase 3: Lore-Powered Dependency Inference ────────────────────────────

/**
 * Result of Lore-powered dependency inference.
 */
export interface DependencyInferenceResult {
  /** Edges that were injected into the task graph. */
  injectedEdges: Array<{ from: string; to: string; reason: string }>;
  /** Issues found during inference (e.g., cycles introduced). */
  issues: TaskGraphIssue[];
  /** The augmented tasks (with injected dependencies).  */
  tasks: MigrationTask[];
}

/**
 * Use the Lore knowledge base to infer missing dependency edges between tasks.
 *
 * For each task's `lineRange`, queries the KB for symbols defined and referenced.
 * When task B references a symbol defined by task A and B doesn't already depend
 * on A (directly or transitively), injects the edge.
 *
 * @param tasks — the merged task list
 * @param taskGroupMap — task ID → group index mapping
 * @param kbDbPath — path to the Lore KB SQLite database
 * @param sourceRoot — root path of the source repository
 * @param logger — logger instance for diagnostics
 */
export async function inferDependencies(
  tasks: MigrationTask[],
  taskGroupMap: Record<string, number>,
  kbDbPath: string,
  sourceRoot: string,
  logger: Logger,
): Promise<DependencyInferenceResult> {
  const lore = await import('@aamf/lore');
  let db: ReturnType<typeof lore.openReadOnly> | undefined;

  try {
    db = lore.openReadOnly(kbDbPath);
  } catch (err) {
    logger.warn(`Failed to open KB database for dependency inference: ${err}`);
    return { injectedEdges: [], issues: [], tasks };
  }

  try {
    return runInference(tasks, taskGroupMap, db, lore, sourceRoot, logger);
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

function runInference(
  tasks: MigrationTask[],
  taskGroupMap: Record<string, number>,
  db: import('better-sqlite3').Database,
  lore: typeof import('@aamf/lore'),
  sourceRoot: string,
  logger: Logger,
): DependencyInferenceResult {
  const issues: TaskGraphIssue[] = [];
  const injectedEdges: Array<{ from: string; to: string; reason: string }> = [];
  const taskById = new Map(tasks.map(t => [t.id, t]));

  // ── Step 1: Map each task to the symbols it defines and references ───

  // Build a map: source file path → file ID in the KB
  const allFiles = lore.listFiles(db);
  const filePathToId = new Map<string, number>();
  for (const f of allFiles) {
    filePathToId.set(f.path, f.id);
    // Also try without leading ./
    if (f.path.startsWith('./')) {
      filePathToId.set(f.path.slice(2), f.id);
    }
  }

  // For each task, find the symbols it defines (within its lineRange)
  // and build a symbol→definer-task map
  const symbolToDefinerTask = new Map<string, string>(); // symbol name → task ID
  const taskDefinedSymbols = new Map<string, Set<string>>(); // task ID → set of symbol names
  const taskReferencedSymbols = new Map<string, Set<string>>(); // task ID → set of symbol names

  const allSymbols = lore.listSymbols(db, { limit: 100_000 });
  // Group symbols by file ID for efficient lookup
  const symbolsByFileId = new Map<number, typeof allSymbols>();
  for (const sym of allSymbols) {
    const existing = symbolsByFileId.get(sym.file_id) ?? [];
    existing.push(sym);
    symbolsByFileId.set(sym.file_id, existing);
  }

  for (const task of tasks) {
    const defined = new Set<string>();
    const referenced = new Set<string>();

    for (const srcFile of task.sourceFiles) {
      // Try to find the file in the KB
      const fileId = filePathToId.get(srcFile)
        ?? filePathToId.get(srcFile.replace(/^\.\//, ''));

      if (fileId === undefined) continue;

      const fileSymbols = symbolsByFileId.get(fileId) ?? [];

      for (const sym of fileSymbols) {
        // If task has a lineRange, only count symbols within that range as "defined"
        if (task.lineRange) {
          if (sym.start_line >= task.lineRange.start && sym.end_line <= task.lineRange.end) {
            defined.add(sym.name);
            symbolToDefinerTask.set(sym.name, task.id);
          }
        } else {
          // No lineRange — all symbols in the file belong to this task
          defined.add(sym.name);
          symbolToDefinerTask.set(sym.name, task.id);
        }
      }
    }

    taskDefinedSymbols.set(task.id, defined);
    taskReferencedSymbols.set(task.id, referenced);
  }

  // ── Step 2: Use the call graph to find which symbols each task references ──

  // Query call_refs table directly for caller→callee relationships
  try {
    const callRefsQuery = db.prepare(`
      SELECT DISTINCT
        s_caller.name AS caller_name,
        s_caller.file_id AS caller_file_id,
        s_caller.start_line AS caller_start_line,
        s_caller.end_line AS caller_end_line,
        cr.callee_raw
      FROM call_refs cr
      JOIN symbols s_caller ON cr.caller_symbol_id = s_caller.id
    `);
    const callRefs = callRefsQuery.all() as Array<{
      caller_name: string;
      caller_file_id: number;
      caller_start_line: number;
      caller_end_line: number;
      callee_raw: string;
    }>;

    // Build a file_id → task mapping for quick lookups
    const fileIdToTasks = new Map<number, MigrationTask[]>();
    for (const task of tasks) {
      for (const srcFile of task.sourceFiles) {
        const fileId = filePathToId.get(srcFile)
          ?? filePathToId.get(srcFile.replace(/^\.\//, ''));
        if (fileId !== undefined) {
          const existing = fileIdToTasks.get(fileId) ?? [];
          existing.push(task);
          fileIdToTasks.set(fileId, existing);
        }
      }
    }

    for (const ref of callRefs) {
      // Find which task owns this call site
      const possibleTasks = fileIdToTasks.get(ref.caller_file_id) ?? [];
      for (const callerTask of possibleTasks) {
        // Check if the call is within the task's lineRange
        if (callerTask.lineRange) {
          if (ref.caller_start_line < callerTask.lineRange.start ||
              ref.caller_end_line > callerTask.lineRange.end) {
            continue;
          }
        }

        // The callee_raw is the raw text of the callee reference
        // Try to resolve it to a known symbol
        const calleeName = extractSymbolName(ref.callee_raw);
        if (calleeName) {
          const refs = taskReferencedSymbols.get(callerTask.id) ?? new Set();
          refs.add(calleeName);
          taskReferencedSymbols.set(callerTask.id, refs);
        }
      }
    }
  } catch (err) {
    // call_refs table may not exist in older KB versions
    logger.warn(`Call graph query failed (KB may lack call_refs table): ${err}`);
  }

  // ── Step 3: Inject missing dependency edges ────────────────────────────

  for (const task of tasks) {
    const refs = taskReferencedSymbols.get(task.id) ?? new Set();
    for (const refSymbol of refs) {
      const definerTaskId = symbolToDefinerTask.get(refSymbol);
      if (!definerTaskId || definerTaskId === task.id) continue;

      // Check if dependency already exists (directly or transitively)
      if (hasDependencyPath(task.id, definerTaskId, taskById)) continue;

      // Inject the edge
      const reason = `${task.id} references symbol "${refSymbol}" defined by ${definerTaskId}`;
      injectedEdges.push({ from: task.id, to: definerTaskId, reason });
      task.dependencies.push(definerTaskId);
      logger.info(`Dependency inference: ${reason}`);
    }
  }

  // ── Step 4: Validate the augmented graph ──────────────────────────────

  if (injectedEdges.length > 0) {
    // Check for cycles in the augmented graph
    try {
      // Use a simple DFS cycle detection
      const visited = new Set<string>();
      const visiting = new Set<string>();

      function detectCycle(id: string): string[] | null {
        if (visited.has(id)) return null;
        if (visiting.has(id)) return [id]; // cycle found
        visiting.add(id);
        const task = taskById.get(id);
        if (task) {
          for (const dep of task.dependencies) {
            const cycle = detectCycle(dep);
            if (cycle) {
              cycle.push(id);
              return cycle;
            }
          }
        }
        visiting.delete(id);
        visited.add(id);
        return null;
      }

      for (const task of tasks) {
        const cycle = detectCycle(task.id);
        if (cycle) {
          // Find which injected edges are in the cycle to give actionable diagnostics
          const cycleSet = new Set(cycle);
          const cycleInjected = injectedEdges.filter(
            e => cycleSet.has(e.from) && cycleSet.has(e.to),
          );
          const cycleStr = cycle.join(' → ');
          // Cycles are expected in real-world codebases with mutual module
          // dependencies.  The runtime handles them via SCC-based two-pass
          // execution (scaffold then implement), so this is informational.
          issues.push({
            severity: 'warning',
            code: 'inferred-cycle',
            message:
              `Dependency inference detected a cycle: ${cycleStr}. ` +
              `Injected edges in cycle: ${cycleInjected.map(e => `${e.from}→${e.to} (${e.reason})`).join('; ')}. ` +
              `The runtime will handle this via SCC two-pass execution (scaffold → implement).`,
          });

          // Keep the injected edges — the SCC scheduler handles cycles.
          break;
        }
      }
    } catch (err) {
      logger.warn(`Cycle detection after inference failed: ${err}`);
    }

    // Check for cross-group edges that violate group barrier direction
    for (const edge of injectedEdges) {
      const fromGroup = taskGroupMap[edge.from] ?? 0;
      const toGroup = taskGroupMap[edge.to] ?? 0;
      if (toGroup > fromGroup) {
        issues.push({
          severity: 'error',
          code: 'cross-group-backward-dep',
          message:
            `Inferred dependency ${edge.from} (group ${fromGroup}) → ${edge.to} (group ${toGroup}) ` +
            `points forward in group order (earlier group depends on later group). ` +
            `This suggests groups.json ordering is incorrect. ${edge.reason}`,
        });
      }
    }
  }

  logger.info(
    `Dependency inference complete: ${injectedEdges.length} edge(s) injected, ` +
    `${issues.length} issue(s) found`,
  );

  return { injectedEdges, issues, tasks };
}

/**
 * Extract the likely symbol name from a raw callee expression.
 * Handles common patterns like `Foo.bar()`, `self.bar()`, `bar()`, `Foo::bar()`.
 */
function extractSymbolName(raw: string): string | null {
  if (!raw || raw.length === 0) return null;
  // Remove trailing parens, template args, etc.
  const cleaned = raw.replace(/[(<].*$/, '').trim();
  if (cleaned.length === 0) return null;

  // For dotted/scoped names, take the last segment
  const parts = cleaned.split(/[.:]/).filter(Boolean);
  const last = parts[parts.length - 1];

  // Skip common noise like 'self', 'this', 'super'
  if (['self', 'this', 'super', 'Self'].includes(last)) {
    return parts.length > 1 ? parts[parts.length - 2] : null;
  }

  return last || null;
}
