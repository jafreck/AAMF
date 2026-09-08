/**
 * @module agents/registry
 *
 * Canonical single source of truth for all scenario metadata in the AAMF system.
 * Combines scenario names, output schemas, phase membership, and backend-neutral
 * capabilities into a single registry.
 */
import { z } from 'zod';
import {
  AamfOutputBase,
} from './agent-output-schemas.js';
import type { AgentName, JsonSchema, ScenarioCapability } from './types.js';

// ─── Shared base properties ──────────────────────────────────────────────────

/** Properties common to every agent's output schema. */
const BASE_OUTPUT_PROPERTIES: Record<string, JsonSchema> = {
  status:      { enum: ['completed', 'failed', 'needs-review'] },
  outputFiles: { type: 'array', items: { type: 'string', minLength: 1 } },
  notes:       { type: 'string' },
};

/**
 * Build an output JSON Schema, merging base properties with agent-specific extras.
 */
function outputSchema(
  opts: {
    extraRequired?: readonly string[];
    extraProperties?: Record<string, JsonSchema>;
    overrideOutputFiles?: JsonSchema;
  } = {},
): JsonSchema {
  const outputFiles = opts.overrideOutputFiles ?? BASE_OUTPUT_PROPERTIES.outputFiles;
  return {
    type: 'object',
    required: ['status', 'outputFiles', ...(opts.extraRequired ?? [])],
    properties: {
      ...BASE_OUTPUT_PROPERTIES,
      outputFiles,
      ...(opts.extraProperties ?? {}),
    },
  };
}

// ─── Registry Entry ──────────────────────────────────────────────────────────

export interface AgentRegistryEntry {
  /** Canonical agent name (must match the AgentName union). */
  name: AgentName;
  /** Human-readable description of the agent's purpose. */
  description: string;
  /** Zod schema for validating the agent's aamf-json output block. */
  outputSchema: z.ZodTypeAny;
  /** JSON Schema describing the agent's expected aamf-json output contract. */
  outputJsonSchema: JsonSchema;
  /** Phase IDs where this agent participates. */
  phases: readonly number[];
  /** Backend-neutral operations available to this scenario. */
  capabilities: readonly ScenarioCapability[];
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
    outputSchema: KnowledgeBuilderSchema,
    outputJsonSchema: outputSchema({
      extraProperties: {
        modulesDocumented: { type: 'integer', minimum: 0 },
      },
    }),
    phases: [2],
    capabilities: capabilities('read', 'search', 'write', 'source-kb'),
  },
  'migration-planner': {
    name: 'migration-planner',
    description: 'Creates a detailed, ordered migration plan by analyzing the knowledge base and producing task breakdowns for code migration.',
    outputSchema: MigrationPlannerSchema,
    outputJsonSchema: outputSchema({
      extraProperties: {
        groupCount: { type: 'integer', minimum: 0 },
        strategy:   { type: 'string' },
      },
    }),
    phases: [3],
    capabilities: capabilities('read', 'search', 'write', 'source-kb'),
  },
  'adjudicator': {
    name: 'adjudicator',
    description: 'Evaluates competing implementation plans or design decisions and selects the best option.',
    outputSchema: AdjudicatorSchema,
    outputJsonSchema: outputSchema({
      extraProperties: {
        taskId:   { type: 'string', minLength: 1 },
        decision: { type: 'string', minLength: 1 },
      },
    }),
    phases: [3],
    capabilities: capabilities('read', 'search', 'write', 'source-kb'),
  },
  'code-migrator': {
    name: 'code-migrator',
    description: 'Migrates source code from legacy to target platform according to a specific task in the migration plan.',
    outputSchema: CodeMigratorSchema,
    outputJsonSchema: outputSchema({
      extraProperties: {
        taskId: { type: 'string', minLength: 1 },
        parity: { enum: ['pass', 'partial', 'fail'] },
        issues: { type: 'array' },
      },
    }),
    phases: [4, 5],
    capabilities: capabilities('read', 'search', 'write', 'execute', 'source-kb', 'target-kb'),
  },
  'parity-verifier': {
    name: 'parity-verifier',
    description: 'Verifies behavioral parity between original source code and migrated target code.',
    outputSchema: ParityVerifierSchema,
    outputJsonSchema: outputSchema({
      extraRequired: ['taskId', 'parity', 'issues'],
      extraProperties: {
        taskId: { type: 'string', minLength: 1 },
        parity: { enum: ['pass', 'partial', 'fail'] },
        issues: {
          type: 'array',
          items: {
            type: 'object',
            required: ['severity', 'description', 'details', 'sourceLocation'],
            properties: {
              severity:       { enum: ['critical', 'major', 'minor'] },
              description:    { type: 'string', minLength: 1 },
              details:        { type: 'string', minLength: 1 },
              sourceLocation: { type: 'string', minLength: 1 },
              targetLocation: { type: 'string', minLength: 1 },
              suggestedFix:   { type: 'string', minLength: 1 },
            },
          },
        },
      },
    }),
    phases: [4],
    capabilities: capabilities('read', 'search', 'execute', 'source-kb', 'target-kb'),
  },
  'test-writer': {
    name: 'test-writer',
    description: 'Writes unit and integration tests for changes made by the code-migrator.',
    outputSchema: TestWriterSchema,
    outputJsonSchema: outputSchema({
      extraRequired: ['taskId'],
      extraProperties: {
        taskId: { type: 'string', minLength: 1 },
      },
    }),
    phases: [4, 6],
    capabilities: capabilities('read', 'search', 'write', 'execute', 'source-kb', 'target-kb'),
  },
  'parity-failure-resolver': {
    name: 'parity-failure-resolver',
    description: 'Diagnoses migration failures, evaluates competing fix strategies, and selects/executes the best recovery path.',
    outputSchema: ParityFailureResolverSchema,
    outputJsonSchema: outputSchema({
      extraRequired: ['taskId', 'failureType', 'attempts', 'scopeReduced'],
      extraProperties: {
        taskId:       { type: 'string', minLength: 1 },
        failureType:  { enum: ['parity', 'build', 'test', 'blocked'] },
        attempts:     { type: 'integer', minimum: 1 },
        scopeReduced: { type: 'boolean' },
      },
    }),
    phases: [4],
    capabilities: capabilities('read', 'search', 'write', 'execute', 'source-kb', 'target-kb'),
  },
  'final-parity-checker': {
    name: 'final-parity-checker',
    description: 'Performs a comprehensive post-migration audit to ensure the entire migrated codebase is complete with no gaps, stubs, or behavioral differences.',
    outputSchema: FinalParityCheckerSchema,
    outputJsonSchema: outputSchema({
      extraProperties: {
        fixes: {
          type: 'array',
          items: {
            type: 'object',
            required: ['description', 'details', 'sourceFile', 'targetFile', 'sourceLocation'],
            properties: {
              description:    { type: 'string', minLength: 1 },
              details:        { type: 'string', minLength: 1 },
              sourceFile:     { type: 'string', minLength: 1 },
              targetFile:     { type: 'string', minLength: 1 },
              sourceLocation: { type: 'string', minLength: 1 },
              targetLocation: { type: 'string', minLength: 1 },
            },
          },
        },
      },
    }),
    phases: [5],
    capabilities: capabilities('read', 'search', 'execute', 'source-kb', 'target-kb'),
  },
  'e2e-test-crafter': {
    name: 'e2e-test-crafter',
    description: 'Plans end-to-end test suites for runtime-managed test-writer fan-out.',
    outputSchema: E2eTestCrafterSchema,
    outputJsonSchema: outputSchema({
      extraProperties: {
        suitesPlanned:   { type: 'integer', minimum: 0 },
        suitesCompleted: { type: 'integer', minimum: 0 },
      },
    }),
    phases: [6],
    capabilities: capabilities('read', 'search', 'write', 'source-kb', 'target-kb'),
  },
  'documentation-writer': {
    name: 'documentation-writer',
    description: 'Produces comprehensive documentation for the migrated codebase including architecture guides, API docs, and migration notes.',
    outputSchema: DocumentationWriterSchema,
    outputJsonSchema: outputSchema({
      extraProperties: {
        documentsWritten: { type: 'integer', minimum: 0 },
      },
    }),
    phases: [6],
    capabilities: capabilities('read', 'search', 'write', 'source-kb', 'target-kb'),
  },
  'idiomatic-reviewer': {
    name: 'idiomatic-reviewer',
    description: 'Reviews the migrated codebase for idiomatic patterns in the target language, producing a report of issues and suggestions.',
    outputSchema: IdiomaticReviewerSchema,
    outputJsonSchema: outputSchema({
      extraProperties: {
        issues: {
          type: 'array',
          items: {
            type: 'object',
            required: ['file', 'location', 'issue', 'suggestion', 'details'],
            properties: {
              file:         { type: 'string', minLength: 1 },
              location:     { type: 'string', minLength: 1 },
              category:     { type: 'string' },
              issue:        { type: 'string', minLength: 1 },
              suggestion:   { type: 'string', minLength: 1 },
              details:      { type: 'string', minLength: 1 },
              relatedFiles: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
    }),
    phases: [7],
    capabilities: capabilities('read', 'search', 'target-kb'),
  },
  'idiomatic-planner': {
    name: 'idiomatic-planner',
    description: 'Analyzes holistic idiomatic review findings and constructs a dependency-ordered task graph for refactoring.',
    outputSchema: IdiomaticPlannerSchema,
    outputJsonSchema: outputSchema({
      extraProperties: {
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            required: ['id', 'name', 'description', 'files', 'issues'],
            properties: {
              id:           { type: 'string', minLength: 1 },
              name:         { type: 'string', minLength: 1 },
              description:  { type: 'string' },
              files:        { type: 'array', items: { type: 'string', minLength: 1 } },
              issues:       { type: 'array', items: { type: 'object' } },
              dependencies: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
    }),
    phases: [7],
    capabilities: capabilities('read', 'search', 'target-kb'),
  },
  'idiomatic-refactorer': {
    name: 'idiomatic-refactorer',
    description: 'Applies idiomatic improvements from a refactoring task to one or more files in the migrated codebase.',
    outputSchema: IdiomaticRefactorerSchema,
    outputJsonSchema: outputSchema(),
    phases: [7],
    capabilities: capabilities('read', 'search', 'write', 'target-kb'),
  },
};

/** All registered agent names (derived from the registry). */
export const ALL_AGENT_NAMES = Object.freeze(Object.keys(AGENT_REGISTRY) as AgentName[]);

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
  return AGENT_REGISTRY[agent].outputSchema;
}

/** Return the immutable capability set for a scenario. */
export function getScenarioCapabilities(agent: AgentName): readonly ScenarioCapability[] {
  return AGENT_REGISTRY[agent].capabilities;
}

/** Test whether a scenario has a backend-neutral capability. */
export function hasScenarioCapability(agent: AgentName, capability: ScenarioCapability): boolean {
  return AGENT_REGISTRY[agent].capabilities.includes(capability);
}


