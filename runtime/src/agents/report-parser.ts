/**
 * @module agents/report-parser
 *
 * Parsers for idiomatic review reports and final parity reports.
 * Extracted from ResultParser for focused single-responsibility modules.
 */
import { readFile } from 'node:fs/promises';
import { fileExists } from '../util/fs.js';

/**
 * Parse an idiomatic review report and extract individual issues.
 */
export async function parseIdiomaticReport(
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
 */
export async function parseFinalParityReport(
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
