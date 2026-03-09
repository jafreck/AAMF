/**
 * Deterministic symbol-graph-based task decomposition for AAMF.
 *
 * Reads the Lore knowledge-base SQLite DB, splits source files into tasks
 * respecting `maxLinesPerTask`, builds dependency edges from both `symbol_refs`
 * (function calls) and `type_refs` (type usage), detects SCCs, and optionally
 * assigns tasks to agent-defined compilation units.
 *
 * @module core/task-graph-builder
 */

import type { MigrationTask, CompilationUnit } from '../agents/types.js';

// ─── Public API ──────────────────────────────────────────────────────────────

export interface TaskGraphBuilderOptions {
  /** Absolute path to the Lore knowledge-base SQLite file (kb.db). */
  kbDbPath: string;
  /** Absolute path to the source project root. */
  sourceRoot: string;
  /** Maximum source lines allowed per task — larger files are split at symbol boundaries. */
  maxLinesPerTask: number;
  /** Target language identifier (e.g. "rust", "typescript", "csharp"). */
  targetLanguage: string;
  /** Target output directory (mirrors the source tree). */
  outputPath: string;
  /**
   * Optional compilation units from the migration-planner.
   * When provided, tasks are annotated with their unit ID and cross-unit
   * dependencies are validated against the actual symbol graph.
   */
  compilationUnits?: CompilationUnit[];
}

export interface TaskGraphResult {
  /** Fully-connected migration tasks with symbol-level dependency edges. */
  tasks: MigrationTask[];
  /** Strongly-connected components with >1 member (cyclic deps requiring two-pass execution). */
  sccs: string[][];
  /** Compilation units with validated cross-unit dependency ordering. */
  compilationUnits: CompilationUnit[];
}

/**
 * Structured dependency summary computed deterministically from the Lore KB.
 * Passed to the migration-planner agent so it can make informed compilation-unit
 * grouping decisions.
 */
export interface DependencySummary {
  /** Total number of indexed source files. */
  fileCount: number;
  /** Total source lines across all files (approximate from symbol ranges). */
  totalLines: number;
  /** Per-file dependency edges. */
  fileDependencies: Record<string, {
    calls: string[];
    calledBy: string[];
    usesTypes: string[];
    typesUsedBy: string[];
  }>;
  /** Per-file metrics. */
  fileMetrics: Record<string, { lines: number; symbolCount: number; complexity: string }>;
  /** Weakly-connected components of the dependency graph (natural module clusters). */
  connectedComponents: Array<{ files: string[]; totalLines: number }>;
  /** Strongly-connected components (cyclic dependency groups) at file level. */
  sccs: string[][];
}

/**
 * Build a structured dependency summary from the Lore KB for the planner agent.
 */
export async function buildDependencySummary(kbDbPath: string): Promise<DependencySummary> {
  const lore = await import('@aamf/lore');
  const db = lore.openReadOnly(kbDbPath);

  try {
    const files = lore.listFiles(db);
    const allSymbols = lore.listSymbols(db, { limit: 100_000 });

    const fileIdToPath = new Map<number, string>();
    for (const f of files) fileIdToPath.set(f.id, f.path);

    const symbolsByFileId = new Map<number, Array<{ startLine: number; endLine: number }>>();
    for (const sym of allSymbols) {
      const list = symbolsByFileId.get(sym.file_id) ?? [];
      list.push({ startLine: sym.start_line, endLine: sym.end_line });
      symbolsByFileId.set(sym.file_id, list);
    }

    // symbol name → set of file_ids that define it
    const symbolNameToFileIds = new Map<string, Set<number>>();
    for (const sym of allSymbols) {
      const set = symbolNameToFileIds.get(sym.name) ?? new Set();
      set.add(sym.file_id);
      symbolNameToFileIds.set(sym.name, set);
    }

    const callEdges = querySymbolRefs(db);
    const typeEdges = queryTypeRefs(db);

    // Build file-level adjacency
    type DepEntry = { calls: Set<string>; calledBy: Set<string>; usesTypes: Set<string>; typesUsedBy: Set<string> };
    const fileDeps = new Map<string, DepEntry>();
    const ensureEntry = (path: string): DepEntry => {
      let e = fileDeps.get(path);
      if (!e) { e = { calls: new Set(), calledBy: new Set(), usesTypes: new Set(), typesUsedBy: new Set() }; fileDeps.set(path, e); }
      return e;
    };
    for (const f of files) ensureEntry(f.path);

    for (const ref of callEdges) {
      const callerPath = fileIdToPath.get(ref.callerFileId);
      if (!callerPath) continue;
      const calleeFileIds = symbolNameToFileIds.get(ref.calleeName);
      if (!calleeFileIds) continue;
      for (const calleeFileId of calleeFileIds) {
        if (calleeFileId === ref.callerFileId) continue;
        const calleePath = fileIdToPath.get(calleeFileId);
        if (!calleePath) continue;
        ensureEntry(callerPath).calls.add(calleePath);
        ensureEntry(calleePath).calledBy.add(callerPath);
      }
    }

    for (const ref of typeEdges) {
      const userPath = fileIdToPath.get(ref.fileId);
      if (!userPath) continue;
      const definerFileIds = symbolNameToFileIds.get(ref.typeName);
      if (!definerFileIds) continue;
      for (const definerFileId of definerFileIds) {
        if (definerFileId === ref.fileId) continue;
        const definerPath = fileIdToPath.get(definerFileId);
        if (!definerPath) continue;
        ensureEntry(userPath).usesTypes.add(definerPath);
        ensureEntry(definerPath).typesUsedBy.add(userPath);
      }
    }

    // File metrics
    const fileMetrics: Record<string, { lines: number; symbolCount: number; complexity: string }> = {};
    let totalLines = 0;
    for (const f of files) {
      const syms = symbolsByFileId.get(f.id) ?? [];
      const maxLine = syms.length > 0 ? Math.max(...syms.map(s => s.endLine)) : 0;
      totalLines += maxLine;
      fileMetrics[f.path] = {
        lines: maxLine,
        symbolCount: syms.length,
        complexity: maxLine <= 100 ? 'simple' : maxLine <= 300 ? 'moderate' : 'complex',
      };
    }

    // Connected components (undirected)
    const allPaths = files.map(f => f.path);
    const undirectedAdj = new Map<string, Set<string>>();
    for (const p of allPaths) undirectedAdj.set(p, new Set());
    for (const [path, deps] of fileDeps) {
      for (const target of [...deps.calls, ...deps.usesTypes]) {
        undirectedAdj.get(path)?.add(target);
        undirectedAdj.get(target)?.add(path);
      }
    }
    const ccs = findConnectedComponents(allPaths, undirectedAdj);
    const ccResults = ccs.map(cc => ({
      files: cc,
      totalLines: cc.reduce((sum, p) => sum + (fileMetrics[p]?.lines ?? 0), 0),
    }));

    // File-level SCCs
    const directedAdj = new Map<string, string[]>();
    for (const [path, deps] of fileDeps) {
      directedAdj.set(path, [...deps.calls, ...deps.usesTypes]);
    }
    const fileSCCs = findSCCs(allPaths, directedAdj);

    // Serialize
    const serializedDeps: DependencySummary['fileDependencies'] = {};
    for (const [path, deps] of fileDeps) {
      serializedDeps[path] = {
        calls: [...deps.calls].sort(),
        calledBy: [...deps.calledBy].sort(),
        usesTypes: [...deps.usesTypes].sort(),
        typesUsedBy: [...deps.typesUsedBy].sort(),
      };
    }

    return {
      fileCount: files.length,
      totalLines,
      fileDependencies: serializedDeps,
      fileMetrics,
      connectedComponents: ccResults,
      sccs: fileSCCs,
    };
  } finally {
    db.close();
  }
}

/**
 * Build a complete task graph from the Lore knowledge-base.
 *
 * 1. Opens the KB read-only
 * 2. Lists all source files and symbols
 * 3. Splits files into tasks respecting maxLinesPerTask (at symbol boundaries)
 * 4. Builds symbol → task mapping
 * 5. Queries symbol_refs AND type_refs for dependency edges
 * 6. Optionally annotates tasks with compilation unit IDs
 * 7. Validates cross-unit dependencies against actual edges
 * 8. Detects SCCs via Tarjan's algorithm
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

    // Build file path → compilation unit mapping
    const fileToUnit = new Map<string, string>();
    if (compilationUnits) {
      for (const unit of compilationUnits) {
        for (const sf of unit.sourceFiles) fileToUnit.set(sf, unit.id);
      }
    }

    const allSymbols = lore.listSymbols(db, { limit: 100_000 });
    const symbolsByFileId = new Map<number, SymbolInfo[]>();
    for (const sym of allSymbols) {
      const list = symbolsByFileId.get(sym.file_id) ?? [];
      list.push({
        id: sym.id, name: sym.name, kind: sym.kind,
        fileId: sym.file_id, startLine: sym.start_line, endLine: sym.end_line,
      });
      symbolsByFileId.set(sym.file_id, list);
    }

    // 3. Split files into tasks
    const tasks: MigrationTask[] = [];
    const symbolToTask = new Map<number, string>();
    const fileIdToTasks = new Map<number, TaskChunk[]>();

    for (let fileIdx = 0; fileIdx < files.length; fileIdx++) {
      const file = files[fileIdx]!;
      const fileSymbols = symbolsByFileId.get(file.id) ?? [];
      fileSymbols.sort((a, b) => a.startLine - b.startLine);

      const chunks = splitFileIntoChunks(fileIdx, file, fileSymbols, maxLinesPerTask);
      fileIdToTasks.set(file.id, chunks);

      const unitId = fileToUnit.get(file.path);

      for (const chunk of chunks) {
        const targetFile = mapSourceToTarget(file.path, targetLanguage, outputPath, sourceRoot);
        const task: MigrationTask = {
          id: chunk.taskId,
          name: chunk.name,
          sourceFiles: [file.path],
          targetFiles: [targetFile],
          knowledgeBaseRef: `kb/${file.path}`,
          dependencies: [],
          complexity: estimateComplexity(chunk.lineCount),
          description: chunk.description,
          acceptanceCriteria: buildAcceptanceCriteria(chunk),
          parityChecks: buildParityChecks(chunk),
          ...(chunk.lineRange ? { lineRange: chunk.lineRange } : {}),
          ...(unitId ? { compilationUnit: unitId } : {}),
        };
        tasks.push(task);
        for (const sym of chunk.symbols) symbolToTask.set(sym.id, chunk.taskId);
      }
    }

    // 4. symbol name → task IDs
    const symbolNameToTaskIds = new Map<string, Set<string>>();
    for (const sym of allSymbols) {
      const taskId = symbolToTask.get(sym.id);
      if (!taskId) continue;
      const set = symbolNameToTaskIds.get(sym.name) ?? new Set();
      set.add(taskId);
      symbolNameToTaskIds.set(sym.name, set);
    }

    // 5. Query symbol_refs AND type_refs
    const callRefs = querySymbolRefs(db);
    const typeRefs = queryTypeRefs(db);
    const taskDeps = new Map<string, Set<string>>();

    const addDep = (from: string, to: string) => {
      if (from === to) return;
      const set = taskDeps.get(from) ?? new Set();
      set.add(to);
      taskDeps.set(from, set);
    };

    for (const ref of callRefs) {
      const callerTaskId = resolveSymbolToTask(ref, fileIdToTasks, symbolToTask);
      if (!callerTaskId) continue;
      const calleeTaskIds = symbolNameToTaskIds.get(ref.calleeName);
      if (!calleeTaskIds) continue;
      for (const cid of calleeTaskIds) addDep(callerTaskId, cid);
    }

    for (const ref of typeRefs) {
      const userTaskId = resolveTypeRefToTask(ref, fileIdToTasks);
      if (!userTaskId) continue;
      const definerTaskIds = symbolNameToTaskIds.get(ref.typeName);
      if (!definerTaskIds) continue;
      for (const did of definerTaskIds) addDep(userTaskId, did);
    }

    const taskMap = new Map(tasks.map(t => [t.id, t]));
    for (const [taskId, deps] of taskDeps) {
      const task = taskMap.get(taskId);
      if (task) task.dependencies = [...deps].sort();
    }

    // 6. Validate compilation units
    const validatedUnits = validateCompilationUnits(tasks, compilationUnits ?? []);

    // 7. Detect SCCs
    const adjacency = new Map<string, string[]>();
    for (const t of tasks) adjacency.set(t.id, t.dependencies);
    const sccs = findSCCs(tasks.map(t => t.id), adjacency);

    return { tasks, sccs, compilationUnits: validatedUnits };
  } finally {
    db.close();
  }
}

// ─── Internal Types ─────────────────────────────────────────────────────────

interface SymbolInfo {
  id: number; name: string; kind: string;
  fileId: number; startLine: number; endLine: number;
}

interface TaskChunk {
  taskId: string; name: string; description: string;
  symbols: SymbolInfo[]; lineCount: number;
  lineRange?: { start: number; end: number };
}

interface CallRefRow {
  callerSymbolId: number; callerFileId: number;
  callerStartLine: number; callerEndLine: number;
  calleeName: string;
}

interface TypeRefRow {
  fileId: number; symbolId: number | null;
  typeName: string; refLine: number;
}

// ─── File Splitting ──────────────────────────────────────────────────────────

function splitFileIntoChunks(
  fileIndex: number,
  file: { id: number; path: string },
  symbols: SymbolInfo[],
  maxLinesPerTask: number,
): TaskChunk[] {
  const maxEndLine = symbols.length > 0
    ? Math.max(...symbols.map(s => s.endLine)) : 0;

  if (maxEndLine <= maxLinesPerTask || symbols.length === 0) {
    return [{
      taskId: `task-${fileIndex}-0`,
      name: fileBaseName(file.path),
      description: `Migrate ${file.path}`,
      symbols: [...symbols],
      lineCount: maxEndLine || maxLinesPerTask,
    }];
  }

  const chunks: TaskChunk[] = [];
  let chunkIndex = 0;
  let currentSymbols: SymbolInfo[] = [];
  let chunkStartLine = 1;

  for (const sym of symbols) {
    currentSymbols.push(sym);
    const chunkEndLine = sym.endLine;
    const chunkLines = chunkEndLine - chunkStartLine + 1;

    if (chunkLines >= maxLinesPerTask && currentSymbols.length > 0) {
      chunks.push({
        taskId: `task-${fileIndex}-${chunkIndex}`,
        name: `${fileBaseName(file.path)} (part ${chunkIndex + 1})`,
        description: `Migrate ${file.path} lines ${chunkStartLine}-${chunkEndLine}`,
        symbols: [...currentSymbols],
        lineCount: chunkLines,
        lineRange: { start: chunkStartLine, end: chunkEndLine },
      });
      chunkIndex++;
      chunkStartLine = chunkEndLine + 1;
      currentSymbols = [];
    }
  }

  if (currentSymbols.length > 0) {
    const chunkEndLine = currentSymbols[currentSymbols.length - 1]!.endLine;
    chunks.push({
      taskId: `task-${fileIndex}-${chunkIndex}`,
      name: `${fileBaseName(file.path)} (part ${chunkIndex + 1})`,
      description: `Migrate ${file.path} lines ${chunkStartLine}-${chunkEndLine}`,
      symbols: [...currentSymbols],
      lineCount: chunkEndLine - chunkStartLine + 1,
      lineRange: { start: chunkStartLine, end: chunkEndLine },
    });
  }

  if (chunks.length === 0) {
    return [{
      taskId: `task-${fileIndex}-0`,
      name: fileBaseName(file.path),
      description: `Migrate ${file.path}`,
      symbols: [...symbols],
      lineCount: maxEndLine,
    }];
  }

  return chunks;
}

// ─── Ref Queries ─────────────────────────────────────────────────────────────

function querySymbolRefs(db: import('better-sqlite3').Database): CallRefRow[] {
  const rows = db.prepare(`
    SELECT s.id AS caller_symbol_id, s.file_id, s.start_line, s.end_line, sr.callee_name
    FROM symbol_refs sr JOIN symbols s ON sr.caller_id = s.id
  `).all() as Array<{
    caller_symbol_id: number; file_id: number;
    start_line: number; end_line: number; callee_name: string;
  }>;
  return rows.map(r => ({
    callerSymbolId: r.caller_symbol_id, callerFileId: r.file_id,
    callerStartLine: r.start_line, callerEndLine: r.end_line,
    calleeName: r.callee_name,
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

function resolveSymbolToTask(
  ref: CallRefRow,
  fileIdToTasks: Map<number, TaskChunk[]>,
  symbolToTask: Map<number, string>,
): string | undefined {
  const direct = symbolToTask.get(ref.callerSymbolId);
  if (direct) return direct;
  const chunks = fileIdToTasks.get(ref.callerFileId);
  if (!chunks) return undefined;
  for (const chunk of chunks) {
    if (chunk.lineRange) {
      if (ref.callerStartLine >= chunk.lineRange.start && ref.callerEndLine <= chunk.lineRange.end)
        return chunk.taskId;
    } else {
      return chunk.taskId;
    }
  }
  return undefined;
}

function resolveTypeRefToTask(
  ref: TypeRefRow,
  fileIdToTasks: Map<number, TaskChunk[]>,
): string | undefined {
  const chunks = fileIdToTasks.get(ref.fileId);
  if (!chunks) return undefined;
  for (const chunk of chunks) {
    if (chunk.lineRange) {
      if (ref.refLine >= chunk.lineRange.start && ref.refLine <= chunk.lineRange.end)
        return chunk.taskId;
    } else {
      return chunk.taskId;
    }
  }
  return undefined;
}

// ─── Compilation Unit Validation ─────────────────────────────────────────────

/**
 * Validate agent-declared compilation unit dependencies against actual
 * task-level edges.  Adds missing cross-unit dependencies.
 */
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

// ─── Target Path Mapping ────────────────────────────────────────────────────

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

// ─── Helpers ────────────────────────────────────────────────────────────────

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

function buildAcceptanceCriteria(chunk: TaskChunk): string[] {
  const criteria: string[] = [];
  const symbolNames = chunk.symbols.map(s => s.name).slice(0, 10);
  if (symbolNames.length > 0) {
    criteria.push(`All exported symbols correctly migrated: ${symbolNames.join(', ')}`);
  }
  criteria.push('Call-site signatures match upstream dependency contracts');
  criteria.push('Target code compiles without type errors');
  return criteria;
}

function buildParityChecks(chunk: TaskChunk): string[] {
  const checks: string[] = [];
  checks.push('Function signatures preserved across source→target boundary');
  checks.push('All call sites to migrated symbols use correct argument types');
  if (chunk.symbols.some(s => s.kind === 'type' || s.kind === 'class' || s.kind === 'struct')) {
    checks.push('Type definitions preserve public field names and types');
  }
  return checks;
}
