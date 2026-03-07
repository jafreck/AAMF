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
  /** Human-readable description of the agent's purpose. */
  description: string;
  /** Title-case display name used in Copilot front matter. */
  displayName: string;
  /** Zod schema for validating the agent's aamf-json output block. */
  outputSchema: z.ZodTypeAny;
  /** Phase IDs where this agent participates. */
  phases: readonly number[];
  /** Tool names for Copilot (GitHub) front matter. */
  copilotTools: readonly string[];
  /** Tool names for Claude Code front matter. */
  claudeTools: readonly string[];
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
/** Default Claude Code tools shared by all agents. */
const CLAUDE_TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'] as const;

export const AGENT_REGISTRY: Record<AgentName, AgentRegistryEntry> = {
  'migration-orchestrator': {
    name: 'migration-orchestrator',
    displayName: 'Migration Orchestrator',
    description: 'Coordinates all phases of a large-scale legacy codebase migration with checkpointing and resume capability.',
    outputSchema: MigrationOrchestratorSchema,
    phases: [],
    copilotTools: ['read', 'edit', 'search', 'execute'],
    claudeTools: CLAUDE_TOOLS,
  },
  'impact-assessor': {
    name: 'impact-assessor',
    displayName: 'Impact Assessor',
    description: 'Analyzes a legacy codebase to assess migration impact, estimate cost/effort, and identify risks.',
    outputSchema: ImpactAssessorSchema,
    phases: [1],
    copilotTools: ['read', 'edit', 'search', 'execute'],
    claudeTools: CLAUDE_TOOLS,
  },
  'knowledge-builder': {
    name: 'knowledge-builder',
    displayName: 'Knowledge Builder',
    description: 'Investigates a legacy codebase and builds a structured knowledge base documenting its architecture, patterns, and behaviors.',
    outputSchema: KnowledgeBuilderSchema,
    phases: [2],
    copilotTools: ['read', 'edit', 'search', 'execute'],
    claudeTools: CLAUDE_TOOLS,
  },
  'migration-planner': {
    name: 'migration-planner',
    displayName: 'Migration Planner',
    description: 'Creates a detailed, ordered migration plan by analyzing the knowledge base and producing task breakdowns for code migration.',
    outputSchema: MigrationPlannerSchema,
    phases: [3],
    copilotTools: ['read', 'edit', 'search'],
    claudeTools: CLAUDE_TOOLS,
  },
  'task-decomposer': {
    name: 'task-decomposer',
    displayName: 'Task Decomposer',
    description: 'Decomposes one module group into atomic migration tasks using the selected strategy and KB analysis files.',
    outputSchema: TaskDecomposerSchema,
    phases: [3],
    copilotTools: ['read', 'edit', 'search'],
    claudeTools: CLAUDE_TOOLS,
  },
  'adjudicator': {
    name: 'adjudicator',
    displayName: 'Adjudicator',
    description: 'Evaluates competing implementation plans or design decisions and selects the best option.',
    outputSchema: AdjudicatorSchema,
    phases: [3],
    copilotTools: ['read', 'edit', 'search', 'execute'],
    claudeTools: CLAUDE_TOOLS,
  },
  'code-migrator': {
    name: 'code-migrator',
    displayName: 'Code Migrator',
    description: 'Migrates source code from legacy to target platform according to a specific task in the migration plan.',
    outputSchema: CodeMigratorSchema,
    phases: [4],
    copilotTools: ['read', 'edit', 'search', 'execute'],
    claudeTools: CLAUDE_TOOLS,
  },
  'parity-verifier': {
    name: 'parity-verifier',
    displayName: 'Parity Verifier',
    description: 'Verifies behavioral parity between original source code and migrated target code.',
    outputSchema: ParityVerifierSchema,
    phases: [4],
    copilotTools: ['read', 'edit', 'search', 'execute'],
    claudeTools: CLAUDE_TOOLS,
  },
  'test-writer': {
    name: 'test-writer',
    displayName: 'Test Writer',
    description: 'Writes unit and integration tests for changes made by the code-writer.',
    outputSchema: TestWriterSchema,
    phases: [4],
    copilotTools: ['read', 'edit', 'search', 'execute'],
    claudeTools: CLAUDE_TOOLS,
  },
  'failure-adjudicator': {
    name: 'failure-adjudicator',
    displayName: 'Failure Adjudicator',
    description: 'Diagnoses migration failures, evaluates competing fix strategies, and selects/executes the best recovery path.',
    outputSchema: FailureAdjudicatorSchema,
    phases: [4],
    copilotTools: ['read', 'edit', 'search', 'execute'],
    claudeTools: CLAUDE_TOOLS,
  },
  'final-parity-checker': {
    name: 'final-parity-checker',
    displayName: 'Final Parity Checker',
    description: 'Performs a comprehensive post-migration audit to ensure the entire migrated codebase is complete with no gaps, stubs, or behavioral differences.',
    outputSchema: FinalParityCheckerSchema,
    phases: [5],
    copilotTools: ['read', 'edit', 'search', 'execute'],
    claudeTools: CLAUDE_TOOLS,
  },
  'e2e-test-crafter': {
    name: 'e2e-test-crafter',
    displayName: 'E2E Test Crafter',
    description: 'Plans and coordinates end-to-end test suites for the fully migrated codebase, delegating individual suite writing to test-writer agents.',
    outputSchema: E2eTestCrafterSchema,
    phases: [6],
    copilotTools: ['read', 'edit', 'search', 'execute'],
    claudeTools: CLAUDE_TOOLS,
  },
  'documentation-writer': {
    name: 'documentation-writer',
    displayName: 'Documentation Writer',
    description: 'Produces comprehensive documentation for the migrated codebase including architecture guides, API docs, and migration notes.',
    outputSchema: DocumentationWriterSchema,
    phases: [6],
    copilotTools: ['read', 'edit', 'search'],
    claudeTools: CLAUDE_TOOLS,
  },
  'migration-runner': {
    name: 'migration-runner',
    displayName: 'Migration Runner',
    description: 'Top-level entry point that launches and manages the migration orchestrator for large-scale legacy codebase migrations.',
    outputSchema: MigrationRunnerSchema,
    phases: [],
    copilotTools: ['read', 'edit', 'search', 'execute'],
    claudeTools: CLAUDE_TOOLS,
  },
  'idiomatic-reviewer': {
    name: 'idiomatic-reviewer',
    displayName: 'Idiomatic Reviewer',
    description: 'Reviews the migrated codebase for idiomatic patterns in the target language, producing a report of issues and suggestions.',
    outputSchema: IdiomaticReviewerSchema,
    phases: [8],
    copilotTools: ['read', 'search'],
    claudeTools: CLAUDE_TOOLS,
  },
  'idiomatic-refactorer': {
    name: 'idiomatic-refactorer',
    displayName: 'Idiomatic Refactorer',
    description: 'Applies a single idiomatic improvement suggestion from the idiomatic review report to a specific file.',
    outputSchema: IdiomaticRefactorerSchema,
    phases: [8],
    copilotTools: ['read', 'edit'],
    claudeTools: CLAUDE_TOOLS,
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
