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
  MigrationPlannerOutput,
  TaskDecomposerOutput,
  AdjudicatorOutput,
  CodeMigratorOutput,
  ParityVerifierOutput,
  TestWriterOutput,
  FailureRecoveryOutput,
  FinalParityCheckerOutput,
  E2eTestCrafterOutput,
  DocumentationWriterOutput,
  MigrationRunnerOutput,
  KbIndexerOutput,
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

    describe('KbIndexerOutput', () => {
      it('should validate with required dbPath field', () => {
        expect(() =>
          KbIndexerOutput.parse({ status: 'completed', agent: 'kb-indexer', dbPath: '/tmp/kb.db' }),
        ).not.toThrow();
      });

      it('should reject missing dbPath', () => {
        expect(() =>
          KbIndexerOutput.parse({ status: 'completed', agent: 'kb-indexer' }),
        ).toThrow();
      });

      it('should reject empty dbPath', () => {
        expect(() =>
          KbIndexerOutput.parse({ status: 'completed', agent: 'kb-indexer', dbPath: '' }),
        ).toThrow();
      });

      it('should reject wrong agent literal', () => {
        expect(() =>
          KbIndexerOutput.parse({ status: 'completed', agent: 'code-migrator', dbPath: '/tmp/kb.db' }),
        ).toThrow();
      });

      it('should parse correctly and expose dbPath', () => {
        const result = KbIndexerOutput.parse({ status: 'completed', agent: 'kb-indexer', dbPath: '/var/db/kb.sqlite' });
        expect(result.agent).toBe('kb-indexer');
        expect(result.dbPath).toBe('/var/db/kb.sqlite');
      });

      it('should parse a KbIndexerOutput aamf-json block', () => {
        const stdout = '```aamf-json\n{"status":"completed","agent":"kb-indexer","dbPath":"/tmp/kb.db"}\n```';
        const result = ResultParser.parseAamfOutput(stdout, KbIndexerOutput);
        expect(result.parsed).toBe(true);
        if (result.parsed) {
          expect(result.data.dbPath).toBe('/tmp/kb.db');
        }
      });
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

    it('should parse metadata-only task-decomposer output', () => {
      const stdout = `\
\
\`\`\`aamf-json
{
  "status": "completed",
  "agent": "task-decomposer",
  "taskId": "group-3-compress-strategies",
  "outputFiles": [".aamf/migration/demo/planning/tasks-group-3-compress-strategies.json"],
  "taskCount": 2
}
\`\`\``;

      const result = ResultParser.parseAamfOutput(stdout, TaskDecomposerOutput);
      expect(result.parsed).toBe(true);
      if (result.parsed) {
        expect(result.data.agent).toBe('task-decomposer');
        expect(result.data.outputFiles.length).toBe(1);
        expect(result.data.taskCount).toBe(2);
      }
    });

    it('should reject task-decomposer output that embeds tasks in aamf-json', () => {
      const stdout = `\
\
\`\`\`aamf-json
{
  "status": "completed",
  "agent": "task-decomposer",
  "taskId": "group-3-compress-strategies",
  "outputFiles": [".aamf/migration/demo/planning/tasks-group-3-compress-strategies.json"],
  "tasks": [
    {
      "id": "task-301",
      "name": "Migrate CWKSP arena allocator",
      "sourceFiles": ["lib/compress/zstd_cwksp.h"],
      "targetFiles": ["src/compress/cwksp.rs"],
      "knowledgeBaseRef": "knowledge-base/modules/compress.md",
      "dependencies": [],
      "complexity": "complex"
    }
  ]
}
\`\`\``;

      const result = ResultParser.parseAamfOutput(stdout, TaskDecomposerOutput);
      expect(result.parsed).toBe(false);
      if (!result.parsed) {
        expect(result.error).toContain('schema validation failed');
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

    it('should route to parseClaudeTokenUsage when runtime is claude-code', () => {
      const output = '{"type":"message","usage":{"input_tokens":1200,"output_tokens":400}}';
      const usage = ResultParser.parseTokenUsage(output, 'claude-code');
      expect(usage).toEqual({ prompt: 1200, completion: 400, total: 1600 });
    });

    it('should use regex path when runtime is not claude-code', () => {
      const output = 'prompt_tokens: 100\ncompletion_tokens: 50\n{"usage":{"input_tokens":999,"output_tokens":999}}';
      const usage = ResultParser.parseTokenUsage(output);
      expect(usage).toEqual({ prompt: 100, completion: 50, total: 150 });
    });
  });

  describe('parseClaudeTokenUsage', () => {
    it('should parse Claude JSON usage from stdout', () => {
      const output = 'Some text\n{"type":"message","usage":{"input_tokens":2000,"output_tokens":500}}\nMore text';
      const usage = ResultParser.parseClaudeTokenUsage(output);
      expect(usage).toEqual({ prompt: 2000, completion: 500, total: 2500 });
    });

    it('should parse Claude JSON usage from stderr', () => {
      const stderr = '[stderr] {"usage":{"input_tokens":1000,"output_tokens":300}}';
      const usage = ResultParser.parseClaudeTokenUsage(stderr);
      expect(usage).toEqual({ prompt: 1000, completion: 300, total: 1300 });
    });

    it('should populate cachedInput when cache_read_input_tokens is present', () => {
      const output = '{"usage":{"input_tokens":1500,"output_tokens":400,"cache_read_input_tokens":200}}';
      const usage = ResultParser.parseClaudeTokenUsage(output);
      expect(usage?.prompt).toBe(1500);
      expect(usage?.completion).toBe(400);
      expect(usage?.total).toBe(1900);
      expect(usage?.cachedInput).toBe(200);
    });

    it('should not include cachedInput when cache_read_input_tokens is absent', () => {
      const output = '{"usage":{"input_tokens":800,"output_tokens":200}}';
      const usage = ResultParser.parseClaudeTokenUsage(output);
      expect(usage?.cachedInput).toBeUndefined();
    });

    it('should return the last usage JSON when multiple are present', () => {
      const output = [
        '{"usage":{"input_tokens":100,"output_tokens":50}}',
        '{"usage":{"input_tokens":900,"output_tokens":300}}',
      ].join('\n');
      const usage = ResultParser.parseClaudeTokenUsage(output);
      expect(usage?.prompt).toBe(900);
      expect(usage?.completion).toBe(300);
    });

    it('should return undefined when no Claude usage JSON is found', () => {
      const usage = ResultParser.parseClaudeTokenUsage('prompt_tokens: 100\ncompletion_tokens: 50');
      expect(usage).toBeUndefined();
    });
  });

  describe('parseCopilotCliUsage', () => {
    it('should parse a single-model breakdown with tokens_in, tokens_out, tokens_cached', () => {
      const output = `Total usage est:
  1 Premium request

Breakdown by AI model:
  claude-sonnet-4-20250514:
    tokens_in: 5000, tokens_out: 1200, tokens_cached: 800, premium_requests_est: 1
`;
      const usage = ResultParser.parseCopilotCliUsage(output);
      expect(usage).toEqual({ prompt: 5000, completion: 1200, total: 6200, cachedInput: 800 });
    });

    it('should sum across multiple models', () => {
      const output = `Total usage est:
  3 Premium requests

Breakdown by AI model:
  claude-sonnet-4-20250514:
    tokens_in: 4000, tokens_out: 1000, tokens_cached: 500, premium_requests_est: 2
  gpt-4o:
    tokens_in: 2000, tokens_out: 600, premium_requests_est: 1
`;
      const usage = ResultParser.parseCopilotCliUsage(output);
      expect(usage).toEqual({ prompt: 6000, completion: 1600, total: 7600, cachedInput: 500 });
    });

    it('should parse numeric shorthand suffixes (k)', () => {
      const output = `Breakdown by AI model:
  claude-sonnet-4-20250514:
    tokens_in: 41.3k, tokens_out: 2.1k, tokens_cached: 13.1k, premium_requests_est: 2
`;
      const usage = ResultParser.parseCopilotCliUsage(output);
      expect(usage).toEqual({ prompt: 41300, completion: 2100, total: 43400, cachedInput: 13100 });
    });

    it('should parse numeric shorthand suffixes (m)', () => {
      const output = `Breakdown by AI model:
  large-model:
    tokens_in: 2.5m, tokens_out: 0.5m, tokens_cached: 1m, premium_requests_est: 10
`;
      const usage = ResultParser.parseCopilotCliUsage(output);
      expect(usage).toEqual({ prompt: 2500000, completion: 500000, total: 3000000, cachedInput: 1000000 });
    });

    it('should handle singular "Premium request"', () => {
      const output = `Total usage est:
  1 Premium request

Breakdown by AI model:
  gpt-4o:
    tokens_in: 3000, tokens_out: 500, premium_requests_est: 1
`;
      const usage = ResultParser.parseCopilotCliUsage(output);
      expect(usage).toEqual({ prompt: 3000, completion: 500, total: 3500 });
    });

    it('should handle plural "Premium requests"', () => {
      const output = `Total usage est:
  5 Premium requests

Breakdown by AI model:
  gpt-4o:
    tokens_in: 10000, tokens_out: 2000, tokens_cached: 500, premium_requests_est: 5
`;
      const usage = ResultParser.parseCopilotCliUsage(output);
      expect(usage).toEqual({ prompt: 10000, completion: 2000, total: 12000, cachedInput: 500 });
    });

    it('should return undefined for cachedInput when tokens_cached is absent', () => {
      const output = `Breakdown by AI model:
  gpt-4o:
    tokens_in: 2000, tokens_out: 800, premium_requests_est: 1
`;
      const usage = ResultParser.parseCopilotCliUsage(output);
      expect(usage).toBeDefined();
      expect(usage?.prompt).toBe(2000);
      expect(usage?.completion).toBe(800);
      expect(usage?.total).toBe(2800);
      expect(usage?.cachedInput).toBeUndefined();
    });

    it('should return undefined when output has no Copilot CLI usage block', () => {
      const output = 'Some random agent output\nprompt_tokens: 100\ncompletion_tokens: 50';
      const usage = ResultParser.parseCopilotCliUsage(output);
      expect(usage).toBeUndefined();
    });

    it('should return undefined when breakdown header exists but no token lines follow', () => {
      const output = `Breakdown by AI model:\n  (no models used)\n`;
      const usage = ResultParser.parseCopilotCliUsage(output);
      expect(usage).toBeUndefined();
    });

    it('should handle minor spacing variations', () => {
      const output = `Breakdown by AI model:
  model-a:
    tokens_in:41.3k,tokens_out:2.1k,tokens_cached:13.1k,premium_requests_est:2
`;
      const usage = ResultParser.parseCopilotCliUsage(output);
      expect(usage).toEqual({ prompt: 41300, completion: 2100, total: 43400, cachedInput: 13100 });
    });

    it('should parse latest footer format (in/out/cached)', () => {
      const output = `Total usage est:        1 Premium request
API time spent:         12s
Total session time:     16s
Total code changes:     +0 -0
Breakdown by AI model:
 claude-sonnet-4.6       87.6k in, 486 out, 43.0k cached (Est. 1 Premium request)
`;
      const usage = ResultParser.parseCopilotCliUsage(output);
      expect(usage).toEqual({ prompt: 87600, completion: 486, total: 88086, cachedInput: 43000 });
    });

    it('should parse latest footer format when cached is absent', () => {
      const output = `Breakdown by AI model:
 gpt-5-mini              1.2k in, 210 out (Est. 1 Premium request)
`;
      const usage = ResultParser.parseCopilotCliUsage(output);
      expect(usage).toEqual({ prompt: 1200, completion: 210, total: 1410 });
    });

    it('should be case-insensitive for the breakdown header', () => {
      const output = `breakdown by ai model:
  gpt-4o:
    tokens_in: 1000, tokens_out: 200, premium_requests_est: 1
`;
      const usage = ResultParser.parseCopilotCliUsage(output);
      expect(usage).toEqual({ prompt: 1000, completion: 200, total: 1200 });
    });

    it('should sum mixed shorthand and plain numbers across models', () => {
      const output = `Breakdown by AI model:
  model-a:
    tokens_in: 1.5k, tokens_out: 300, tokens_cached: 200, premium_requests_est: 1
  model-b:
    tokens_in: 2000, tokens_out: 0.5k, premium_requests_est: 1
`;
      const usage = ResultParser.parseCopilotCliUsage(output);
      expect(usage).toEqual({ prompt: 3500, completion: 800, total: 4300, cachedInput: 200 });
    });

    it('should return undefined for empty string input', () => {
      const usage = ResultParser.parseCopilotCliUsage('');
      expect(usage).toBeUndefined();
    });
  });

  describe('parseTokenUsage (copilot-cli dispatch)', () => {
    it('should route to parseCopilotCliUsage when runtime is copilot-cli', () => {
      const output = `Breakdown by AI model:
  gpt-4o:
    tokens_in: 3000, tokens_out: 500, premium_requests_est: 1
`;
      const usage = ResultParser.parseTokenUsage(output, 'copilot-cli');
      expect(usage).toEqual({ prompt: 3000, completion: 500, total: 3500 });
    });

    it('should return undefined via copilot-cli dispatch when no usage block', () => {
      const usage = ResultParser.parseTokenUsage('no copilot cli output here', 'copilot-cli');
      expect(usage).toBeUndefined();
    });

    it('should preserve cachedInput through copilot-cli dispatch', () => {
      const output = `Breakdown by AI model:
  claude-sonnet-4-20250514:
    tokens_in: 5000, tokens_out: 1200, tokens_cached: 800, premium_requests_est: 1
`;
      const usage = ResultParser.parseTokenUsage(output, 'copilot-cli') as { prompt: number; completion: number; total: number; cachedInput?: number };
      expect(usage).toBeDefined();
      expect(usage.cachedInput).toBe(800);
    });

    it('should not fall through to regex path when runtime is copilot-cli', () => {
      const output = 'prompt_tokens: 999\ncompletion_tokens: 111\nBreakdown by AI model:\n  m:\n    tokens_in: 100, tokens_out: 50, premium_requests_est: 1';
      const usage = ResultParser.parseTokenUsage(output, 'copilot-cli');
      expect(usage).toEqual({ prompt: 100, completion: 50, total: 150 });
    });

    it('should parse latest footer format via copilot-cli dispatch', () => {
      const output = `Breakdown by AI model:
 claude-sonnet-4.6       2.4k in, 100 out, 1.1k cached (Est. 1 Premium request)
`;
      const usage = ResultParser.parseTokenUsage(output, 'copilot-cli');
      expect(usage).toEqual({ prompt: 2400, completion: 100, total: 2500, cachedInput: 1100 });
    });
  });

  describe('parseIdiomaticReport', () => {
    it('should return an empty array for a non-existent file', async () => {
      const entries = await ResultParser.parseIdiomaticReport('/nonexistent/path/report.md');
      expect(entries).toEqual([]);
    });

    it('should return an empty array for a report with no Issue sections', async () => {
      const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const dir = await mkdtemp(join(tmpdir(), 'aamf-rp-test-'));
      try {
        const reportPath = join(dir, 'empty-report.md');
        await writeFile(reportPath, '# Idiomatic Review Report\n\nNo issues found.\n', 'utf-8');
        const entries = await ResultParser.parseIdiomaticReport(reportPath);
        expect(entries).toEqual([]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('should parse a well-formed report with Issue sections', async () => {
      const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const dir = await mkdtemp(join(tmpdir(), 'aamf-rp-test-'));
      try {
        const reportContent = `# Idiomatic Review Report

## Issue

File: src/utils/formatter.ts
Issue: Uses a manual for-loop where a map would be idiomatic.
Suggestion: Replace the for-loop with Array.prototype.map().

## Issue

File: src/auth/login.ts
Issue: Error handling uses callback-style instead of async/await.
Suggestion: Refactor to use async/await with try/catch.
`;
        const reportPath = join(dir, 'review-report.md');
        await writeFile(reportPath, reportContent, 'utf-8');
        const entries = await ResultParser.parseIdiomaticReport(reportPath);
        expect(entries).toHaveLength(2);
        expect(entries[0]?.file).toBe('src/utils/formatter.ts');
        expect(entries[0]?.issue).toContain('for-loop');
        expect(entries[0]?.suggestion).toContain('map');
        expect(entries[1]?.file).toBe('src/auth/login.ts');
        expect(entries[1]?.issue).toContain('callback-style');
        expect(entries[1]?.suggestion).toContain('async/await');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('should parse Finding sections in addition to Issue sections', async () => {
      const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const dir = await mkdtemp(join(tmpdir(), 'aamf-rp-test-'));
      try {
        const reportContent = `# Idiomatic Review Report

### Finding

File: src/index.ts
Issue: Global mutable state used for caching.
Suggestion: Use a closure or module-level const instead.
`;
        const reportPath = join(dir, 'review-report.md');
        await writeFile(reportPath, reportContent, 'utf-8');
        const entries = await ResultParser.parseIdiomaticReport(reportPath);
        expect(entries).toHaveLength(1);
        expect(entries[0]?.file).toBe('src/index.ts');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('should return empty strings for missing fields in a section', async () => {
      const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const dir = await mkdtemp(join(tmpdir(), 'aamf-rp-test-'));
      try {
        const reportContent = `# Idiomatic Review Report

## Issue

Some vague finding with no structured fields.
`;
        const reportPath = join(dir, 'review-report.md');
        await writeFile(reportPath, reportContent, 'utf-8');
        const entries = await ResultParser.parseIdiomaticReport(reportPath);
        expect(entries).toHaveLength(0);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
