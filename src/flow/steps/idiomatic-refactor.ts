/**
 * Phase 7 — Idiomatic Refactor (task-graph approach, scalable)
 *
 * 1. Chunked review: parallel idiomatic-reviewers scoped to compilation units.
 * 2. Planning: idiomatic-planner constructs a dependency-ordered task graph.
 * 3. Parallel execution: idiomatic-refactorer runs for independent tasks concurrently.
 *
 * Findings and tasks are stored as sidecar artifact files to keep
 * checkpoint saves constant-size at any codebase scale.
 */

import { join } from 'node:path';
import type { FlowExecutionContext } from '@cadre-dev/framework/flow';
import type { MigrationFlowContext } from '../context.js';
import type { PhaseResult, CompilationUnit } from '../../agents/types.js';
import { ParallelExecutor } from '../../execution/parallel-executor.js';
import { readJson, writeJson, fileExists } from '../../util/fs.js';
import {
  buildInvocation, launchAgentWithEvents, recordTokens,
  commitForAgent, runCommand,
  getPhase7Cursor, savePhase7Cursor,
  assertPhaseSuccess,
} from './shared.js';

// ─── Types ──────────────────────────────────────────────────────────────────

interface IdiomaticIssue {
  file: string;
  location: string;
  category?: string;
  issue: string;
  suggestion: string;
  details?: string;
  relatedFiles?: string[];
}

interface IdiomaticTask {
  id: string;
  name: string;
  description: string;
  files: string[];
  issues: Array<{ file: string; location: string; issue: string; suggestion: string }>;
  dependencies: string[];
}

// ─── Artifact Helpers ───────────────────────────────────────────────────────

function reviewArtifactPath(ctx: MigrationFlowContext): string {
  return join(ctx.paths.artifactsPlanningDir, 'idiomatic-review.json');
}

function taskArtifactPath(ctx: MigrationFlowContext): string {
  return join(ctx.paths.artifactsPlanningDir, 'idiomatic-tasks.json');
}

async function loadIssuesFromArtifact(ctx: MigrationFlowContext): Promise<IdiomaticIssue[]> {
  const path = reviewArtifactPath(ctx);
  if (!(await fileExists(path))) return [];
  return readJson<IdiomaticIssue[]>(path);
}

async function loadTasksFromArtifact(ctx: MigrationFlowContext): Promise<IdiomaticTask[]> {
  const path = taskArtifactPath(ctx);
  if (!(await fileExists(path))) return [];
  return readJson<IdiomaticTask[]>(path);
}

// ─── Compilation Unit Discovery ─────────────────────────────────────────────

async function loadCompilationUnits(ctx: MigrationFlowContext): Promise<CompilationUnit[]> {
  const cuPath = join(ctx.paths.artifactsPlanningDir, 'compilation-units.json');
  if (!(await fileExists(cuPath))) return [];
  try {
    return await readJson<CompilationUnit[]>(cuPath);
  } catch {
    return [];
  }
}

/**
 * Build review chunks from compilation units. Each chunk scopes a reviewer
 * to the target files belonging to one compilation unit.
 * Falls back to a single "all files" chunk when no units are available.
 */
function buildReviewChunks(
  units: CompilationUnit[],
): Array<{ id: string; name: string; targetPath: string }> {
  if (units.length === 0) {
    return [{ id: 'all', name: 'full codebase', targetPath: '.' }];
  }
  return units.map(u => ({
    id: u.id,
    name: u.name,
    targetPath: u.targetPath,
  }));
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Run the full Phase 7 idiomatic refactor pipeline:
 * chunked review → plan → parallel execute.
 */
export async function runIdiomaticRefactorPipeline(
  flowCtx: FlowExecutionContext<MigrationFlowContext>,
): Promise<{ tasksCompleted: number }> {
  const ctx = flowCtx.context;
  const cursor = getPhase7Cursor(ctx);
  const start = Date.now();
  const concurrency = ctx.config.options.maxParallelAgents ?? 3;

  // ── Step 1: Chunked Parallel Review ──────────────────────────────────────

  let issues: IdiomaticIssue[];

  if (cursor.lastSuccessfulStep === 'plan-complete' ||
      cursor.lastSuccessfulStep === 'task-complete' ||
      cursor.lastSuccessfulStep === 'review-complete') {
    issues = await loadIssuesFromArtifact(ctx);
    ctx.logger.info(`Resuming Phase 7 with ${issues.length} issue(s) from artifact`);
  } else {
    const units = await loadCompilationUnits(ctx);
    const chunks = buildReviewChunks(units);

    ctx.logger.info(`Phase 7 review: ${chunks.length} chunk(s) with concurrency ${concurrency}`);

    const reviewExecutor = new ParallelExecutor(
      concurrency,
      (inv) => launchAgentWithEvents(ctx, inv),
      ctx.logger,
    );

    // Build invocations — one reviewer per chunk with scoped payload
    const reviewInvocations = await Promise.all(
      chunks.map(async (chunk) => {
        const reviewCtx = await ctx.contextBuilder.buildContext(
          'idiomatic-reviewer', 7, chunk.id,
          { scope: { unitId: chunk.id, unitName: chunk.name, targetPath: chunk.targetPath } },
        );
        return buildInvocation(ctx, 'idiomatic-reviewer', reviewCtx, 7, chunk.id);
      }),
    );

    const reviewResults = await reviewExecutor.executeAll(reviewInvocations);
    ctx.peakConcurrency = Math.max(ctx.peakConcurrency, reviewExecutor.peakConcurrency);

    // Merge all findings
    issues = [];
    for (let i = 0; i < reviewResults.length; i++) {
      const result = reviewResults[i]!;
      recordTokens(ctx, result, 7);
      if (!result.success) {
        ctx.logger.warn(`Idiomatic review failed for chunk ${chunks[i]!.id}: ${result.error ?? 'unknown'} — skipping`);
        continue;
      }
      if (result.extensions.outputParsed && Array.isArray(result.extensions.structuredOutput?.['issues'])) {
        const chunkIssues = result.extensions.structuredOutput['issues'] as IdiomaticIssue[];
        issues.push(...chunkIssues);
      } else {
        ctx.logger.warn(`No structured output from reviewer for chunk ${chunks[i]!.id}`);
      }
    }

    if (issues.length === 0) {
      ctx.logger.info('Idiomatic review found no issues — skipping refactor');
      await savePhase7Cursor(ctx, { iteration: 0, issueIndex: 0, lastSuccessfulStep: 'no-issues' });
      return { tasksCompleted: 0 };
    }

    // Deduplicate issues by file+location
    const seen = new Set<string>();
    issues = issues.filter(issue => {
      const key = `${issue.file}:${issue.location}:${issue.issue}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    ctx.logger.info(`Idiomatic review found ${issues.length} issue(s) across ${new Set(issues.map(i => i.file)).size} file(s)`);

    // Write to sidecar artifact (not inline in checkpoint)
    await writeJson(reviewArtifactPath(ctx), issues);
    await savePhase7Cursor(ctx, {
      iteration: 0, issueIndex: 0,
      lastSuccessfulStep: 'review-complete',
      reviewArtifact: reviewArtifactPath(ctx),
    });
  }

  // ── Step 2: Task Graph Construction ──────────────────────────────────────

  let tasks: IdiomaticTask[];

  if (cursor.lastSuccessfulStep === 'task-complete' && cursor.taskArtifact) {
    tasks = await loadTasksFromArtifact(ctx);
    const completedSet = new Set(cursor.completedTaskIds ?? []);
    ctx.logger.info(`Resuming Phase 7 execution: ${tasks.length} task(s), ${completedSet.size} completed`);
  } else if (cursor.lastSuccessfulStep === 'plan-complete' && cursor.taskArtifact) {
    tasks = await loadTasksFromArtifact(ctx);
    ctx.logger.info(`Resuming Phase 7 from plan: ${tasks.length} task(s)`);
  } else {
    const planCtx = await ctx.contextBuilder.buildContext('idiomatic-planner', 7, undefined, {
      reviewFindings: { issues },
    });
    const planInv = buildInvocation(ctx, 'idiomatic-planner', planCtx, 7);
    const planResult = await launchAgentWithEvents(ctx, planInv);
    recordTokens(ctx, planResult, 7);

    if (!planResult.success) {
      const failResult: PhaseResult = {
        phase: 7, name: 'Idiomatic Refactor', success: false,
        duration: Date.now() - start, error: planResult.error,
        exitCode: planResult.exitCode ?? undefined, stderr: planResult.stderr,
      };
      assertPhaseSuccess(failResult);
    }

    if (planResult.extensions.outputParsed && Array.isArray(planResult.extensions.structuredOutput?.['tasks'])) {
      tasks = planResult.extensions.structuredOutput['tasks'] as IdiomaticTask[];
    } else {
      ctx.logger.warn('Idiomatic-planner structured output unavailable');
      const failResult: PhaseResult = {
        phase: 7, name: 'Idiomatic Refactor', success: false,
        duration: Date.now() - start, error: 'No structured tasks output',
      };
      assertPhaseSuccess(failResult);
      return { tasksCompleted: 0 }; // unreachable
    }

    if (tasks.length === 0) {
      ctx.logger.info('Idiomatic planner produced no tasks — skipping refactor');
      await savePhase7Cursor(ctx, { iteration: 0, issueIndex: 0, lastSuccessfulStep: 'no-tasks' });
      return { tasksCompleted: 0 };
    }

    tasks = topologicalSort(tasks, ctx);
    ctx.logger.info(`Idiomatic planner constructed ${tasks.length} task(s) in dependency order`);

    await writeJson(taskArtifactPath(ctx), tasks);
    await savePhase7Cursor(ctx, {
      iteration: 0, issueIndex: 0,
      lastSuccessfulStep: 'plan-complete',
      reviewArtifact: reviewArtifactPath(ctx),
      taskArtifact: taskArtifactPath(ctx),
      completedTaskIds: [],
    });
  }

  // ── Step 3: Execute Tasks (parallel where independent) ───────────────────

  const completedTaskIds = new Set<string>(cursor.completedTaskIds ?? []);
  const remaining = tasks.filter(t => !completedTaskIds.has(t.id));

  if (remaining.length === 0) {
    ctx.logger.info('All idiomatic tasks already completed');
    return { tasksCompleted: tasks.length };
  }

  ctx.logger.info(`Executing ${remaining.length} idiomatic task(s) with concurrency ${concurrency}`);

  // Group into waves: a wave contains all tasks whose dependencies are met.
  // Execute each wave in parallel, then advance to the next wave.
  const taskMap = new Map(tasks.map(t => [t.id, t]));
  let completed = new Set(completedTaskIds);
  let totalCompleted = completed.size;

  while (true) {
    // Find tasks whose dependencies are all satisfied
    const ready = tasks.filter(t =>
      !completed.has(t.id) &&
      t.dependencies.every(dep => completed.has(dep) || !taskMap.has(dep)),
    );

    if (ready.length === 0) {
      // Check if we still have unfinished tasks (cycle or unresolvable deps)
      const unfinished = tasks.filter(t => !completed.has(t.id));
      if (unfinished.length > 0) {
        ctx.logger.warn(`${unfinished.length} idiomatic task(s) have unresolvable dependencies — skipping`);
      }
      break;
    }

    ctx.logger.info(`Idiomatic wave: ${ready.length} task(s) ready for parallel execution`);

    const waveExecutor = new ParallelExecutor(
      concurrency,
      (inv) => launchAgentWithEvents(ctx, inv),
      ctx.logger,
    );

    const waveInvocations = await Promise.all(
      ready.map(async (task) => {
        const refactorCtx = await ctx.contextBuilder.buildContext(
          'idiomatic-refactorer', 7, task.id, { task },
        );
        return buildInvocation(ctx, 'idiomatic-refactorer', refactorCtx, 7, task.id);
      }),
    );

    const waveResults = await waveExecutor.executeAll(waveInvocations);
    ctx.peakConcurrency = Math.max(ctx.peakConcurrency, waveExecutor.peakConcurrency);

    for (let i = 0; i < waveResults.length; i++) {
      const task = ready[i]!;
      const result = waveResults[i]!;
      recordTokens(ctx, result, 7);

      if (result.success) {
        if (ctx.config.target.formatCommand) {
          const fmtResult = await runCommand(ctx, 'format', ctx.config.target.formatCommand, `phase7-${task.id}`);
          if (!fmtResult.success) ctx.logger.warn(`Phase 7 format failed for ${task.id}: ${fmtResult.error ?? 'unknown'}`);
        }
        await commitForAgent(ctx, 'idiomatic-refactorer', 7, task.id, task.name);
        ctx.logger.info(`Completed idiomatic task ${task.id}: ${task.name}`);
      } else {
        ctx.logger.warn(`Idiomatic refactorer failed for task ${task.id}: ${result.error ?? 'unknown'} — skipping`);
      }

      completed.add(task.id);
      totalCompleted++;

      // Persist progress after each task
      await savePhase7Cursor(ctx, {
        iteration: 0, issueIndex: totalCompleted,
        lastSuccessfulStep: 'task-complete',
        reviewArtifact: reviewArtifactPath(ctx),
        taskArtifact: taskArtifactPath(ctx),
        completedTaskIds: [...completed],
      });
    }
  }

  ctx.logger.info(`Phase 7 complete: ${totalCompleted} idiomatic refactoring task(s) executed`);
  return { tasksCompleted: totalCompleted };
}

// ─── Topological Sort ───────────────────────────────────────────────────────

/**
 * Sort tasks in topological order based on their declared dependencies.
 * Tasks with unknown dependency IDs have those dependencies silently dropped.
 * If a cycle is detected, tasks are returned in declaration order with a warning.
 */
function topologicalSort(
  tasks: IdiomaticTask[],
  ctx: MigrationFlowContext,
): IdiomaticTask[] {
  const taskMap = new Map(tasks.map(t => [t.id, t]));
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const sorted: IdiomaticTask[] = [];

  function visit(id: string): boolean {
    if (visited.has(id)) return true;
    if (visiting.has(id)) return false; // cycle
    visiting.add(id);
    const task = taskMap.get(id);
    if (!task) return true;
    for (const dep of task.dependencies) {
      if (!taskMap.has(dep)) continue; // unknown dep — skip
      if (!visit(dep)) {
        ctx.logger.warn(`Cycle detected in idiomatic task graph involving ${id} → ${dep}`);
        return false;
      }
    }
    visiting.delete(id);
    visited.add(id);
    sorted.push(task);
    return true;
  }

  let hasCycle = false;
  for (const task of tasks) {
    if (!visit(task.id)) {
      hasCycle = true;
      break;
    }
  }

  if (hasCycle) {
    ctx.logger.warn('Cycle in idiomatic task graph — falling back to declaration order');
    return tasks;
  }

  return sorted;
}
