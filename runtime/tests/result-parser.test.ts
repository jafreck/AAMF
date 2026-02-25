import { describe, it, expect, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ResultParser,
  TaskResultSchema,
  AamfOutputBase,
  MigrationOrchestratorOutput,
  ImpactAssessorOutput,
  KnowledgeBuilderOutput,
  LargeFileAnalyzerOutput,
  MigrationPlannerOutput,
  AdjudicatorOutput,
  CodeMigratorOutput,
  ParityVerifierOutput,
  TestWriterOutput,
  FailureRecoveryOutput,
  FinalParityCheckerOutput,
  E2eTestCrafterOutput,
  DocumentationWriterOutput,
  MigrationRunnerOutput,
} from '../src/agents/result-parser.js';

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

    it('should not treat structural headings as task blocks', () => {
      const content = `## Task Summary

This section summarizes all tasks.

## Tasks

Here are the tasks:

## Task: task-001 - Module A

**Description:** First task
**Complexity:** simple

**Source Files:**
- src/a.py

## Task: task-002 - Module B

**Description:** Second task
**Complexity:** simple

**Source Files:**
- src/b.py
`;
      const log = silentLogger();
      const tasks = ResultParser.parseMigrationPlanContent(content, log);
      expect(tasks).toHaveLength(2);
      expect(log.warn).not.toHaveBeenCalledWith(expect.stringContaining('Unparseable block headers'));
      expect(log.error).not.toHaveBeenCalledWith(expect.stringContaining('Task Summary'));
      expect(log.error).not.toHaveBeenCalledWith(expect.stringContaining('Tasks'));
      expect(tasks[0]?.id).toBe('task-001');
      expect(tasks[1]?.id).toBe('task-002');
    });

    it('should reject non-canonical "Task N:" headers', () => {
      const content = `## Task 1: Migrate Constants Module

**Description:** Migrate the constants module
**Complexity:** simple

**Source Files:**
- constants.py

**Target Files:**
- src/constants.ts
`;
      const log = silentLogger();
      const tasks = ResultParser.parseMigrationPlanContent(content, log);
      // Non-canonical header format should not parse into tasks
      expect(tasks).toHaveLength(0);
    });

    it('should only accept task-NNN dependency references', () => {
      const content = `## Task: task-001 - Module A

**Description:** First task
**Complexity:** simple

**Source Files:**
- src/a.py

**Dependencies:** none

## Task: task-002 - Module B

**Description:** Second task
**Complexity:** simple

**Source Files:**
- src/b.py

**Dependencies:** task-001, Task 3 (some-file.ts)
`;
      const log = silentLogger();
      const tasks = ResultParser.parseMigrationPlanContent(content, log);
      expect(tasks).toHaveLength(2);
      // Only the canonical task-001 reference should be kept
      expect(tasks[1]?.dependencies).toEqual(['task-001']);
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

  describe('AamfOutputBase schema', () => {
    it('should accept a minimal valid output', () => {
      const result = AamfOutputBase.parse({ status: 'completed', agent: 'code-migrator' });
      expect(result.status).toBe('completed');
      expect(result.agent).toBe('code-migrator');
      expect(result.taskId).toBeUndefined();
      expect(result.tokenUsage).toBeUndefined();
      expect(result.notes).toBeUndefined();
    });

    it('should accept all optional fields', () => {
      const result = AamfOutputBase.parse({
        status: 'needs-review',
        agent: 'parity-verifier',
        taskId: 'task-007',
        tokenUsage: { prompt: 100, completion: 50, total: 150 },
        notes: 'Some note',
      });
      expect(result.taskId).toBe('task-007');
      expect(result.tokenUsage?.total).toBe(150);
      expect(result.notes).toBe('Some note');
    });

    it('should reject invalid status values', () => {
      expect(() => AamfOutputBase.parse({ status: 'unknown', agent: 'x' })).toThrow();
    });

    it('should reject empty agent string', () => {
      expect(() => AamfOutputBase.parse({ status: 'completed', agent: '' })).toThrow();
    });

    it('should reject non-integer tokenUsage fields', () => {
      expect(() =>
        AamfOutputBase.parse({
          status: 'completed',
          agent: 'x',
          tokenUsage: { prompt: 1.5, completion: 0, total: 1 },
        }),
      ).toThrow();
    });

    it('should accept all valid status enum values', () => {
      for (const status of ['completed', 'failed', 'needs-review'] as const) {
        expect(() => AamfOutputBase.parse({ status, agent: 'a' })).not.toThrow();
      }
    });
  });

  describe('per-agent output schemas', () => {
    it('should accept a matching agent literal for MigrationOrchestratorOutput', () => {
      const result = MigrationOrchestratorOutput.parse({ status: 'completed', agent: 'migration-orchestrator' });
      expect(result.agent).toBe('migration-orchestrator');
    });

    it('should reject a wrong agent literal for MigrationOrchestratorOutput', () => {
      expect(() =>
        MigrationOrchestratorOutput.parse({ status: 'completed', agent: 'code-migrator' }),
      ).toThrow();
    });

    it('should validate ImpactAssessorOutput', () => {
      expect(() => ImpactAssessorOutput.parse({ status: 'completed', agent: 'impact-assessor' })).not.toThrow();
    });

    it('should validate KnowledgeBuilderOutput', () => {
      expect(() => KnowledgeBuilderOutput.parse({ status: 'completed', agent: 'knowledge-builder' })).not.toThrow();
    });

    it('should validate LargeFileAnalyzerOutput', () => {
      expect(() => LargeFileAnalyzerOutput.parse({ status: 'completed', agent: 'large-file-analyzer' })).not.toThrow();
    });

    it('should validate MigrationPlannerOutput', () => {
      expect(() => MigrationPlannerOutput.parse({ status: 'completed', agent: 'migration-planner' })).not.toThrow();
    });

    it('should validate AdjudicatorOutput', () => {
      expect(() => AdjudicatorOutput.parse({ status: 'completed', agent: 'adjudicator' })).not.toThrow();
    });

    it('should validate CodeMigratorOutput', () => {
      expect(() => CodeMigratorOutput.parse({ status: 'completed', agent: 'code-migrator' })).not.toThrow();
    });

    it('should validate ParityVerifierOutput', () => {
      expect(() => ParityVerifierOutput.parse({ status: 'completed', agent: 'parity-verifier' })).not.toThrow();
    });

    it('should validate TestWriterOutput', () => {
      expect(() => TestWriterOutput.parse({ status: 'completed', agent: 'test-writer' })).not.toThrow();
    });

    it('should validate FailureRecoveryOutput', () => {
      expect(() => FailureRecoveryOutput.parse({ status: 'completed', agent: 'failure-recovery' })).not.toThrow();
    });

    it('should validate FinalParityCheckerOutput', () => {
      expect(() => FinalParityCheckerOutput.parse({ status: 'completed', agent: 'final-parity-checker' })).not.toThrow();
    });

    it('should validate E2eTestCrafterOutput', () => {
      expect(() => E2eTestCrafterOutput.parse({ status: 'completed', agent: 'e2e-test-crafter' })).not.toThrow();
    });

    it('should validate DocumentationWriterOutput', () => {
      expect(() => DocumentationWriterOutput.parse({ status: 'completed', agent: 'documentation-writer' })).not.toThrow();
    });

    it('should validate MigrationRunnerOutput', () => {
      expect(() => MigrationRunnerOutput.parse({ status: 'completed', agent: 'migration-runner' })).not.toThrow();
    });
  });

  describe('parseAamfOutput', () => {
    it('should parse a valid aamf-json block and return data', () => {
      const stdout = `
Some output text.
\`\`\`aamf-json
{"status":"completed","agent":"code-migrator"}
\`\`\`
`;
      const result = ResultParser.parseAamfOutput(stdout, CodeMigratorOutput);
      expect(result.parsed).toBe(true);
      if (result.parsed) {
        expect(result.data.status).toBe('completed');
        expect(result.data.agent).toBe('code-migrator');
      }
    });

    it('should return the last aamf-json block when multiple are present', () => {
      const stdout = `
\`\`\`aamf-json
{"status":"failed","agent":"code-migrator"}
\`\`\`
intermediate text
\`\`\`aamf-json
{"status":"completed","agent":"code-migrator"}
\`\`\`
`;
      const result = ResultParser.parseAamfOutput(stdout, CodeMigratorOutput);
      expect(result.parsed).toBe(true);
      if (result.parsed) {
        expect(result.data.status).toBe('completed');
      }
    });

    it('should return parsed: false with error "missing aamf-json block" when no block present', () => {
      const result = ResultParser.parseAamfOutput('no fenced blocks here', AamfOutputBase);
      expect(result.parsed).toBe(false);
      if (!result.parsed) {
        expect(result.error).toContain('missing aamf-json block');
      }
    });

    it('should return parsed: false for malformed JSON', () => {
      const stdout = '```aamf-json\n{not valid json}\n```';
      const result = ResultParser.parseAamfOutput(stdout, AamfOutputBase);
      expect(result.parsed).toBe(false);
      if (!result.parsed) {
        expect(result.error).toContain('malformed JSON');
      }
    });

    it('should return parsed: false for schema validation failure', () => {
      const stdout = '```aamf-json\n{"status":"invalid-status","agent":"code-migrator"}\n```';
      const result = ResultParser.parseAamfOutput(stdout, CodeMigratorOutput);
      expect(result.parsed).toBe(false);
      if (!result.parsed) {
        expect(result.error).toContain('schema validation failed');
      }
    });

    it('should return parsed: false when agent literal does not match schema', () => {
      const stdout = '```aamf-json\n{"status":"completed","agent":"impact-assessor"}\n```';
      const result = ResultParser.parseAamfOutput(stdout, CodeMigratorOutput);
      expect(result.parsed).toBe(false);
      if (!result.parsed) {
        expect(result.error).toContain('schema validation failed');
      }
    });

    it('should parse optional fields when provided', () => {
      const stdout = `\`\`\`aamf-json
{"status":"completed","agent":"test-writer","taskId":"task-003","tokenUsage":{"prompt":100,"completion":50,"total":150},"notes":"All good"}
\`\`\``;
      const result = ResultParser.parseAamfOutput(stdout, TestWriterOutput);
      expect(result.parsed).toBe(true);
      if (result.parsed) {
        expect(result.data.taskId).toBe('task-003');
        expect(result.data.tokenUsage?.total).toBe(150);
        expect(result.data.notes).toBe('All good');
      }
    });

    it('should handle CRLF line endings in the fenced block', () => {
      const stdout = '```aamf-json\r\n{"status":"completed","agent":"adjudicator"}\r\n```';
      const result = ResultParser.parseAamfOutput(stdout, AdjudicatorOutput);
      expect(result.parsed).toBe(true);
    });

    it('should work with the base AamfOutputBase schema', () => {
      const stdout = '```aamf-json\n{"status":"needs-review","agent":"any-agent"}\n```';
      const result = ResultParser.parseAamfOutput(stdout, AamfOutputBase);
      expect(result.parsed).toBe(true);
      if (result.parsed) {
        expect(result.data.status).toBe('needs-review');
      }
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
      // 80% prompt, 20% completion — consistent with CostEstimator.estimateFromTotal
      expect(usage?.prompt).toBe(4000);
      expect(usage?.completion).toBe(1000);
    });

    it('should return undefined for no token info', () => {
      const usage = ResultParser.parseTokenUsage('some output with no tokens');
      expect(usage).toBeUndefined();
    });
  });
});
