import { AgentName } from '../agents/types.js';
import { getAgentsForPhase } from '../agents/registry.js';

/** Defines a single phase in the migration pipeline */
export interface PhaseDefinition {
  id: number;
  name: string;
  description: string;
  /** Primary agents used in this phase */
  agents: AgentName[];
  /** Whether failure in this phase aborts the migration */
  critical: boolean;
  /** Whether agents in this phase can run in parallel */
  parallel: boolean;
  /** Whether this phase is optional (skipped unless explicitly enabled) */
  optional?: boolean;
}

/**
 * Ordered migration phases.
 *
 * Deterministic phases run first (0–1) so the task graph is available
 * before any agent launches.  Agentic phases follow (2–9).
 */
export const PHASES: readonly PhaseDefinition[] = [
  // ── Deterministic block (no agents) ──────────────────────────────────
  {
    id: 0,
    name: 'KB Indexing',
    description: 'Build a local knowledge-base index of the source codebase via Lore',
    agents: getAgentsForPhase(0),
    critical: true,
    parallel: false,
  },
  {
    id: 1,
    name: 'Task Graph Construction',
    description: 'Build the deterministic task graph, dependency summary, and compilation units from the Lore KB',
    agents: [],  // purely deterministic — no agent
    critical: true,
    parallel: false,
  },
  // ── Agentic block ────────────────────────────────────────────────────
  {
    id: 2,
    name: 'Impact Assessment',
    description: 'Analyze source codebase to determine migration scope, complexity, and risks',
    agents: getAgentsForPhase(2),
    critical: true,
    parallel: false,
  },
  {
    id: 3,
    name: 'Knowledge Base Construction',
    description: 'Build high-level architecture, risk, and integration documentation for migration planning',
    agents: getAgentsForPhase(3),
    critical: true,
    parallel: false,
  },
  {
    id: 4,
    name: 'Migration Strategy',
    description: 'Create migration strategy, adjudicate competing approaches, and refine the task graph',
    agents: getAgentsForPhase(4),
    critical: true,
    parallel: false,
  },
  {
    id: 5,
    name: 'Iterative Migration',
    description: 'Execute migration tasks: code migration, parity verification, and test writing in per-task or wave-barrier mode',
    agents: getAgentsForPhase(5),
    critical: true,
    parallel: false,  // tasks are serial but sub-tasks (parity+test) can overlap
  },
  {
    id: 6,
    name: 'Final Parity Verification',
    description: 'Comprehensive parity check across the entire migrated codebase',
    agents: getAgentsForPhase(6),
    critical: false,  // issues trigger loop-back, not abort
    parallel: false,
  },
  {
    id: 7,
    name: 'E2E Testing & Documentation',
    description: 'Create end-to-end tests and comprehensive migration documentation',
    agents: getAgentsForPhase(7),
    critical: false,
    parallel: true,  // e2e tests and docs can be written in parallel
  },
  {
    id: 8,
    name: 'Idiomatic Refactor',
    description: 'Review and refactor migrated code to use idiomatic patterns for the target language',
    agents: getAgentsForPhase(8),
    critical: false,
    parallel: false,
    optional: true,
  },
  {
    id: 9,
    name: 'Completion',
    description: 'Final summary and migration report',
    agents: getAgentsForPhase(9),
    critical: false,
    parallel: false,
  },
] as const;

/** Get a phase definition by ID */
export function getPhase(id: number): PhaseDefinition | undefined {
  return PHASES.find(p => p.id === id);
}

/** Get remaining phases from a given starting phase */
export function getRemainingPhases(fromPhase: number): PhaseDefinition[] {
  return PHASES.filter(p => p.id >= fromPhase);
}
