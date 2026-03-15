/**
 * Phase 1 — Task Graph Construction (deterministic)
 *
 * Builds the dependency-aware task graph from the Lore KB using symbol-graph
 * analysis. Persists tasks, SCCs, and compilation units as JSON artifacts.
 */

import { join } from 'node:path';
import type { FlowExecutionContext } from '@cadre-dev/framework/flow';
import type { MigrationFlowContext } from '../context.js';
import type { PhaseResult, MigrationTask, CompilationUnit } from '../../agents/types.js';
import { fileExists, atomicWrite, ensureDir, readJson } from '../../util/fs.js';
import { assertPhaseSuccess } from './shared.js';
import { buildTaskGraph, buildDependencySummary } from '../../core/task-graph-builder.js';

/** Extended PhaseResult that carries the structured task graph data for downstream steps. */
export interface TaskGraphOutput extends PhaseResult {
  tasks: MigrationTask[];
  sccs: string[][];
  compilationUnits: CompilationUnit[];
}

export async function buildTaskGraphStep(
  flowCtx: FlowExecutionContext<MigrationFlowContext>,
): Promise<TaskGraphOutput> {
  const ctx = flowCtx.context;
  const start = Date.now();
  const planningDir = ctx.paths.artifactsPlanningDir;
  const mergedTasksFile = join(planningDir, 'tasks-merged.json');
  await ensureDir(planningDir);

  // Resume path
  if (await fileExists(mergedTasksFile)) {
    ctx.logger.info('Phase 1: loading existing tasks-merged.json (prior run)');
    const allTasks = await readJson<MigrationTask[]>(mergedTasksFile);
    let taskGraphSCCs: string[][] = [];
    const sccsFile = join(planningDir, 'sccs.json');
    if (await fileExists(sccsFile)) {
      try { taskGraphSCCs = await readJson<string[][]>(sccsFile); } catch { /* ignore */ }
    }
    let compilationUnits: CompilationUnit[] = [];
    const compilationUnitsFile = join(planningDir, 'compilation-units.json');
    if (await fileExists(compilationUnitsFile)) {
      try { compilationUnits = await readJson<CompilationUnit[]>(compilationUnitsFile); } catch { /* ignore */ }
    }
    ctx.phase1TaskGraphResult = {
      agent: 'migration-planner', exitCode: 0, success: true,
      outputFiles: [mergedTasksFile], duration: Date.now() - start,
      outputParsed: true,
      structuredOutput: { tasks: allTasks, sccs: taskGraphSCCs, compilationUnits },
    };
    return {
      phase: 1, name: 'Task Graph Construction', success: true,
      outputPath: mergedTasksFile, duration: Date.now() - start,
      tasks: allTasks, sccs: taskGraphSCCs, compilationUnits,
    };
  }

  // Verify KB exists
  if (!(await fileExists(ctx.paths.kbDbFile))) {
    const failResultNoKb: TaskGraphOutput = {
      phase: 1, name: 'Task Graph Construction', success: false, duration: Date.now() - start,
      error: 'Lore KB database (kb.db) not found — Phase 0 must complete first',
      tasks: [], sccs: [], compilationUnits: [],
    };
    assertPhaseSuccess(failResultNoKb);
    return failResultNoKb;
  }

  // Dependency summary
  const depSummaryFile = ctx.paths.dependencySummaryFile;
  if (!(await fileExists(depSummaryFile))) {
    ctx.logger.info('Computing dependency summary from Lore KB…');
    try {
      const depSummary = await buildDependencySummary(ctx.paths.kbDbFile, ctx.config.options.maxLinesPerTask);
      await atomicWrite(depSummaryFile, JSON.stringify(depSummary, null, 2));
      ctx.logger.info(
        `Dependency summary: ${depSummary.fileCount} files, ${depSummary.totalLines} lines, ` +
        `${depSummary.connectedComponents.length} CC(s), ${depSummary.sccs.length} SCC(s)`,
      );
    } catch (err) {
      ctx.logger.warn(`Failed to compute dependency summary: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Build task graph
  ctx.logger.info('Phase 1: building task graph from Lore KB');
  try {
    const graphResult = await buildTaskGraph({
      kbDbPath: ctx.paths.kbDbFile,
      sourceRoot: ctx.config.source.path,
      maxLinesPerTask: ctx.config.options.maxLinesPerTask,
      targetLanguage: ctx.config.target.language,
      outputPath: ctx.config.target.outputPath,
    });
    const allTasks = graphResult.tasks;
    const taskGraphSCCs = graphResult.sccs;
    const compilationUnits = graphResult.compilationUnits;

    if (taskGraphSCCs.length > 0) {
      ctx.logger.info(`Detected ${taskGraphSCCs.length} SCC(s) with cyclic deps`);
    }
    ctx.logger.info(
      `Task graph built: ${allTasks.length} task(s) with ${allTasks.reduce((n, t) => n + t.dependencies.length, 0)} dependency edge(s)`,
    );

    await atomicWrite(mergedTasksFile, JSON.stringify(allTasks, null, 2));
    const sccsFile = join(planningDir, 'sccs.json');
    if (taskGraphSCCs.length > 0) {
      await atomicWrite(sccsFile, JSON.stringify(taskGraphSCCs, null, 2));
      ctx.logger.info(`Persisted ${taskGraphSCCs.length} SCC(s) → ${sccsFile}`);
    }
    const compilationUnitsFile = join(planningDir, 'compilation-units.json');
    if (compilationUnits.length > 0) {
      await atomicWrite(compilationUnitsFile, JSON.stringify(compilationUnits, null, 2));
      ctx.logger.info(`Persisted ${compilationUnits.length} compilation unit(s)`);
    }

    ctx.phase1TaskGraphResult = {
      agent: 'migration-planner', exitCode: 0, success: true,
      outputFiles: [mergedTasksFile], duration: Date.now() - start,
      outputParsed: true,
      structuredOutput: { tasks: allTasks, sccs: taskGraphSCCs, compilationUnits },
    };

    return {
      phase: 1, name: 'Task Graph Construction', success: true,
      outputPath: mergedTasksFile, duration: Date.now() - start,
      tasks: allTasks, sccs: taskGraphSCCs, compilationUnits,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.logger.error(`Failed to build task graph: ${msg}`);
    const failResultBuild: TaskGraphOutput = { phase: 1, name: 'Task Graph Construction', success: false, duration: Date.now() - start, error: `Lore task-graph build failed: ${msg}`, tasks: [], sccs: [], compilationUnits: [] };
    assertPhaseSuccess(failResultBuild);
    return failResultBuild;
  }
}
