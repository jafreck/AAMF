/**
 * @module agents/agent-output-schemas
 *
 * Base Zod schemas for structured output blocks emitted by AAMF agents.
 * Per-agent schema extensions live in the AGENT_REGISTRY (registry.ts).
 */
import { z } from 'zod';

/**
 * Base Zod schema for structured output blocks emitted by AAMF agents.
 * Agents write a fenced ```aamf-json block to stdout with this shape.
 */
export const AamfOutputBase = z.object({
  status: z.enum(['completed', 'failed', 'needs-review']),
  agent: z.string().min(1),
  taskId: z.string().min(1).optional(),
  tokenUsage: z.object({
    prompt: z.number().int(),
    completion: z.number().int(),
    total: z.number().int(),
  }).optional(),
  notes: z.string().optional(),
}).passthrough();

export type AamfOutputBaseType = z.infer<typeof AamfOutputBase>;

/**
 * JSON schema for structured agent task results.
 * @deprecated Parity results are now extracted from aamf-json output directly.
 * Retained for backward compatibility with readTaskResultJson.
 */
export const TaskResultSchema = z.object({
  taskId: z.string().min(1),
  agent: z.string().min(1),
  status: z.enum(['completed', 'failed', 'needs-review']),
  outputFiles: z.array(z.string()).default([]),
  parity: z.enum(['pass', 'partial', 'fail']).optional(),
  issues: z.array(z.object({
    severity: z.enum(['critical', 'major', 'minor']),
    description: z.string(),
    sourceLocation: z.string().optional(),
    targetLocation: z.string().optional(),
  })).default([]),
  metrics: z.object({
    linesOfCode: z.number().int().optional(),
    tokensUsed: z.number().int().optional(),
    durationMs: z.number().int().optional(),
  }).optional(),
  notes: z.string().optional(),
});

export type TaskResult = z.infer<typeof TaskResultSchema>;

export const MISSING_BLOCK_ERROR = 'missing aamf-json block';

/**
 * Extended output schema for the KB indexer pseudo-agent.
 * Not part of the standard AgentName union — used by the KB indexing step.
 */
export const KbIndexerOutput = AamfOutputBase.extend({
  agent: z.literal('kb-indexer'),
  /** Absolute path to the SQLite knowledge-base database written by the indexer. */
  dbPath: z.string().min(1),
});
