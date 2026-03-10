/**
 * Phase 4 — Migration Strategy (planning + adjudication + scaffold)
 */

import { join } from 'node:path';
import { readdir } from 'node:fs/promises';
import type { FlowExecutionContext } from '@cadre-dev/framework/flow';
import type { MigrationFlowContext } from '../context.js';
import type { PhaseResult, CompilationUnit } from '../../agents/types.js';
import {
  buildInvocation, launchAgentWithEvents, recordTokens, runCommand,
} from './shared.js';
import { ensureDir, fileExists, readJson } from '../../util/fs.js';
import { generateScaffold } from '../../core/scaffold.js';

export async function launchMigrationPlanner(
  flowCtx: FlowExecutionContext<MigrationFlowContext>,
): Promise<PhaseResult> {
  const ctx = flowCtx.context;
  const start = Date.now();
  const planningDir = ctx.paths.artifactsPlanningDir;
  await ensureDir(planningDir);

  const checkpointState = ctx.checkpoint.getState();

  // Step 4a: migration-planner + optional adjudicator
  if (!checkpointState.phase3aComplete) {
    const planContext = await ctx.contextBuilder.buildContext('migration-planner', 4);
    const planInv = buildInvocation(ctx, 'migration-planner', planContext, 4);
    const planResult = await launchAgentWithEvents(ctx, planInv);
    recordTokens(ctx, planResult, 4);

    if (!planResult.success) {
      return {
        phase: 4, name: 'Migration Strategy', success: false, duration: Date.now() - start,
        error: planResult.error, exitCode: planResult.exitCode, stderr: planResult.stderr,
      };
    }

    // Adjudicator
    const adjudicationFile = ctx.paths.competingStrategiesFile;
    if (await fileExists(adjudicationFile)) {
      const adjCtx = await ctx.contextBuilder.buildContext('adjudicator', 4, undefined, {
        competingStrategiesFile: adjudicationFile, decisionType: 'migration-strategy',
      });
      const adjInv = buildInvocation(ctx, 'adjudicator', adjCtx, 4);
      const adjResult = await launchAgentWithEvents(ctx, adjInv);
      recordTokens(ctx, adjResult, 4);
    } else {
      try {
        const planningEntries = await readdir(planningDir);
        const progressEntries = await readdir(ctx.paths.root);
        const hasVariants = [...planningEntries, ...progressEntries]
          .some(name => /^strategy-[a-z0-9_-]+\.md$/i.test(name));
        if (hasVariants) {
          ctx.logger.warn('Detected strategy-* artifacts but missing competing-strategies.md; skipping adjudicator.');
        } else {
          ctx.logger.info('No competing-strategies.md found; adjudicator not invoked.');
        }
      } catch {
        ctx.logger.info('No competing-strategies.md found; adjudicator not invoked.');
      }
    }

    await ctx.checkpoint.completePhase3a();
    ctx.logger.info('Phase 4 step 4a complete: migration-planner wrote strategy');
  } else {
    ctx.logger.info('Resuming Phase 4 — strategy already complete');
  }

  // Step 4b: scaffold
  if (!ctx.checkpoint.getState().scaffoldComplete) {
    const compilationUnitsFile = join(planningDir, 'compilation-units.json');
    if (await fileExists(compilationUnitsFile)) {
      try {
        const units = await readJson<CompilationUnit[]>(compilationUnitsFile);
        if (units.length > 0) {
          ctx.logger.info(`Scaffolding target repo from ${units.length} compilation unit(s)…`);
          const scaffoldResult = await generateScaffold({
            outputPath: ctx.config.target.outputPath,
            targetLanguage: ctx.config.target.language,
            targetFramework: ctx.config.target.framework,
            projectName: ctx.config.projectName,
            compilationUnits: units,
            buildCommand: ctx.config.target.buildCommand,
          }, ctx.logger);
          if (ctx.config.target.buildCommand && scaffoldResult.filesCreated > 0) {
            ctx.logger.info('Verifying scaffold compiles…');
            const buildResult = await runCommand(ctx, 'build', ctx.config.target.buildCommand, 'scaffold-verify');
            if (!buildResult.success) {
              ctx.logger.warn(`Scaffold build verification failed: ${buildResult.error ?? 'unknown'} — proceeding`);
            } else {
              ctx.logger.info('Scaffold builds successfully');
            }
          }
        }
      } catch (err) {
        ctx.logger.warn(`Failed to generate scaffold: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      ctx.logger.info('No compilation-units.json — skipping scaffold');
    }
    await ctx.checkpoint.completeScaffold();
  } else {
    ctx.logger.info('Resuming Phase 4 — scaffold already generated');
  }

  return {
    phase: 4, name: 'Migration Strategy', success: true,
    outputPath: join(planningDir, 'strategy.md'), duration: Date.now() - start,
  };
}

/** Predicate: competing strategies file exists. */
export function hasCompetingStrategies(
  flowCtx: FlowExecutionContext<MigrationFlowContext>,
): boolean {
  // This is checked within launchMigrationPlanner; kept here for flow DSL reference.
  return false;
}
