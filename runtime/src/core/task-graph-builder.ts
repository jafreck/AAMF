/**
 * Deterministic symbol-graph-based task decomposition for AAMF.
 *
 * Replaces LLM-driven structural decomposition (Phase 3b task-decomposer
 * agents) with a deterministic algorithm that reads the Lore knowledge-base
 * SQLite DB, splits source files into tasks respecting `maxLinesPerTask`,
 * builds symbol-level dependency edges from `call_refs`, and detects SCCs
 * for two-pass scaffold execution.
 *
 * @module core/task-graph-builder
 */

import type { MigrationTask } from '../agents/types.js';

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
}

export interface TaskGraphResult {
  /** Fully-connected migration tasks with symbol-level dependency edges. */
  tasks: MigrationTask[];
  /** Strongly-connected components with >1 member (cyclic deps requiring two-pass execution). */
  sccs: string[][];
}

/**
 * Build a complete task graph from the Lore knowledge-base.
 *
 * 1. Opens the KB read-only
 * 2. Lists all source files and symbols
 * 3. Splits files into tasks respecting maxLinesPerTask (at symbol boundaries)
 * 4. Builds symbol → task mapping
 * 5. Queries call_refs for dependency edges
 * 6. Detects SCCs via Tarjan's algorithm
 */
export async function buildTaskGraph(options: TaskGraphBuilderOptions): Promise<TaskGraphResult> {
  const { kbDbPath, sourceRoot, maxLinesPerTask, targetLanguage, outputPath } = options;

  // Dynamic import — Lore is an ESM-only dependency
  const lore = await import('@aamf/lore');
  const db = lore.openReadOnly(kbDbPath);

  try {
    // 1. List all indexed source files
    const files = lore.listFiles(db);
    if (files.length === 0) {
      return { tasks: [], sccs: [] };
    }

    // 2. List all symbols, grouped by file_id
    const allSymbols = lore.listSymbols(db, { limit: 100_000 });
    const symbolsByFileId = new Map<number, SymbolInfo[]>();
    for (const sym of allSymbols) {
      const list = symbolsByFileId.get(sym.file_id) ?? [];
      list.push({
        id: sym.id,
        name: sym.name,
        kind: sym.kind,
        fileId: sym.file_id,
        startLine: sym.start_line,
        endLine: sym.end_line,
      });
      symbolsByFileId.set(sym.file_id, list);
    }

    // 3. Split files into tasks
    const tasks: MigrationTask[] = [];
    const symbolToTask = new Map<number, string>(); // symbol.id → task.id
    const fileIdToTasks = new Map<number, TaskChunk[]>(); // file_id → chunks

    for (let fileIdx = 0; fileIdx < files.length; fileIdx++) {
      const file = files[fileIdx]!;
      const fileSymbols = symbolsByFileId.get(file.id) ?? [];
      // Sort symbols by start line for stable splitting
      fileSymbols.sort((a, b) => a.startLine - b.startLine);

      const chunks = splitFileIntoChunks(fileIdx, file, fileSymbols, maxLinesPerTask);
      fileIdToTasks.set(file.id, chunks);

      for (const chunk of chunks) {
        const taskId = chunk.taskId;
        const targetFile = mapSourceToTarget(file.path, targetLanguage, outputPath, sourceRoot);

        const task: MigrationTask = {
          id: taskId,
          name: chunk.name,
          sourceFiles: [file.path],
          targetFiles: [targetFile],
          knowledgeBaseRef: `kb/${file.path}`,
          dependencies: [], // populated in step 5
          complexity: estimateComplexity(chunk.lineCount),
          description: chunk.description,
          acceptanceCriteria: buildAcceptanceCriteria(chunk),
          parityChecks: buildParityChecks(chunk),
          ...(chunk.lineRange ? { lineRange: chunk.lineRange } : {}),
        };

        tasks.push(task);

        // Map every symbol in this chunk to the task ID
        for (const sym of chunk.symbols) {
          symbolToTask.set(sym.id, taskId);
        }
      }
    }

    // 4. Build symbol name → task mapping for callee resolution
    const symbolNameToTaskIds = new Map<string, Set<string>>();
    for (const sym of allSymbols) {
      const taskId = symbolToTask.get(sym.id);
      if (!taskId) continue;
      const existing = symbolNameToTaskIds.get(sym.name) ?? new Set();
      existing.add(taskId);
      symbolNameToTaskIds.set(sym.name, existing);
    }

    // 5. Query symbol_refs and build dependency edges
    const callRefs = querySymbolRefs(db);
    const taskDeps = new Map<string, Set<string>>(); // taskId → set of dependency taskIds

    for (const ref of callRefs) {
      // Find which task the caller symbol belongs to
      const callerTaskId = resolveSymbolToTask(ref, fileIdToTasks, symbolToTask);
      if (!callerTaskId) continue;

      // Resolve the callee_name text to a known symbol name → task
      const calleeTaskIds = symbolNameToTaskIds.get(ref.calleeName);
      if (!calleeTaskIds) continue;

      for (const calleeTaskId of calleeTaskIds) {
        // Skip self-references
        if (calleeTaskId === callerTaskId) continue;

        const deps = taskDeps.get(callerTaskId) ?? new Set();
        deps.add(calleeTaskId);
        taskDeps.set(callerTaskId, deps);
      }
    }

    // Populate dependency arrays on tasks
    const taskMap = new Map(tasks.map(t => [t.id, t]));
    for (const [taskId, deps] of taskDeps) {
      const task = taskMap.get(taskId);
      if (task) {
        task.dependencies = [...deps].sort();
      }
    }

    // 6. Detect SCCs using Tarjan's algorithm
    const allTaskIds = tasks.map(t => t.id);
    const adjacency = new Map<string, string[]>();
    for (const t of tasks) {
      adjacency.set(t.id, t.dependencies);
    }
    const sccs = findSCCs(allTaskIds, adjacency);

    return { tasks, sccs };
  } finally {
    db.close();
  }
}

// ─── Internal Types ─────────────────────────────────────────────────────────

interface SymbolInfo {
  id: number;
  name: string;
  kind: string;
  fileId: number;
  startLine: number;
  endLine: number;
}

interface TaskChunk {
  taskId: string;
  name: string;
  description: string;
  symbols: SymbolInfo[];
  lineCount: number;
  lineRange?: { start: number; end: number };
}

interface CallRefRow {
  callerSymbolId: number;
  callerFileId: number;
  callerStartLine: number;
  callerEndLine: number;
  calleeName: string;
}

// ─── File Splitting ──────────────────────────────────────────────────────────

/**
 * Split a single source file into one or more task chunks, respecting the
 * maxLinesPerTask limit.  Splits happen at symbol boundaries to avoid cutting
 * a function in half.
 */
function splitFileIntoChunks(
  fileIndex: number,
  file: { id: number; path: string },
  symbols: SymbolInfo[],
  maxLinesPerTask: number,
): TaskChunk[] {
  // Compute approximate file size from symbol range (or assume small if no symbols)
  const maxEndLine = symbols.length > 0
    ? Math.max(...symbols.map(s => s.endLine))
    : 0;

  // If file fits in one task, return a single chunk
  if (maxEndLine <= maxLinesPerTask || symbols.length === 0) {
    return [{
      taskId: `task-${fileIndex}-0`,
      name: fileBaseName(file.path),
      description: `Migrate ${file.path}`,
      symbols: [...symbols],
      lineCount: maxEndLine || maxLinesPerTask,
      // No lineRange for whole-file tasks
    }];
  }

  // Split at symbol boundaries
  const chunks: TaskChunk[] = [];
  let chunkIndex = 0;
  let currentSymbols: SymbolInfo[] = [];
  let chunkStartLine = 1;

  for (const sym of symbols) {
    currentSymbols.push(sym);

    // Check if adding this symbol pushes past the limit
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

  // Flush remaining symbols
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

  // Edge case: if no chunks were created (all symbols fit in one), wrap as single
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

// ─── Symbol-Ref Query ────────────────────────────────────────────────────────

/**
 * Query the symbol_refs table joined with symbols to get caller file/line info.
 */
function querySymbolRefs(db: import('better-sqlite3').Database): CallRefRow[] {
  const stmt = db.prepare(`
    SELECT s.id AS caller_symbol_id, s.file_id, s.start_line, s.end_line, sr.callee_name
    FROM symbol_refs sr
    JOIN symbols s ON sr.caller_id = s.id
  `);
  const rows = stmt.all() as Array<{
    caller_symbol_id: number;
    file_id: number;
    start_line: number;
    end_line: number;
    callee_name: string;
  }>;

  return rows.map(r => ({
    callerSymbolId: r.caller_symbol_id,
    callerFileId: r.file_id,
    callerStartLine: r.start_line,
    callerEndLine: r.end_line,
    calleeName: r.callee_name,
  }));
}

/**
 * Resolve a call-ref's caller symbol to the task ID that contains it.
 */
function resolveSymbolToTask(
  ref: CallRefRow,
  fileIdToTasks: Map<number, TaskChunk[]>,
  symbolToTask: Map<number, string>,
): string | undefined {
  // Fast path: direct symbol → task mapping
  const direct = symbolToTask.get(ref.callerSymbolId);
  if (direct) return direct;

  // Fallback: match by file_id + line range
  const chunks = fileIdToTasks.get(ref.callerFileId);
  if (!chunks) return undefined;

  for (const chunk of chunks) {
    if (chunk.lineRange) {
      if (ref.callerStartLine >= chunk.lineRange.start && ref.callerEndLine <= chunk.lineRange.end) {
        return chunk.taskId;
      }
    } else {
      // Whole-file chunk — any symbol in this file belongs to this task
      return chunk.taskId;
    }
  }
  return undefined;
}

// ─── SCC Detection (Tarjan's Algorithm) ──────────────────────────────────────

/**
 * Find all strongly-connected components with more than one member.
 * These represent cyclic dependency groups requiring two-pass execution.
 */
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

    const successors = adjacency.get(v) ?? [];
    for (const w of successors) {
      if (!indices.has(w)) {
        strongconnect(w);
        lowlinks.set(v, Math.min(lowlinks.get(v)!, lowlinks.get(w)!));
      } else if (onStack.has(w)) {
        lowlinks.set(v, Math.min(lowlinks.get(v)!, indices.get(w)!));
      }
    }

    // Root of an SCC
    if (lowlinks.get(v) === indices.get(v)) {
      const scc: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);

      // Only return SCCs with >1 member (non-trivial cycles)
      if (scc.length > 1) {
        result.push(scc);
      }
    }
  }

  for (const id of nodeIds) {
    if (!indices.has(id)) {
      strongconnect(id);
    }
  }

  return result;
}

// ─── Target Path Mapping ────────────────────────────────────────────────────

/** Map of target language identifiers to file extensions. */
const LANGUAGE_EXTENSIONS: Record<string, string> = {
  rust: '.rs',
  typescript: '.ts',
  javascript: '.js',
  csharp: '.cs',
  python: '.py',
  go: '.go',
  java: '.java',
  kotlin: '.kt',
  swift: '.swift',
  cpp: '.cpp',
  c: '.c',
};

/**
 * Map a source file path to the corresponding target file path.
 *
 * Replaces the source extension with the target language extension and
 * prefixes with the output directory.
 */
function mapSourceToTarget(
  sourcePath: string,
  targetLanguage: string,
  outputPath: string,
  sourceRoot: string,
): string {
  const ext = LANGUAGE_EXTENSIONS[targetLanguage.toLowerCase()] ?? `.${targetLanguage}`;

  // Strip sourceRoot prefix if the path is absolute or starts with it
  let relativePath = sourcePath;
  if (relativePath.startsWith(sourceRoot)) {
    relativePath = relativePath.slice(sourceRoot.length);
    if (relativePath.startsWith('/')) relativePath = relativePath.slice(1);
  }

  // Replace extension
  const dotIdx = relativePath.lastIndexOf('.');
  const stem = dotIdx >= 0 ? relativePath.slice(0, dotIdx) : relativePath;

  // Join with outputPath
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

  // Core criterion: all symbols in the chunk must be correctly migrated
  const symbolNames = chunk.symbols.map(s => s.name).slice(0, 10);
  if (symbolNames.length > 0) {
    criteria.push(`All exported symbols correctly migrated: ${symbolNames.join(', ')}`);
  }

  // Call-site correctness for upstream dependencies
  criteria.push('Call-site signatures match upstream dependency contracts');

  // Type safety
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
