import { z } from 'zod';

export const AGENT_NAMES = [
  'knowledge-builder',
  'migration-planner',
  'adjudicator',
  'code-migrator',
  'parity-verifier',
  'test-writer',
  'parity-failure-resolver',
  'final-parity-checker',
  'e2e-test-crafter',
  'documentation-writer',
  'idiomatic-reviewer',
  'idiomatic-planner',
  'idiomatic-refactorer',
] as const;

export const AgentNameSchema = z.enum(AGENT_NAMES);
export type AgentName = z.infer<typeof AgentNameSchema>;

const PathArraySchema = z.array(z.string().min(1));
const StringArraySchema = z.array(z.string());
const LooseObjectSchema = z.object({}).passthrough();

const TaskScopeSchema = z.object({
  description: z.string().optional(),
  acceptanceCriteria: StringArraySchema.optional(),
  parityChecks: StringArraySchema.optional(),
  lineRange: z.object({ start: z.number().int(), end: z.number().int() }).optional(),
  symbols: z.array(LooseObjectSchema).optional(),
}).passthrough();

const RemediationContextSchema = z.object({
  failureKind: z.string(),
  failureTarget: z.object({
    wave: z.number().int().optional(),
    taskId: z.string().optional(),
    check: z.string().optional(),
  }).passthrough(),
  artifactPaths: StringArraySchema,
  expectedSuccessCondition: z.string(),
  adjudicationReportPath: z.string().optional(),
  parityIssues: z.array(LooseObjectSchema).optional(),
  priorAttempts: z.array(LooseObjectSchema).optional(),
}).passthrough();

const ExecutionStrategySchema = z.object({
  executionMode: z.enum(['per-task', 'wave-barrier', 'sync-epoch']),
  maxParallelAgents: z.number().int().min(1),
  waveControl: z.object({ maxConvergenceIterations: z.number().int().min(0) }),
  maxRetriesPerTask: z.number().int().min(1),
  buildCommand: z.string().optional(),
  testCommand: z.string().optional(),
  formatCommand: z.string().optional(),
  lintCommand: z.string().optional(),
  requiresNonOverlappingTargets: z.literal(true),
});

const AgentContextBaseSchema = z.object({
  agent: AgentNameSchema,
  projectName: z.string().min(1),
  phase: z.number().int().min(0).max(8),
  taskId: z.string().min(1).optional(),
  config: z.object({
    source: z.object({ path: z.string().min(1), language: z.string().min(1) }),
    target: z.object({
      language: z.string().min(1),
      framework: z.string().optional(),
      outputPath: z.string().min(1),
    }),
  }),
  inputFiles: PathArraySchema,
  outputPath: z.string().min(1),
  guidance: z.array(z.string().min(1)).optional(),
});

const PayloadSchemas = {
  'knowledge-builder': z.object({
    dependencySummaryPath: z.string().min(1),
    moduleGroups: z.array(LooseObjectSchema).optional(),
  }).passthrough(),
  'migration-planner': z.object({
    executionStrategy: ExecutionStrategySchema,
    dependencySummaryPath: z.string().min(1),
    analysisFiles: PathArraySchema.optional(),
  }).passthrough(),
  adjudicator: z.object({
    competingStrategiesFile: z.string().optional(),
    decisionType: z.string().min(1),
    options: LooseObjectSchema.optional(),
  }).passthrough(),
  'code-migrator': z.object({
    taskId: z.string().min(1),
    sourceFiles: PathArraySchema,
    targetFiles: PathArraySchema,
    taskScope: TaskScopeSchema.optional(),
    remediationContext: RemediationContextSchema.optional(),
    kbEntry: z.string().optional(),
    taskPlanSlice: z.string().optional(),
  }).passthrough(),
  'parity-verifier': z.object({
    taskId: z.string().min(1),
    sourceFiles: PathArraySchema,
    targetFiles: PathArraySchema,
    taskScope: TaskScopeSchema.optional(),
    taskPlanSlice: z.string().optional(),
  }).passthrough(),
  'test-writer': z.object({
    taskId: z.string().min(1),
    sourceFiles: PathArraySchema.optional(),
    targetFiles: PathArraySchema.optional(),
    testType: z.enum(['unit', 'e2e']),
    e2eSuiteBrief: LooseObjectSchema.optional(),
    testCommand: z.string().optional(),
    taskScope: TaskScopeSchema.optional(),
  }).passthrough(),
  'parity-failure-resolver': z.object({
    taskId: z.string().min(1),
    sourceFiles: PathArraySchema,
    targetFiles: PathArraySchema,
    failureType: z.string().optional(),
    failureReport: z.string().optional(),
    attemptNumber: z.number().int().min(1),
    taskScope: TaskScopeSchema.optional(),
    remediationContext: RemediationContextSchema.optional(),
  }).passthrough(),
  'final-parity-checker': LooseObjectSchema,
  'e2e-test-crafter': z.object({ planOnly: z.boolean().optional() }).passthrough(),
  'documentation-writer': z.object({ documentationPaths: PathArraySchema.optional() }).passthrough(),
  'idiomatic-reviewer': z.object({
    scope: z.object({
      unitId: z.string().optional(),
      unitName: z.string().optional(),
      targetPath: z.string().optional(),
    }).passthrough().optional(),
  }).passthrough(),
  'idiomatic-planner': z.object({
    reviewFindings: z.object({ issues: z.array(LooseObjectSchema) }).passthrough(),
  }).passthrough(),
  'idiomatic-refactorer': z.object({
    task: z.object({
      id: z.string().optional(),
      name: z.string().optional(),
      description: z.string().optional(),
      files: PathArraySchema,
      issues: z.array(LooseObjectSchema).optional(),
      dependencies: StringArraySchema.optional(),
    }).passthrough(),
  }).passthrough(),
} satisfies Record<AgentName, z.ZodTypeAny>;

function contextSchema<A extends AgentName>(
  agent: A,
  payload: (typeof PayloadSchemas)[A],
) {
  return AgentContextBaseSchema.extend({
    agent: z.literal(agent),
    payload: payload.optional(),
  }).strict();
}

function taskContextSchema<A extends AgentName>(
  agent: A,
  payload: (typeof PayloadSchemas)[A],
) {
  return contextSchema(agent, payload).extend({ taskId: z.string().min(1) });
}

export const AGENT_CONTEXT_SCHEMAS = {
  'knowledge-builder': contextSchema('knowledge-builder', PayloadSchemas['knowledge-builder']),
  'migration-planner': contextSchema('migration-planner', PayloadSchemas['migration-planner']),
  adjudicator: contextSchema('adjudicator', PayloadSchemas.adjudicator),
  'code-migrator': taskContextSchema('code-migrator', PayloadSchemas['code-migrator']),
  'parity-verifier': taskContextSchema('parity-verifier', PayloadSchemas['parity-verifier']),
  'test-writer': taskContextSchema('test-writer', PayloadSchemas['test-writer']),
  'parity-failure-resolver': taskContextSchema('parity-failure-resolver', PayloadSchemas['parity-failure-resolver']),
  'final-parity-checker': contextSchema('final-parity-checker', PayloadSchemas['final-parity-checker']),
  'e2e-test-crafter': contextSchema('e2e-test-crafter', PayloadSchemas['e2e-test-crafter']),
  'documentation-writer': contextSchema('documentation-writer', PayloadSchemas['documentation-writer']),
  'idiomatic-reviewer': taskContextSchema('idiomatic-reviewer', PayloadSchemas['idiomatic-reviewer']),
  'idiomatic-planner': contextSchema('idiomatic-planner', PayloadSchemas['idiomatic-planner']),
  'idiomatic-refactorer': taskContextSchema('idiomatic-refactorer', PayloadSchemas['idiomatic-refactorer']),
} satisfies Record<AgentName, z.ZodTypeAny>;

export type AgentPayloadByName = {
  [A in AgentName]: z.input<(typeof PayloadSchemas)[A]>;
};

export type TypedAgentContextByName = {
  [A in AgentName]: z.infer<(typeof AGENT_CONTEXT_SCHEMAS)[A]>;
};

export type TypedAgentContext = TypedAgentContextByName[AgentName];
