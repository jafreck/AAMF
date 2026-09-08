import { MAX_PHASE } from './phases.js';

/** Stable node-to-phase metadata shared without importing any flow definition. */
export const NODE_PHASES: Readonly<Record<string, number>> = {
  'kb-index': 0,
  'task-graph-construction': 1,
  'kb-construction': 2,
  'budget-check-2': 2,
  'migration-planning': 3,
  'budget-check-3': 3,
  'iterative-migration': 4,
  'phase-4-teardown': 4,
  'budget-check-4': 4,
  'final-parity-loop': 5,
  'final-parity-iteration': 5,
  'final-parity-convergence-gate': 5,
  'e2e-test-plan': 6,
  finalization: 6,
  'e2e-suite-writers': 6,
  'documentation-writer': 6,
  'phase-6-promote': 6,
  'idiomatic-refactor-gate': 7,
  'idiomatic-refactor-pipeline': 7,
  completion: 8,
};

export const PHASE_NAMES: readonly string[] = [
  'KB Indexing',
  'Task Graph Construction',
  'Knowledge Base Construction',
  'Migration Strategy',
  'Iterative Migration',
  'Final Parity Verification',
  'E2E Testing & Documentation',
  'Idiomatic Refactor',
  'Completion',
];

/** Last top-level node in each numbered phase. */
export const PHASE_BOUNDARY_NODE_IDS: readonly string[] = [
  'kb-index',
  'task-graph-construction',
  'budget-check-2',
  'budget-check-3',
  'budget-check-4',
  'final-parity-convergence-gate',
  'phase-6-promote',
  'idiomatic-refactor-gate',
  'completion',
];

export function nodeIdToPhase(nodeId: string): number {
  return NODE_PHASES[nodeId] ?? -1;
}

export { MAX_PHASE };
