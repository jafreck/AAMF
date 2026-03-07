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

// ─── JSON Schema type ────────────────────────────────────────────────────────

/** A plain JSON Schema object used to document agent input/output contracts. */
export type JsonSchema = Record<string, unknown>;

// ─── Shared base properties ──────────────────────────────────────────────────

/** Properties common to every agent's input schema. */
const BASE_INPUT_PROPERTIES: Record<string, JsonSchema> = {
  contextFile: { type: 'string', minLength: 1 },
  projectRoot: { type: 'string', minLength: 1 },
  progressDir: { type: 'string', minLength: 1 },
  phase:       { type: 'integer', minimum: 0 },
};

/** The minimum required keys for every agent input. */
const BASE_INPUT_REQUIRED = ['contextFile', 'projectRoot', 'progressDir', 'phase'] as const;

/** Properties common to every agent's output schema (excluding `agent`). */
const BASE_OUTPUT_PROPERTIES: Record<string, JsonSchema> = {
  status:      { enum: ['completed', 'failed', 'needs-review'] },
  outputFiles: { type: 'array', items: { type: 'string', minLength: 1 } },
  notes:       { type: 'string' },
};

/**
 * Build an input JSON Schema, merging base properties with agent-specific extras.
 * Extra `required` entries are appended to the base required list.
 */
function inputSchema(
  opts: { extraRequired?: readonly string[]; extraProperties?: Record<string, JsonSchema> } = {},
): JsonSchema {
  return {
    type: 'object',
    required: [...BASE_INPUT_REQUIRED, ...(opts.extraRequired ?? [])],
    properties: { ...BASE_INPUT_PROPERTIES, ...(opts.extraProperties ?? {}) },
  };
}

/**
 * Build an output JSON Schema, merging base properties with agent-specific extras.
 * The `agent` const is always injected from the agent name.
 */
function outputSchema(
  agentName: string,
  opts: {
    extraRequired?: readonly string[];
    extraProperties?: Record<string, JsonSchema>;
    overrideOutputFiles?: JsonSchema;
  } = {},
): JsonSchema {
  const outputFiles = opts.overrideOutputFiles ?? BASE_OUTPUT_PROPERTIES.outputFiles;
  return {
    type: 'object',
    required: ['agent', 'status', 'outputFiles', ...(opts.extraRequired ?? [])],
    properties: {
      agent: { const: agentName },
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
  /** Title-case display name used in Copilot front matter. */
  displayName: string;
  /** Zod schema for validating the agent's aamf-json output block. */
  outputSchema: z.ZodTypeAny;
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
    inputJsonSchema: inputSchema({ extraProperties: { resume: { type: 'boolean' } } }),
    outputJsonSchema: outputSchema('migration-orchestrator', {
      extraProperties: {
        currentPhase:   { type: 'integer', minimum: 0 },
        completedTasks: { type: 'array', items: { type: 'string' } },
        failedTasks:    { type: 'array', items: { type: 'string' } },
      },
    }),
    phases: [],
    copilotTools: ['read', 'edit', 'search', 'execute'],
    claudeTools: CLAUDE_TOOLS,
  },
  'impact-assessor': {
    name: 'impact-assessor',
    displayName: 'Impact Assessor',
    description: 'Analyzes a legacy codebase to assess migration impact, estimate cost/effort, and identify risks.',
    outputSchema: ImpactAssessorSchema,
    inputJsonSchema: inputSchema({ extraProperties: { sourcePath: { type: 'string' } } }),
    outputJsonSchema: outputSchema('impact-assessor', {
      extraProperties: {
        totalFiles: { type: 'integer', minimum: 0 },
        totalLoc:   { type: 'integer', minimum: 0 },
        riskCount:  { type: 'integer', minimum: 0 },
      },
    }),
    phases: [1],
    copilotTools: ['read', 'edit', 'search', 'execute'],
    claudeTools: CLAUDE_TOOLS,
  },
  'knowledge-builder': {
    name: 'knowledge-builder',
    displayName: 'Knowledge Builder',
    description: 'Investigates a legacy codebase and builds a structured knowledge base documenting its architecture, patterns, and behaviors.',
    outputSchema: KnowledgeBuilderSchema,
    inputJsonSchema: inputSchema({ extraProperties: { moduleGroups: { type: 'array' } } }),
    outputJsonSchema: outputSchema('knowledge-builder', {
      extraProperties: {
        modulesDocumented: { type: 'integer', minimum: 0 },
      },
    }),
    phases: [2],
    copilotTools: ['read', 'edit', 'search', 'execute'],
    claudeTools: CLAUDE_TOOLS,
  },
  'migration-planner': {
    name: 'migration-planner',
    displayName: 'Migration Planner',
    description: 'Creates a detailed, ordered migration plan by analyzing the knowledge base and producing task breakdowns for code migration.',
    outputSchema: MigrationPlannerSchema,
    inputJsonSchema: inputSchema({ extraProperties: { analysisFiles: { type: 'array' } } }),
    outputJsonSchema: outputSchema('migration-planner', {
      extraProperties: {
        groupCount: { type: 'integer', minimum: 0 },
        strategy:   { type: 'string' },
      },
    }),
    phases: [3],
    copilotTools: ['read', 'edit', 'search'],
    claudeTools: CLAUDE_TOOLS,
  },
  'task-decomposer': {
    name: 'task-decomposer',
    displayName: 'Task Decomposer',
    description: 'Decomposes one module group into atomic migration tasks using the selected strategy and KB analysis files.',
    outputSchema: TaskDecomposerSchema,
    inputJsonSchema: inputSchema({
      extraRequired: ['taskId'],
      extraProperties: {
        taskId:    { type: 'string', minLength: 1 },
        groupFile: { type: 'string' },
      },
    }),
    outputJsonSchema: outputSchema('task-decomposer', {
      extraRequired: ['taskId'],
      extraProperties: {
        taskId:    { type: 'string', minLength: 1 },
        taskCount: { type: 'integer', minimum: 0 },
      },
      overrideOutputFiles: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1 },
    }),
    phases: [3],
    copilotTools: ['read', 'edit', 'search'],
    claudeTools: CLAUDE_TOOLS,
  },
  'adjudicator': {
    name: 'adjudicator',
    displayName: 'Adjudicator',
    description: 'Evaluates competing implementation plans or design decisions and selects the best option.',
    outputSchema: AdjudicatorSchema,
    inputJsonSchema: inputSchema({
      extraProperties: {
        taskId:  { type: 'string', minLength: 1 },
        options: { type: 'object' },
      },
    }),
    outputJsonSchema: outputSchema('adjudicator', {
      extraProperties: {
        taskId:   { type: 'string', minLength: 1 },
        decision: { type: 'string', minLength: 1 },
      },
    }),
    phases: [3],
    copilotTools: ['read', 'edit', 'search', 'execute'],
    claudeTools: CLAUDE_TOOLS,
  },
  'code-migrator': {
    name: 'code-migrator',
    displayName: 'Code Migrator',
    description: 'Migrates source code from legacy to target platform according to a specific task in the migration plan.',
    outputSchema: CodeMigratorSchema,
    inputJsonSchema: inputSchema({
      extraRequired: ['taskId'],
      extraProperties: {
        taskId:      { type: 'string', minLength: 1 },
        sourceFiles: { type: 'array', items: { type: 'string' } },
        targetFiles: { type: 'array', items: { type: 'string' } },
      },
    }),
    outputJsonSchema: outputSchema('code-migrator', {
      extraProperties: {
        taskId: { type: 'string', minLength: 1 },
        parity: { enum: ['pass', 'partial', 'fail'] },
        issues: { type: 'array' },
      },
    }),
    phases: [4],
    copilotTools: ['read', 'edit', 'search', 'execute'],
    claudeTools: CLAUDE_TOOLS,
  },
  'parity-verifier': {
    name: 'parity-verifier',
    displayName: 'Parity Verifier',
    description: 'Verifies behavioral parity between original source code and migrated target code.',
    outputSchema: ParityVerifierSchema,
    inputJsonSchema: inputSchema({
      extraRequired: ['taskId'],
      extraProperties: {
        taskId:      { type: 'string', minLength: 1 },
        sourceFiles: { type: 'array', items: { type: 'string' } },
        targetFiles: { type: 'array', items: { type: 'string' } },
      },
    }),
    outputJsonSchema: outputSchema('parity-verifier', {
      extraRequired: ['taskId', 'parity', 'issues'],
      extraProperties: {
        taskId: { type: 'string', minLength: 1 },
        parity: { enum: ['pass', 'partial', 'fail'] },
        issues: {
          type: 'array',
          items: {
            type: 'object',
            required: ['severity', 'description'],
            properties: {
              severity:       { enum: ['critical', 'major', 'minor'] },
              description:    { type: 'string', minLength: 1 },
              sourceLocation: { type: 'string' },
              targetLocation: { type: 'string' },
            },
          },
        },
      },
    }),
    phases: [4],
    copilotTools: ['read', 'edit', 'search', 'execute'],
    claudeTools: CLAUDE_TOOLS,
  },
  'test-writer': {
    name: 'test-writer',
    displayName: 'Test Writer',
    description: 'Writes unit and integration tests for changes made by the code-writer.',
    outputSchema: TestWriterSchema,
    inputJsonSchema: inputSchema({
      extraRequired: ['taskId'],
      extraProperties: {
        taskId:      { type: 'string', minLength: 1 },
        sourceFiles: { type: 'array', items: { type: 'string' } },
        targetFiles: { type: 'array', items: { type: 'string' } },
      },
    }),
    outputJsonSchema: outputSchema('test-writer', {
      extraRequired: ['taskId'],
      extraProperties: {
        taskId: { type: 'string', minLength: 1 },
      },
    }),
    phases: [4],
    copilotTools: ['read', 'edit', 'search', 'execute'],
    claudeTools: CLAUDE_TOOLS,
  },
  'failure-adjudicator': {
    name: 'failure-adjudicator',
    displayName: 'Failure Adjudicator',
    description: 'Diagnoses migration failures, evaluates competing fix strategies, and selects/executes the best recovery path.',
    outputSchema: FailureAdjudicatorSchema,
    inputJsonSchema: inputSchema({
      extraRequired: ['taskId', 'failureType'],
      extraProperties: {
        taskId:        { type: 'string', minLength: 1 },
        failureType:   { enum: ['parity', 'build', 'test', 'blocked'] },
        failureReport: { type: 'string' },
      },
    }),
    outputJsonSchema: outputSchema('failure-recovery', {
      extraRequired: ['taskId', 'failureType', 'attempts', 'scopeReduced'],
      extraProperties: {
        taskId:       { type: 'string', minLength: 1 },
        failureType:  { enum: ['parity', 'build', 'test', 'blocked'] },
        attempts:     { type: 'integer', minimum: 1 },
        scopeReduced: { type: 'boolean' },
      },
    }),
    phases: [4],
    copilotTools: ['read', 'edit', 'search', 'execute'],
    claudeTools: CLAUDE_TOOLS,
  },
  'final-parity-checker': {
    name: 'final-parity-checker',
    displayName: 'Final Parity Checker',
    description: 'Performs a comprehensive post-migration audit to ensure the entire migrated codebase is complete with no gaps, stubs, or behavioral differences.',
    outputSchema: FinalParityCheckerSchema,
    inputJsonSchema: inputSchema({ extraProperties: { targetPath: { type: 'string' } } }),
    outputJsonSchema: outputSchema('final-parity-checker', {
      extraProperties: {
        fixes: {
          type: 'array',
          items: {
            type: 'object',
            required: ['description', 'sourceFile', 'targetFile'],
            properties: {
              description: { type: 'string', minLength: 1 },
              sourceFile:  { type: 'string', minLength: 1 },
              targetFile:  { type: 'string', minLength: 1 },
            },
          },
        },
      },
    }),
    phases: [5],
    copilotTools: ['read', 'edit', 'search', 'execute'],
    claudeTools: CLAUDE_TOOLS,
  },
  'e2e-test-crafter': {
    name: 'e2e-test-crafter',
    displayName: 'E2E Test Crafter',
    description: 'Plans and coordinates end-to-end test suites for the fully migrated codebase, delegating individual suite writing to test-writer agents.',
    outputSchema: E2eTestCrafterSchema,
    inputJsonSchema: inputSchema({ extraProperties: { testFramework: { type: 'string' } } }),
    outputJsonSchema: outputSchema('e2e-test-crafter', {
      extraProperties: {
        suitesPlanned:   { type: 'integer', minimum: 0 },
        suitesCompleted: { type: 'integer', minimum: 0 },
      },
    }),
    phases: [6],
    copilotTools: ['read', 'edit', 'search', 'execute'],
    claudeTools: CLAUDE_TOOLS,
  },
  'documentation-writer': {
    name: 'documentation-writer',
    displayName: 'Documentation Writer',
    description: 'Produces comprehensive documentation for the migrated codebase including architecture guides, API docs, and migration notes.',
    outputSchema: DocumentationWriterSchema,
    inputJsonSchema: inputSchema({
      extraProperties: { documentationPaths: { type: 'array', items: { type: 'string' } } },
    }),
    outputJsonSchema: outputSchema('documentation-writer', {
      extraProperties: {
        documentsWritten: { type: 'integer', minimum: 0 },
      },
    }),
    phases: [6],
    copilotTools: ['read', 'edit', 'search'],
    claudeTools: CLAUDE_TOOLS,
  },
  'migration-runner': {
    name: 'migration-runner',
    displayName: 'Migration Runner',
    description: 'Top-level entry point that launches and manages the migration orchestrator for large-scale legacy codebase migrations.',
    outputSchema: MigrationRunnerSchema,
    inputJsonSchema: inputSchema({ extraProperties: { configPath: { type: 'string', minLength: 1 } } }),
    outputJsonSchema: outputSchema('migration-runner', {
      extraProperties: {
        projectName:          { type: 'string' },
        orchestratorLaunched: { type: 'boolean' },
      },
    }),
    phases: [],
    copilotTools: ['read', 'edit', 'search', 'execute'],
    claudeTools: CLAUDE_TOOLS,
  },
  'idiomatic-reviewer': {
    name: 'idiomatic-reviewer',
    displayName: 'Idiomatic Reviewer',
    description: 'Reviews the migrated codebase for idiomatic patterns in the target language, producing a report of issues and suggestions.',
    outputSchema: IdiomaticReviewerSchema,
    inputJsonSchema: inputSchema(),
    outputJsonSchema: outputSchema('idiomatic-reviewer', {
      extraProperties: {
        issues: {
          type: 'array',
          items: {
            type: 'object',
            required: ['file', 'issue', 'suggestion'],
            properties: {
              file:       { type: 'string', minLength: 1 },
              issue:      { type: 'string', minLength: 1 },
              suggestion: { type: 'string', minLength: 1 },
            },
          },
        },
      },
    }),
    phases: [8],
    copilotTools: ['read', 'search'],
    claudeTools: CLAUDE_TOOLS,
  },
  'idiomatic-refactorer': {
    name: 'idiomatic-refactorer',
    displayName: 'Idiomatic Refactorer',
    description: 'Applies a single idiomatic improvement suggestion from the idiomatic review report to a specific file.',
    outputSchema: IdiomaticRefactorerSchema,
    inputJsonSchema: inputSchema({
      extraProperties: {
        targetFile:      { type: 'string', minLength: 1 },
        idiomaticReport: { type: 'string', minLength: 1 },
      },
    }),
    outputJsonSchema: outputSchema('idiomatic-refactorer'),
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
