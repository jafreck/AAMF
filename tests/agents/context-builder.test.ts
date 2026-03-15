import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { ContextBuilder } from '../../src/agents/context-builder.js';
import { AgentContext } from '../../src/agents/types.js';
import { createMockConfig, createSilentLogger } from '../helpers/mocks.js';
import { ensureDir, fileExists, readJson } from '../../src/util/fs.js';
import type { RuntimePaths } from '../../src/core/runtime-paths.js';

describe('ContextBuilder', () => {
  let tempDir: string;
  let progressDir: string;
  let builder: ContextBuilder;
  let paths: RuntimePaths;

  function buildTestPaths(root: string): RuntimePaths {
    const stateDir = join(root, 'state');
    const logsRuntimeDir = join(root, 'logs', 'runtime');
    const logsAgentsDir = join(root, 'logs', 'agents');
    const logsCommandsDir = join(root, 'logs', 'commands');
    const artifactsDir = join(root, 'artifacts');
    const artifactsPlanningDir = join(artifactsDir, 'planning');
    const artifactsParityDir = join(artifactsDir, 'parity');
    const reportsDir = join(root, 'reports');
    const metricsDir = join(root, 'metrics');
    return {
      root,
      stateDir,
      checkpointFile: join(stateDir, 'checkpoint.json'),
      checkpointBackupFile: join(stateDir, 'checkpoint.backup.json'),
      runManifestFile: join(stateDir, 'run-manifest.json'),
      logsRuntimeDir,
      migrationLogFile: join(logsRuntimeDir, 'migration.log'),
      logsAgentsDir,
      logsCommandsDir,
      logsCommandBuildDir: join(logsCommandsDir, 'build'),
      logsCommandTestDir: join(logsCommandsDir, 'test'),
      artifactsDir,
      artifactsContextsDir: join(artifactsDir, 'contexts'),
      artifactsResultsDir: join(artifactsDir, 'results'),
      artifactsPlanningDir,
      artifactsParityDir,
      artifactsAdjudicationDir: join(artifactsDir, 'adjudication'),
      reportsDir,
      progressReportFile: join(reportsDir, 'progress.md'),
      reportsObservabilityDir: join(reportsDir, 'observability'),
      metricsDir,
      metricsInvocationsFile: join(metricsDir, 'invocations.jsonl'),
      metricsSummaryFile: join(metricsDir, 'summary.json'),
      kbDbFile: join(root, 'kb.db'),
      knowledgeBaseDir: join(root, 'knowledge-base'),
      dependencySummaryFile: join(artifactsPlanningDir, 'dependency-summary.json'),
      migrationPlanFile: join(artifactsPlanningDir, 'migration-plan.md'),
      competingStrategiesFile: join(artifactsPlanningDir, 'competing-strategies.md'),
      finalParityReportFile: join(artifactsParityDir, 'final-parity-report.md'),
      idiomaticReviewReportFile: join(artifactsParityDir, 'idiomatic-review-report.md'),
    };
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'aamf-ctx-test-'));
    progressDir = join(tempDir, 'progress');
    await ensureDir(progressDir);
    const config = createMockConfig();
    paths = buildTestPaths(progressDir);
    builder = new ContextBuilder(config, progressDir, paths);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // ─── Context File Creation ─────────────────────────────────────────

  describe('Context File Creation', () => {
    it('should write context JSON to the contexts directory', async () => {
      const { contextPath } = await builder.buildContext('knowledge-builder', 3);

      expect(contextPath).toContain('contexts');
      expect(await fileExists(contextPath)).toBe(true);

      const context = await readJson<AgentContext>(contextPath);
      expect(context.agent).toBe('knowledge-builder');
    });

    it('should include correct base fields in context', async () => {
      const { contextPath } = await builder.buildContext('knowledge-builder', 3);
      const context = await readJson<AgentContext>(contextPath);

      expect(context.agent).toBe('knowledge-builder');
      expect(context.projectName).toBe('test-project');
      expect(context.phase).toBe(3);
      expect(context.config.source.path).toBe('/tmp/source');
      expect(context.config.source.language).toBe('python');
      expect(context.config.target.language).toBe('typescript');
      expect(context.config.target.framework).toBe('express');
      expect(context.config.target.outputPath).toBe('/tmp/target');
    });

    it('should include optional taskId when provided', async () => {
      const { contextPath } = await builder.buildContext('code-migrator', 4, 'task-001');
      const context = await readJson<AgentContext>(contextPath);

      expect(context.taskId).toBe('task-001');
    });
  });

  // ─── Per-Agent File Routing ────────────────────────────────────────

  describe('Per-Agent File Routing', () => {
    it('should route knowledge-builder to source, output to KB dir', async () => {
      const { contextPath } = await builder.buildContext('knowledge-builder', 3);
      const context = await readJson<AgentContext>(contextPath);

      expect(context.inputFiles).toContain('/tmp/source');
      expect(context.outputPath).toContain('knowledge-base');
      expect(context.payload?.dependencySummaryPath).toContain('dependency-summary.json');
    });

    it('should route migration-planner to KB index + dependency summary', async () => {
      const { contextPath } = await builder.buildContext('migration-planner', 4);
      const context = await readJson<AgentContext>(contextPath);

      expect(context.inputFiles.some((f: string) => f.includes('index.md'))).toBe(true);
      expect(context.inputFiles.some((f: string) => f.includes('dependency-summary.json'))).toBe(true);
      // Output path is now the planning/ directory (migration-planner emits
      // strategy.md; the runtime builds the task graph deterministically)
      expect(context.outputPath).toContain('planning');
    });

    it('should include executionStrategy in migration-planner payload with default config', async () => {
      const { contextPath } = await builder.buildContext('migration-planner', 4);
      const context = await readJson<AgentContext>(contextPath);
      const strategy = context.payload?.executionStrategy as Record<string, unknown>;

      expect(strategy).toBeDefined();
      expect(strategy.executionMode).toBe('per-task');
      expect(strategy.maxParallelAgents).toBe(3);
      expect(strategy.maxRetriesPerTask).toBe(3);
      expect(strategy.requiresNonOverlappingTargets).toBe(true);
      expect(strategy.waveControl).toEqual({ maxConvergenceIterations: 3 });
      expect(strategy.buildCommand).toBeUndefined();
      expect(strategy.testCommand).toBeUndefined();
    });

    it('should reflect wave-barrier mode and build/test commands in migration-planner executionStrategy', async () => {
      const config = createMockConfig({
        target: {
          language: 'rust',
          outputPath: '/tmp/target',
          buildCommand: 'cargo build',
          testCommand: 'cargo test',
        },
        options: {
          maxParallelAgents: 5,
          maxRetriesPerTask: 2,
          maxLinesPerTask: 500,
          dryRun: false,
          resume: false,
          invocationDelayMs: 0,
          buildConcurrency: 1,
          continueOnBlocked: true,
          maxBlockedTasks: 0,
          maxInfraRetries: 3,
          keepArtifacts: false,
          qualityPolicy: 'strict' as const,
          executionMode: 'wave-barrier' as const,
          waveControl: { maxConvergenceIterations: 5 },
          git: { enabled: false, autoInit: true, commitByAgent: true, commitPerTask: true, authorName: 'AAMF Migration Bot', authorEmail: 'aamf@local.invalid' },
        },
      });
      const b = new ContextBuilder(config, progressDir, paths);
      const { contextPath } = await b.buildContext('migration-planner', 4);
      const context = await readJson<AgentContext>(contextPath);
      const strategy = context.payload?.executionStrategy as Record<string, unknown>;

      expect(strategy.executionMode).toBe('wave-barrier');
      expect(strategy.maxParallelAgents).toBe(5);
      expect(strategy.maxRetriesPerTask).toBe(2);
      expect(strategy.waveControl).toEqual({ maxConvergenceIterations: 5 });
      expect(strategy.buildCommand).toBe('cargo build');
      expect(strategy.testCommand).toBe('cargo test');
      expect(strategy.requiresNonOverlappingTargets).toBe(true);
    });

    it('should route adjudicator to competing strategies file', async () => {
      const { contextPath } = await builder.buildContext('adjudicator', 3, undefined, {
        competingStrategiesFile: '/tmp/strategies.md',
        decisionType: 'migration-strategy',
      });
      const context = await readJson<AgentContext>(contextPath);

      expect(context.inputFiles).toContain('/tmp/strategies.md');
      expect(context.outputPath).toContain('adjudication-result.md');
    });

    it('should default adjudicator decisionType and allow empty competing strategies input', async () => {
      const { contextPath } = await builder.buildContext('adjudicator', 3);
      const context = await readJson<AgentContext>(contextPath);

      expect(context.inputFiles).toEqual([]);
      expect(context.payload?.decisionType).toBe('migration-strategy');
      expect(context.outputPath).toContain('adjudication-result.md');
    });

    it('should route code-migrator with task-specific source/target files', async () => {
      const { contextPath } = await builder.buildContext('code-migrator', 4, 'task-001', {
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

    it('should include remediationContext in code-migrator payload for recovery-triggered remigration', async () => {
      const { contextPath } = await builder.buildContext('code-migrator', 4, 'task-001', {
        sourceFiles: ['src/auth.py'],
        targetFiles: ['src/auth.ts'],
        remediationContext: {
          failureKind: 'parity',
          failureTarget: { wave: 1, workItemId: 'task-001', check: 'auth-parity' },
          artifactPaths: ['/tmp/parity/task-001.md'],
          expectedSuccessCondition: 'Parity report returns minor-or-better',
        },
      });
      const context = await readJson<AgentContext>(contextPath);
      const remediation = context.payload?.remediationContext as Record<string, unknown> | undefined;

      expect(context.payload?.taskId).toBe('task-001');
      expect(context.payload?.sourceFiles).toEqual(['src/auth.py']);
      expect(context.payload?.targetFiles).toEqual(['src/auth.ts']);
      expect(remediation?.failureKind).toBe('parity');
      expect(remediation?.failureSummary).toBeUndefined();
    });

    it('should not include .md artifact paths as inputFiles for code-migrator during recovery (structured context only)', async () => {
      const { contextPath } = await builder.buildContext('code-migrator', 4, 'task-001', {
        sourceFiles: ['src/auth.py'],
        targetFiles: ['src/auth.ts'],
        kbEntry: 'kb/auth.md',
        remediationContext: {
          failureKind: 'parity',
          failureTarget: { workItemId: 'task-001', check: 'parity-verifier' },
          artifactPaths: ['/tmp/parity/task-001.md', '/tmp/source/auth.py', '/tmp/target/auth.rs'],
          expectedSuccessCondition: 'Parity passes',
        },
      });
      const context = await readJson<AgentContext>(contextPath);

      // .md files from artifactPaths should NOT appear in inputFiles — structured data only
      expect(context.inputFiles).not.toContain('/tmp/parity/task-001.md');
      expect(context.inputFiles).not.toContain('/tmp/source/auth.py');
      expect(context.inputFiles).not.toContain('/tmp/target/auth.rs');
    });

    it('should not include adjudicationReportPath as inputFile for code-migrator during recovery (structured context only)', async () => {
      const { contextPath } = await builder.buildContext('code-migrator', 4, 'task-001', {
        sourceFiles: ['src/auth.py'],
        targetFiles: ['src/auth.ts'],
        remediationContext: {
          failureKind: 'parity',
          failureTarget: { workItemId: 'task-001', check: 'parity-verifier' },
          artifactPaths: ['/tmp/parity/task-001.md'],
          expectedSuccessCondition: 'Parity passes',
          adjudicationReportPath: '/tmp/adjudication/task-001.md',
        },
      });
      const context = await readJson<AgentContext>(contextPath);

      // Sidecar .md paths should NOT appear in inputFiles
      expect(context.inputFiles).not.toContain('/tmp/adjudication/task-001.md');
      expect(context.inputFiles).not.toContain('/tmp/parity/task-001.md');
    });

    it('should not add recovery inputFiles for code-migrator without remediationContext', async () => {
      const { contextPath } = await builder.buildContext('code-migrator', 4, 'task-001', {
        sourceFiles: ['src/auth.py'],
        targetFiles: ['src/auth.ts'],
        kbEntry: 'kb/auth.md',
      });
      const context = await readJson<AgentContext>(contextPath);

      // Should only have the migration plan (kbEntry is in payload, not inputFiles)
      expect(context.inputFiles.length).toBe(1);
    });

    it('should prioritize nested remediationContext payload for code-migrator when both shapes are provided', async () => {
      const nestedRemediation = {
        failureKind: 'parity',
        failureTarget: { wave: 1, workItemId: 'task-001', check: 'parity' },
        artifactPaths: ['/tmp/parity.md'],
        expectedSuccessCondition: 'Parity delta is minor-or-better',
      };
      const { contextPath } = await builder.buildContext('code-migrator', 4, 'task-001', {
        sourceFiles: ['src/auth.py'],
        targetFiles: ['src/auth.ts'],
        remediationContext: nestedRemediation,
        failureKind: 'command',
      });
      const context = await readJson<AgentContext>(contextPath);

      expect(context.payload?.remediationContext).toEqual(nestedRemediation);
    });

    it('should route parity-verifier to source + target files', async () => {
      const { contextPath } = await builder.buildContext('parity-verifier', 4, 'task-001', {
        sourceFile: 'src/auth.py',
        targetFile: 'src/auth.ts',
      });
      const context = await readJson<AgentContext>(contextPath);

      expect(context.inputFiles).toContain('src/auth.py');
      expect(context.inputFiles).toContain('src/auth.ts');
      expect(context.outputPath).toBe('/tmp/target');
    });

    it('should include taskScope in parity-verifier payload when provided', async () => {
      const { contextPath } = await builder.buildContext('parity-verifier', 4, 'task-001', {
        sourceFile: 'src/auth.py',
        targetFile: 'src/auth.ts',
        taskScope: {
          description: 'Scaffold auth module with type stubs',
          acceptanceCriteria: ['Function signatures compile'],
          parityChecks: ['API surface only'],
        },
      });
      const context = await readJson<AgentContext>(contextPath);
      const scope = context.payload?.taskScope as Record<string, unknown> | undefined;

      expect(scope).toBeDefined();
      expect(scope?.description).toBe('Scaffold auth module with type stubs');
      expect(scope?.acceptanceCriteria).toEqual(['Function signatures compile']);
      expect(scope?.parityChecks).toEqual(['API surface only']);
    });

    it('should omit taskScope from parity-verifier payload when not provided', async () => {
      const { contextPath } = await builder.buildContext('parity-verifier', 4, 'task-001', {
        sourceFile: 'src/auth.py',
        targetFile: 'src/auth.ts',
      });
      const context = await readJson<AgentContext>(contextPath);

      expect(context.payload?.taskScope).toBeUndefined();
    });

    it('should route test-writer to target file + KB entry', async () => {
      const { contextPath } = await builder.buildContext('test-writer', 4, 'task-001', {
        targetFile: 'src/auth.ts',
        kbEntry: 'kb/auth.md',
        testType: 'unit',
      });
      const context = await readJson<AgentContext>(contextPath);

      expect(context.inputFiles).toContain('src/auth.ts');
      expect(context.inputFiles).toContain('kb/auth.md');
      expect(context.outputPath).toBe('/tmp/target');
    });

    it('should include taskScope in test-writer payload when provided', async () => {
      const { contextPath } = await builder.buildContext('test-writer', 4, 'task-001', {
        targetFile: 'src/auth.ts',
        kbEntry: 'kb/auth.md',
        testType: 'unit',
        taskScope: {
          description: 'Migrate auth module login flow',
          acceptanceCriteria: ['Login function returns token on success'],
          parityChecks: ['Login returns equivalent token format'],
        },
      });
      const context = await readJson<AgentContext>(contextPath);
      const scope = context.payload?.taskScope as Record<string, unknown> | undefined;

      expect(scope).toBeDefined();
      expect(scope?.description).toBe('Migrate auth module login flow');
      expect(scope?.acceptanceCriteria).toEqual(['Login function returns token on success']);
    });

    it('should set test-writer outputPath to target root, not a subdirectory', async () => {
      const { contextPath } = await builder.buildContext('test-writer', 4, 'task-001', {
        targetFile: 'src/auth.ts',
      });
      const context = await readJson<AgentContext>(contextPath);

      expect(context.outputPath).toBe('/tmp/target');
      expect(context.outputPath).not.toContain('__tests__');
    });

    it('should include parityReport in test-writer inputFiles when provided', async () => {
      const { contextPath } = await builder.buildContext('test-writer', 4, 'task-001', {
        targetFile: 'src/auth.ts',
        parityReport: '/tmp/parity/auth-report.md',
      });
      const context = await readJson<AgentContext>(contextPath);

      expect(context.inputFiles).toContain('src/auth.ts');
      expect(context.inputFiles).toContain('/tmp/parity/auth-report.md');
      expect(context.outputPath).toBe('/tmp/target');
    });

    it('should default test-writer testType to unit when not specified', async () => {
      const { contextPath } = await builder.buildContext('test-writer', 4, 'task-001', {
        targetFile: 'src/auth.ts',
      });
      const context = await readJson<AgentContext>(contextPath);

      expect(context.payload?.testType).toBe('unit');
    });

    it('should route Phase 7 per-suite test-writer with e2eSuiteBrief payload', async () => {
      const suiteBrief = {
        id: 'suite-001',
        name: 'Auth E2E',
        purpose: 'Validate authentication workflows end-to-end',
        targetFiles: ['/tmp/target/src/auth.ts', '/tmp/target/src/session.ts'],
        kbReferences: ['kb/auth.md', 'kb/session.md'],
        framework: 'vitest',
        outputLocation: '/tmp/target/tests/e2e/auth',
        scenarios: ['Login flow', 'Token refresh', 'Logout'],
      };
      const { contextPath } = await builder.buildContext('test-writer', 6, 'suite-001', {
        e2eSuiteBrief: suiteBrief,
      });
      const context = await readJson<AgentContext>(contextPath);

      expect(context.inputFiles).toContain('/tmp/target/src/auth.ts');
      expect(context.inputFiles).toContain('/tmp/target/src/session.ts');
      expect(context.inputFiles).toContain('kb/auth.md');
      expect(context.inputFiles).toContain('kb/session.md');
      expect(context.outputPath).toBe('/tmp/target/tests/e2e/auth');
      expect(context.payload?.testType).toBe('e2e');
      expect(context.payload?.e2eSuiteBrief).toBeDefined();
      expect((context.payload?.e2eSuiteBrief as Record<string, unknown>).name).toBe('Auth E2E');
      expect((context.payload?.e2eSuiteBrief as Record<string, unknown>).scenarios).toEqual([
        'Login flow', 'Token refresh', 'Logout',
      ]);
    });

    it('should fall back to target outputPath when e2eSuiteBrief has no outputLocation', async () => {
      const suiteBrief = {
        id: 'suite-002',
        name: 'Payments E2E',
        purpose: 'Validate payment processing',
        targetFiles: ['/tmp/target/src/payments.ts'],
        kbReferences: [],
        framework: 'vitest',
        outputLocation: '',
        scenarios: ['Charge card'],
      };
      const { contextPath } = await builder.buildContext('test-writer', 6, 'suite-002', {
        e2eSuiteBrief: suiteBrief,
      });
      const context = await readJson<AgentContext>(contextPath);

      // Empty outputLocation falls back to target outputPath
      expect(context.outputPath).toBe('/tmp/target');
    });

    it('should not change Phase 5 test-writer context when e2eSuiteBrief is absent', async () => {
      const { contextPath } = await builder.buildContext('test-writer', 4, 'task-001', {
        targetFile: 'src/auth.ts',
        kbEntry: 'kb/auth.md',
        testType: 'unit',
      });
      const context = await readJson<AgentContext>(contextPath);

      expect(context.inputFiles).toContain('src/auth.ts');
      expect(context.inputFiles).toContain('kb/auth.md');
      expect(context.payload?.testType).toBe('unit');
      expect(context.payload?.e2eSuiteBrief).toBeUndefined();
    });

    it('should default to empty inputFiles when e2eSuiteBrief has non-array targetFiles and kbReferences', async () => {
      const suiteBrief = {
        id: 'suite-bad',
        name: 'Bad Brief',
        targetFiles: 'not-an-array',
        kbReferences: 42,
        outputLocation: '/tmp/target/tests/e2e/bad',
      };
      const { contextPath } = await builder.buildContext('test-writer', 6, 'suite-bad', {
        e2eSuiteBrief: suiteBrief,
      });
      const context = await readJson<AgentContext>(contextPath);

      expect(context.inputFiles).toEqual([]);
      expect(context.payload?.testType).toBe('e2e');
      expect(context.outputPath).toBe('/tmp/target/tests/e2e/bad');
    });

    it('should fall through to Phase 5 path when e2eSuiteBrief is not a record', async () => {
      const { contextPath } = await builder.buildContext('test-writer', 6, 'suite-str', {
        e2eSuiteBrief: 'not-an-object',
        targetFile: 'src/payments.ts',
      });
      const context = await readJson<AgentContext>(contextPath);

      // Falls through to the Phase 4 unit-test path
      expect(context.inputFiles).toContain('src/payments.ts');
      expect(context.payload?.testType).toBe('unit');
      expect(context.payload?.e2eSuiteBrief).toBeUndefined();
    });

    it('should propagate taskId in e2e suite brief payload', async () => {
      const suiteBrief = {
        id: 'suite-tid',
        name: 'TaskId Test',
        targetFiles: ['/tmp/target/src/app.ts'],
        kbReferences: [],
        outputLocation: '/tmp/target/tests/e2e/app',
        scenarios: ['Boot'],
      };
      const { contextPath } = await builder.buildContext('test-writer', 6, 'suite-tid', {
        e2eSuiteBrief: suiteBrief,
      });
      const context = await readJson<AgentContext>(contextPath);

      expect(context.payload?.taskId).toBe('suite-tid');
      expect(context.taskId).toBe('suite-tid');
    });

    it('should produce empty inputFiles when e2eSuiteBrief has empty targetFiles and kbReferences', async () => {
      const suiteBrief = {
        id: 'suite-empty',
        name: 'Empty Arrays',
        targetFiles: [],
        kbReferences: [],
        outputLocation: '/tmp/target/tests/e2e/empty',
        scenarios: [],
      };
      const { contextPath } = await builder.buildContext('test-writer', 6, 'suite-empty', {
        e2eSuiteBrief: suiteBrief,
      });
      const context = await readJson<AgentContext>(contextPath);

      expect(context.inputFiles).toEqual([]);
      expect(context.outputPath).toBe('/tmp/target/tests/e2e/empty');
      expect(context.payload?.testType).toBe('e2e');
    });

    it('should route parity-failure-resolver with source/target (no failureReport in inputFiles)', async () => {
      const { contextPath } = await builder.buildContext('parity-failure-resolver', 4, 'task-001', {
        failureReport: '/tmp/failure.md',
        sourceFile: 'src/auth.py',
        targetFile: 'src/auth.ts',
        kbEntry: 'kb/auth.md',
        attemptNumber: 2,
      });
      const context = await readJson<AgentContext>(contextPath);

      // failureReport is passed via payload, not inputFiles
      expect(context.inputFiles).not.toContain('/tmp/failure.md');
      expect(context.inputFiles).toContain('src/auth.py');
      expect(context.inputFiles).toContain('src/auth.ts');
      expect(context.outputPath).toBe('/tmp/target');
    });

    it('should include taskScope in parity-failure-resolver payload when provided', async () => {
      const { contextPath } = await builder.buildContext('parity-failure-resolver', 4, 'task-001', {
        failureReport: 'Parity failed',
        sourceFile: 'src/auth.py',
        targetFile: 'src/auth.ts',
        kbEntry: 'kb/auth.md',
        attemptNumber: 1,
        taskScope: {
          description: 'Scaffold auth module',
          acceptanceCriteria: ['Signatures compile'],
          parityChecks: ['API surface matches'],
        },
      });
      const context = await readJson<AgentContext>(contextPath);
      const scope = context.payload?.taskScope as Record<string, unknown> | undefined;

      expect(scope).toBeDefined();
      expect(scope?.description).toBe('Scaffold auth module');
      expect(scope?.acceptanceCriteria).toEqual(['Signatures compile']);
      expect(scope?.parityChecks).toEqual(['API surface matches']);
    });

    it('should include taskScope in code-migrator payload when provided', async () => {
      const { contextPath } = await builder.buildContext('code-migrator', 4, 'task-001', {
        sourceFiles: ['src/auth.py'],
        targetFiles: ['src/auth.ts'],
        kbEntry: 'kb/auth.md',
        taskScope: {
          description: 'Migrate auth login',
          acceptanceCriteria: ['Login/logout parity'],
          parityChecks: ['Token format matches'],
        },
      });
      const context = await readJson<AgentContext>(contextPath);
      const scope = context.payload?.taskScope as Record<string, unknown> | undefined;

      expect(scope).toBeDefined();
      expect(scope?.description).toBe('Migrate auth login');
      expect(scope?.acceptanceCriteria).toEqual(['Login/logout parity']);
    });

    it('should omit taskScope from code-migrator payload when not provided', async () => {
      const { contextPath } = await builder.buildContext('code-migrator', 4, 'task-001', {
        sourceFiles: ['src/auth.py'],
        targetFiles: ['src/auth.ts'],
      });
      const context = await readJson<AgentContext>(contextPath);

      expect(context.payload?.taskScope).toBeUndefined();
    });

    it('should preserve remediation payload fields in parity-failure-resolver payload', async () => {
      const { contextPath } = await builder.buildContext('parity-failure-resolver', 4, 'task-001', {
        failureReport: '/tmp/failure.md',
        sourceFile: 'src/auth.py',
        targetFile: 'src/auth.ts',
        kbEntry: 'kb/auth.md',
        attemptNumber: 2,
        failureKind: 'command',
        failureTarget: { wave: 2, workItemId: 'task-001', check: 'test' },
        artifactPaths: ['/tmp/failure.md', '/tmp/test.log'],
        expectedSuccessCondition: 'Test command exits with code 0',
      });
      const context = await readJson<AgentContext>(contextPath);
      const remediation = context.payload?.remediationContext as Record<string, unknown> | undefined;

      expect(context.inputFiles).not.toContain('/tmp/failure.md');
      expect(context.inputFiles).toContain('src/auth.py');
      expect(context.inputFiles).toContain('src/auth.ts');
      expect(context.payload?.attemptNumber).toBe(2);
      expect(remediation?.failureKind).toBe('command');
      expect(remediation?.expectedSuccessCondition).toBe('Test command exits with code 0');
    });

    it('should keep inline failure text in payload and exclude it from inputFiles', async () => {
      const inlineFailure = [
        'test command failed (exit code 101):',
        'error[E0601]: `main` function not found in crate `common`',
        ' --> examples/common.rs:256:2',
      ].join('\n');

      const { contextPath } = await builder.buildContext('parity-failure-resolver', 4, 'wave-1', {
        failureReport: inlineFailure,
        failureType: 'test',
        sourceFile: 'examples/common.h',
        targetFile: 'examples/common.rs',
      });
      const context = await readJson<AgentContext>(contextPath);

      expect(context.inputFiles).not.toContain(inlineFailure);
      expect(context.inputFiles).toContain('examples/common.h');
      expect(context.inputFiles).toContain('examples/common.rs');
      expect(context.payload?.failureReport).toBe(inlineFailure);
      expect(context.payload?.failureType).toBe('test');
    });

    it('should support legacy remediation alias in parity-failure-resolver payload', async () => {
      const { contextPath } = await builder.buildContext('parity-failure-resolver', 4, 'task-001', {
        failureReport: '/tmp/failure.md',
        sourceFile: 'src/auth.py',
        targetFile: 'src/auth.ts',
        remediation: {
          failureKind: 'build',
          failureTarget: { wave: 2, workItemId: 'task-001', check: 'build' },
          artifactPaths: ['/tmp/build.log'],
          expectedSuccessCondition: 'Build command exits with code 0',
        },
      });
      const context = await readJson<AgentContext>(contextPath);
      const remediation = context.payload?.remediationContext as Record<string, unknown> | undefined;

      expect(remediation?.failureKind).toBe('build');
      expect(remediation?.failureSummary).toBeUndefined();
    });

    it('should omit remediationContext when nested remediation payload is not an object', async () => {
      const { contextPath } = await builder.buildContext('parity-failure-resolver', 4, 'task-001', {
        failureReport: '/tmp/failure.md',
        sourceFile: 'src/auth.py',
        targetFile: 'src/auth.ts',
        remediationContext: 'invalid-remediation-shape',
      });
      const context = await readJson<AgentContext>(contextPath);

      expect(context.payload?.remediationContext).toBeUndefined();
    });

    it('should route final-parity-checker to source + output + plan', async () => {
      const { contextPath } = await builder.buildContext('final-parity-checker', 5);
      const context = await readJson<AgentContext>(contextPath);

      expect(context.inputFiles).toContain('/tmp/source');
      expect(context.inputFiles).toContain('/tmp/target');
      expect(context.inputFiles.some((f: string) => f.includes('migration-plan.md'))).toBe(true);
      expect(context.outputPath).toBe('/tmp/target');
    });

    it('should route e2e-test-crafter to KB architecture docs', async () => {
      const { contextPath } = await builder.buildContext('e2e-test-crafter', 6);
      const context = await readJson<AgentContext>(contextPath);

      expect(context.inputFiles.some((f: string) => f.includes('architecture.md'))).toBe(true);
      expect(context.inputFiles.some((f: string) => f.includes('integrations.md'))).toBe(true);
      expect(context.outputPath).toContain('e2e');
    });

    it('should route documentation-writer to KB + plan', async () => {
      const { contextPath } = await builder.buildContext('documentation-writer', 6);
      const context = await readJson<AgentContext>(contextPath);

      expect(context.inputFiles.some((f: string) => f.includes('knowledge-base'))).toBe(true);
      expect(context.inputFiles.some((f: string) => f.includes('migration-plan.md'))).toBe(true);
      // No longer includes final-parity-report.md — structured data only
      expect(context.inputFiles.every((f: string) => !f.includes('final-parity-report.md'))).toBe(true);
      expect(context.outputPath).toContain('docs');
    });

    it('should route idiomatic-reviewer to target output dir', async () => {
      const { contextPath } = await builder.buildContext('idiomatic-reviewer', 8);
      const context = await readJson<AgentContext>(contextPath);

      expect(context.inputFiles).toContain('/tmp/target');
      expect(context.outputPath).toBe('/tmp/target');
    });

    it('should route idiomatic-refactorer with targetFile and structured issue from payload', async () => {
      const issue = {
        file: '/tmp/target/src/utils.ts',
        location: '42-58',
        issue: 'Uses manual for-loop instead of map',
        suggestion: 'Replace with Array.prototype.map()',
        details: 'The for-loop iterates over an array and pushes to a new array, which is the exact use case for map().',
      };
      const { contextPath } = await builder.buildContext('idiomatic-refactorer', 8, undefined, {
        targetFile: '/tmp/target/src/utils.ts',
        issue,
      });
      const context = await readJson<AgentContext>(contextPath);

      expect(context.inputFiles).toContain('/tmp/target/src/utils.ts');
      // No idiomaticReport path in inputFiles
      expect(context.inputFiles).toHaveLength(1);
      expect(context.outputPath).toBe('/tmp/target');
      expect(context.payload?.issue).toEqual(issue);
      expect(context.payload?.targetFile).toBe('/tmp/target/src/utils.ts');
    });

    it('should use default routing for unknown/orchestrator agents', async () => {
      const { contextPath } = await builder.buildContext('migration-orchestrator', 1);
      const context = await readJson<AgentContext>(contextPath);

      expect(context.inputFiles).toContain('/tmp/source');
      expect(context.outputPath).toBe(progressDir);
    });
  });

  // ─── Guidance Propagation ──────────────────────────────────────────

  describe('Guidance Propagation', () => {
    it('should include guidance in context when config has guidance', async () => {
      const config = createMockConfig({
        guidance: ['Do not use wrapper crates', 'Write native Rust port'],
      });
      const guidanceBuilder = new ContextBuilder(config, progressDir, paths);

      const { contextPath } = await guidanceBuilder.buildContext('code-migrator', 4, 'task-001');
      const context = await readJson<AgentContext>(contextPath);

      expect(context.guidance).toEqual(['Do not use wrapper crates', 'Write native Rust port']);
    });

    it('should omit guidance from context when config has no guidance', async () => {
      const { contextPath } = await builder.buildContext('code-migrator', 4, 'task-001');
      const context = await readJson<AgentContext>(contextPath);

      expect(context.guidance).toBeUndefined();
    });

    it('should omit guidance from context when config guidance is empty array', async () => {
      const config = createMockConfig({ guidance: [] });
      const emptyGuidanceBuilder = new ContextBuilder(config, progressDir, paths);

      const { contextPath } = await emptyGuidanceBuilder.buildContext('migration-planner', 4);
      const context = await readJson<AgentContext>(contextPath);

      expect(context.guidance).toBeUndefined();
    });

    it('should propagate guidance to all agent types', async () => {
      const config = createMockConfig({
        guidance: ['No FFI bindings allowed'],
      });
      const guidanceBuilder = new ContextBuilder(config, progressDir, paths);

      for (const agent of ['migration-planner', 'code-migrator', 'parity-verifier'] as const) {
        const { contextPath } = await guidanceBuilder.buildContext(agent, 1, 'task-001');
        const context = await readJson<AgentContext>(contextPath);
        expect(context.guidance).toEqual(['No FFI bindings allowed']);
      }
    });
  });
});
