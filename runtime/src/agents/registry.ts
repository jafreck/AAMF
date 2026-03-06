/**
 * @module agents/registry
 *
 * Canonical single source of truth for all agent metadata in the AAMF system.
 * Combines agent names, output schemas, phase membership, and agent file
 * conventions that were previously scattered across types.ts, result-parser.ts,
 * phase-registry.ts, and claude-agent-definitions.test.ts.
 */
import { z } from 'zod';
import {
  AamfOutputBase,
} from './agent-output-schemas.js';
import type { AgentName } from './types.js';

// ─── Registry Entry ──────────────────────────────────────────────────────────

export interface AgentRegistryEntry {
  /** Canonical agent name (must match the AgentName union). */
  name: AgentName;
  /** Zod schema for validating the agent's aamf-json output block. */
  outputSchema: z.ZodTypeAny;
  /** Phase IDs where this agent participates. */
  phases: readonly number[];
  /**
   * Agent definition filename convention (without extension).
   * Defaults to the agent name if not specified.
   */
  agentFile?: string;
}

// ─── Per-Agent Output Schema Extensions ──────────────────────────────────────
// These extend AamfOutputBase with agent-specific fields.

const MigrationOrchestratorSchema = AamfOutputBase.extend({ agent: z.literal('migration-orchestrator') });
const ImpactAssessorSchema = AamfOutputBase.extend({ agent: z.literal('impact-assessor') });
const KnowledgeBuilderSchema = AamfOutputBase.extend({ agent: z.literal('knowledge-builder') });
const MigrationPlannerSchema = AamfOutputBase.extend({ agent: z.literal('migration-planner') });
const TaskDecomposerSchema = AamfOutputBase.extend({
  agent: z.literal('task-decomposer'),
  outputFiles: z.array(z.string().min(1)).min(1),
  taskCount: z.number().int().nonnegative().optional(),
  tasks: z.never().optional(),
});
const AdjudicatorSchema = AamfOutputBase.extend({ agent: z.literal('adjudicator') });
const CodeMigratorSchema = AamfOutputBase.extend({ agent: z.literal('code-migrator') });
const ParityVerifierSchema = AamfOutputBase.extend({ agent: z.literal('parity-verifier') });
const TestWriterSchema = AamfOutputBase.extend({ agent: z.literal('test-writer') });
const FailureAdjudicatorSchema = AamfOutputBase.extend({
  agent: z.enum(['failure-adjudicator', 'failure-recovery']),
}).transform((data) => ({ ...data, agent: 'failure-adjudicator' as const }));
const FinalParityCheckerSchema = AamfOutputBase.extend({
  agent: z.literal('final-parity-checker'),
  fixes: z.array(z.object({
    description: z.string().min(1),
    sourceFile: z.string().min(1),
    targetFile: z.string().min(1),
  })).optional(),
});
const E2eTestCrafterSchema = AamfOutputBase.extend({ agent: z.literal('e2e-test-crafter') });
const DocumentationWriterSchema = AamfOutputBase.extend({ agent: z.literal('documentation-writer') });
const MigrationRunnerSchema = AamfOutputBase.extend({ agent: z.literal('migration-runner') });
const IdiomaticReviewerSchema = AamfOutputBase.extend({
  agent: z.literal('idiomatic-reviewer'),
  issues: z.array(z.object({
    file: z.string().min(1),
    issue: z.string().min(1),
    suggestion: z.string().min(1),
  })).optional(),
});
const IdiomaticRefactorerSchema = AamfOutputBase.extend({ agent: z.literal('idiomatic-refactorer') });

// ─── The Registry ────────────────────────────────────────────────────────────

/**
 * Single source of truth for all agent metadata.
 *
 * Usage:
 * - Derive `AgentName` union values: `Object.keys(AGENT_REGISTRY)`
 * - Derive per-phase agent lists: `getAgentsForPhase(phaseId)`
 * - Look up output schemas: `AGENT_REGISTRY['code-migrator'].outputSchema`
 * - Validate agent file existence: iterate entries and check `agentFile ?? name`
 */
export const AGENT_REGISTRY: Record<AgentName, AgentRegistryEntry> = {
  'migration-orchestrator': {
    name: 'migration-orchestrator',
    outputSchema: MigrationOrchestratorSchema,
    phases: [],
  },
  'impact-assessor': {
    name: 'impact-assessor',
    outputSchema: ImpactAssessorSchema,
    phases: [1],
  },
  'knowledge-builder': {
    name: 'knowledge-builder',
    outputSchema: KnowledgeBuilderSchema,
    phases: [2],
  },
  'migration-planner': {
    name: 'migration-planner',
    outputSchema: MigrationPlannerSchema,
    phases: [3],
  },
  'task-decomposer': {
    name: 'task-decomposer',
    outputSchema: TaskDecomposerSchema,
    phases: [3],
  },
  'adjudicator': {
    name: 'adjudicator',
    outputSchema: AdjudicatorSchema,
    phases: [3],
  },
  'code-migrator': {
    name: 'code-migrator',
    outputSchema: CodeMigratorSchema,
    phases: [4],
  },
  'parity-verifier': {
    name: 'parity-verifier',
    outputSchema: ParityVerifierSchema,
    phases: [4],
  },
  'test-writer': {
    name: 'test-writer',
    outputSchema: TestWriterSchema,
    phases: [4],
  },
  'failure-adjudicator': {
    name: 'failure-adjudicator',
    outputSchema: FailureAdjudicatorSchema,
    phases: [4],
  },
  'final-parity-checker': {
    name: 'final-parity-checker',
    outputSchema: FinalParityCheckerSchema,
    phases: [5],
  },
  'e2e-test-crafter': {
    name: 'e2e-test-crafter',
    outputSchema: E2eTestCrafterSchema,
    phases: [6],
  },
  'documentation-writer': {
    name: 'documentation-writer',
    outputSchema: DocumentationWriterSchema,
    phases: [6],
  },
  'migration-runner': {
    name: 'migration-runner',
    outputSchema: MigrationRunnerSchema,
    phases: [],
  },
  'idiomatic-reviewer': {
    name: 'idiomatic-reviewer',
    outputSchema: IdiomaticReviewerSchema,
    phases: [8],
  },
  'idiomatic-refactorer': {
    name: 'idiomatic-refactorer',
    outputSchema: IdiomaticRefactorerSchema,
    phases: [8],
  },
};

/** All registered agent names (derived from the registry). */
export const ALL_AGENT_NAMES = Object.keys(AGENT_REGISTRY) as AgentName[];

/** Get agents that participate in a given phase. */
export function getAgentsForPhase(phaseId: number): AgentName[] {
  return ALL_AGENT_NAMES.filter(name => AGENT_REGISTRY[name].phases.includes(phaseId));
}

/** Get the output schema for a given agent. */
export function getOutputSchema(agent: AgentName): z.ZodTypeAny {
  return AGENT_REGISTRY[agent].outputSchema;
}

// ─── Re-exports for backward compatibility ───────────────────────────────────
// These named schema exports preserve the existing public API from result-parser.ts
// so that existing imports continue to work during transition.

export {
  MigrationOrchestratorSchema as MigrationOrchestratorOutput,
  ImpactAssessorSchema as ImpactAssessorOutput,
  KnowledgeBuilderSchema as KnowledgeBuilderOutput,
  MigrationPlannerSchema as MigrationPlannerOutput,
  TaskDecomposerSchema as TaskDecomposerOutput,
  AdjudicatorSchema as AdjudicatorOutput,
  CodeMigratorSchema as CodeMigratorOutput,
  ParityVerifierSchema as ParityVerifierOutput,
  TestWriterSchema as TestWriterOutput,
  FailureAdjudicatorSchema as FailureAdjudicatorOutput,
  FailureAdjudicatorSchema as FailureRecoveryOutput,
  FinalParityCheckerSchema as FinalParityCheckerOutput,
  E2eTestCrafterSchema as E2eTestCrafterOutput,
  DocumentationWriterSchema as DocumentationWriterOutput,
  MigrationRunnerSchema as MigrationRunnerOutput,
  IdiomaticReviewerSchema as IdiomaticReviewerOutput,
  IdiomaticRefactorerSchema as IdiomaticRefactorerOutput,
};
