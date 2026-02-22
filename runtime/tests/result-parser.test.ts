import { describe, it, expect, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ResultParser, TaskResultSchema } from '../src/agents/result-parser.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

/** Suppress console output during parsing tests. */
function silentLogger() {
  return {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  };
}

describe('ResultParser', () => {
  describe('parseMigrationPlanContent', () => {
    it('should parse tasks from migration plan markdown', async () => {
      const content = await readFile(join(__dirname, 'fixtures', 'sample-migration-plan.md'), 'utf-8');
      const log = silentLogger();
      const tasks = ResultParser.parseMigrationPlanContent(content, log);
      
      expect(tasks).toHaveLength(3);
      expect(tasks[0]?.id).toBe('task-001');
      expect(tasks[0]?.name).toContain('User Authentication');
      expect(tasks[0]?.complexity).toBe('moderate');
      expect(tasks[0]?.sourceFiles).toContain('src/auth/login.py');
      expect(tasks[0]?.dependencies).toHaveLength(0);
      
      expect(tasks[1]?.id).toBe('task-002');
      expect(tasks[1]?.dependencies).toContain('task-001');
      
      expect(tasks[2]?.id).toBe('task-003');
      expect(tasks[2]?.dependencies).toContain('task-001');
      expect(tasks[2]?.dependencies).toContain('task-002');
    });

    it('should skip malformed task blocks with missing source files', () => {
      const content = `## Task: task-001 - Orphan Module

**Description:** A task with no listed inputs
**Complexity:** simple
`;
      const log = silentLogger();
      const tasks = ResultParser.parseMigrationPlanContent(content, log);
      expect(tasks).toHaveLength(0);
      expect(log.error).toHaveBeenCalledWith(expect.stringContaining('no source files'));
    });

    it('should detect and deduplicate duplicate task IDs', () => {
      const content = `## Task: task-001 - First Module

**Description:** First task
**Complexity:** simple

**Source Files:**
- src/first.py

## Task: task-001 - Duplicate Module

**Description:** Duplicate task
**Complexity:** simple

**Source Files:**
- src/duplicate.py
`;
      const log = silentLogger();
      const tasks = ResultParser.parseMigrationPlanContent(content, log);
      expect(tasks).toHaveLength(1);
      expect(tasks[0]?.sourceFiles).toContain('src/first.py');
      expect(log.error).toHaveBeenCalledWith(expect.stringContaining('Duplicate task ID'));
    });

    it('should warn about dangling dependency references', () => {
      const content = `## Task: task-001 - Module A

**Description:** First task
**Complexity:** simple

**Source Files:**
- src/a.py

**Dependencies:** task-999

## Task: task-002 - Module B

**Description:** Second task
**Complexity:** simple

**Source Files:**
- src/b.py

**Dependencies:** task-001, task-888
`;
      const log = silentLogger();
      const tasks = ResultParser.parseMigrationPlanContent(content, log);
      expect(tasks).toHaveLength(2);
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('task-999'));
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('task-888'));
    });

    it('should return empty array for empty plan file', () => {
      const log = silentLogger();
      const tasks = ResultParser.parseMigrationPlanContent('', log);
      expect(tasks).toHaveLength(0);
    });

    it('should return empty array for plan with only non-task headings', () => {
      const content = `# Migration Plan

## Overview

This is a plan that has headings but no task definitions.

## Summary

Nothing to migrate.

### Notes

Just notes.
`;
      const log = silentLogger();
      const tasks = ResultParser.parseMigrationPlanContent(content, log);
      expect(tasks).toHaveLength(0);
    });

    it('should log an error summary after parsing', () => {
      const content = `## Task: task-001 - Valid Task

**Description:** A valid task
**Complexity:** simple

**Source Files:**
- src/valid.py
`;
      const log = silentLogger();
      ResultParser.parseMigrationPlanContent(content, log);
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining('1 tasks OK'));
    });
  });

  describe('TaskResultSchema', () => {
    it('should validate a well-formed result JSON', () => {
      const result = TaskResultSchema.parse({
        taskId: 'task-001',
        agent: 'code-migrator',
        status: 'completed',
        outputFiles: ['src/auth/login.ts'],
        parity: 'pass',
        issues: [],
      });
      expect(result.taskId).toBe('task-001');
      expect(result.status).toBe('completed');
    });

    it('should reject a result with missing taskId', () => {
      expect(() => TaskResultSchema.parse({ agent: 'x', status: 'completed' })).toThrow();
    });
  });

  describe('parseTokenUsage', () => {
    it('should parse prompt and completion tokens', () => {
      const output = 'prompt_tokens: 1500\ncompletion_tokens: 800\ntotal_tokens: 2300';
      const usage = ResultParser.parseTokenUsage(output);
      expect(usage).toEqual({ prompt: 1500, completion: 800, total: 2300 });
    });

    it('should parse total-only format', () => {
      const output = 'Total tokens: 5000';
      const usage = ResultParser.parseTokenUsage(output);
      expect(usage).toBeDefined();
      expect(usage?.total).toBe(5000);
    });

    it('should return undefined for no token info', () => {
      const usage = ResultParser.parseTokenUsage('some output with no tokens');
      expect(usage).toBeUndefined();
    });
  });
});
