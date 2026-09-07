/**
 * @module agents/registry
 *
 * Canonical single source of truth for all agent metadata in the AAMF system.
 * Combines agent names, output schemas, phase membership, and agent file
 * conventions into a single registry.
 */
import { z } from 'zod';
import {
  AamfOutputBase,
} from './agent-output-schemas.js';
import { AGENT_CONTEXT_SCHEMAS, AGENT_NAMES, type AgentName } from './contracts.js';
import type { JsonSchema } from './types.js';

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
  /** Zod schema for the exact JSON context serialized for this agent. */
  contextSchema: z.ZodTypeAny;
  /** Whether successful execution must produce at least one filesystem artifact. */
  artifactPolicy: 'required' | 'structured-only';
  /** JSON Schema describing the agent's expected input (context) contract. */
  inputJsonSchema: JsonSchema;
  /** JSON Schema describing the agent's expected aamf-json output contract. */
  outputJsonSchema: JsonSchema;
  /** Phase IDs where this agent participates. */
  phases: readonly number[];
  /** Tool names for Copilot (GitHub) front matter. */
  copilotTools: readonly string[];
  /** Tool names for Claude Code front matter. */
  claudeTools: readonly string[];
}

function contractFields(agent: AgentName, outputSchema: z.ZodTypeAny): Pick<
  AgentRegistryEntry,
  'contextSchema' | 'outputSchema' | 'inputJsonSchema' | 'outputJsonSchema'
> {
  const contextSchema = AGENT_CONTEXT_SCHEMAS[agent];
  return {
    contextSchema,
    outputSchema,
    inputJsonSchema: z.toJSONSchema(contextSchema, { io: 'input' }) as JsonSchema,
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
  })).optional(),
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
  })).optional(),
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
  })).optional(),
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
/** Default Claude Code tools shared by all agents. */
const CLAUDE_TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'] as const;

export const AGENT_REGISTRY: Record<AgentName, AgentRegistryEntry> = {
  'knowledge-builder': {
    name: 'knowledge-builder',
    displayName: 'Knowledge Builder',
    description: 'Investigates a legacy codebase and builds a structured knowledge base documenting its architecture, patterns, and behaviors.',
    ...contractFields('knowledge-builder', KnowledgeBuilderSchema),
    artifactPolicy: 'required',
    phases: [2],
    copilotTools: ['read', 'edit', 'search', 'execute'],
    claudeTools: CLAUDE_TOOLS,
  },
  'migration-planner': {
    name: 'migration-planner',
    displayName: 'Migration Planner',
    description: 'Creates a detailed, ordered migration plan by analyzing the knowledge base and producing task breakdowns for code migration.',
    ...contractFields('migration-planner', MigrationPlannerSchema),
    artifactPolicy: 'required',
    phases: [3],
    copilotTools: ['read', 'edit', 'search'],
    claudeTools: CLAUDE_TOOLS,
  },
  'adjudicator': {
    name: 'adjudicator',
    displayName: 'Adjudicator',
    description: 'Evaluates competing implementation plans or design decisions and selects the best option.',
    ...contractFields('adjudicator', AdjudicatorSchema),
    artifactPolicy: 'required',
    phases: [3],
    copilotTools: ['read', 'edit', 'search', 'execute'],
    claudeTools: CLAUDE_TOOLS,
  },
  'code-migrator': {
    name: 'code-migrator',
    displayName: 'Code Migrator',
    description: 'Migrates source code from legacy to target platform according to a specific task in the migration plan.',
    ...contractFields('code-migrator', CodeMigratorSchema),
    artifactPolicy: 'required',
    phases: [4, 5],
    copilotTools: ['read', 'edit', 'search', 'execute'],
    claudeTools: CLAUDE_TOOLS,
  },
  'parity-verifier': {
    name: 'parity-verifier',
    displayName: 'Parity Verifier',
    description: 'Verifies behavioral parity between original source code and migrated target code.',
    ...contractFields('parity-verifier', ParityVerifierSchema),
    artifactPolicy: 'structured-only',
    phases: [4],
    copilotTools: ['read', 'edit', 'search', 'execute'],
    claudeTools: CLAUDE_TOOLS,
  },
  'test-writer': {
    name: 'test-writer',
    displayName: 'Test Writer',
    description: 'Writes unit and integration tests for changes made by the code-writer.',
    ...contractFields('test-writer', TestWriterSchema),
    artifactPolicy: 'required',
    phases: [4, 6],
    copilotTools: ['read', 'edit', 'search', 'execute'],
    claudeTools: CLAUDE_TOOLS,
  },
  'parity-failure-resolver': {
    name: 'parity-failure-resolver',
    displayName: 'Parity Failure Resolver',
    description: 'Diagnoses migration failures, evaluates competing fix strategies, and selects/executes the best recovery path.',
    ...contractFields('parity-failure-resolver', ParityFailureResolverSchema),
    artifactPolicy: 'required',
    phases: [4],
    copilotTools: ['read', 'edit', 'search', 'execute'],
    claudeTools: CLAUDE_TOOLS,
  },
  'final-parity-checker': {
    name: 'final-parity-checker',
    displayName: 'Final Parity Checker',
    description: 'Performs a comprehensive post-migration audit to ensure the entire migrated codebase is complete with no gaps, stubs, or behavioral differences.',
    ...contractFields('final-parity-checker', FinalParityCheckerSchema),
    artifactPolicy: 'structured-only',
    phases: [5],
    copilotTools: ['read', 'edit', 'search', 'execute'],
    claudeTools: CLAUDE_TOOLS,
  },
  'e2e-test-crafter': {
    name: 'e2e-test-crafter',
    displayName: 'E2E Test Crafter',
    description: 'Produces a validated end-to-end suite plan for the fully migrated codebase.',
    ...contractFields('e2e-test-crafter', E2eTestCrafterSchema),
    artifactPolicy: 'required',
    phases: [6],
    copilotTools: ['read', 'edit', 'search', 'execute'],
    claudeTools: CLAUDE_TOOLS,
  },
  'documentation-writer': {
    name: 'documentation-writer',
    displayName: 'Documentation Writer',
    description: 'Produces comprehensive documentation for the migrated codebase including architecture guides, API docs, and migration notes.',
    ...contractFields('documentation-writer', DocumentationWriterSchema),
    artifactPolicy: 'required',
    phases: [6],
    copilotTools: ['read', 'edit', 'search'],
    claudeTools: CLAUDE_TOOLS,
  },
  'idiomatic-reviewer': {
    name: 'idiomatic-reviewer',
    displayName: 'Idiomatic Reviewer',
    description: 'Reviews the migrated codebase for idiomatic patterns in the target language, producing a report of issues and suggestions.',
    ...contractFields('idiomatic-reviewer', IdiomaticReviewerSchema),
    artifactPolicy: 'structured-only',
    phases: [7],
    copilotTools: ['read', 'search'],
    claudeTools: CLAUDE_TOOLS,
  },
  'idiomatic-planner': {
    name: 'idiomatic-planner',
    displayName: 'Idiomatic Planner',
    description: 'Analyzes holistic idiomatic review findings and constructs a dependency-ordered task graph for refactoring.',
    ...contractFields('idiomatic-planner', IdiomaticPlannerSchema),
    artifactPolicy: 'structured-only',
    phases: [7],
    copilotTools: ['read', 'search', 'execute'],
    claudeTools: CLAUDE_TOOLS,
  },
  'idiomatic-refactorer': {
    name: 'idiomatic-refactorer',
    displayName: 'Idiomatic Refactorer',
    description: 'Applies idiomatic improvements from a refactoring task to one or more files in the migrated codebase.',
    ...contractFields('idiomatic-refactorer', IdiomaticRefactorerSchema),
    artifactPolicy: 'required',
    phases: [7],
    copilotTools: ['read', 'edit', 'execute'],
    claudeTools: CLAUDE_TOOLS,
  },
};

/** All registered agent names (derived from the registry). */
export const ALL_AGENT_NAMES = [...AGENT_NAMES];

/** Get agents that participate in a given phase. */
export function getAgentsForPhase(phaseId: number): AgentName[] {
  return ALL_AGENT_NAMES.filter(name => AGENT_REGISTRY[name].phases.includes(phaseId));
}

/** Get the output schema for a given agent. */
export function getOutputSchema(agent: AgentName): z.ZodTypeAny {
  return AGENT_OUTPUT_SCHEMAS[agent];
}


