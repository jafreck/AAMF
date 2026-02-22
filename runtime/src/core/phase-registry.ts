import { AgentName } from '../agents/types.js';

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
}

/** The 7 ordered migration phases */
export const PHASES: readonly PhaseDefinition[] = [
  {
    id: 1,
    name: 'Impact Assessment',
    description: 'Analyze source codebase to determine migration scope, complexity, and risks',
    agents: ['impact-assessor'],
    critical: true,
    parallel: false,
  },
  {
    id: 2,
    name: 'Knowledge Base Construction',
    description: 'Build comprehensive documentation of all source code modules, dependencies, and patterns',
    agents: ['knowledge-builder', 'large-file-analyzer'],
    critical: true,
    parallel: true,   // multiple large-file-analyzer instances can run in parallel
  },
  {
    id: 3,
    name: 'Migration Planning',
    description: 'Create detailed migration plan with task breakdown, dependencies, and ordering',
    agents: ['migration-planner', 'adjudicator'],
    critical: true,
    parallel: false,
  },
  {
    id: 4,
    name: 'Iterative Migration',
    description: 'Execute migration tasks: code migration, parity verification, test writing',
    agents: ['code-migrator', 'parity-verifier', 'test-writer', 'failure-recovery'],
    critical: true,
    parallel: false,  // tasks are serial but sub-tasks (parity+test) can overlap
  },
  {
    id: 5,
    name: 'Final Parity Verification',
    description: 'Comprehensive parity check across the entire migrated codebase',
    agents: ['final-parity-checker'],
    critical: false,  // issues trigger loop-back, not abort
    parallel: false,
  },
  {
    id: 6,
    name: 'E2E Testing & Documentation',
    description: 'Create end-to-end tests and comprehensive migration documentation',
    agents: ['e2e-test-crafter', 'documentation-writer'],
    critical: false,
    parallel: true,  // e2e tests and docs can be written in parallel
  },
  {
    id: 7,
    name: 'Completion',
    description: 'Final summary and migration report',
    agents: [],
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
