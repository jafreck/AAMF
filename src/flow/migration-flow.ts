/**
 * migration-flow.ts — The declarative migration pipeline.
 *
 * Replaces the imperative MigrationOrchestrator.run() with a single
 * defineFlow() declaration. Phase ordering, budget enforcement,
 * conditional execution, convergence loops, and parallel fan-out are
 * expressed via the @cadre-dev/framework flow DSL.
 */

import {
  defineFlow,
  step,
  gate,
  conditional,
  loop,
  parallel,
  fromStep,
  type FlowDefinition,
  type FlowNode,
} from '@cadre-dev/framework/flow';

import type { MigrationFlowContext } from './context.js';
import type { PhaseResult } from '../agents/types.js';
import { checkBudget } from './steps/shared.js';

// Step implementations
import { buildKbIndex } from './steps/kb-indexing.js';
import { buildTaskGraphStep } from './steps/task-graph.js';
import { launchKnowledgeBuilder } from './steps/kb-construction.js';
import { launchMigrationPlanner } from './steps/planning.js';
import { executeIterativeMigration } from './steps/migration.js';
import {
  runFinalParityIteration,
  noFixesNeeded,
} from './steps/final-parity.js';
import {
  launchE2eTestCrafter,
  launchE2eSuiteWriters,
  launchDocWriter,
} from './steps/finalization.js';
import {
  runIdiomaticReviewIteration,
  noIdiomaticIssues,
} from './steps/idiomatic-refactor.js';
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
 * All phases are critical — a failure in any phase halts the flow.
 * Step `run()` functions throw {@link MigrationError} on failure.
 *
 *   Phase 0  → KB Indexing (deterministic)
 *   Phase 1  → Task Graph Construction (deterministic)
 *   Phase 3  → Knowledge Base Construction → budget gate
 *   Phase 4  → Migration Strategy → budget gate
 *   Phase 5  → Iterative Migration → budget gate
 *   Phase 6  → Final Parity (loop: check → fix, until no fixes or max 3)
 *   Phase 7  → E2E Testing & Documentation (parallel: suites + docs)
 *   Phase 8  → Idiomatic Refactor (conditional → loop: review → refactor)
 *   Phase 9  → Completion
 */
export const migrationFlow: FlowDefinition<MigrationFlowContext> = defineFlow<MigrationFlowContext>(
  'aamf-migration',
  [
    // ── Phase 0 — KB Indexing (deterministic) ──
    step<MigrationFlowContext>({
      id: 'kb-index',
      run: buildKbIndex,
    }),

    // ── Phase 1 — Task Graph Construction (deterministic) ──
    step<MigrationFlowContext>({
      id: 'task-graph-construction',
      dependsOn: ['kb-index'],
      run: buildTaskGraphStep,
    }),

    // ── Phase 3 — Knowledge Base Construction + budget gate ──
    step<MigrationFlowContext>({
      id: 'kb-construction',
      dependsOn: ['task-graph-construction'],
      run: launchKnowledgeBuilder,
    }),
    gate<MigrationFlowContext>({
      id: 'budget-check-3',
      dependsOn: ['kb-construction'],
      evaluate: budgetOk,
    }),

    // ── Phase 4 — Migration Strategy + budget gate ──
    step<MigrationFlowContext>({
      id: 'migration-planning',
      dependsOn: ['budget-check-3'],
      run: launchMigrationPlanner,
    }),
    gate<MigrationFlowContext>({
      id: 'budget-check-4',
      dependsOn: ['migration-planning'],
      evaluate: budgetOk,
    }),

    // ── Phase 5 — Iterative Migration + budget gate ──
    step<MigrationFlowContext>({
      id: 'iterative-migration',
      dependsOn: ['budget-check-4'],
      input: fromStep('task-graph-construction'),
      run: (ctx, input) => executeIterativeMigration(ctx, input as import('./steps/task-graph.js').TaskGraphOutput | undefined),
    }),
    gate<MigrationFlowContext>({
      id: 'budget-check-5',
      dependsOn: ['iterative-migration'],
      evaluate: budgetOk,
    }),

    // ── Phase 6 — Final Parity Verification (loopback) ──
    loop<MigrationFlowContext>({
      id: 'final-parity-loop',
      dependsOn: ['budget-check-5'],
      maxIterations: 3,
      do: [
        step<MigrationFlowContext>({
          id: 'final-parity-iteration',
          run: runFinalParityIteration,
        }),
      ],
      until: noFixesNeeded,
    }),

    // ── Phase 7 — E2E Testing & Documentation (parallel) ──
    step<MigrationFlowContext>({
      id: 'e2e-test-plan',
      dependsOn: ['final-parity-loop'],
      run: launchE2eTestCrafter,
    }),
    parallel<MigrationFlowContext>({
      id: 'finalization',
      dependsOn: ['e2e-test-plan'],
      branches: {
        e2e: [
          step<MigrationFlowContext>({
            id: 'e2e-suite-writers',
            run: launchE2eSuiteWriters,
          }),
        ],
        docs: [
          step<MigrationFlowContext>({
            id: 'documentation-writer',
            run: launchDocWriter,
          }),
        ],
      },
    }),

    // ── Phase 8 — Idiomatic Refactor (optional, review-refactor loop) ──
    conditional<MigrationFlowContext>({
      id: 'idiomatic-refactor-gate',
      dependsOn: ['finalization'],
      when: (ctx) => ctx.context.config.options.idiomaticRefactor?.enabled === true,
      then: [
        loop<MigrationFlowContext>({
          id: 'idiomatic-loop',
          maxIterations: 3,
          do: [
            step<MigrationFlowContext>({
              id: 'idiomatic-iteration',
              run: runIdiomaticReviewIteration,
            }),
          ],
          until: noIdiomaticIssues,
        }),
      ],
    }),

    // ── Phase 9 — Completion ──
    step<MigrationFlowContext>({
      id: 'completion',
      dependsOn: ['idiomatic-refactor-gate'],
      run: finalizeAndReport,
    }),
  ],
  'AAMF migration pipeline — 9 phases (0-1, 3-9) from KB indexing through completion',
);

/**
 * Map a flow node ID to a phase number for logger.setPhase().
 */
export function nodeIdToPhase(nodeId: string): number {
  const map: Record<string, number> = {
    'kb-index': 0,
    'task-graph-construction': 1,
    'kb-construction': 3,
    'budget-check-3': 3,
    'migration-planning': 4,
    'budget-check-4': 4,
    'iterative-migration': 5,
    'budget-check-5': 5,
    'final-parity-loop': 6,
    'final-parity-iteration': 6,
    'e2e-test-plan': 7,
    'finalization': 7,
    'e2e-suite-writers': 7,
    'documentation-writer': 7,
    'idiomatic-refactor-gate': 8,
    'idiomatic-loop': 8,
    'idiomatic-iteration': 8,
    'completion': 9,
  };
  return map[nodeId] ?? -1;
}

/**
 * Ordered list of phase boundary node IDs for `--phase` filtering.
 * Each entry is the last top-level node ID belonging to that phase.
 */
const PHASE_BOUNDARY_NODE_IDS: readonly (string | undefined)[] = [
  'kb-index',                // Phase 0
  'task-graph-construction', // Phase 1
  undefined,               // Phase 2 (removed — impact assessor)
  'budget-check-3',         // Phase 3
  'budget-check-4',         // Phase 4
  'budget-check-5',         // Phase 5
  'final-parity-loop',      // Phase 6
  'finalization',           // Phase 7
  'idiomatic-refactor-gate', // Phase 8
  'completion',             // Phase 9
];

/**
 * Build a flow definition truncated to include only phases 0..maxPhase.
 * Used to implement `--phase N` (run/resume up to and including phase N).
 */
export function buildFlowUpToPhase(maxPhase: number): FlowDefinition<MigrationFlowContext> {
  if (maxPhase >= 9) return migrationFlow;

  const lastNodeId = PHASE_BOUNDARY_NODE_IDS[maxPhase];
  if (!lastNodeId) return migrationFlow;

  const truncated: FlowNode<MigrationFlowContext>[] = [];
  for (const node of migrationFlow.nodes) {
    truncated.push(node);
    if (node.id === lastNodeId) break;
  }

  return defineFlow<MigrationFlowContext>(
    migrationFlow.id,
    truncated,
    migrationFlow.description,
  );
}
