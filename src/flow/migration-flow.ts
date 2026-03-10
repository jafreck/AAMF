/**
 * migration-flow.ts — The declarative migration pipeline.
 *
 * Replaces the imperative MigrationOrchestrator.run() with a single
 * defineFlow() declaration. All phase ordering, convergence loops,
 * conditional execution, and parallel fan-out are expressed via the
 * @cadre-dev/framework flow DSL.
 */

import {
  defineFlow,
  step,
  gate,
  conditional,
  type FlowDefinition,
} from '@cadre-dev/framework/flow';

import type { MigrationFlowContext } from './context.js';
import type { PhaseResult } from '../agents/types.js';
import { checkBudget } from './steps/shared.js';

// Step implementations
import { buildKbIndex } from './steps/kb-indexing.js';
import { buildTaskGraphStep } from './steps/task-graph.js';
import { launchImpactAssessor } from './steps/impact-assessment.js';
import { launchKnowledgeBuilder } from './steps/kb-construction.js';
import { launchMigrationPlanner } from './steps/planning.js';
import { executeIterativeMigration } from './steps/migration.js';
import { launchFinalParityChecker } from './steps/final-parity.js';
import { launchFinalization } from './steps/finalization.js';
import { launchIdiomaticRefactor } from './steps/idiomatic-refactor.js';
import { finalizeAndReport } from './steps/completion.js';

/**
 * Budget gate evaluator — returns true when budget is OK.
 */
function budgetOk(ctx: { context: MigrationFlowContext }): boolean {
  return checkBudget(ctx.context);
}

/**
 * The AAMF migration pipeline expressed as a declarative flow.
 *
 * Phases 0–9 map directly to flow nodes. The topology reads as a specification:
 *
 *   Phase 0  → KB Indexing (deterministic)
 *   Phase 1  → Task Graph Construction (deterministic)
 *   Phase 2  → Impact Assessment (agentic) → budget gate
 *   Phase 3  → Knowledge Base Construction (agentic) → budget gate
 *   Phase 4  → Migration Strategy (planning + adjudication + scaffold) → budget gate
 *   Phase 5  → Iterative Migration (per-task or wave-barrier) → budget gate
 *   Phase 6  → Final Parity Verification (loopback)
 *   Phase 7  → E2E Testing & Documentation (parallel fan-out)
 *   Phase 8  → Idiomatic Refactor (optional, review-refactor loop)
 *   Phase 9  → Completion
 */
export const migrationFlow: FlowDefinition<MigrationFlowContext> = defineFlow<MigrationFlowContext>(
  'aamf-migration',
  [
    // ── Phase 0 — KB Indexing (deterministic) ──
    step<MigrationFlowContext>({
      id: 'kb-index',
      name: 'Phase 0: KB Indexing',
      run: buildKbIndex,
    }),

    // ── Phase 1 — Task Graph Construction (deterministic) ──
    step<MigrationFlowContext>({
      id: 'task-graph-construction',
      name: 'Phase 1: Task Graph Construction',
      run: buildTaskGraphStep,
    }),

    // ── Phase 2 — Impact Assessment ──
    step<MigrationFlowContext>({
      id: 'impact-assessment',
      name: 'Phase 2: Impact Assessment',
      run: launchImpactAssessor,
    }),
    gate<MigrationFlowContext>({
      id: 'budget-check-2',
      name: 'Budget Gate (Phase 2)',
      evaluate: budgetOk,
    }),

    // ── Phase 3 — Knowledge Base Construction ──
    step<MigrationFlowContext>({
      id: 'kb-construction',
      name: 'Phase 3: Knowledge Base Construction',
      run: launchKnowledgeBuilder,
    }),
    gate<MigrationFlowContext>({
      id: 'budget-check-3',
      name: 'Budget Gate (Phase 3)',
      evaluate: budgetOk,
    }),

    // ── Phase 4 — Migration Strategy ──
    step<MigrationFlowContext>({
      id: 'migration-planning',
      name: 'Phase 4: Migration Strategy',
      run: launchMigrationPlanner,
    }),
    gate<MigrationFlowContext>({
      id: 'budget-check-4',
      name: 'Budget Gate (Phase 4)',
      evaluate: budgetOk,
    }),

    // ── Phase 5 — Iterative Migration ──
    step<MigrationFlowContext>({
      id: 'iterative-migration',
      name: 'Phase 5: Iterative Migration',
      run: executeIterativeMigration,
    }),
    gate<MigrationFlowContext>({
      id: 'budget-check-5',
      name: 'Budget Gate (Phase 5)',
      evaluate: budgetOk,
    }),

    // ── Phase 6 — Final Parity Verification ──
    step<MigrationFlowContext>({
      id: 'final-parity-checker',
      name: 'Phase 6: Final Parity Verification',
      run: launchFinalParityChecker,
    }),

    // ── Phase 7 — E2E Testing & Documentation ──
    step<MigrationFlowContext>({
      id: 'finalization',
      name: 'Phase 7: E2E Testing & Documentation',
      run: launchFinalization,
    }),

    // ── Phase 8 — Idiomatic Refactor (optional) ──
    conditional<MigrationFlowContext>({
      id: 'idiomatic-refactor-gate',
      name: 'Phase 8: Idiomatic Refactor (conditional)',
      when: (ctx) => ctx.context.config.options.idiomaticRefactor?.enabled === true,
      then: [
        step<MigrationFlowContext>({
          id: 'idiomatic-refactor',
          name: 'Phase 8: Idiomatic Refactor',
          run: launchIdiomaticRefactor,
        }),
      ],
    }),

    // ── Phase 9 — Completion ──
    step<MigrationFlowContext>({
      id: 'completion',
      name: 'Phase 9: Completion',
      run: finalizeAndReport,
    }),
  ],
  'AAMF migration pipeline — 10 phases (0-9) from KB indexing through completion',
);
