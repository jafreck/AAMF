/**
 * @module agents/plan-parser
 *
 * Parses migration-plan.md and e2e-test-plan.md into structured task/suite arrays.
 * Extracted from ResultParser for focused single-responsibility modules.
 */
import { readFile } from 'node:fs/promises';
import { MigrationTask, E2eSuiteBrief } from './types.js';

// ─── Migration Plan Parsing ──────────────────────────────────────────────────

export interface ParseSummary {
  totalParsed: number;
  failedBlocks: number;
  failedBlockHeaders: string[];
  duplicateIds: string[];
  danglingDependencies: Array<{ taskId: string; missingDeps: string[] }>;
}

/**
 * Parse a migration-plan.md file into an array of MigrationTask.
 */
export async function parseMigrationPlan(planPath: string): Promise<MigrationTask[]> {
  const content = await readFile(planPath, 'utf-8');
  return parseMigrationPlanContent(content);
}

/**
 * Parse raw migration-plan markdown content into MigrationTask[].
 */
export function parseMigrationPlanContent(
  content: string,
  log?: { warn: (msg: string) => void; error: (msg: string) => void; info: (msg: string) => void },
): MigrationTask[] {
  const logger = log ?? { warn: console.warn, error: console.error, info: console.info };
  const tasks: MigrationTask[] = [];
  const failedBlockHeaders: string[] = [];

  const taskBlocks = content.split(/^#{2,3}\s+(?:Task:\s*)?(?=task-\d+)/mi).filter(Boolean);

  for (const block of taskBlocks) {
    const task = parseTaskBlock(block);
    if (task) {
      const warnings: string[] = [];
      if (!task.id) {
        logger.error(`Task block has empty id, skipping`);
        failedBlockHeaders.push(block.split('\n')[0]?.trim() ?? '(unknown)');
        continue;
      }
      if (!task.name) {
        logger.error(`Task ${task.id} has empty name, skipping`);
        failedBlockHeaders.push(block.split('\n')[0]?.trim() ?? '(unknown)');
        continue;
      }
      if (task.sourceFiles.length === 0) {
        logger.error(`Task ${task.id} has no source files, skipping`);
        failedBlockHeaders.push(block.split('\n')[0]?.trim() ?? '(unknown)');
        continue;
      }

      if (!task.knowledgeBaseRef) warnings.push('knowledgeBaseRef');
      if (task.acceptanceCriteria.length === 0) warnings.push('acceptanceCriteria');
      if (task.parityChecks.length === 0) warnings.push('parityChecks');
      if (warnings.length > 0) {
        logger.warn(`Task ${task.id} is missing optional fields: ${warnings.join(', ')}`);
      }
      tasks.push(task);
    } else {
      const headerLine = block.split('\n')[0]?.trim() ?? '(unknown)';
      if (/task-\d+/i.test(headerLine)) {
        failedBlockHeaders.push(headerLine);
      }
    }
  }

  // Duplicate ID detection
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

  // Dependency validation
  const validIds = new Set(deduped.map(t => t.id));
  const danglingDeps: Array<{ taskId: string; missingDeps: string[] }> = [];
  for (const task of deduped) {
    const missing = task.dependencies.filter(dep => dep !== 'none' && !validIds.has(dep));
    if (missing.length > 0) {
      logger.warn(`Task ${task.id} references non-existent dependencies: ${missing.join(', ')}`);
      danglingDeps.push({ taskId: task.id, missingDeps: missing });
    }
  }

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

function parseTaskBlock(block: string): MigrationTask | null {
  const headerMatch = block.match(/^(task-\d+)\s*[-:]\s*(.+)/m);
  if (!headerMatch) return null;

  const id = headerMatch[1]!;
  const name = headerMatch[2]!.trim();

  const sourceFiles = extractListItems(block, /source\s*files?/i);
  const targetFiles = extractListItems(block, /target\s*files?/i);
  const rawDeps = extractListItems(block, /dependenc/i);
  const dependencies = rawDeps.flatMap(dep => {
    const refs = dep.match(/task-\d+/gi);
    return refs ? refs.map(d => d.toLowerCase()) : [];
  });
  const kbMatch = block.match(/knowledge[\s-]*base[\s-]*(?:ref|reference)?:?\s*[`"]?([^\n`"]+)/i);
  const knowledgeBaseRef = kbMatch?.[1]?.trim() ?? '';
  const complexityMatch = block.match(/complexity:?\s*(simple|moderate|complex)/i);
  const complexity = (complexityMatch?.[1]?.toLowerCase() ?? 'moderate') as 'simple' | 'moderate' | 'complex';
  const descMatch = block.match(
    /description:?\s*(.+?)(?=\n(?:#{1,4}|\*\*|source|target|depend|complex|accept|parity|knowledge|line))/is,
  );
  const description = descMatch?.[1]?.trim() ?? name;
  const acceptanceCriteria = extractListItems(block, /acceptance[\s-]*criteria/i);
  const parityChecks = extractListItems(block, /parity[\s-]*checks?/i);
  const lineRangeMatch = block.match(/line[\s-]*range:?\s*(\d+)\s*[-–]\s*(\d+)/i);
  const lineRange = lineRangeMatch
    ? { start: parseInt(lineRangeMatch[1]!, 10), end: parseInt(lineRangeMatch[2]!, 10) }
    : undefined;

  return { id, name, sourceFiles, targetFiles, knowledgeBaseRef, dependencies, complexity, description, acceptanceCriteria, parityChecks, lineRange };
}

// ─── E2E Test Plan Parsing ───────────────────────────────────────────────────

export async function parseE2eTestPlan(planPath: string): Promise<E2eSuiteBrief[]> {
  const content = await readFile(planPath, 'utf-8');
  return parseE2eTestPlanContent(content);
}

export function parseE2eTestPlanContent(
  content: string,
  log?: { warn: (msg: string) => void; error: (msg: string) => void; info: (msg: string) => void },
): E2eSuiteBrief[] {
  const logger = log ?? { warn: console.warn, error: console.error, info: console.info };
  if (!content.trim()) return [];

  const suites: E2eSuiteBrief[] = [];
  const blocks = content.split(/^(?=###\s+Suite:)/mi).filter(b => /^###\s+Suite:/mi.test(b));

  for (const block of blocks) {
    try {
      const suite = parseSuiteBlock(block);
      if (suite) {
        suites.push(suite);
      } else {
        logger.warn(`Skipping malformed suite block: ${block.split('\n')[0]?.trim() ?? '(unknown)'}`);
      }
    } catch (err) {
      logger.warn(`Skipping malformed suite block: ${block.split('\n')[0]?.trim() ?? '(unknown)'} — ${(err as Error).message}`);
    }
  }

  return suites;
}

function parseSuiteBlock(block: string): E2eSuiteBrief | null {
  const headerMatch = block.match(/^###\s+Suite:\s*(suite-\d+)\s*[-:]\s*(.+)/mi);
  if (!headerMatch) return null;

  const id = headerMatch[1]!.trim();
  const name = headerMatch[2]!.trim();
  if (!id || !name) return null;

  const purposeMatch = block.match(/\*\*Purpose:?\*\*:?\s*(.+)/i) ?? block.match(/Purpose:?\s*(.+)/i);
  const purpose = purposeMatch?.[1]?.trim() ?? '';
  const targetFiles = extractListItems(block, /target\s*files?/i);
  const kbReferences = extractListItems(block, /kb[\s-]*references?/i);
  const frameworkMatch = block.match(/\*\*Framework:?\*\*:?\s*(.+)/i) ?? block.match(/Framework:?\s*(.+)/i);
  const framework = frameworkMatch?.[1]?.trim() ?? '';
  const outputMatch = block.match(/\*\*Output\s*Location:?\*\*:?\s*(.+)/i) ?? block.match(/Output\s*Location:?\s*(.+)/i);
  const outputLocation = outputMatch?.[1]?.trim() ?? '';
  const scenarios = extractListItems(block, /scenarios?/i);

  return { id, name, purpose, targetFiles, kbReferences, framework, outputLocation, scenarios };
}

// ─── Shared Helpers ──────────────────────────────────────────────────────────

/** Extract list items from a section identified by a heading pattern. */
export function extractListItems(block: string, sectionPattern: RegExp): string[] {
  const lines = block.split('\n');
  let inSection = false;
  const items: string[] = [];

  for (const line of lines) {
    if (sectionPattern.test(line)) {
      inSection = true;
      const inlineMatch = line.match(new RegExp(sectionPattern.source + '\\w*\\**:?\\**\\s*(.+)', 'i'));
      if (inlineMatch?.[1]) {
        const values = inlineMatch[1]
          .split(/[,;]/)
          .map(v => v.trim().replace(/^[-*•`]+\s*/, ''))
          .filter(v => v !== '' && v.toLowerCase() !== 'none' && v.toLowerCase() !== 'n/a');
        items.push(...values);
      }
      continue;
    }
    if (inSection) {
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
