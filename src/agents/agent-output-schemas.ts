/**
 * @module agents/agent-output-schemas
 *
 * Base Zod schemas and parsing utilities for structured output blocks
 * emitted by AAMF agents.
 * Per-agent schema extensions live in the AGENT_REGISTRY (registry.ts).
 */
import { join } from 'node:path';
import { z } from 'zod';
import { fileExists, readJson } from '../util/fs.js';

/**
 * Base Zod schema for structured output blocks emitted by AAMF agents.
 * Agents write a fenced ```aamf-json block to stdout with this shape.
 */
export const AamfOutputBase = z.object({
  status: z.enum(['completed', 'failed', 'needs-review']),
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
  status: z.enum(['completed', 'failed', 'needs-review']),
  outputFiles: z.array(z.string()).default([]),
  parity: z.enum(['pass', 'partial', 'fail']).optional(),
  issues: z.array(z.object({
    severity: z.enum(['critical', 'major', 'minor']),
    description: z.string(),
    details: z.string(),
    sourceLocation: z.string(),
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
  /** Absolute path to the SQLite knowledge-base database written by the indexer. */
  dbPath: z.string().min(1),
});

// ─── Parsing helpers ─────────────────────────────────────────────────────────

/**
 * Extract and validate the last ```aamf-json fenced block from agent stdout.
 */
export function parseAamfOutput<T extends z.ZodTypeAny>(
  stdout: string,
  schema: T,
): { data: z.infer<T>; parsed: true } | { parsed: false; error: string } {
  const blockRegex = /```aamf-json\r?\n([\s\S]*?)```/g;
  let lastMatch: RegExpExecArray | null = null;
  let match: RegExpExecArray | null;
  while ((match = blockRegex.exec(stdout)) !== null) {
    lastMatch = match;
  }

  if (!lastMatch) {
    return { parsed: false, error: MISSING_BLOCK_ERROR };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(lastMatch[1]!.trim());
  } catch (err) {
    return { parsed: false, error: `malformed JSON in aamf-json block: ${String(err)}` };
  }

  const result = schema.safeParse(raw);
  if (!result.success) {
    return { parsed: false, error: `schema validation failed: ${result.error.message}` };
  }

  return { data: result.data, parsed: true };
}

/**
 * Read a sidecar `.result.json` file for a task.
 * @deprecated Sidecar files are no longer used. Parity results are
 * extracted from the aamf-json output block. Retained for backward
 * compatibility only.
 */
export async function readTaskResultJson(
  progressDir: string,
  agent: string,
  taskId: string,
): Promise<TaskResult | undefined> {
  const sidecarPath = join(progressDir, 'artifacts', 'results', `${agent}-${taskId}.result.json`);
  if (!(await fileExists(sidecarPath))) return undefined;
  try {
    const raw = await readJson<unknown>(sidecarPath);
    return TaskResultSchema.parse(raw);
  } catch {
    return undefined;
  }
}
