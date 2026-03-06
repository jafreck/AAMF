/**
 * @module agents/result-parser
 *
 * Backward-compatible facade that re-exports from the focused parser modules.
 * New code should import directly from the sub-modules:
 *   - agent-output-schemas.ts — Zod schemas
 *   - registry.ts — AGENT_REGISTRY with per-agent output schemas
 *   - plan-parser.ts — migration plan & e2e test plan parsing
 *   - token-usage-parser.ts — token usage extraction
 *   - report-parser.ts — idiomatic & parity report parsing
 */
import { join } from 'node:path';
import { z } from 'zod';
import { fileExists, readJson } from '../util/fs.js';

// Re-export schemas
export {
  AamfOutputBase,
  type AamfOutputBaseType,
  TaskResultSchema,
  type TaskResult,
  MISSING_BLOCK_ERROR,
  KbIndexerOutput,
} from './agent-output-schemas.js';

// Re-export per-agent output schemas from registry (backward compatibility)
export {
  MigrationOrchestratorOutput,
  ImpactAssessorOutput,
  KnowledgeBuilderOutput,
  MigrationPlannerOutput,
  TaskDecomposerOutput,
  AdjudicatorOutput,
  CodeMigratorOutput,
  ParityVerifierOutput,
  TestWriterOutput,
  FailureAdjudicatorOutput,
  FailureRecoveryOutput,
  FinalParityCheckerOutput,
  E2eTestCrafterOutput,
  DocumentationWriterOutput,
  MigrationRunnerOutput,
  IdiomaticReviewerOutput,
  IdiomaticRefactorerOutput,
} from './registry.js';

// Re-export plan parser types
export type { ParseSummary } from './plan-parser.js';

// Import from sub-modules for the ResultParser facade class
import { MISSING_BLOCK_ERROR, TaskResultSchema } from './agent-output-schemas.js';
import type { TaskResult } from './agent-output-schemas.js';
import {
  parseMigrationPlan,
  parseMigrationPlanContent,
  parseE2eTestPlan,
  parseE2eTestPlanContent,
  extractListItems,
} from './plan-parser.js';
import {
  parseTokenUsage,
  parseClaudeTokenUsage,
  parseCopilotCliUsage,
} from './token-usage-parser.js';
import {
  parseIdiomaticReport,
  parseFinalParityReport,
} from './report-parser.js';
import type { MigrationTask, E2eSuiteBrief } from './types.js';

/**
 * Backward-compatible ResultParser class.
 *
 * All methods delegate to the focused sub-modules. New code should
 * call the sub-module functions directly instead of going through
 * this class.
 */
export class ResultParser {
  static parseMigrationPlan(planPath: string): Promise<MigrationTask[]> {
    return parseMigrationPlan(planPath);
  }

  static parseMigrationPlanContent(
    content: string,
    log?: { warn: (msg: string) => void; error: (msg: string) => void; info: (msg: string) => void },
  ): MigrationTask[] {
    return parseMigrationPlanContent(content, log);
  }

  static async readTaskResultJson(
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

  static parseAamfOutput<T extends z.ZodTypeAny>(
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

  static parseTokenUsage(
    output: string,
    runtime?: string,
  ): { prompt: number; completion: number; total: number } | undefined {
    return parseTokenUsage(output, runtime);
  }

  static parseClaudeTokenUsage(
    output: string,
  ): { prompt: number; completion: number; total: number; cachedInput?: number } | undefined {
    return parseClaudeTokenUsage(output);
  }

  static parseCopilotCliUsage(
    output: string,
  ): { prompt: number; completion: number; total: number; cachedInput?: number; premiumRequests?: number } | undefined {
    return parseCopilotCliUsage(output);
  }

  static async parseIdiomaticReport(
    reportPath: string,
  ): Promise<Array<{ file: string; issue: string; suggestion: string }>> {
    return parseIdiomaticReport(reportPath);
  }

  static async parseFinalParityReport(
    reportPath: string,
  ): Promise<Array<{ description: string; sourceFile: string; targetFile: string }>> {
    return parseFinalParityReport(reportPath);
  }

  static parseE2eTestPlan(planPath: string): Promise<E2eSuiteBrief[]> {
    return parseE2eTestPlan(planPath);
  }

  static parseE2eTestPlanContent(
    content: string,
    log?: { warn: (msg: string) => void; error: (msg: string) => void; info: (msg: string) => void },
  ): E2eSuiteBrief[] {
    return parseE2eTestPlanContent(content, log);
  }
}
