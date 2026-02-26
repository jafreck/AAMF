import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { MigrationTask } from './types.js';
import { fileExists, readJson } from '../util/fs.js';

export const MISSING_BLOCK_ERROR = 'missing aamf-json block';

// ─── AamfOutput Schemas ───────────────────────────────────────────────────────

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

/** Per-agent output schemas — each locks `agent` to its canonical name. */
export const MigrationOrchestratorOutput = AamfOutputBase.extend({ agent: z.literal('migration-orchestrator') });
export const ImpactAssessorOutput = AamfOutputBase.extend({ agent: z.literal('impact-assessor') });
export const KnowledgeBuilderOutput = AamfOutputBase.extend({ agent: z.literal('knowledge-builder') });
export const LargeFileAnalyzerOutput = AamfOutputBase.extend({ agent: z.literal('large-file-analyzer') });
export const MigrationPlannerOutput = AamfOutputBase.extend({ agent: z.literal('migration-planner') });
export const AdjudicatorOutput = AamfOutputBase.extend({ agent: z.literal('adjudicator') });
export const CodeMigratorOutput = AamfOutputBase.extend({ agent: z.literal('code-migrator') });
export const ParityVerifierOutput = AamfOutputBase.extend({ agent: z.literal('parity-verifier') });
export const TestWriterOutput = AamfOutputBase.extend({ agent: z.literal('test-writer') });
export const FailureRecoveryOutput = AamfOutputBase.extend({ agent: z.literal('failure-recovery') });
export const FinalParityCheckerOutput = AamfOutputBase.extend({ agent: z.literal('final-parity-checker') });
export const E2eTestCrafterOutput = AamfOutputBase.extend({ agent: z.literal('e2e-test-crafter') });
export const DocumentationWriterOutput = AamfOutputBase.extend({ agent: z.literal('documentation-writer') });
export const MigrationRunnerOutput = AamfOutputBase.extend({ agent: z.literal('migration-runner') });
export const IdiomaticReviewerOutput = AamfOutputBase.extend({ agent: z.literal('idiomatic-reviewer') });
export const IdiomaticRefactorerOutput = AamfOutputBase.extend({ agent: z.literal('idiomatic-refactorer') });
export const KbIndexerOutput = AamfOutputBase.extend({
  agent: z.literal('kb-indexer'),
  /** Absolute path to the SQLite knowledge-base database written by the indexer. */
  dbPath: z.string().min(1),
});

/**
 * JSON schema for structured agent task results (sidecar `.result.json`).
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

/** Summary of parsing outcomes for a migration plan. */
export interface ParseSummary {
  totalParsed: number;
  failedBlocks: number;
  failedBlockHeaders: string[];
  duplicateIds: string[];
  danglingDependencies: Array<{ taskId: string; missingDeps: string[] }>;
}

/**
 * Parses agent output files into structured results.
 *
 * Handles migration-plan.md → {@link MigrationTask}[] conversion,
 * token-usage extraction from agent stdout/stderr, and final parity
 * report parsing for required fixes.
 *
 * Also supports structured JSON sidecar outputs (`.result.json`).
 */
export class ResultParser {
  /**
   * Parse a migration-plan.md file into an array of {@link MigrationTask}.
   * Uses regex-based extraction from the well-defined markdown format.
   * @param planPath - Absolute path to the migration plan markdown file.
   */
  static async parseMigrationPlan(planPath: string): Promise<MigrationTask[]> {
    const content = await readFile(planPath, 'utf-8');
    return ResultParser.parseMigrationPlanContent(content);
  }

  /**
   * Parse raw migration-plan markdown content into {@link MigrationTask}[].
   * Performs validation, deduplication, and dependency checking.
   * @param content - The full markdown string of the migration plan.
   * @param log - Optional logger callback for warnings/errors (defaults to console).
   */
  static parseMigrationPlanContent(
    content: string,
    log?: { warn: (msg: string) => void; error: (msg: string) => void; info: (msg: string) => void },
  ): MigrationTask[] {
    const logger = log ?? { warn: console.warn, error: console.error, info: console.info };
    const tasks: MigrationTask[] = [];
    const failedBlockHeaders: string[] = [];

    // Split on task headers like "## Task: task-001 - Module Name"
    // or "### task-001: Module Name"
    const taskBlocks = content.split(/^#{2,3}\s+(?:Task:\s*)?(?=task-\d+)/mi).filter(Boolean);

    for (const block of taskBlocks) {
      const task = ResultParser.parseTaskBlock(block);
      if (task) {
        // Validate required fields
        const warnings: string[] = [];
        if (!task.id) {
          logger.error(`Task block has empty id, skipping`);
          const headerLine = block.split('\n')[0]?.trim() ?? '(unknown)';
          failedBlockHeaders.push(headerLine);
          continue;
        }
        if (!task.name) {
          logger.error(`Task ${task.id} has empty name, skipping`);
          const headerLine = block.split('\n')[0]?.trim() ?? '(unknown)';
          failedBlockHeaders.push(headerLine);
          continue;
        }
        if (task.sourceFiles.length === 0) {
          logger.error(`Task ${task.id} has no source files, skipping`);
          const headerLine = block.split('\n')[0]?.trim() ?? '(unknown)';
          failedBlockHeaders.push(headerLine);
          continue;
        }

        // Warn for missing optional fields
        if (!task.knowledgeBaseRef) warnings.push('knowledgeBaseRef');
        if (task.acceptanceCriteria.length === 0) warnings.push('acceptanceCriteria');
        if (task.parityChecks.length === 0) warnings.push('parityChecks');
        if (warnings.length > 0) {
          logger.warn(`Task ${task.id} is missing optional fields: ${warnings.join(', ')}`);
        }

        tasks.push(task);
      } else {
        // Block didn't match task header pattern — not necessarily an error
        // (could be a preamble or non-task heading)
        const headerLine = block.split('\n')[0]?.trim() ?? '(unknown)';
        // Only count as failed if it looks like it was *trying* to be a canonical task
        if (/task-\d+/i.test(headerLine)) {
          failedBlockHeaders.push(headerLine);
        }
      }
    }

    // Duplicate ID detection – keep first occurrence
    const seenIds = new Set<string>();
    const duplicateIds: string[] = [];
    const deduped: MigrationTask[] = [];
    for (const task of tasks) {
      if (seenIds.has(task.id)) {
        logger.error(`Duplicate task ID "${task.id}" — keeping first occurrence, discarding duplicate`);
        duplicateIds.push(task.id);
      } else {
        seenIds.add(task.id);
        deduped.push(task);
      }
    }

    // Dependency validation – check that all referenced deps exist
    const validIds = new Set(deduped.map(t => t.id));
    const danglingDeps: Array<{ taskId: string; missingDeps: string[] }> = [];
    for (const task of deduped) {
      const missing = task.dependencies.filter(dep => dep !== 'none' && !validIds.has(dep));
      if (missing.length > 0) {
        logger.warn(`Task ${task.id} references non-existent dependencies: ${missing.join(', ')}`);
        danglingDeps.push({ taskId: task.id, missingDeps: missing });
      }
    }

    // Error summary
    logger.info(
      `Migration plan parsed: ${deduped.length} tasks OK, ${failedBlockHeaders.length} blocks failed` +
      (duplicateIds.length > 0 ? `, ${duplicateIds.length} duplicate IDs removed` : '') +
      (danglingDeps.length > 0 ? `, ${danglingDeps.length} tasks with dangling dependencies` : ''),
    );
    if (failedBlockHeaders.length > 0) {
      logger.warn(`Unparseable block headers: ${failedBlockHeaders.join('; ')}`);
    }

    return deduped;
  }

  /**
   * Read a structured JSON sidecar result file for a given agent/task.
   * Returns the validated `TaskResult` or `undefined` if the file doesn't
   * exist or fails validation.
   *
   * @param progressDir - The migration progress directory.
   * @param agent - Agent name.
   * @param taskId - Task identifier.
   */
  static async readTaskResultJson(
    progressDir: string,
    agent: string,
    taskId: string,
  ): Promise<TaskResult | undefined> {
    const sidecarPath = join(progressDir, 'results', `${agent}-${taskId}.result.json`);
    if (!(await fileExists(sidecarPath))) return undefined;
    try {
      const raw = await readJson<unknown>(sidecarPath);
      return TaskResultSchema.parse(raw);
    } catch {
      return undefined;
    }
  }

  /**
   * Extract the last ```aamf-json fenced block from agent stdout and validate
   * it against the provided Zod schema.
   *
   * @param stdout - Raw agent stdout string.
   * @param schema - Zod schema to validate the parsed JSON against.
   * @returns `{ data, parsed: true }` on success, or `{ parsed: false, error }`.
   */
  static parseAamfOutput<T extends z.ZodTypeAny>(
    stdout: string,
    schema: T,
  ): { data: z.infer<T>; parsed: true } | { parsed: false; error: string } {
    // Find all ```aamf-json ... ``` blocks; use the last one.
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
   * Parse an individual task block into a {@link MigrationTask}, or `null`
   * if the block does not contain a recognisable task header.
   *
   * Expects the canonical format produced by the migration-planner agent:
   *   "task-001 - Some Name" or "task-001: Some Name"
   */
  private static parseTaskBlock(block: string): MigrationTask | null {
    const headerMatch = block.match(/^(task-\d+)\s*[-:]\s*(.+)/m);
    if (!headerMatch) return null;

    const id = headerMatch[1]!;
    const name = headerMatch[2]!.trim();

    // Source files
    const sourceFiles = ResultParser.extractListItems(block, /source\s*files?/i);
    // Target files
    const targetFiles = ResultParser.extractListItems(block, /target\s*files?/i);
    // Dependencies — only accept canonical task-NNN references
    const rawDeps = ResultParser.extractListItems(block, /dependenc/i);
    const dependencies = rawDeps
      .flatMap(dep => {
        const refs = dep.match(/task-\d+/gi);
        return refs ? refs.map(d => d.toLowerCase()) : [];
      });
    // Knowledge base reference
    const kbMatch = block.match(
      /knowledge[\s-]*base[\s-]*(?:ref|reference)?:?\s*[`"]?([^\n`"]+)/i,
    );
    const knowledgeBaseRef = kbMatch?.[1]?.trim() ?? '';
    // Complexity
    const complexityMatch = block.match(/complexity:?\s*(simple|moderate|complex)/i);
    const complexity = (complexityMatch?.[1]?.toLowerCase() ?? 'moderate') as
      | 'simple'
      | 'moderate'
      | 'complex';
    // Description
    const descMatch = block.match(
      /description:?\s*(.+?)(?=\n(?:#{1,4}|\*\*|source|target|depend|complex|accept|parity|knowledge|line))/is,
    );
    const description = descMatch?.[1]?.trim() ?? name;
    // Acceptance criteria
    const acceptanceCriteria = ResultParser.extractListItems(block, /acceptance[\s-]*criteria/i);
    // Parity checks
    const parityChecks = ResultParser.extractListItems(block, /parity[\s-]*checks?/i);
    // Line range
    const lineRangeMatch = block.match(/line[\s-]*range:?\s*(\d+)\s*[-–]\s*(\d+)/i);
    const lineRange = lineRangeMatch
      ? { start: parseInt(lineRangeMatch[1]!, 10), end: parseInt(lineRangeMatch[2]!, 10) }
      : undefined;

    return {
      id,
      name,
      sourceFiles,
      targetFiles,
      knowledgeBaseRef,
      dependencies,
      complexity,
      description,
      acceptanceCriteria,
      parityChecks,
      lineRange,
    };
  }

  /**
   * Extract list items from a section identified by a heading pattern.
   *
   * Supports both inline comma-separated values and subsequent bullet-list
   * items. Extraction stops at the next heading, bold label, or blank line.
   *
   * @param block - The text block to search within.
   * @param sectionPattern - A regex that identifies the section heading.
   */
  private static extractListItems(block: string, sectionPattern: RegExp): string[] {
    const lines = block.split('\n');
    let inSection = false;
    const items: string[] = [];

    for (const line of lines) {
      if (sectionPattern.test(line)) {
        inSection = true;
        // Check if there's an inline value like "Dependencies: task-001, task-002"
        const inlineMatch = line.match(
          new RegExp(sectionPattern.source + '\\w*\\**:?\\**\\s*(.+)', 'i'),
        );
        if (inlineMatch?.[1]) {
          const values = inlineMatch[1]
            .split(/[,;]/)
            .map((v) => v.trim().replace(/^[-*•`]+\s*/, ''))
            .filter((v) => v !== '' && v.toLowerCase() !== 'none' && v.toLowerCase() !== 'n/a');
          items.push(...values);
        }
        continue;
      }
      if (inSection) {
        // Stop section at blank lines, headings, or bold labels (even if preceded by a bullet)
        const stripped = line.replace(/^\s*[-*•]\s+/, '');
        if (line.match(/^\s*$/) || line.match(/^#{1,4}\s/) || /^\*\*/.test(stripped)) {
          inSection = false;
        } else {
          const listMatch = line.match(/^\s*[-*•]\s+(.+)/);
          if (listMatch) {
            items.push(listMatch[1]!.trim().replace(/`/g, ''));
          }
        }
      }
    }
    return items;
  }

  /**
   * Parse token usage from Claude's JSON-based output format.
   *
   * Searches for JSON fragments containing a `usage` object with
   * `input_tokens` and `output_tokens` fields (emitted by the Claude API).
   * Also extracts `cache_read_input_tokens` when present.
   *
   * @param output - Raw agent output text (stdout or stderr).
   * @returns Parsed token counts, or `undefined` if no Claude usage JSON is found.
   */
  static parseClaudeTokenUsage(
    output: string,
  ): { prompt: number; completion: number; total: number; cachedInput?: number } | undefined {
    // Match JSON objects that contain a "usage" key with input_tokens/output_tokens
    const usageRegex = /\{[^{}]*"usage"\s*:\s*\{[^{}]*"input_tokens"\s*:\s*(\d+)[^{}]*"output_tokens"\s*:\s*(\d+)[^{}]*\}/g;
    let lastMatch: RegExpExecArray | null = null;
    let match: RegExpExecArray | null;
    while ((match = usageRegex.exec(output)) !== null) {
      lastMatch = match;
    }

    if (!lastMatch) return undefined;

    const prompt = parseInt(lastMatch[1]!, 10);
    const completion = parseInt(lastMatch[2]!, 10);

    // Extract cache_read_input_tokens from the same usage object if present
    const cacheMatch = lastMatch[0].match(/"cache_read_input_tokens"\s*:\s*(\d+)/);
    const cachedInput = cacheMatch ? parseInt(cacheMatch[1]!, 10) : undefined;

    return { prompt, completion, total: prompt + completion, ...(cachedInput !== undefined && { cachedInput }) };
  }

  /**
   * Parse token usage from agent stdout/stderr output.
   *
   * Recognises formats such as `prompt_tokens: 1234`, `completion-tokens: 567`,
   * and `total tokens: 1801`. When only a total is available the split is
   * estimated as 80 % prompt / 20 % completion (consistent with
   * {@link CostEstimator.estimateFromTotal}).
   *
   * When `runtime` is `'claude-code'`, delegates to {@link parseClaudeTokenUsage}
   * to handle Claude's JSON-based usage format instead.
   *
   * **Note:** Regex-based token extraction from free-form text is unreliable.
   * Agents should emit structured token data inside their `aamf-json` block
   * under the `tokenUsage` field for accurate accounting.
   *
   * @param output - Raw agent output text.
   * @param runtime - Optional runtime identifier; pass `'claude-code'` to parse Claude JSON format.
   * @returns Parsed token counts, or `undefined` if no usage data is found.
   */
  static parseTokenUsage(
    output: string,
    runtime?: string,
  ): { prompt: number; completion: number; total: number } | undefined {
    if (runtime === 'claude-code') {
      return ResultParser.parseClaudeTokenUsage(output);
    }

    const promptMatch = output.match(/prompt[\s_-]*tokens?:?\s*(\d+)/i);
    const completionMatch = output.match(/completion[\s_-]*tokens?:?\s*(\d+)/i);
    const totalMatch = output.match(/total[\s_-]*tokens?:?\s*(\d+)/i);

    if (promptMatch && completionMatch) {
      const prompt = parseInt(promptMatch[1]!, 10);
      const completion = parseInt(completionMatch[1]!, 10);
      return {
        prompt,
        completion,
        total: totalMatch ? parseInt(totalMatch[1]!, 10) : prompt + completion,
      };
    }

    if (totalMatch) {
      const total = parseInt(totalMatch[1]!, 10);
      return { prompt: Math.round(total * 0.8), completion: total - Math.round(total * 0.8), total };
    }

    return undefined;
  }

  /**
   * Parse an idiomatic review report and extract individual issues.
   *
   * Splits the report on H2/H3 headings that begin with "Issue" or "Finding"
   * and extracts file, issue, and suggestion fields from each block.
   *
   * @param reportPath - Absolute path to the idiomatic review report markdown file.
   * @returns Array of issues, or empty array if the file doesn't exist or has no sections.
   */
  static async parseIdiomaticReport(
    reportPath: string,
  ): Promise<Array<{ file: string; issue: string; suggestion: string }>> {
    if (!(await fileExists(reportPath))) return [];
    let content: string;
    try {
      content = await readFile(reportPath, 'utf-8');
    } catch {
      return [];
    }
    const entries: Array<{ file: string; issue: string; suggestion: string }> = [];
    const issueBlocks = content.split(/^#{2,3}\s+(?:Issue|Finding)/mi);
    for (const block of issueBlocks.slice(1)) {
      const fileMatch = block.match(/file:?\s*[`"]?([^\n`"]+)/i);
      const file = fileMatch?.[1]?.trim() ?? '';
      if (!file) continue;
      const issueMatch = block.match(/issue:?\s*[`"]?([^\n`"]+)/i);
      const suggestionMatch = block.match(/suggestion:?\s*[`"]?([^\n`"]+)/i);
      entries.push({
        file,
        issue: issueMatch?.[1]?.trim() ?? '',
        suggestion: suggestionMatch?.[1]?.trim() ?? '',
      });
    }
    return entries;
  }

  /**
   * Parse the final parity report and extract required fixes.
   *
   * Splits the report on headings that begin with "Fix", "Issue", "Gap", or
   * "Discrepancy" and extracts a description, source file, and target file
   * from each block.
   *
   * @param reportPath - Absolute path to the final parity report markdown file.
   */
  static async parseFinalParityReport(
    reportPath: string,
  ): Promise<Array<{ description: string; sourceFile: string; targetFile: string }>> {
    const content = await readFile(reportPath, 'utf-8');
    const fixes: Array<{ description: string; sourceFile: string; targetFile: string }> = [];

    const fixBlocks = content.split(/^#{2,3}\s+(?:Fix|Issue|Gap|Discrepancy)/mi);
    for (const block of fixBlocks.slice(1)) {
      const descMatch = block.match(/^[:\s-]*(.+)/m);
      const sourceMatch = block.match(/source[\s-]*file:?\s*[`"]?([^\n`"]+)/i);
      const targetMatch = block.match(/target[\s-]*file:?\s*[`"]?([^\n`"]+)/i);
      if (descMatch) {
        fixes.push({
          description: descMatch[1]!.trim(),
          sourceFile: sourceMatch?.[1]?.trim() ?? '',
          targetFile: targetMatch?.[1]?.trim() ?? '',
        });
      }
    }
    return fixes;
  }
}
