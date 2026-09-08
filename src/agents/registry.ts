/**
 * @module agents/registry
 *
 * Canonical single source of truth for all scenario metadata in the AAMF system.
 * Combines context/output contracts, artifact policy, phase membership, and
 * backend-neutral capabilities into a single registry.
 */
import { z } from 'zod';
import {
  AamfOutputBase,
} from './agent-output-schemas.js';
import { AGENT_CONTEXT_SCHEMAS, AGENT_NAMES, type AgentName } from './contracts.js';
import type { JsonSchema, ScenarioCapability } from './types.js';

// ─── Registry Entry ──────────────────────────────────────────────────────────

export interface AgentRegistryEntry {
  /** Canonical agent name (must match the AgentName union). */
  name: AgentName;
  /** Human-readable description of the agent's purpose. */
  description: string;
  /** Zod schema for validating the agent's aamf-json output block. */
  outputSchema: z.ZodTypeAny;
  /** Zod schema for the exact JSON context serialized for this agent. */
  contextSchema: z.ZodTypeAny;
  /** Whether successful execution must produce at least one filesystem artifact. */
  artifactPolicy: 'required' | 'structured-only';
  /** JSON Schema describing the agent's expected aamf-json output contract. */
  outputJsonSchema: JsonSchema;
  /** Phase IDs where this agent participates. */
  phases: readonly number[];
  /** Backend-neutral operations available to this scenario. */
  capabilities: readonly ScenarioCapability[];
}

function contractFields(agent: AgentName, outputSchema: z.ZodTypeAny): Pick<
  AgentRegistryEntry,
  'contextSchema' | 'outputSchema' | 'outputJsonSchema'
> {
  const contextSchema = AGENT_CONTEXT_SCHEMAS[agent];
  return {
    contextSchema,
    outputSchema,
    outputJsonSchema: z.toJSONSchema(outputSchema, { io: 'input' }) as JsonSchema,
  };
}

// ─── Per-Agent Output Schema Extensions ──────────────────────────────────────
// These extend AamfOutputBase with agent-specific fields.

export const KnowledgeBuilderSchema = AamfOutputBase;
export const MigrationPlannerSchema = AamfOutputBase;
export const AdjudicatorSchema = AamfOutputBase;
export const CodeMigratorSchema = AamfOutputBase;
export const ParityVerifierSchema = AamfOutputBase.extend({
  parity: z.enum(['pass', 'partial', 'fail']),
  issues: z.array(z.object({
    severity: z.enum(['critical', 'major', 'minor']),
    description: z.string(),
    details: z.string(),
    sourceLocation: z.string(),
    targetLocation: z.string().optional(),
    suggestedFix: z.string().optional(),
  })).default([]),
});
export const TestWriterSchema = AamfOutputBase;
export const ParityFailureResolverSchema = AamfOutputBase;
export const FinalParityCheckerSchema = AamfOutputBase.extend({
  fixes: z.array(z.object({
    description: z.string().min(1),
    details: z.string(),
    sourceFile: z.string().min(1),
    targetFile: z.string().min(1),
    sourceLocation: z.string(),
    targetLocation: z.string().optional(),
  })).default([]),
});
export const E2eTestCrafterSchema = AamfOutputBase;
export const DocumentationWriterSchema = AamfOutputBase;
export const IdiomaticReviewerSchema = AamfOutputBase.extend({
  issues: z.array(z.object({
    file: z.string().min(1),
    location: z.string(),
    category: z.string().optional(),
    issue: z.string().min(1),
    suggestion: z.string().min(1),
    details: z.string(),
    relatedFiles: z.array(z.string()).optional(),
  })).default([]),
});
export const IdiomaticPlannerSchema = AamfOutputBase.extend({
  tasks: z.array(z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string(),
    files: z.array(z.string().min(1)),
    issues: z.array(z.object({
      file: z.string().min(1),
      location: z.string(),
      issue: z.string().min(1),
      suggestion: z.string().min(1),
    })),
    dependencies: z.array(z.string()).default([]),
  })).default([]),
});
export const IdiomaticRefactorerSchema = AamfOutputBase;

export const AGENT_OUTPUT_SCHEMAS = {
  'knowledge-builder': KnowledgeBuilderSchema,
  'migration-planner': MigrationPlannerSchema,
  adjudicator: AdjudicatorSchema,
  'code-migrator': CodeMigratorSchema,
  'parity-verifier': ParityVerifierSchema,
  'test-writer': TestWriterSchema,
  'parity-failure-resolver': ParityFailureResolverSchema,
  'final-parity-checker': FinalParityCheckerSchema,
  'e2e-test-crafter': E2eTestCrafterSchema,
  'documentation-writer': DocumentationWriterSchema,
  'idiomatic-reviewer': IdiomaticReviewerSchema,
  'idiomatic-planner': IdiomaticPlannerSchema,
  'idiomatic-refactorer': IdiomaticRefactorerSchema,
} satisfies Record<AgentName, z.ZodTypeAny>;

export type AgentOutputByName = {
  [A in AgentName]: z.infer<(typeof AGENT_OUTPUT_SCHEMAS)[A]>;
};

// ─── The Registry ────────────────────────────────────────────────────────────

/**
 * Single source of truth for all agent metadata.
 *
 * Usage:
 * - Derive `AgentName` union values: `Object.keys(AGENT_REGISTRY)`
 * - Derive per-phase agent lists: `getAgentsForPhase(phaseId)`
 * - Look up output schemas: `AGENT_REGISTRY['code-migrator'].outputSchema`
 */
function capabilities(...values: ScenarioCapability[]): readonly ScenarioCapability[] {
  return Object.freeze(values);
}

export const AGENT_REGISTRY: Record<AgentName, AgentRegistryEntry> = {
  'knowledge-builder': {
    name: 'knowledge-builder',
    description: 'Investigates a legacy codebase and builds a structured knowledge base documenting its architecture, patterns, and behaviors.',
    ...contractFields('knowledge-builder', KnowledgeBuilderSchema),
    artifactPolicy: 'required',
    phases: [2],
    capabilities: capabilities('read', 'search', 'write', 'source-kb'),
  },
  'migration-planner': {
    name: 'migration-planner',
    description: 'Creates a detailed, ordered migration plan by analyzing the knowledge base and producing task breakdowns for code migration.',
    ...contractFields('migration-planner', MigrationPlannerSchema),
    artifactPolicy: 'required',
    phases: [3],
    capabilities: capabilities('read', 'search', 'write', 'source-kb'),
  },
  'adjudicator': {
    name: 'adjudicator',
    description: 'Evaluates competing implementation plans or design decisions and selects the best option.',
    ...contractFields('adjudicator', AdjudicatorSchema),
    artifactPolicy: 'structured-only',
    phases: [3],
    capabilities: capabilities('read', 'search', 'source-kb'),
  },
  'code-migrator': {
    name: 'code-migrator',
    description: 'Migrates source code from legacy to target platform according to a specific task in the migration plan.',
    ...contractFields('code-migrator', CodeMigratorSchema),
    artifactPolicy: 'required',
    phases: [4, 5],
    capabilities: capabilities('read', 'search', 'write', 'execute', 'source-kb', 'target-kb'),
  },
  'parity-verifier': {
    name: 'parity-verifier',
    description: 'Verifies behavioral parity between original source code and migrated target code.',
    ...contractFields('parity-verifier', ParityVerifierSchema),
    artifactPolicy: 'structured-only',
    phases: [4],
    capabilities: capabilities('read', 'search', 'execute', 'source-kb', 'target-kb'),
  },
  'test-writer': {
    name: 'test-writer',
    description: 'Writes unit and integration tests for changes made by the code-migrator.',
    ...contractFields('test-writer', TestWriterSchema),
    artifactPolicy: 'required',
    phases: [4, 6],
    capabilities: capabilities('read', 'search', 'write', 'execute', 'source-kb', 'target-kb'),
  },
  'parity-failure-resolver': {
    name: 'parity-failure-resolver',
    description: 'Diagnoses migration failures, evaluates competing fix strategies, and selects/executes the best recovery path.',
    ...contractFields('parity-failure-resolver', ParityFailureResolverSchema),
    artifactPolicy: 'structured-only',
    phases: [4],
    capabilities: capabilities('read', 'search', 'write', 'execute', 'source-kb', 'target-kb'),
  },
  'final-parity-checker': {
    name: 'final-parity-checker',
    description: 'Performs a comprehensive post-migration audit to ensure the entire migrated codebase is complete with no gaps, stubs, or behavioral differences.',
    ...contractFields('final-parity-checker', FinalParityCheckerSchema),
    artifactPolicy: 'structured-only',
    phases: [5],
    capabilities: capabilities('read', 'search', 'execute', 'source-kb', 'target-kb'),
  },
  'e2e-test-crafter': {
    name: 'e2e-test-crafter',
    description: 'Produces a validated end-to-end suite plan for the fully migrated codebase.',
    ...contractFields('e2e-test-crafter', E2eTestCrafterSchema),
    artifactPolicy: 'required',
    phases: [6],
    capabilities: capabilities('read', 'search', 'write', 'source-kb', 'target-kb'),
  },
  'documentation-writer': {
    name: 'documentation-writer',
    description: 'Produces comprehensive documentation for the migrated codebase including architecture guides, API docs, and migration notes.',
    ...contractFields('documentation-writer', DocumentationWriterSchema),
    artifactPolicy: 'required',
    phases: [6],
    capabilities: capabilities('read', 'search', 'write', 'source-kb', 'target-kb'),
  },
  'idiomatic-reviewer': {
    name: 'idiomatic-reviewer',
    description: 'Reviews the migrated codebase for idiomatic patterns in the target language, producing a report of issues and suggestions.',
    ...contractFields('idiomatic-reviewer', IdiomaticReviewerSchema),
    artifactPolicy: 'structured-only',
    phases: [7],
    capabilities: capabilities('read', 'search', 'target-kb'),
  },
  'idiomatic-planner': {
    name: 'idiomatic-planner',
    description: 'Analyzes holistic idiomatic review findings and constructs a dependency-ordered task graph for refactoring.',
    ...contractFields('idiomatic-planner', IdiomaticPlannerSchema),
    artifactPolicy: 'structured-only',
    phases: [7],
    capabilities: capabilities('read', 'search', 'target-kb'),
  },
  'idiomatic-refactorer': {
    name: 'idiomatic-refactorer',
    description: 'Applies idiomatic improvements from a refactoring task to one or more files in the migrated codebase.',
    ...contractFields('idiomatic-refactorer', IdiomaticRefactorerSchema),
    artifactPolicy: 'required',
    phases: [7],
    capabilities: capabilities('read', 'search', 'write', 'target-kb'),
  },
};

/** All registered agent names (derived from the registry). */
export const ALL_AGENT_NAMES = Object.freeze([...AGENT_NAMES]);

/** Scenarios with live phase membership, used by startup prompt validation. */
export const ACTIVE_AGENT_NAMES = Object.freeze(
  ALL_AGENT_NAMES.filter(name => AGENT_REGISTRY[name].phases.length > 0),
);

/** Get agents that participate in a given phase. */
export function getAgentsForPhase(phaseId: number): AgentName[] {
  return ALL_AGENT_NAMES.filter(name => AGENT_REGISTRY[name].phases.includes(phaseId));
}

/** Get the output schema for a given agent. */
export function getOutputSchema(agent: AgentName): z.ZodTypeAny {
  return AGENT_OUTPUT_SCHEMAS[agent];
}

/** Return the immutable capability set for a scenario. */
export function getScenarioCapabilities(agent: AgentName): readonly ScenarioCapability[] {
  return AGENT_REGISTRY[agent].capabilities;
}

/** Test whether a scenario has a backend-neutral capability. */
export function hasScenarioCapability(agent: AgentName, capability: ScenarioCapability): boolean {
  return AGENT_REGISTRY[agent].capabilities.includes(capability);
}


