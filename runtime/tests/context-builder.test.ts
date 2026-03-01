import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { ContextBuilder } from '../src/agents/context-builder.js';
import { AgentContext } from '../src/agents/types.js';
import { createMockConfig, createSilentLogger } from './helpers/mocks.js';
import { ensureDir, fileExists, readJson } from '../src/util/fs.js';

describe('ContextBuilder', () => {
  let tempDir: string;
  let progressDir: string;
  let builder: ContextBuilder;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'aamf-ctx-test-'));
    progressDir = join(tempDir, 'progress');
    await ensureDir(progressDir);
    const config = createMockConfig();
    builder = new ContextBuilder(config, progressDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // ─── Context File Creation ─────────────────────────────────────────

  describe('Context File Creation', () => {
    it('should write context JSON to the contexts directory', async () => {
      const contextPath = await builder.buildContext('impact-assessor', 1);

      expect(contextPath).toContain('contexts');
      expect(await fileExists(contextPath)).toBe(true);

      const context = await readJson<AgentContext>(contextPath);
      expect(context.agent).toBe('impact-assessor');
    });

    it('should include correct base fields in context', async () => {
      const contextPath = await builder.buildContext('impact-assessor', 1);
      const context = await readJson<AgentContext>(contextPath);

      expect(context.agent).toBe('impact-assessor');
      expect(context.projectName).toBe('test-project');
      expect(context.phase).toBe(1);
      expect(context.config.source.path).toBe('/tmp/source');
      expect(context.config.source.language).toBe('python');
      expect(context.config.target.language).toBe('typescript');
      expect(context.config.target.framework).toBe('express');
      expect(context.config.target.outputPath).toBe('/tmp/target');
    });

    it('should include optional taskId when provided', async () => {
      const contextPath = await builder.buildContext('code-migrator', 4, 'task-001');
      const context = await readJson<AgentContext>(contextPath);

      expect(context.taskId).toBe('task-001');
    });
  });

  // ─── Per-Agent File Routing ────────────────────────────────────────

  describe('Per-Agent File Routing', () => {
    it('should route impact-assessor to source path and impact-assessment.md', async () => {
      const contextPath = await builder.buildContext('impact-assessor', 1);
      const context = await readJson<AgentContext>(contextPath);

      expect(context.inputFiles).toContain('/tmp/source');
      expect(context.outputPath).toContain('impact-assessment.md');
    });

    it('should route knowledge-builder to source + impact assessment, output to KB dir', async () => {
      const contextPath = await builder.buildContext('knowledge-builder', 2);
      const context = await readJson<AgentContext>(contextPath);

      expect(context.inputFiles).toContain('/tmp/source');
      expect(context.inputFiles.some((f: string) => f.includes('impact-assessment.md'))).toBe(true);
      expect(context.outputPath).toContain('knowledge-base');
    });

    it('should route migration-planner to KB index + impact assessment', async () => {
      const contextPath = await builder.buildContext('migration-planner', 3);
      const context = await readJson<AgentContext>(contextPath);

      expect(context.inputFiles.some((f: string) => f.includes('index.md'))).toBe(true);
      expect(context.inputFiles.some((f: string) => f.includes('impact-assessment.md'))).toBe(true);
      // Output path is now the planning/ directory (migration-planner emits groups.json +
      // strategy.md; task-decomposers emit tasks-<group>.json into the same directory)
      expect(context.outputPath).toContain('planning');
    });

    it('should route adjudicator to competing strategies file', async () => {
      const contextPath = await builder.buildContext('adjudicator', 3, undefined, {
        competingStrategiesFile: '/tmp/strategies.md',
        decisionType: 'migration-strategy',
      });
      const context = await readJson<AgentContext>(contextPath);

      expect(context.inputFiles).toContain('/tmp/strategies.md');
      expect(context.outputPath).toContain('adjudication-result.md');
    });

    it('should default adjudicator decisionType and allow empty competing strategies input', async () => {
      const contextPath = await builder.buildContext('adjudicator', 3);
      const context = await readJson<AgentContext>(contextPath);

      expect(context.inputFiles).toEqual([]);
      expect(context.payload?.decisionType).toBe('migration-strategy');
      expect(context.outputPath).toContain('adjudication-result.md');
    });

    it('should pass task-decomposer schema path in both inputFiles and payload', async () => {
      const contextPath = await builder.buildContext('task-decomposer', 3, 'core', {
        strategyFile: '/tmp/strategy.md',
        analysisFiles: ['/tmp/kb-core.md'],
        groupId: 'core',
        groupName: 'Core',
      });
      const context = await readJson<AgentContext>(contextPath);

      const schemaFile = context.inputFiles.find((f: string) =>
        f.endsWith('/runtime/src/agents/task-decomposer.tasks.schema.json'),
      );
      expect(schemaFile).toBeDefined();
      expect(context.payload?.taskSchemaPath).toBe(schemaFile);
      expect(context.payload?.maxLinesPerTask).toBe(500);
      expect(context.inputFiles).toContain('/tmp/strategy.md');
      expect(context.inputFiles).toContain('/tmp/kb-core.md');
    });

    it('should route code-migrator with task-specific source/target files', async () => {
      const contextPath = await builder.buildContext('code-migrator', 4, 'task-001', {
        sourceFiles: ['src/auth.py'],
        targetFiles: ['src/auth.ts'],
        kbEntry: 'kb/auth.md',
      });
      const context = await readJson<AgentContext>(contextPath);

      expect(context.outputPath).toBe('/tmp/target');
      expect(context.payload?.taskId).toBe('task-001');
      expect(context.payload?.sourceFiles).toEqual(['src/auth.py']);
      expect(context.payload?.targetFiles).toEqual(['src/auth.ts']);
    });

    it('should route parity-verifier to source + target files', async () => {
      const contextPath = await builder.buildContext('parity-verifier', 4, 'task-001', {
        sourceFile: 'src/auth.py',
        targetFile: 'src/auth.ts',
      });
      const context = await readJson<AgentContext>(contextPath);

      expect(context.inputFiles).toContain('src/auth.py');
      expect(context.inputFiles).toContain('src/auth.ts');
      expect(context.outputPath).toContain('parity-reports');
    });

    it('should route test-writer to target file + KB entry', async () => {
      const contextPath = await builder.buildContext('test-writer', 4, 'task-001', {
        targetFile: 'src/auth.ts',
        kbEntry: 'kb/auth.md',
        testType: 'unit',
      });
      const context = await readJson<AgentContext>(contextPath);

      expect(context.inputFiles).toContain('src/auth.ts');
      expect(context.inputFiles).toContain('kb/auth.md');
      expect(context.outputPath).toBe('/tmp/target');
    });

    it('should set test-writer outputPath to target root, not a subdirectory', async () => {
      const contextPath = await builder.buildContext('test-writer', 4, 'task-001', {
        targetFile: 'src/auth.ts',
      });
      const context = await readJson<AgentContext>(contextPath);

      expect(context.outputPath).toBe('/tmp/target');
      expect(context.outputPath).not.toContain('__tests__');
    });

    it('should include parityReport in test-writer inputFiles when provided', async () => {
      const contextPath = await builder.buildContext('test-writer', 4, 'task-001', {
        targetFile: 'src/auth.ts',
        parityReport: '/tmp/parity/auth-report.md',
      });
      const context = await readJson<AgentContext>(contextPath);

      expect(context.inputFiles).toContain('src/auth.ts');
      expect(context.inputFiles).toContain('/tmp/parity/auth-report.md');
      expect(context.outputPath).toBe('/tmp/target');
    });

    it('should default test-writer testType to unit when not specified', async () => {
      const contextPath = await builder.buildContext('test-writer', 4, 'task-001', {
        targetFile: 'src/auth.ts',
      });
      const context = await readJson<AgentContext>(contextPath);

      expect(context.payload?.testType).toBe('unit');
    });

    it('should route failure-adjudicator to failure report + source/target', async () => {
      const contextPath = await builder.buildContext('failure-adjudicator', 4, 'task-001', {
        failureReport: '/tmp/failure.md',
        sourceFile: 'src/auth.py',
        targetFile: 'src/auth.ts',
        kbEntry: 'kb/auth.md',
        attemptNumber: 2,
      });
      const context = await readJson<AgentContext>(contextPath);

      expect(context.inputFiles).toContain('/tmp/failure.md');
      expect(context.inputFiles).toContain('src/auth.py');
      expect(context.inputFiles).toContain('src/auth.ts');
      expect(context.outputPath).toContain('adjudication');
    });

    it('should route final-parity-checker to source + output + plan', async () => {
      const contextPath = await builder.buildContext('final-parity-checker', 5);
      const context = await readJson<AgentContext>(contextPath);

      expect(context.inputFiles).toContain('/tmp/source');
      expect(context.inputFiles).toContain('/tmp/target');
      expect(context.inputFiles.some((f: string) => f.includes('migration-plan.md'))).toBe(true);
      expect(context.outputPath).toContain('final-parity-report.md');
    });

    it('should route e2e-test-crafter to KB architecture docs', async () => {
      const contextPath = await builder.buildContext('e2e-test-crafter', 6);
      const context = await readJson<AgentContext>(contextPath);

      expect(context.inputFiles.some((f: string) => f.includes('architecture.md'))).toBe(true);
      expect(context.inputFiles.some((f: string) => f.includes('integrations.md'))).toBe(true);
      expect(context.outputPath).toContain('e2e');
    });

    it('should route documentation-writer to KB + plan + parity report', async () => {
      const contextPath = await builder.buildContext('documentation-writer', 6);
      const context = await readJson<AgentContext>(contextPath);

      expect(context.inputFiles.some((f: string) => f.includes('knowledge-base'))).toBe(true);
      expect(context.inputFiles.some((f: string) => f.includes('migration-plan.md'))).toBe(true);
      expect(context.inputFiles.some((f: string) => f.includes('final-parity-report.md'))).toBe(true);
      expect(context.outputPath).toContain('docs');
    });

    it('should route idiomatic-reviewer to target output dir, output to idiomatic-review-report.md', async () => {
      const contextPath = await builder.buildContext('idiomatic-reviewer', 8);
      const context = await readJson<AgentContext>(contextPath);

      expect(context.inputFiles).toContain('/tmp/target');
      expect(context.outputPath).toContain('idiomatic-review-report.md');
    });

    it('should route idiomatic-refactorer with targetFile and idiomaticReport from payload', async () => {
      const contextPath = await builder.buildContext('idiomatic-refactorer', 8, undefined, {
        targetFile: '/tmp/target/src/utils.ts',
        idiomaticReport: '/tmp/progress/idiomatic-review-report.md',
      });
      const context = await readJson<AgentContext>(contextPath);

      expect(context.inputFiles).toContain('/tmp/target/src/utils.ts');
      expect(context.inputFiles).toContain('/tmp/progress/idiomatic-review-report.md');
      expect(context.outputPath).toBe('/tmp/target');
    });

    it('should use default routing for unknown/orchestrator agents', async () => {
      const contextPath = await builder.buildContext('migration-orchestrator', 1);
      const context = await readJson<AgentContext>(contextPath);

      expect(context.inputFiles).toContain('/tmp/source');
      expect(context.outputPath).toBe(progressDir);
    });
  });

  // ─── Context Window Token Limit ────────────────────────────────────────────

  describe('Context Window Token Limit', () => {
    it('should include contextWindowTokens from options for copilot runtime', async () => {
      const config = createMockConfig({
        agentRuntime: 'copilot',
        options: {
          maxParallelAgents: 3,
          maxRetriesPerTask: 3,
          maxLinesPerTask: 500,
          dryRun: false,
          resume: false,
          invocationDelayMs: 0,
          buildConcurrency: 1,
          continueOnBlocked: true,
          maxBlockedTasks: 0,
          maxInfraRetries: 3,
          avgTokensPerTask: 5000,
          contextWindowStrategy: 'per-invocation',
          contextWindowTokens: 64_000,
        },
      });
      const b = new ContextBuilder(config, progressDir);
      const contextPath = await b.buildContext('impact-assessor', 1);
      const context = await readJson<AgentContext & { contextWindowTokens?: number }>(contextPath);

      expect(context.contextWindowTokens).toBe(64_000);
    });

    it('should use claudeCode.contextWindowTokens for claude-code runtime, taking precedence over options', async () => {
      const config = createMockConfig({
        agentRuntime: 'claude-code',
        claudeCode: {
          cliCommand: 'claude',
          agentDir: '.claude/agents',
          timeout: 300_000,
          contextWindowTokens: 200_000,
        },
        options: {
          maxParallelAgents: 3,
          maxRetriesPerTask: 3,
          maxLinesPerTask: 500,
          dryRun: false,
          resume: false,
          invocationDelayMs: 0,
          buildConcurrency: 1,
          continueOnBlocked: true,
          maxBlockedTasks: 0,
          maxInfraRetries: 3,
          avgTokensPerTask: 5000,
          contextWindowStrategy: 'per-invocation',
          contextWindowTokens: 64_000,
        },
      });
      const b = new ContextBuilder(config, progressDir);
      const contextPath = await b.buildContext('impact-assessor', 1);
      const context = await readJson<AgentContext & { contextWindowTokens?: number }>(contextPath);

      // claudeCode.contextWindowTokens (200_000) takes precedence over options.contextWindowTokens (64_000)
      expect(context.contextWindowTokens).toBe(200_000);
    });

    it('should fall back to options.contextWindowTokens when claude-code has no override', async () => {
      const config = createMockConfig({
        agentRuntime: 'claude-code',
        claudeCode: {
          cliCommand: 'claude',
          agentDir: '.claude/agents',
          timeout: 300_000,
        },
        options: {
          maxParallelAgents: 3,
          maxRetriesPerTask: 3,
          maxLinesPerTask: 500,
          dryRun: false,
          resume: false,
          invocationDelayMs: 0,
          buildConcurrency: 1,
          continueOnBlocked: true,
          maxBlockedTasks: 0,
          maxInfraRetries: 3,
          avgTokensPerTask: 5000,
          contextWindowStrategy: 'per-invocation',
          contextWindowTokens: 128_000,
        },
      });
      const b = new ContextBuilder(config, progressDir);
      const contextPath = await b.buildContext('impact-assessor', 1);
      const context = await readJson<AgentContext & { contextWindowTokens?: number }>(contextPath);

      expect(context.contextWindowTokens).toBe(128_000);
    });

    it('should omit contextWindowTokens from context when not configured', async () => {
      // Default createMockConfig has no contextWindowTokens set
      const contextPath = await builder.buildContext('impact-assessor', 1);
      const context = await readJson<AgentContext & { contextWindowTokens?: number }>(contextPath);

      expect(context.contextWindowTokens).toBeUndefined();
    });
  });
});
