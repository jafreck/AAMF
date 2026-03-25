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
  subflow,
  type FlowDefinition,
  type FlowNode,
  type FlowRunnerOptions,
} from '@cadre-dev/framework/flow';

import type { MigrationFlowContext } from './context.js';
import type { TaskGraphOutput } from './steps/task-graph.js';
import { checkBudget } from './steps/shared.js';

// Step implementations
import { buildKbIndex } from './steps/kb-indexing.js';
import { buildTaskGraphStep } from './steps/task-graph.js';
import { launchKnowledgeBuilder } from './steps/kb-construction.js';
import { launchMigrationPlanner } from './steps/planning.js';
import { buildPhase4Subflow, computePhase4RunnerOptions } from './steps/migration.js';
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
import { resolveLoopMaxIterations } from './iteration-policy.js';

/**
 * Budget gate evaluator — returns true when budget is OK.
 */
function budgetOk(ctx: { context: MigrationFlowContext }): boolean {
  return checkBudget(ctx.context);
}

/**
 * Shared mutable ref for Phase 4 subflow runner options.
 *
 * Because `runnerOptions` on a subflow node is structurally static,
 * but the checkpoint adapter and concurrency must be derived from runtime
 * context, we use a shared object that the `flow` thunk populates before
 * the runner reads it (the thunk always runs first per the runner contract).
 */
const _phase4RunnerOpts: FlowRunnerOptions<MigrationFlowContext> = {};

/**
 * Shared mutable ref for the Phase 7 loop node.
 *
 * As with Phase 4 runner options, the loop bound must be derived from runtime
 * config even though the flow node is declared statically.
 */
const _idiomaticLoopNode = loop<MigrationFlowContext>({
  id: 'idiomatic-loop',
  dependsOn: ['idiomatic-loop-configure'],
  maxIterations: 2,
  do: [
    step<MigrationFlowContext>({
      id: 'idiomatic-iteration',
      run: runIdiomaticReviewIteration,
    }),
  ],
  until: noIdiomaticIssues,
});

/**
 * The AAMF migration pipeline expressed as a declarative flow.
 *
 * All phases are critical — a failure in any phase halts the flow.
 * Step `run()` functions throw {@link MigrationError} on failure.
 *
 *   Phase 0  → KB Indexing (deterministic)
 *   Phase 1  → Task Graph Construction (deterministic)
 *   Phase 2  → Knowledge Base Construction → budget gate
 *   Phase 3  → Migration Strategy → budget gate
 *   Phase 4  → Iterative Migration → budget gate
 *   Phase 5  → Final Parity (loop: check → fix, until no fixes or max 3)
 *   Phase 6  → E2E Testing & Documentation (parallel: suites + docs)
 *   Phase 7  → Idiomatic Refactor (conditional → loop: review → refactor)
 *   Phase 8  → Completion
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

    // ── Phase 2 — Knowledge Base Construction + budget gate ──
    step<MigrationFlowContext>({
      id: 'kb-construction',
      dependsOn: ['task-graph-construction'],
      run: launchKnowledgeBuilder,
    }),
    gate<MigrationFlowContext>({
      id: 'budget-check-2',
      dependsOn: ['kb-construction'],
      evaluate: budgetOk,
    }),

    // ── Phase 3 — Migration Strategy + budget gate ──
    step<MigrationFlowContext>({
      id: 'migration-planning',
      dependsOn: ['budget-check-2'],
      run: launchMigrationPlanner,
    }),
    gate<MigrationFlowContext>({
      id: 'budget-check-3',
      dependsOn: ['migration-planning'],
      evaluate: budgetOk,
    }),

    // ── Phase 4 — Iterative Migration + budget gate ──
    subflow<MigrationFlowContext, MigrationFlowContext>({
      id: 'iterative-migration',
      dependsOn: ['budget-check-3'],
      flow: async (ctx) => {
        // Populate runner options dynamically before the runner reads them
        Object.assign(_phase4RunnerOpts, computePhase4RunnerOptions(ctx.context));
        const taskGraphInput = ctx.getStepOutput<TaskGraphOutput>('task-graph-construction');
        return buildPhase4Subflow(ctx, taskGraphInput);
      },
      contextMap: (ctx) => ctx.context,
      runnerOptions: _phase4RunnerOpts,
    }) as unknown as FlowNode<MigrationFlowContext>,
    gate<MigrationFlowContext>({
      id: 'budget-check-4',
      dependsOn: ['iterative-migration'],
      evaluate: budgetOk,
    }),

    // ── Phase 5 — Final Parity Verification (loopback) ──
    loop<MigrationFlowContext>({
      id: 'final-parity-loop',
      dependsOn: ['budget-check-4'],
      maxIterations: 3,
      do: [
        step<MigrationFlowContext>({
          id: 'final-parity-iteration',
          run: runFinalParityIteration,
        }),
      ],
      until: noFixesNeeded,
    }),

    // ── Phase 6 — E2E Testing & Documentation (parallel) ──
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

    // ── Phase 7 — Idiomatic Refactor (optional, review-refactor loop) ──
    conditional<MigrationFlowContext>({
      id: 'idiomatic-refactor-gate',
      dependsOn: ['finalization'],
      when: (ctx) => ctx.context.config.options.idiomaticRefactor?.enabled === true,
      then: [
        step<MigrationFlowContext>({
          id: 'idiomatic-loop-configure',
          run: async (ctx) => {
            _idiomaticLoopNode.maxIterations = resolveLoopMaxIterations(
              ctx.context.config.options.idiomaticRefactor?.maxIterations,
              2,
            );
            return {
              maxIterations: ctx.context.config.options.idiomaticRefactor?.maxIterations ?? 2,
            };
          },
        }),
        _idiomaticLoopNode,
      ],
    }),

    // ── Phase 8 — Completion ──
    step<MigrationFlowContext>({
      id: 'completion',
      dependsOn: ['idiomatic-refactor-gate'],
      run: finalizeAndReport,
    }),
  ],
  'AAMF migration pipeline — 9 phases (0-8) from KB indexing through completion',
);

/**
 * Map a flow node ID to a phase number for logger.setPhase().
 */
export function nodeIdToPhase(nodeId: string): number {
  const map: Record<string, number> = {
    'kb-index': 0,
    'task-graph-construction': 1,
    'kb-construction': 2,
    'budget-check-2': 2,
    'migration-planning': 3,
    'budget-check-3': 3,
    'iterative-migration': 4,
    'budget-check-4': 4,
    'final-parity-loop': 5,
    'final-parity-iteration': 5,
    'e2e-test-plan': 6,
    'finalization': 6,
    'e2e-suite-writers': 6,
    'documentation-writer': 6,
    'idiomatic-refactor-gate': 7,
    'idiomatic-loop-configure': 7,
    'idiomatic-loop': 7,
    'idiomatic-iteration': 7,
    'completion': 8,
  };
  return map[nodeId] ?? -1;
}

/**
 * Ordered list of phase boundary node IDs for `--phase` filtering.
 * Each entry is the last top-level node ID belonging to that phase.
 */
export const PHASE_BOUNDARY_NODE_IDS: readonly string[] = [
  'kb-index',                // Phase 0
  'task-graph-construction', // Phase 1
  'budget-check-2',         // Phase 2
  'budget-check-3',         // Phase 3
  'budget-check-4',         // Phase 4
  'final-parity-loop',      // Phase 5
  'finalization',           // Phase 6
  'idiomatic-refactor-gate', // Phase 7
  'completion',             // Phase 8
];

/**
 * Build a flow definition truncated to include only phases 0..maxPhase.
 * Used to implement `--phase N` (run/resume up to and including phase N).
 */
export function buildFlowUpToPhase(maxPhase: number): FlowDefinition<MigrationFlowContext> {
  if (maxPhase >= 8) return migrationFlow;

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
