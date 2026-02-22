import { readFile } from 'node:fs/promises';
import { MigrationTask } from './types.js';

/**
 * Parses agent output files into structured results.
 *
 * Handles migration-plan.md → {@link MigrationTask}[] conversion,
 * token-usage extraction from agent stdout/stderr, and final parity
 * report parsing for required fixes.
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
   * @param content - The full markdown string of the migration plan.
   */
  static parseMigrationPlanContent(content: string): MigrationTask[] {
    const tasks: MigrationTask[] = [];
    // Split on task headers like "## Task: task-001 - Module Name"
    // or "### task-001: Module Name"
    const taskBlocks = content.split(/^#{2,3}\s+(?:Task:\s*)?/m).filter(Boolean);

    for (const block of taskBlocks) {
      const task = ResultParser.parseTaskBlock(block);
      if (task) tasks.push(task);
    }
    return tasks;
  }

  /**
   * Parse an individual task block into a {@link MigrationTask}, or `null`
   * if the block does not contain a recognisable task header.
   */
  private static parseTaskBlock(block: string): MigrationTask | null {
    // Parse task ID from the first line: "task-001 - Some Name" or "task-001: Some Name"
    const headerMatch = block.match(/^(task-\d+)\s*[-:]\s*(.+)/m);
    if (!headerMatch) return null;

    const id = headerMatch[1]!;
    const name = headerMatch[2]!.trim();

    // Source files
    const sourceFiles = ResultParser.extractListItems(block, /source\s*files?/i);
    // Target files
    const targetFiles = ResultParser.extractListItems(block, /target\s*files?/i);
    // Dependencies
    const dependencies = ResultParser.extractListItems(block, /dependenc/i);
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
        const listMatch = line.match(/^\s*[-*•]\s+(.+)/);
        if (listMatch) {
          items.push(listMatch[1]!.trim().replace(/`/g, ''));
        } else if (line.match(/^\s*$/) || line.match(/^#{1,4}\s/) || line.match(/^\*\*/)) {
          inSection = false;
        }
      }
    }
    return items;
  }

  /**
   * Parse token usage from agent stdout/stderr output.
   *
   * Recognises formats such as `prompt_tokens: 1234`, `completion-tokens: 567`,
   * and `total tokens: 1801`. When only a total is available the split is
   * estimated as 60 % prompt / 40 % completion.
   *
   * @param output - Raw agent output text.
   * @returns Parsed token counts, or `undefined` if no usage data is found.
   */
  static parseTokenUsage(
    output: string,
  ): { prompt: number; completion: number; total: number } | undefined {
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
      return { prompt: Math.round(total * 0.6), completion: Math.round(total * 0.4), total };
    }

    return undefined;
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
