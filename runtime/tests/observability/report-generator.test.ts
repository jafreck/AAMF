import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ReportGenerator } from '../../src/observability/report-generator.js';
import type { InvocationMetric } from '../../src/agents/types.js';
import type { MetricsAggregate } from '../../src/observability/metrics-collector.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeMetric(overrides?: Partial<InvocationMetric>): InvocationMetric {
  return {
    runId: 'run-001',
    phase: 4,
    taskId: 'task-001',
    agentType: 'code-migrator',
    invocationId: 'inv-abc-123',
    startTime: '2026-02-27T06:00:00.000Z',
    endTime: '2026-02-27T06:00:05.000Z',
    durationMs: 5000,
    attemptNumber: 1,
    maxAttempts: 3,
    wasRetry: false,
    status: 'success',
    model: 'claude-opus-4',
    tokensPrompt: 1000,
    tokensCompletion: 500,
    tokensTotal: 1500,
    costUsd: 0.045,
    ...overrides,
  };
}

function makeAggregates(overrides?: Partial<MetricsAggregate>): MetricsAggregate {
  return {
    totalInvocations: 2,
    invocationsByAgent: { 'code-migrator': 1, 'test-writer': 1 },
    totalRetries: 0,
    retriesByAgent: {},
    retriesByPhase: {},
    totalTokens: 3000,
    totalCost: 0.09,
    tokensByAgent: { 'code-migrator': 1500, 'test-writer': 1500 },
    costByAgent: { 'code-migrator': 0.045, 'test-writer': 0.045 },
    peakParallelInvocations: 2,
    parallelismOverTime: [
      { epochSecond: 1772175600, concurrency: 1 },
      { epochSecond: 1772175601, concurrency: 2 },
    ],
    escalationCount: 0,
    escalationsByTier: {},
    totalEscalationCostUsd: 0,
    retriesAvoidedByRouting: 0,
    phase4ExecutionMode: 'wave-barrier',
    phase4DurationMs: 12000,
    completedPhase4Tasks: 2,
    waveCount: 1,
    waveValidationRuns: 1,
    waveConvergenceIterations: 1,
    waveConvergenceFailures: 0,
    waveConvergenceLimitHits: 0,
    buildCommandRuns: 1,
    testCommandRuns: 1,
    commandRecoveryAttempts: 0,
    commandInfraRetries: 0,
    recoveryLoopTimeMs: 0,
    buildTestInvocationsPerCompletedTask: 1,
    retryVolumePerCompletedTask: 0,
    parityRetryContinuedCount: 0,
    parityEarlyStopCount: 0,
    parityTargetedRecoveryCount: 0,
    parityRetryReductions: 0,
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ReportGenerator', () => {
  let generator: ReportGenerator;
  let tmpDir: string;
  let reportDir: string;
  let metricsDir: string;

  beforeEach(async () => {
    generator = new ReportGenerator();
    tmpDir = await mkdtemp(join(tmpdir(), 'report-test-'));
    reportDir = join(tmpDir, 'reports', 'observability');
    metricsDir = join(tmpDir, 'metrics');
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe('generate', () => {
    it('should create index.md in the report directory', async () => {
      const metrics = [makeMetric()];
      const aggregates = makeAggregates({ totalInvocations: 1 });
      await generator.generate(metricsDir, reportDir, metrics, aggregates);
      const content = await readFile(join(reportDir, 'index.md'), 'utf-8');
      expect(content).toContain('# Observability Report');
    });

    it('should create metrics.json in the report directory', async () => {
      const metrics = [makeMetric()];
      const aggregates = makeAggregates({ totalInvocations: 1 });
      await generator.generate(metricsDir, reportDir, metrics, aggregates);
      const raw = await readFile(join(reportDir, 'metrics.json'), 'utf-8');
      const parsed = JSON.parse(raw);
      expect(parsed).toHaveProperty('metrics');
      expect(parsed).toHaveProperty('aggregates');
      expect(parsed.metrics).toHaveLength(1);
    });

    it('should include a Mermaid Gantt chart section', async () => {
      const metrics = [
        makeMetric({ agentType: 'code-migrator', taskId: 'task-001' }),
        makeMetric({ agentType: 'test-writer', taskId: 'task-002' }),
      ];
      const aggregates = makeAggregates();
      await generator.generate(metricsDir, reportDir, metrics, aggregates);
      const content = await readFile(join(reportDir, 'index.md'), 'utf-8');
      expect(content).toContain('```mermaid');
      expect(content).toContain('gantt');
      expect(content).toContain('Agent Invocation Timeline');
    });

    it('should include parallelism over time section', async () => {
      const metrics = [makeMetric()];
      const aggregates = makeAggregates();
      await generator.generate(metricsDir, reportDir, metrics, aggregates);
      const content = await readFile(join(reportDir, 'index.md'), 'utf-8');
      expect(content).toContain('Parallelism Over Time');
      expect(content).toContain('Peak concurrent invocations');
    });

    it('should include cost/token breakdown table', async () => {
      const metrics = [makeMetric()];
      const aggregates = makeAggregates();
      await generator.generate(metricsDir, reportDir, metrics, aggregates);
      const content = await readFile(join(reportDir, 'index.md'), 'utf-8');
      expect(content).toContain('Cost & Token Breakdown by Agent Type');
      expect(content).toContain('| Agent | Invocations | Tokens | Cost (USD) |');
    });

    it('should include retry summary table', async () => {
      const metrics = [
        makeMetric({ wasRetry: false, attemptNumber: 1, status: 'failed' }),
        makeMetric({ wasRetry: true, attemptNumber: 2, status: 'success' }),
      ];
      const aggregates = makeAggregates({ totalRetries: 1 });
      await generator.generate(metricsDir, reportDir, metrics, aggregates);
      const content = await readFile(join(reportDir, 'index.md'), 'utf-8');
      expect(content).toContain('Retry Summary');
    });

    it('should include wave lifecycle and efficiency section', async () => {
      const metrics = [makeMetric()];
      const aggregates = makeAggregates({
        waveCount: 2,
        waveValidationRuns: 3,
        waveConvergenceIterations: 4,
        waveConvergenceFailures: 2,
        waveConvergenceLimitHits: 1,
        buildCommandRuns: 3,
        testCommandRuns: 2,
        commandRecoveryAttempts: 1,
        commandInfraRetries: 2,
        recoveryLoopTimeMs: 2500,
        buildTestInvocationsPerCompletedTask: 2.5,
        retryVolumePerCompletedTask: 0.5,
      });
      await generator.generate(metricsDir, reportDir, metrics, aggregates);
      const content = await readFile(join(reportDir, 'index.md'), 'utf-8');
      expect(content).toContain('Wave Lifecycle & Efficiency');
      expect(content).toContain('Execution mode');
      expect(content).toContain('Convergence iterations:** 4');
      expect(content).toContain('Convergence failures:** 2');
      expect(content).toContain('Convergence limit hits:** 1');
      expect(content).toContain('| Build command runs | 3 |');
      expect(content).toContain('| Test command runs | 2 |');
      expect(content).toContain('| Recovery-loop time (ms) | 2500 |');
      expect(content).toContain('| Build/test invocations per completed task | 2.50 |');
      expect(content).toContain('| Retry volume per completed task | 0.50 |');
    });

    it('should include parity guardrail decision summary in markdown', async () => {
      const metrics = [makeMetric()];
      const aggregates = makeAggregates({
        parityRetryContinuedCount: 2,
        parityEarlyStopCount: 1,
        parityTargetedRecoveryCount: 1,
        parityRetryReductions: 3,
      });
      await generator.generate(metricsDir, reportDir, metrics, aggregates);
      const content = await readFile(join(reportDir, 'index.md'), 'utf-8');
      expect(content).toContain('Parity Guardrail Decisions');
      expect(content).toContain('| Retry-continued decisions | 2 |');
      expect(content).toContain('| Early-stop decisions | 1 |');
      expect(content).toContain('| Targeted recoveries | 1 |');
      expect(content).toContain('| Retry reductions | 3 |');
    });

    it('should include wave fields in metrics.json aggregates', async () => {
      const metrics = [makeMetric()];
      const aggregates = makeAggregates({
        phase4ExecutionMode: 'per-task',
        parityEarlyStopCount: 1,
        parityRetryReductions: 2,
      });
      await generator.generate(metricsDir, reportDir, metrics, aggregates);
      const raw = await readFile(join(reportDir, 'metrics.json'), 'utf-8');
      const parsed = JSON.parse(raw);
      expect(parsed.aggregates).toHaveProperty('phase4ExecutionMode', 'per-task');
      expect(parsed.aggregates).toHaveProperty('waveCount');
      expect(parsed.aggregates).toHaveProperty('buildTestInvocationsPerCompletedTask');
      expect(parsed.aggregates).toHaveProperty('parityEarlyStopCount', 1);
      expect(parsed.aggregates).toHaveProperty('parityRetryReductions', 2);
    });

    it('should show "No retries recorded" when there are no retries', async () => {
      const metrics = [makeMetric({ wasRetry: false })];
      const aggregates = makeAggregates({ totalRetries: 0 });
      await generator.generate(metricsDir, reportDir, metrics, aggregates);
      const content = await readFile(join(reportDir, 'index.md'), 'utf-8');
      expect(content).toContain('No retries recorded');
    });

    it('should mark failed invocations as crit in Gantt chart', async () => {
      const metrics = [makeMetric({ status: 'failed' })];
      const aggregates = makeAggregates({ totalInvocations: 1 });
      await generator.generate(metricsDir, reportDir, metrics, aggregates);
      const content = await readFile(join(reportDir, 'index.md'), 'utf-8');
      expect(content).toContain('crit');
    });

    it('should mark retry invocations as active in Gantt chart', async () => {
      const metrics = [makeMetric({ wasRetry: true, status: 'success' })];
      const aggregates = makeAggregates({ totalInvocations: 1 });
      await generator.generate(metricsDir, reportDir, metrics, aggregates);
      const content = await readFile(join(reportDir, 'index.md'), 'utf-8');
      expect(content).toContain('active');
    });

    it('should show "No invocations recorded" when metrics are empty', async () => {
      const metrics: InvocationMetric[] = [];
      const aggregates = makeAggregates({
        totalInvocations: 0,
        parallelismOverTime: [],
        invocationsByAgent: {},
      });
      await generator.generate(metricsDir, reportDir, metrics, aggregates);
      const content = await readFile(join(reportDir, 'index.md'), 'utf-8');
      expect(content).toContain('No invocations recorded');
    });

    it('should clearly represent failed-then-succeeded retry chains', async () => {
      const metrics = [
        makeMetric({
          agentType: 'code-migrator',
          taskId: 'task-001',
          phase: 4,
          attemptNumber: 1,
          wasRetry: false,
          status: 'failed',
          invocationId: 'inv-1',
        }),
        makeMetric({
          agentType: 'code-migrator',
          taskId: 'task-001',
          phase: 4,
          attemptNumber: 2,
          wasRetry: true,
          status: 'success',
          invocationId: 'inv-2',
        }),
      ];
      const aggregates = makeAggregates({ totalRetries: 1 });
      await generator.generate(metricsDir, reportDir, metrics, aggregates);
      const content = await readFile(join(reportDir, 'index.md'), 'utf-8');
      expect(content).toContain('✅ Yes');
    });

    it('should show "No" for retry chains that did not succeed', async () => {
      const metrics = [
        makeMetric({
          agentType: 'code-migrator',
          taskId: 'task-001',
          phase: 4,
          attemptNumber: 1,
          wasRetry: false,
          status: 'failed',
          invocationId: 'inv-1',
        }),
        makeMetric({
          agentType: 'code-migrator',
          taskId: 'task-001',
          phase: 4,
          attemptNumber: 2,
          wasRetry: true,
          status: 'failed',
          invocationId: 'inv-2',
        }),
      ];
      const aggregates = makeAggregates({ totalRetries: 1 });
      await generator.generate(metricsDir, reportDir, metrics, aggregates);
      const content = await readFile(join(reportDir, 'index.md'), 'utf-8');
      expect(content).toContain('❌ No');
    });

    it('should group Gantt sections by agent type', async () => {
      const metrics = [
        makeMetric({ agentType: 'code-migrator', invocationId: 'inv-1' }),
        makeMetric({ agentType: 'test-writer', invocationId: 'inv-2' }),
      ];
      const aggregates = makeAggregates();
      await generator.generate(metricsDir, reportDir, metrics, aggregates);
      const content = await readFile(join(reportDir, 'index.md'), 'utf-8');
      expect(content).toContain('section code-migrator');
      expect(content).toContain('section test-writer');
    });

    it('should show parallelism table with epoch seconds and concurrency', async () => {
      const metrics = [makeMetric()];
      const aggregates = makeAggregates({
        parallelismOverTime: [
          { epochSecond: 1000, concurrency: 1 },
          { epochSecond: 1001, concurrency: 3 },
        ],
      });
      await generator.generate(metricsDir, reportDir, metrics, aggregates);
      const content = await readFile(join(reportDir, 'index.md'), 'utf-8');
      expect(content).toContain('| 1000 | 1 |');
      expect(content).toContain('| 1001 | 3 |');
    });

    it('should show "No parallelism data" when parallelism buckets are empty', async () => {
      const metrics = [makeMetric()];
      const aggregates = makeAggregates({ parallelismOverTime: [] });
      await generator.generate(metricsDir, reportDir, metrics, aggregates);
      const content = await readFile(join(reportDir, 'index.md'), 'utf-8');
      expect(content).toContain('No parallelism data');
    });
  });
});
