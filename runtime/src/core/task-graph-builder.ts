/**
 * Call-graph-clustering task decomposition for AAMF.
 *
 * Uses the Lore knowledge-base symbol graph (symbol_refs + type_refs) to
 * cluster tightly-coupled symbols into migration tasks.  Language-agnostic:
 * works on function calls, type references, and method dispatch equally.
 *
 * Algorithm:
 *   1. Load all symbols and edges (symbol_refs + type_refs)
 *   2. Contract SCCs — mutually-dependent symbols must share a task
 *   3. Greedy merge — merge the pair of clusters with the highest
 *      inter-cluster edge weight, until merging would exceed maxLinesPerTask
 *   4. Each cluster becomes a MigrationTask with correct dependency edges
 *   5. Optionally annotate tasks with compilation unit IDs
 *
 * @module core/task-graph-builder
 */

import type { MigrationTask, CompilationUnit } from '../agents/types.js';

// ─── Public Types ────────────────────────────────────────────────────────────

export interface TaskGraphBuilderOptions {
  kbDbPath: string;
  sourceRoot: string;
  maxLinesPerTask: number;
  targetLanguage: string;
  outputPath: string;
  compilationUnits?: CompilationUnit[];
}

export interface TaskGraphResult {
  tasks: MigrationTask[];
  sccs: string[][];
  compilationUnits: CompilationUnit[];
}

/** A module in the condensed dependency summary for the planner agent. */
export interface CondensedModule {
  /** Stable cluster identifier. */
  id: string;
  /** Source files that contain symbols in this cluster. */
  files: string[];
  /** Total lines covered by the cluster's symbols. */
  lines: number;
  /** Number of symbols in the cluster. */
  symbolCount: number;
  /** Symbol names (up to 20 representative names). */
  symbols: string[];
  /** IDs of other modules this one depends on. */
  dependsOn: string[];
}

export interface DependencySummary {
  fileCount: number;
  totalLines: number;
  /** Condensed modules derived from call-graph clustering. */
  modules: CondensedModule[];
  /** Weakly-connected components of the module graph. */
  connectedComponents: Array<{ moduleIds: string[]; totalLines: number }>;
  /** Module-level SCCs (cyclic dependency groups). */
  sccs: string[][];
  /** Per-file metrics for context. */
  fileMetrics: Record<string, { lines: number; symbolCount: number }>;
}

// ─── Public Functions ────────────────────────────────────────────────────────

/**
 * Build a condensed dependency summary from call-graph clustering.
 */
export async function buildDependencySummary(
  kbDbPath: string,
  maxLinesPerModule: number = 500,
): Promise<DependencySummary> {
  const lore = await import('@aamf/lore');
  const db = lore.openReadOnly(kbDbPath);

  try {
    const files = lore.listFiles(db);
    const allSymbols = lore.listSymbols(db, { limit: 100_000 });

    const fileIdToPath = new Map<number, string>();
    for (const f of files) fileIdToPath.set(f.id, f.path);

    // Build symbol graph
    const symInfos = allSymbols.map(s => ({
      id: s.id, name: s.name, kind: s.kind,
      fileId: s.file_id, startLine: s.start_line, endLine: s.end_line,
    }));
    const callRefs = queryResolvedEdges(db);
    const typeRefs = queryTypeRefs(db);

    // Cluster symbols
    const clusters = clusterSymbols(symInfos, callRefs, typeRefs, maxLinesPerModule, fileIdToPath);

    // Build modules from clusters
    const modules: CondensedModule[] = [];
    for (const cluster of clusters) {
      const clusterFiles = new Set<string>();
      for (const sym of cluster.symbols) {
        const path = fileIdToPath.get(sym.fileId);
        if (path) clusterFiles.add(path);
      }
      modules.push({
        id: cluster.id,
        files: [...clusterFiles].sort(),
        lines: cluster.totalLines,
        symbolCount: cluster.symbols.length,
        symbols: cluster.symbols.slice(0, 20).map(s => s.name),
        dependsOn: [...cluster.dependencies].sort(),
      });
    }

    // File metrics
    const symbolsByFileId = new Map<number, Array<{ endLine: number }>>();
    for (const s of allSymbols) {
      const list = symbolsByFileId.get(s.file_id) ?? [];
      list.push({ endLine: s.end_line });
      symbolsByFileId.set(s.file_id, list);
    }
    const fileMetrics: Record<string, { lines: number; symbolCount: number }> = {};
    let totalLines = 0;
    for (const f of files) {
      const syms = symbolsByFileId.get(f.id) ?? [];
      const maxLine = syms.length > 0 ? Math.max(...syms.map(s => s.endLine)) : 0;
      totalLines += maxLine;
      fileMetrics[f.path] = { lines: maxLine, symbolCount: syms.length };
    }

    // Module-level connected components and SCCs
    const moduleAdj = new Map<string, string[]>();
    for (const m of modules) moduleAdj.set(m.id, m.dependsOn);
    const moduleSCCs = findSCCs(modules.map(m => m.id), moduleAdj);

    const undirAdj = new Map<string, Set<string>>();
    for (const m of modules) undirAdj.set(m.id, new Set());
    for (const m of modules) {
      for (const dep of m.dependsOn) {
        undirAdj.get(m.id)?.add(dep);
        undirAdj.get(dep)?.add(m.id);
      }
    }
    const ccs = findConnectedComponents(modules.map(m => m.id), undirAdj);
    const moduleMap = new Map(modules.map(m => [m.id, m]));
    const ccResults = ccs.map(cc => ({
      moduleIds: cc,
      totalLines: cc.reduce((sum, id) => sum + (moduleMap.get(id)?.lines ?? 0), 0),
    }));

    return {
      fileCount: files.length,
      totalLines,
      modules,
      connectedComponents: ccResults,
      sccs: moduleSCCs,
      fileMetrics,
    };
  } finally {
    db.close();
  }
}

/**
 * Build a complete task graph using call-graph clustering.
 */
export async function buildTaskGraph(options: TaskGraphBuilderOptions): Promise<TaskGraphResult> {
  const { kbDbPath, sourceRoot, maxLinesPerTask, targetLanguage, outputPath, compilationUnits } = options;

  const lore = await import('@aamf/lore');
  const db = lore.openReadOnly(kbDbPath);

  try {
    const files = lore.listFiles(db);
    if (files.length === 0) {
      return { tasks: [], sccs: [], compilationUnits: compilationUnits ?? [] };
    }

    const fileIdToPath = new Map<number, string>();
    for (const f of files) fileIdToPath.set(f.id, f.path);

    // File → compilation unit mapping
    const fileToUnit = new Map<string, string>();
    if (compilationUnits) {
      for (const unit of compilationUnits) {
        for (const sf of unit.sourceFiles) fileToUnit.set(sf, unit.id);
      }
    }

    const allSymbols = lore.listSymbols(db, { limit: 100_000 });
    const symInfos: SymbolInfo[] = allSymbols.map(s => ({
      id: s.id, name: s.name, kind: s.kind,
      fileId: s.file_id, startLine: s.start_line, endLine: s.end_line,
    }));

    // Handle empty symbol table — create one task per file
    if (symInfos.length === 0) {
      const tasks: MigrationTask[] = files.map((f, idx) => {
        const targetFile = mapSourceToTarget(f.path, targetLanguage, outputPath, sourceRoot);
        const unitId = fileToUnit.get(f.path);
        return {
          id: `task-${idx}-0`,
          name: fileBaseName(f.path),
          sourceFiles: [f.path],
          targetFiles: [targetFile],
          knowledgeBaseRef: `kb/${f.path}`,
          dependencies: [],
          complexity: 'simple' as const,
          description: `Migrate ${f.path}`,
          acceptanceCriteria: ['Target code compiles without type errors'],
          parityChecks: ['Function signatures preserved across source→target boundary'],
          ...(unitId ? { compilationUnit: unitId } : {}),
        };
      });
      return { tasks, sccs: [], compilationUnits: compilationUnits ?? [] };
    }

    const callRefs = queryResolvedEdges(db);
    const typeRefs = queryTypeRefs(db);

    // Cluster symbols into tasks
    const clusters = clusterSymbols(symInfos, callRefs, typeRefs, maxLinesPerTask, fileIdToPath);

    // Build tasks from clusters
    const tasks: MigrationTask[] = [];
    const clusterIdToTaskId = new Map<string, string>();

    for (let i = 0; i < clusters.length; i++) {
      const cluster = clusters[i]!;
      const taskId = `task-${i}-0`;
      clusterIdToTaskId.set(cluster.id, taskId);

      // Collect source files from the cluster's symbols
      const clusterFiles = new Set<string>();
      for (const sym of cluster.symbols) {
        const path = fileIdToPath.get(sym.fileId);
        if (path) clusterFiles.add(path);
      }
      const sourceFiles = [...clusterFiles].sort();

      // Target files
      const targetFiles = sourceFiles.map(sf =>
        mapSourceToTarget(sf, targetLanguage, outputPath, sourceRoot),
      );
      // Deduplicate target files (multiple source files may map to the same target)
      const uniqueTargets = [...new Set(targetFiles)];

      // Determine compilation unit (majority vote if cluster spans multiple files)
      let unitId: string | undefined;
      if (compilationUnits) {
        const unitCounts = new Map<string, number>();
        for (const sf of sourceFiles) {
          const u = fileToUnit.get(sf);
          if (u) unitCounts.set(u, (unitCounts.get(u) ?? 0) + 1);
        }
        if (unitCounts.size > 0) {
          unitId = [...unitCounts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
        }
      }

      // Compute line range if cluster is within a single file
      let lineRange: { start: number; end: number } | undefined;
      if (clusterFiles.size === 1) {
        const minLine = Math.min(...cluster.symbols.map(s => s.startLine));
        const maxLine = Math.max(...cluster.symbols.map(s => s.endLine));
        lineRange = { start: minLine, end: maxLine };
      }

      const symbolNames = cluster.symbols.map(s => s.name);
      const repNames = symbolNames.slice(0, 5).join(', ');
      const isStubs = cluster.isStubs === true;
      const taskName = isStubs
        ? `[stubs] ${repNames}${symbolNames.length > 5 ? ` (+${symbolNames.length - 5})` : ''}`
        : cluster.symbols.length === 1
          ? cluster.symbols[0]!.name
          : `${repNames}${symbolNames.length > 5 ? ` (+${symbolNames.length - 5})` : ''}`;

      tasks.push({
        id: taskId,
        name: taskName,
        sourceFiles,
        targetFiles: uniqueTargets,
        knowledgeBaseRef: sourceFiles.map(f => `kb/${f}`).join(', '),
        dependencies: [], // populated below
        complexity: isStubs ? 'simple' : estimateComplexity(cluster.totalLines),
        description: isStubs
          ? `Emit type signatures and placeholder function bodies for ${symbolNames.length} symbols`
          : describeCluster(cluster, fileIdToPath),
        acceptanceCriteria: isStubs
          ? ['All type definitions and function signatures are present', 'All function bodies are placeholders (no real implementation)']
          : buildAcceptanceCriteria(cluster),
        parityChecks: isStubs
          ? ['Type signatures match source definitions']
          : buildParityChecks(cluster),
        ...(lineRange ? { lineRange } : {}),
        ...(unitId ? { compilationUnit: unitId } : {}),
      });
    }

    // Populate inter-task dependencies from inter-cluster edges
    const taskMap = new Map(tasks.map(t => [t.id, t]));
    for (const cluster of clusters) {
      const taskId = clusterIdToTaskId.get(cluster.id)!;
      const task = taskMap.get(taskId)!;
      const deps = new Set<string>();
      for (const depClusterId of cluster.dependencies) {
        const depTaskId = clusterIdToTaskId.get(depClusterId);
        if (depTaskId && depTaskId !== taskId) deps.add(depTaskId);
      }
      task.dependencies = [...deps].sort();
    }

    // Validate compilation units
    const validatedUnits = validateCompilationUnits(tasks, compilationUnits ?? []);

    // Assert task ID uniqueness — a collision would silently corrupt the
    // dependency graph, so fail loudly rather than producing invalid output.
    const seenIds = new Set<string>();
    for (const t of tasks) {
      if (seenIds.has(t.id)) {
        throw new Error(
          `Duplicate task ID "${t.id}" detected after clustering — this is a ` +
          `bug in the task graph builder. Please report it.`,
        );
      }
      seenIds.add(t.id);
    }

    // Detect task-level SCCs
    const adjacency = new Map<string, string[]>();
    for (const t of tasks) adjacency.set(t.id, t.dependencies);
    const sccs = findSCCs(tasks.map(t => t.id), adjacency);

    return { tasks, sccs, compilationUnits: validatedUnits };
  } finally {
    db.close();
  }
}

// ─── Clustering Engine ──────────────────────────────────────────────────────

interface SymbolInfo {
  id: number; name: string; kind: string;
  fileId: number; startLine: number; endLine: number;
}

interface Cluster {
  id: string;
  symbols: SymbolInfo[];
  totalLines: number;
  /** Cluster IDs this cluster depends on (outbound edges). */
  dependencies: Set<string>;
  /** True if this is a stubs-only cluster from SCC splitting. */
  isStubs?: boolean;
  /** If this cluster was split from an SCC, the SCC group identifier. */
  sccGroup?: string;
}

/**
 * Cluster symbols using call-graph analysis:
 *   1. Build directed symbol-level adjacency from symbol_refs + type_refs
 *   2. Contract SCCs — mutually-dependent symbols must share a cluster
 *   3. Greedy merge — repeatedly merge the pair with the highest edge
 *      weight, as long as the merged size doesn't exceed maxLines
 */
function clusterSymbols(
  symbols: SymbolInfo[],
  callRefs: CallRefRow[],
  typeRefs: TypeRefRow[],
  maxLines: number,
  fileIdToPath?: Map<number, string>,
): Cluster[] {
  if (symbols.length === 0) return [];

  // Build symbol name → symbol IDs map (for resolving callee names)
  const nameToIds = new Map<string, number[]>();
  for (const sym of symbols) {
    const list = nameToIds.get(sym.name) ?? [];
    list.push(sym.id);
    nameToIds.set(sym.name, list);
  }

  const symMap = new Map(symbols.map(s => [s.id, s]));

  // Build directed edges: symId → Set<symId>
  const edges = new Map<number, Set<number>>();
  const ensureEdges = (id: number) => {
    if (!edges.has(id)) edges.set(id, new Set());
  };
  for (const sym of symbols) ensureEdges(sym.id);

  // Add call edges — use Lore's pre-resolved callee_id when available.
  // Falls back to name-based matching only for unresolved edges.
  for (const ref of callRefs) {
    if (!symMap.has(ref.callerSymbolId)) continue;

    if (ref.calleeId != null && symMap.has(ref.calleeId)) {
      // Lore already resolved this edge (LSP, same-file, or unique name)
      if (ref.calleeId !== ref.callerSymbolId) {
        ensureEdges(ref.callerSymbolId);
        edges.get(ref.callerSymbolId)!.add(ref.calleeId);
      }
    } else {
      // Fallback: name-based resolution (only for edges Lore couldn't resolve).
      // Prefer same-file matches; for cross-file, only link when the name is
      // globally unique.  Ambiguous names (e.g. init, free, read) would create
      // false coupling between unrelated compilation units.
      const calleeIds = nameToIds.get(ref.calleeName) ?? [];
      const callerFileId = ref.callerFileId;
      const localCallees = calleeIds.filter(id => symMap.get(id)?.fileId === callerFileId);
      // Cross-file: only if the name resolves to exactly one symbol
      const resolvedIds = localCallees.length > 0
        ? localCallees
        : calleeIds.length === 1 ? calleeIds : [];
      for (const calleeId of resolvedIds) {
        if (calleeId !== ref.callerSymbolId && symMap.has(calleeId)) {
          ensureEdges(ref.callerSymbolId);
          edges.get(ref.callerSymbolId)!.add(calleeId);
        }
      }
    }
  }

  // Add type edges (file_id + ref_line → containing symbol → type definer)
  const symbolsByFile = new Map<number, SymbolInfo[]>();
  for (const sym of symbols) {
    const list = symbolsByFile.get(sym.fileId) ?? [];
    list.push(sym);
    symbolsByFile.set(sym.fileId, list);
  }

  for (const ref of typeRefs) {
    // Find the symbol containing this type reference
    let userSymId: number | undefined;
    if (ref.symbolId != null && symMap.has(ref.symbolId)) {
      userSymId = ref.symbolId;
    } else {
      // Fallback: find the symbol whose line range contains ref_line
      const fileSym = symbolsByFile.get(ref.fileId);
      if (fileSym) {
        for (const s of fileSym) {
          if (ref.refLine >= s.startLine && ref.refLine <= s.endLine) {
            userSymId = s.id;
            break;
          }
        }
      }
    }
    if (userSymId == null) continue;

    const definerIds = nameToIds.get(ref.typeName) ?? [];
    // Prefer same-file type definitions; for cross-file, only link when the
    // type name is globally unique.  C codebases often reuse struct/typedef
    // names across compilation units — linking all of them creates false
    // cross-unit coupling.
    const userFileId = symMap.get(userSymId)?.fileId;
    const localDefiners = definerIds.filter(id => symMap.get(id)?.fileId === userFileId);
    const resolvedDefiners = localDefiners.length > 0
      ? localDefiners
      : definerIds.length === 1 ? definerIds : [];
    for (const defId of resolvedDefiners) {
      if (defId !== userSymId && symMap.has(defId)) {
        ensureEdges(userSymId);
        edges.get(userSymId)!.add(defId);
      }
    }
  }

  // Step 1: Find SCCs using Tarjan's on the symbol graph
  const symIds = symbols.map(s => s.id.toString());
  const symAdj = new Map<string, string[]>();
  for (const [from, tos] of edges) {
    symAdj.set(from.toString(), [...tos].map(t => t.toString()));
  }
  for (const sym of symbols) {
    if (!symAdj.has(sym.id.toString())) symAdj.set(sym.id.toString(), []);
  }
  const symbolSCCs = findSCCs(symIds, symAdj);

  // Step 2: Build initial clusters — one per SCC, one per non-SCC symbol.
  //         Oversized SCCs (> maxLines) are split into a stubs cluster +
  //         sequential implementation chunks.
  const symbolToCluster = new Map<number, string>();
  const clusterMap = new Map<string, Cluster>();
  let clusterCounter = 0;

  // SCC clusters — with splitting for oversized ones
  for (const scc of symbolSCCs) {
    const clusterSyms: SymbolInfo[] = [];
    for (const sid of scc) {
      const sym = symMap.get(parseInt(sid));
      if (sym) clusterSyms.push(sym);
    }
    const totalLines = computeClusterLines(clusterSyms);

    if (totalLines <= maxLines || clusterSyms.length <= 1) {
      // Fits in one cluster — no splitting needed
      const clusterId = `c${clusterCounter++}`;
      for (const sym of clusterSyms) symbolToCluster.set(sym.id, clusterId);
      clusterMap.set(clusterId, {
        id: clusterId, symbols: clusterSyms, totalLines,
        dependencies: new Set(),
      });
    } else {
      // Oversized SCC: split into stubs + implementation chunks
      const subClusters = splitOversizedSCC(
        clusterSyms, edges, maxLines, clusterCounter,
      );
      for (const sub of subClusters) {
        clusterMap.set(sub.id, sub);
        for (const sym of sub.symbols) {
          symbolToCluster.set(sym.id, sub.id);
        }
      }
      clusterCounter += subClusters.length;
    }
  }

  // Singleton clusters for non-SCC symbols
  for (const sym of symbols) {
    if (symbolToCluster.has(sym.id)) continue;
    const clusterId = `c${clusterCounter++}`;
    symbolToCluster.set(sym.id, clusterId);
    const lineCount = sym.endLine - sym.startLine + 1;
    clusterMap.set(clusterId, {
      id: clusterId, symbols: [sym], totalLines: lineCount,
      dependencies: new Set(),
    });
  }

  // Build inter-cluster edges with weights
  const interClusterEdges = new Map<string, Map<string, number>>(); // from → (to → weight)
  for (const [fromSym, toSyms] of edges) {
    const fromCluster = symbolToCluster.get(fromSym)!;
    for (const toSym of toSyms) {
      const toCluster = symbolToCluster.get(toSym)!;
      if (fromCluster === toCluster) continue;
      if (!interClusterEdges.has(fromCluster)) interClusterEdges.set(fromCluster, new Map());
      const fromMap = interClusterEdges.get(fromCluster)!;
      fromMap.set(toCluster, (fromMap.get(toCluster) ?? 0) + 1);
    }
  }

  // Step 3: Greedy merge — two passes:
  //   Pass A: merge same-file clusters with ≥1 edge (directional OK)
  //   Pass B: merge cross-file clusters with ≥2 bidirectional edges
  // Both passes respect maxLines using line SPAN (not deduplicated line count).

  // Line span = max(endLine) - min(startLine) + 1 per file, summed.
  // This measures the actual source range the agent must read, including
  // inter-function gaps (comments, blank lines).
  const computeLineSpan = (syms: SymbolInfo[]): number => {
    if (syms.length === 0) return 0;
    const byFile = new Map<number, { min: number; max: number }>();
    for (const s of syms) {
      const existing = byFile.get(s.fileId);
      if (existing) {
        existing.min = Math.min(existing.min, s.startLine);
        existing.max = Math.max(existing.max, s.endLine);
      } else {
        byFile.set(s.fileId, { min: s.startLine, max: s.endLine });
      }
    }
    let total = 0;
    for (const { min, max } of byFile.values()) total += max - min + 1;
    return total;
  };

  // Helper: get the set of file IDs a cluster spans
  const clusterFileIds = (cluster: Cluster): Set<number> => {
    const s = new Set<number>();
    for (const sym of cluster.symbols) s.add(sym.fileId);
    return s;
  };

  // Helper: check if two clusters share at least one file
  const shareFile = (a: Cluster, b: Cluster): boolean => {
    const aFiles = clusterFileIds(a);
    for (const sym of b.symbols) {
      if (aFiles.has(sym.fileId)) return true;
    }
    return false;
  };

  // Merge function shared by both passes
  const mergeClusters = (keepId: string, mergeId: string) => {
    const keepCluster = clusterMap.get(keepId)!;
    const mergeCluster = clusterMap.get(mergeId)!;

    keepCluster.symbols.push(...mergeCluster.symbols);
    keepCluster.totalLines = computeClusterLines(keepCluster.symbols);

    for (const sym of mergeCluster.symbols) {
      symbolToCluster.set(sym.id, keepId);
    }

    // Rewire edges
    const mergedTargets = interClusterEdges.get(mergeId);
    if (mergedTargets) {
      for (const [target, w] of mergedTargets) {
        if (target === keepId) continue;
        if (!interClusterEdges.has(keepId)) interClusterEdges.set(keepId, new Map());
        const keepTargets = interClusterEdges.get(keepId)!;
        keepTargets.set(target, (keepTargets.get(target) ?? 0) + w);
      }
    }
    for (const [from, targets] of interClusterEdges) {
      if (from === mergeId) continue;
      const w = targets.get(mergeId);
      if (w != null) {
        targets.delete(mergeId);
        if (from !== keepId) {
          targets.set(keepId, (targets.get(keepId) ?? 0) + w);
        }
      }
    }
    interClusterEdges.get(keepId)?.delete(keepId);
    interClusterEdges.delete(mergeId);
    clusterMap.delete(mergeId);
  };

  // Pass A: same-file merging (≥1 edge, any direction)
  // Use actual merged size (computeClusterLines) not sum, since same-file
  // symbols have overlapping line ranges.
  let changed = true;
  while (changed) {
    changed = false;
    let bestPair: [string, string] | undefined;
    let bestWeight = 0;

    for (const [from, targets] of interClusterEdges) {
      for (const [to, weight] of targets) {
        if (!clusterMap.has(from) || !clusterMap.has(to)) continue;
        const fromCluster = clusterMap.get(from)!;
        const toCluster = clusterMap.get(to)!;

        // Only same-file pairs in this pass
        if (!shareFile(fromCluster, toCluster)) continue;

        // Check actual merged span (not deduplicated line count)
        const mergedSpan = computeLineSpan([...fromCluster.symbols, ...toCluster.symbols]);
        if (mergedSpan > maxLines) continue;

        const reverseWeight = interClusterEdges.get(to)?.get(from) ?? 0;
        const totalWeight = weight + reverseWeight;
        if (totalWeight > bestWeight) {
          bestWeight = totalWeight;
          bestPair = [from, to];
        }
      }
    }

    if (!bestPair || bestWeight < 1) break;
    mergeClusters(bestPair[0], bestPair[1]);
    changed = true;
  }

  // Pass B: cross-file merging (≥2 bidirectional edges)
  changed = true;
  while (changed) {
    changed = false;
    let bestPair: [string, string] | undefined;
    let bestWeight = 0;

    for (const [from, targets] of interClusterEdges) {
      for (const [to, weight] of targets) {
        if (!clusterMap.has(from) || !clusterMap.has(to)) continue;
        const fromCluster = clusterMap.get(from)!;
        const toCluster = clusterMap.get(to)!;
        if (computeLineSpan([...fromCluster.symbols, ...toCluster.symbols]) > maxLines) continue;

        const reverseWeight = interClusterEdges.get(to)?.get(from) ?? 0;
        const totalWeight = weight + reverseWeight;
        if (totalWeight <= bestWeight) continue;
        if (totalWeight < 2) continue; // require ≥2 for cross-file

        bestWeight = totalWeight;
        bestPair = [from, to];
      }
    }

    if (!bestPair) break;
    mergeClusters(bestPair[0], bestPair[1]);
    changed = true;
  }

  // Step 4: Hierarchical affinity folding for undersized clusters.
  //
  // Small clusters (< MIN_LINES_PER_TASK) are folded into related clusters
  // using a strict affinity hierarchy.  Unlike blind bin-packing, merges
  // only happen when the clusters share a concrete relationship:
  //
  //   Tier 1 — File affinity (strongest): fold into another cluster that
  //            shares at least one source file.  The agent already reads
  //            the file, so co-located symbols add minimal overhead.
  //
  //   Tier 2 — Dependency affinity: fold into the cluster with the most
  //            call/type edges to/from this one.  A leaf function with a
  //            single caller naturally belongs in the caller's task.
  //
  //   Tier 3 — Directory affinity: fold into a cluster whose symbols live
  //            in the same parent directory, but only when that cluster is
  //            the sole directory-mate under the size limit.  Directory
  //            co-location implies module membership in C-style projects.
  //
  //   No match → leave as standalone.  A 10-line task is cheap; forcing it
  //              into an unrelated cluster confuses the migrator agent.
  const MIN_LINES_PER_TASK = 50;

  const getFileDir = (fid: number): string => {
    const path = fileIdToPath?.get(fid) ?? fid.toString();
    const lastSlash = path.lastIndexOf('/');
    return lastSlash >= 0 ? path.substring(0, lastSlash) : '.';
  };

  changed = true;
  while (changed) {
    changed = false;
    for (const [cid, cluster] of clusterMap) {
      if (cluster.isStubs) continue;
      if (computeLineSpan(cluster.symbols) >= MIN_LINES_PER_TASK) continue;

      let bestNeighbor: string | undefined;

      // ── Tier 1: file affinity ──────────────────────────────────────────
      // Find the cluster sharing the most files, preferring the one with
      // the highest edge weight as a tiebreaker.
      {
        let bestFileOverlap = 0;
        let bestEdgeWeight = 0;
        const myFiles = clusterFileIds(cluster);

        for (const [otherId, otherCluster] of clusterMap) {
          if (otherId === cid || otherCluster.isStubs) continue;
          if (computeLineSpan([...cluster.symbols, ...otherCluster.symbols]) > maxLines) continue;

          let overlap = 0;
          for (const sym of otherCluster.symbols) {
            if (myFiles.has(sym.fileId)) { overlap++; break; }
          }
          if (overlap === 0) continue;

          const edgeWeight =
            (interClusterEdges.get(cid)?.get(otherId) ?? 0) +
            (interClusterEdges.get(otherId)?.get(cid) ?? 0);

          if (overlap > bestFileOverlap || (overlap === bestFileOverlap && edgeWeight > bestEdgeWeight)) {
            bestFileOverlap = overlap;
            bestEdgeWeight = edgeWeight;
            bestNeighbor = otherId;
          }
        }
      }

      // ── Tier 2: dependency affinity ────────────────────────────────────
      // Fold into the neighbor with the most call/type edges (any direction).
      if (!bestNeighbor) {
        let bestEdgeCount = 0;
        const outbound = interClusterEdges.get(cid);

        if (outbound) {
          for (const [target, w] of outbound) {
            if (!clusterMap.has(target)) continue;
            const targetCluster = clusterMap.get(target)!;
            if (targetCluster.isStubs) continue;
            if (computeLineSpan([...cluster.symbols, ...targetCluster.symbols]) > maxLines) continue;
            const reverseW = interClusterEdges.get(target)?.get(cid) ?? 0;
            if (w + reverseW > bestEdgeCount) {
              bestEdgeCount = w + reverseW;
              bestNeighbor = target;
            }
          }
        }

        for (const [from, targets] of interClusterEdges) {
          if (from === cid || !clusterMap.has(from)) continue;
          const fromCluster = clusterMap.get(from)!;
          if (fromCluster.isStubs) continue;
          const w = targets.get(cid);
          if (w == null) continue;
          if (computeLineSpan([...cluster.symbols, ...fromCluster.symbols]) > maxLines) continue;
          const reverseW = outbound?.get(from) ?? 0;
          if (w + reverseW > bestEdgeCount) {
            bestEdgeCount = w + reverseW;
            bestNeighbor = from;
          }
        }
      }

      // ── Tier 3: directory affinity ─────────────────────────────────────
      // Only merge when there is exactly one viable directory-mate under
      // the size limit.  Multiple candidates means the relationship is
      // ambiguous — leave the cluster standalone rather than guess.
      if (!bestNeighbor) {
        const myDirs = new Set(cluster.symbols.map(s => getFileDir(s.fileId)));
        let dirCandidate: string | undefined;
        let dirCandidateCount = 0;

        for (const [otherId, otherCluster] of clusterMap) {
          if (otherId === cid || otherCluster.isStubs) continue;
          if (computeLineSpan([...cluster.symbols, ...otherCluster.symbols]) > maxLines) continue;

          const otherDirs = new Set(otherCluster.symbols.map(s => getFileDir(s.fileId)));
          let sharesDir = false;
          for (const d of myDirs) {
            if (otherDirs.has(d)) { sharesDir = true; break; }
          }
          if (sharesDir) {
            dirCandidate = otherId;
            dirCandidateCount++;
            if (dirCandidateCount > 1) break; // ambiguous — stop early
          }
        }

        if (dirCandidateCount === 1) {
          bestNeighbor = dirCandidate;
        }
      }

      // ── No match → leave as standalone ─────────────────────────────────
      if (bestNeighbor) {
        mergeClusters(bestNeighbor, cid);
        changed = true;
        break; // restart iteration since clusterMap changed
      }
    }
  }

  // Step 5: Split any oversized clusters that grew past maxLines during
  // merging.  Uses computeLineSpan (already defined in Step 3) to measure
  // actual source range including inter-function gaps.
  const oversizedIds = [...clusterMap.entries()]
    .filter(([_, c]) => computeLineSpan(c.symbols) > maxLines && c.symbols.length > 1)
    .map(([id]) => id);

  for (const oversizedId of oversizedIds) {
    const cluster = clusterMap.get(oversizedId);
    if (!cluster) continue;

    const subClusters = splitOversizedSCC(
      cluster.symbols, edges, maxLines, clusterCounter,
    );
    // Remove the oversized cluster
    clusterMap.delete(oversizedId);

    // Add the sub-clusters
    for (const sub of subClusters) {
      // Preserve any external dependencies the oversized cluster had
      for (const dep of cluster.dependencies) {
        if (!sub.dependencies.has(dep)) sub.dependencies.add(dep);
      }
      clusterMap.set(sub.id, sub);
      for (const sym of sub.symbols) {
        symbolToCluster.set(sym.id, sub.id);
      }
    }
    clusterCounter += subClusters.length;
  }

  // Compute final inter-cluster dependencies (directed)
  for (const cluster of clusterMap.values()) {
    cluster.dependencies.clear();
  }
  for (const [fromSym, toSyms] of edges) {
    const fromCluster = symbolToCluster.get(fromSym)!;
    for (const toSym of toSyms) {
      const toCluster = symbolToCluster.get(toSym)!;
      if (fromCluster !== toCluster) {
        clusterMap.get(fromCluster)?.dependencies.add(toCluster);
      }
    }
  }

  return [...clusterMap.values()];
}

/**
 * Compute total lines for a cluster, accounting for overlapping symbol
 * ranges within the same file.
 */
function computeClusterLines(symbols: SymbolInfo[]): number {
  if (symbols.length === 0) return 0;

  // Group by file, then compute non-overlapping line ranges
  const byFile = new Map<number, Array<{ start: number; end: number }>>();
  for (const s of symbols) {
    const list = byFile.get(s.fileId) ?? [];
    list.push({ start: s.startLine, end: s.endLine });
    byFile.set(s.fileId, list);
  }

  let total = 0;
  for (const ranges of byFile.values()) {
    ranges.sort((a, b) => a.start - b.start);
    let mergedStart = ranges[0]!.start;
    let mergedEnd = ranges[0]!.end;
    for (let i = 1; i < ranges.length; i++) {
      if (ranges[i]!.start <= mergedEnd + 1) {
        mergedEnd = Math.max(mergedEnd, ranges[i]!.end);
      } else {
        total += mergedEnd - mergedStart + 1;
        mergedStart = ranges[i]!.start;
        mergedEnd = ranges[i]!.end;
      }
    }
    total += mergedEnd - mergedStart + 1;
  }

  return total;
}

// ─── SCC Splitting ───────────────────────────────────────────────────────────

/**
 * Split an oversized SCC into a stubs cluster + sequential implementation
 * chunks.  The stubs cluster contains all symbols (placeholder — the agent
 * emits only signatures/type defs).  Each implementation chunk contains
 * ≤maxLines of symbol bodies, ordered by a greedy walk of the internal
 * acyclic edges.  Each chunk depends on the stubs cluster and on the
 * preceding chunk.
 */
function splitOversizedSCC(
  symbols: SymbolInfo[],
  allEdges: Map<number, Set<number>>,
  maxLines: number,
  counterStart: number,
): Cluster[] {
  const sccSymIds = new Set(symbols.map(s => s.id));

  // Build SCC-internal acyclic edge subset: remove back-edges by DFS
  // to get a partial ordering we can use for chunking.
  const internalAdj = new Map<number, number[]>();
  for (const sym of symbols) internalAdj.set(sym.id, []);
  for (const sym of symbols) {
    const tos = allEdges.get(sym.id);
    if (!tos) continue;
    for (const to of tos) {
      if (sccSymIds.has(to) && to !== sym.id) {
        internalAdj.get(sym.id)!.push(to);
      }
    }
  }

  // DFS ordering — gives us a usable sequence even with cycles
  const visited = new Set<number>();
  const ordered: SymbolInfo[] = [];
  const symMap = new Map(symbols.map(s => [s.id, s]));

  function dfs(id: number): void {
    if (visited.has(id)) return;
    visited.add(id);
    for (const to of (internalAdj.get(id) ?? [])) {
      dfs(to);
    }
    ordered.push(symMap.get(id)!);
  }

  // Start from symbols with the most outbound edges (likely entry points)
  const sortedByOutDegree = [...symbols].sort((a, b) =>
    (internalAdj.get(b.id)?.length ?? 0) - (internalAdj.get(a.id)?.length ?? 0),
  );
  for (const sym of sortedByOutDegree) dfs(sym.id);
  ordered.reverse(); // DFS post-order reversed → approximate topo order

  // Stubs cluster — all symbols, but marked as stubs (small estimated size)
  const stubsId = `c${counterStart}`;
  const sccGroupId = `scc-${counterStart}`;
  // Estimate stub size as ~3 lines per symbol (signature + empty body)
  const stubsLines = Math.max(symbols.length * 3, 50);
  const stubsCluster: Cluster = {
    id: stubsId,
    symbols: [...symbols], // all symbols — agent knows to emit stubs only
    totalLines: stubsLines,
    dependencies: new Set(),
    isStubs: true,
    sccGroup: sccGroupId,
  };

  // Chunk the ordered symbols into implementation sub-clusters
  const chunks: Cluster[] = [stubsCluster];
  let chunkIdx = 1;
  let currentSymbols: SymbolInfo[] = [];
  let currentLines = 0;

  for (const sym of ordered) {
    const symLines = sym.endLine - sym.startLine + 1;
    if (currentLines + symLines > maxLines && currentSymbols.length > 0) {
      const chunkId = `c${counterStart + chunkIdx}`;
      const chunk: Cluster = {
        id: chunkId,
        symbols: currentSymbols,
        totalLines: computeClusterLines(currentSymbols),
        dependencies: new Set([stubsId]),
        sccGroup: sccGroupId,
      };
      // Each chunk depends on the previous chunk for sequential ordering
      if (chunkIdx > 1) {
        chunk.dependencies.add(`c${counterStart + chunkIdx - 1}`);
      }
      chunks.push(chunk);
      chunkIdx++;
      currentSymbols = [];
      currentLines = 0;
    }
    currentSymbols.push(sym);
    currentLines += symLines;
  }

  // Flush remaining
  if (currentSymbols.length > 0) {
    const chunkId = `c${counterStart + chunkIdx}`;
    const chunk: Cluster = {
      id: chunkId,
      symbols: currentSymbols,
      totalLines: computeClusterLines(currentSymbols),
      dependencies: new Set([stubsId]),
      sccGroup: sccGroupId,
    };
    if (chunkIdx > 1) {
      chunk.dependencies.add(`c${counterStart + chunkIdx - 1}`);
    }
    chunks.push(chunk);
  }

  return chunks;
}

// ─── DB Queries ──────────────────────────────────────────────────────────────

interface CallRefRow {
  callerSymbolId: number; callerFileId: number;
  callerStartLine: number; callerEndLine: number;
  calleeName: string;
  /** Resolved callee symbol ID (null if unresolved). Lore v0.3.0+. */
  calleeId: number | null;
  /** Resolved callee file ID (null if unresolved). Lore v0.3.0+. */
  calleeFileId: number | null;
}

interface TypeRefRow {
  fileId: number; symbolId: number | null;
  typeName: string; refLine: number;
}

/**
 * Load pre-resolved call-graph edges.
 *
 * Prefers Lore v0.3.0's denormalized columns on `symbol_refs` (file_id,
 * resolution_method) when available, falling back to a JOIN through `symbols`
 * for older schemas.  When resolution_method is present, low-confidence
 * resolution methods are excluded via a blocklist so that new high-confidence
 * methods added in future Lore versions are automatically included.
 */
function queryResolvedEdges(
  db: import('better-sqlite3').Database,
): CallRefRow[] {
  // Detect whether the v0.3.0 columns exist
  const cols = db.prepare('PRAGMA table_info(symbol_refs)').all() as Array<{ name: string }>;
  const hasFileId = cols.some(c => c.name === 'file_id');
  const hasResolutionMethod = cols.some(c => c.name === 'resolution_method');

  if (hasFileId && hasResolutionMethod) {
    // Lore v0.3.0+: use denormalized file_id, exclude low-confidence methods.
    // Blocklist approach: new high-confidence methods added by future Lore
    // versions are automatically included without code changes here.
    const rows = db.prepare(`
      SELECT sr.caller_id, sr.file_id AS caller_file_id,
             sr.callee_id, sr.callee_name,
             cs.file_id AS callee_file_id
      FROM symbol_refs sr
      LEFT JOIN symbols cs ON sr.callee_id = cs.id
      WHERE sr.callee_id IS NOT NULL
        AND (sr.resolution_method IS NULL
             OR sr.resolution_method NOT IN ('name_ambiguous', 'unresolved'))
    `).all() as Array<{
      caller_id: number; caller_file_id: number;
      callee_id: number | null; callee_name: string;
      callee_file_id: number | null;
    }>;
    return rows.map(r => ({
      callerSymbolId: r.caller_id,
      callerFileId: r.caller_file_id,
      callerStartLine: 0,
      callerEndLine: 0,
      calleeName: r.callee_name,
      calleeId: r.callee_id,
      calleeFileId: r.callee_file_id,
    }));
  }

  // Fallback for older schemas: JOIN through symbols to get file_id
  const rows = db.prepare(`
    SELECT s.id AS caller_symbol_id, s.file_id AS caller_file_id,
           sr.callee_id, sr.callee_name,
           cs.file_id AS callee_file_id
    FROM symbol_refs sr
    JOIN symbols s ON sr.caller_id = s.id
    LEFT JOIN symbols cs ON sr.callee_id = cs.id
  `).all() as Array<{
    caller_symbol_id: number; caller_file_id: number;
    callee_id: number | null; callee_name: string;
    callee_file_id: number | null;
  }>;
  return rows.map(r => ({
    callerSymbolId: r.caller_symbol_id,
    callerFileId: r.caller_file_id,
    callerStartLine: 0,
    callerEndLine: 0,
    calleeName: r.callee_name,
    calleeId: r.callee_id,
    calleeFileId: r.callee_file_id,
  }));
}

function queryTypeRefs(db: import('better-sqlite3').Database): TypeRefRow[] {
  const rows = db.prepare(`
    SELECT file_id, symbol_id, type_name, ref_line FROM type_refs
  `).all() as Array<{
    file_id: number; symbol_id: number | null;
    type_name: string; ref_line: number;
  }>;
  return rows.map(r => ({
    fileId: r.file_id, symbolId: r.symbol_id,
    typeName: r.type_name, refLine: r.ref_line,
  }));
}

// ─── Compilation Unit Validation ─────────────────────────────────────────────

function validateCompilationUnits(
  tasks: MigrationTask[],
  units: CompilationUnit[],
): CompilationUnit[] {
  if (units.length === 0) return [];

  const taskToUnit = new Map<string, string>();
  for (const task of tasks) {
    if (task.compilationUnit) taskToUnit.set(task.id, task.compilationUnit);
  }

  const actualCrossUnitDeps = new Map<string, Set<string>>();
  for (const task of tasks) {
    const myUnit = taskToUnit.get(task.id);
    if (!myUnit) continue;
    for (const depId of task.dependencies) {
      const depUnit = taskToUnit.get(depId);
      if (depUnit && depUnit !== myUnit) {
        const deps = actualCrossUnitDeps.get(myUnit) ?? new Set();
        deps.add(depUnit);
        actualCrossUnitDeps.set(myUnit, deps);
      }
    }
  }

  const unitMap = new Map(units.map(u => [u.id, u]));
  for (const [unitId, actualDeps] of actualCrossUnitDeps) {
    const unit = unitMap.get(unitId);
    if (!unit) continue;
    const declaredSet = new Set(unit.dependsOn);
    for (const dep of actualDeps) {
      if (!declaredSet.has(dep)) unit.dependsOn.push(dep);
    }
    unit.dependsOn.sort();
  }

  return units;
}

// ─── Graph Algorithms ────────────────────────────────────────────────────────

export function findSCCs(
  nodeIds: string[],
  adjacency: Map<string, string[]>,
): string[][] {
  let index = 0;
  const stack: string[] = [];
  const onStack = new Set<string>();
  const indices = new Map<string, number>();
  const lowlinks = new Map<string, number>();
  const result: string[][] = [];

  function strongconnect(v: string): void {
    indices.set(v, index);
    lowlinks.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);
    for (const w of (adjacency.get(v) ?? [])) {
      if (!indices.has(w)) {
        strongconnect(w);
        lowlinks.set(v, Math.min(lowlinks.get(v)!, lowlinks.get(w)!));
      } else if (onStack.has(w)) {
        lowlinks.set(v, Math.min(lowlinks.get(v)!, indices.get(w)!));
      }
    }
    if (lowlinks.get(v) === indices.get(v)) {
      const scc: string[] = [];
      let w: string;
      do { w = stack.pop()!; onStack.delete(w); scc.push(w); } while (w !== v);
      if (scc.length > 1) result.push(scc);
    }
  }

  for (const id of nodeIds) { if (!indices.has(id)) strongconnect(id); }
  return result;
}

function findConnectedComponents(
  nodes: string[],
  adjacency: Map<string, Set<string>>,
): string[][] {
  const parent = new Map<string, string>();
  const rank = new Map<string, number>();
  function find(x: string): string {
    if (parent.get(x) !== x) parent.set(x, find(parent.get(x)!));
    return parent.get(x)!;
  }
  function union(a: string, b: string): void {
    const ra = find(a), rb = find(b);
    if (ra === rb) return;
    const rka = rank.get(ra) ?? 0, rkb = rank.get(rb) ?? 0;
    if (rka < rkb) parent.set(ra, rb);
    else if (rka > rkb) parent.set(rb, ra);
    else { parent.set(rb, ra); rank.set(ra, rka + 1); }
  }
  for (const n of nodes) { parent.set(n, n); rank.set(n, 0); }
  for (const [node, neighbors] of adjacency) { for (const nb of neighbors) union(node, nb); }
  const groups = new Map<string, string[]>();
  for (const n of nodes) { const root = find(n); const list = groups.get(root) ?? []; list.push(n); groups.set(root, list); }
  return [...groups.values()].filter(g => g.length > 0);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const LANGUAGE_EXTENSIONS: Record<string, string> = {
  rust: '.rs', typescript: '.ts', javascript: '.js', csharp: '.cs',
  python: '.py', go: '.go', java: '.java', kotlin: '.kt',
  swift: '.swift', cpp: '.cpp', c: '.c',
};

function mapSourceToTarget(
  sourcePath: string, targetLanguage: string, outputPath: string, sourceRoot: string,
): string {
  const ext = LANGUAGE_EXTENSIONS[targetLanguage.toLowerCase()] ?? `.${targetLanguage}`;
  let relativePath = sourcePath;
  if (relativePath.startsWith(sourceRoot)) {
    relativePath = relativePath.slice(sourceRoot.length);
    if (relativePath.startsWith('/')) relativePath = relativePath.slice(1);
  }
  const dotIdx = relativePath.lastIndexOf('.');
  const stem = dotIdx >= 0 ? relativePath.slice(0, dotIdx) : relativePath;
  return `${outputPath}/${stem}${ext}`.replace(/\/\//g, '/');
}

function fileBaseName(path: string): string {
  const lastSlash = path.lastIndexOf('/');
  const name = lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
  const dotIdx = name.lastIndexOf('.');
  return dotIdx >= 0 ? name.slice(0, dotIdx) : name;
}

function estimateComplexity(lineCount: number): 'simple' | 'moderate' | 'complex' {
  if (lineCount <= 100) return 'simple';
  if (lineCount <= 300) return 'moderate';
  return 'complex';
}

function describeCluster(cluster: Cluster, fileIdToPath: Map<number, string>): string {
  const files = new Set<string>();
  for (const sym of cluster.symbols) {
    const path = fileIdToPath.get(sym.fileId);
    if (path) files.add(path);
  }
  const fileList = [...files].sort();
  const symNames = cluster.symbols.slice(0, 5).map(s => s.name).join(', ');
  if (fileList.length === 1) {
    return `Migrate ${symNames} from ${fileList[0]}`;
  }
  return `Migrate ${symNames} across ${fileList.length} file(s)`;
}

function buildAcceptanceCriteria(cluster: Cluster): string[] {
  const criteria: string[] = [];
  const symbolNames = cluster.symbols.map(s => s.name).slice(0, 10);
  if (symbolNames.length > 0) {
    criteria.push(`All symbols correctly migrated: ${symbolNames.join(', ')}`);
  }
  criteria.push('Call-site signatures match upstream dependency contracts');
  criteria.push('Target code compiles without type errors');
  return criteria;
}

function buildParityChecks(cluster: Cluster): string[] {
  const checks: string[] = [];
  checks.push('Function signatures preserved across source→target boundary');
  checks.push('All call sites to migrated symbols use correct argument types');
  if (cluster.symbols.some(s => s.kind === 'type' || s.kind === 'class' || s.kind === 'struct')) {
    checks.push('Type definitions preserve public field names and types');
  }
  return checks;
}
