import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MetricsCollector } from '../../src/observability/metrics-collector.js';
import type { InvocationMetric } from '../../src/agents/types.js';

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

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('MetricsCollector', () => {
  let collector: MetricsCollector;
  let tmpDir: string;

  beforeEach(async () => {
    collector = new MetricsCollector();
    tmpDir = await mkdtemp(join(tmpdir(), 'metrics-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // ─── record / getMetrics ──────────────────────────────────────────────

  describe('record', () => {
    it('should add a metric to the in-memory store', () => {
      const metric = makeMetric();
      collector.record(metric);
      expect(collector.getMetrics()).toHaveLength(1);
      expect(collector.getMetrics()[0]).toBe(metric);
    });

    it('should accumulate multiple metrics', () => {
      collector.record(makeMetric({ invocationId: 'inv-1' }));
      collector.record(makeMetric({ invocationId: 'inv-2' }));
      collector.record(makeMetric({ invocationId: 'inv-3' }));
      expect(collector.getMetrics()).toHaveLength(3);
    });
  });

  describe('getMetrics', () => {
    it('should return empty array when no metrics recorded', () => {
      expect(collector.getMetrics()).toEqual([]);
    });
  });

  // ─── writeJsonl ───────────────────────────────────────────────────────

  describe('writeJsonl', () => {
    it('should create metrics directory and JSONL file', async () => {
      collector.record(makeMetric());
      await collector.writeJsonl(tmpDir);
      const content = await readFile(join(tmpDir, 'metrics', 'invocations.jsonl'), 'utf-8');
      expect(content.trim()).not.toBe('');
    });

    it('should write the last metric as a single JSON line', async () => {
      const metric = makeMetric({ invocationId: 'inv-only' });
      collector.record(metric);
      await collector.writeJsonl(tmpDir);
      const content = await readFile(join(tmpDir, 'metrics', 'invocations.jsonl'), 'utf-8');
      const parsed = JSON.parse(content.trim());
      expect(parsed.invocationId).toBe('inv-only');
    });

    it('should append (not overwrite) on subsequent calls', async () => {
      collector.record(makeMetric({ invocationId: 'inv-1' }));
      await collector.writeJsonl(tmpDir);
      collector.record(makeMetric({ invocationId: 'inv-2' }));
      await collector.writeJsonl(tmpDir);

      const content = await readFile(join(tmpDir, 'metrics', 'invocations.jsonl'), 'utf-8');
      const lines = content.split('\n').filter((l) => l.trim().length > 0);
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]!).invocationId).toBe('inv-1');
      expect(JSON.parse(lines[1]!).invocationId).toBe('inv-2');
    });

    it('should do nothing when no metrics are recorded', async () => {
      await collector.writeJsonl(tmpDir);
      // No file should be created since there's no metric to write
      await expect(
        readFile(join(tmpDir, 'metrics', 'invocations.jsonl'), 'utf-8'),
      ).rejects.toThrow();
    });
  });

  // ─── writeSummary ─────────────────────────────────────────────────────

  describe('writeSummary', () => {
    it('should write summary.json with aggregate data', async () => {
      collector.record(makeMetric());
      await collector.writeSummary(tmpDir);
      const raw = await readFile(join(tmpDir, 'metrics', 'summary.json'), 'utf-8');
      const summary = JSON.parse(raw);
      expect(summary.totalInvocations).toBe(1);
      expect(summary.totalTokens).toBe(1500);
      expect(summary.totalCost).toBe(0.045);
    });

    it('should write valid JSON with all aggregate fields', async () => {
      collector.record(makeMetric({ wasRetry: true, agentType: 'test-writer' }));
      collector.record(makeMetric({ agentType: 'code-migrator' }));
      await collector.writeSummary(tmpDir);
      const raw = await readFile(join(tmpDir, 'metrics', 'summary.json'), 'utf-8');
      const summary = JSON.parse(raw);
      expect(summary).toHaveProperty('totalInvocations');
      expect(summary).toHaveProperty('invocationsByAgent');
      expect(summary).toHaveProperty('totalRetries');
      expect(summary).toHaveProperty('retriesByAgent');
      expect(summary).toHaveProperty('retriesByPhase');
      expect(summary).toHaveProperty('totalTokens');
      expect(summary).toHaveProperty('totalCost');
      expect(summary).toHaveProperty('tokensByAgent');
      expect(summary).toHaveProperty('costByAgent');
      expect(summary).toHaveProperty('peakParallelInvocations');
      expect(summary).toHaveProperty('parallelismOverTime');
      expect(summary).toHaveProperty('phase4ExecutionMode');
      expect(summary).toHaveProperty('waveCount');
      expect(summary).toHaveProperty('buildCommandRuns');
      expect(summary).toHaveProperty('testCommandRuns');
      expect(summary).toHaveProperty('recoveryLoopTimeMs');
      expect(summary).toHaveProperty('buildTestInvocationsPerCompletedTask');
      expect(summary).toHaveProperty('retryVolumePerCompletedTask');
      expect(summary).toHaveProperty('parityRetryContinuedCount');
      expect(summary).toHaveProperty('parityEarlyStopCount');
      expect(summary).toHaveProperty('parityTargetedRecoveryCount');
      expect(summary).toHaveProperty('parityRetryReductions');
    });
  });

  // ─── loadFromJsonl ────────────────────────────────────────────────────

  describe('loadFromJsonl', () => {
    it('should load metrics from existing JSONL file', async () => {
      // Write some metrics manually
      const metricsDir = join(tmpDir, 'metrics');
      await mkdir(metricsDir, { recursive: true });
      const m1 = makeMetric({ invocationId: 'inv-1' });
      const m2 = makeMetric({ invocationId: 'inv-2' });
      await writeFile(
        join(metricsDir, 'invocations.jsonl'),
        JSON.stringify(m1) + '\n' + JSON.stringify(m2) + '\n',
        'utf-8',
      );

      await collector.loadFromJsonl(tmpDir);
      expect(collector.getMetrics()).toHaveLength(2);
      expect(collector.getMetrics()[0]!.invocationId).toBe('inv-1');
      expect(collector.getMetrics()[1]!.invocationId).toBe('inv-2');
    });

    it('should skip the first N records when skipCount is provided', async () => {
      const metricsDir = join(tmpDir, 'metrics');
      await mkdir(metricsDir, { recursive: true });
      const lines = [
        JSON.stringify(makeMetric({ invocationId: 'inv-1' })),
        JSON.stringify(makeMetric({ invocationId: 'inv-2' })),
        JSON.stringify(makeMetric({ invocationId: 'inv-3' })),
      ].join('\n') + '\n';
      await writeFile(join(metricsDir, 'invocations.jsonl'), lines, 'utf-8');

      await collector.loadFromJsonl(tmpDir, 2);
      expect(collector.getMetrics()).toHaveLength(1);
      expect(collector.getMetrics()[0]!.invocationId).toBe('inv-3');
    });

    it('should do nothing when JSONL file does not exist', async () => {
      await collector.loadFromJsonl(tmpDir);
      expect(collector.getMetrics()).toEqual([]);
    });

    it('should handle empty file gracefully', async () => {
      const metricsDir = join(tmpDir, 'metrics');
      await mkdir(metricsDir, { recursive: true });
      await writeFile(join(metricsDir, 'invocations.jsonl'), '', 'utf-8');
      await collector.loadFromJsonl(tmpDir);
      expect(collector.getMetrics()).toEqual([]);
    });
  });

  // ─── getAggregates ────────────────────────────────────────────────────

  describe('getAggregates', () => {
    it('should return zero counts for empty collector', () => {
      const agg = collector.getAggregates();
      expect(agg.totalInvocations).toBe(0);
      expect(agg.totalRetries).toBe(0);
      expect(agg.totalTokens).toBe(0);
      expect(agg.totalCost).toBe(0);
      expect(agg.peakParallelInvocations).toBe(0);
      expect(agg.parallelismOverTime).toEqual([]);
      expect(agg.waveCount).toBe(0);
      expect(agg.buildCommandRuns).toBe(0);
      expect(agg.buildTestInvocationsPerCompletedTask).toBe(0);
      expect(agg.parityRetryContinuedCount).toBe(0);
      expect(agg.parityEarlyStopCount).toBe(0);
      expect(agg.parityTargetedRecoveryCount).toBe(0);
      expect(agg.parityRetryReductions).toBe(0);
    });

    it('should count invocations by agent', () => {
      collector.record(makeMetric({ agentType: 'code-migrator' }));
      collector.record(makeMetric({ agentType: 'code-migrator' }));
      collector.record(makeMetric({ agentType: 'test-writer' }));
      const agg = collector.getAggregates();
      expect(agg.totalInvocations).toBe(3);
      expect(agg.invocationsByAgent['code-migrator']).toBe(2);
      expect(agg.invocationsByAgent['test-writer']).toBe(1);
    });

    it('should count retries correctly', () => {
      collector.record(makeMetric({ wasRetry: false }));
      collector.record(makeMetric({ wasRetry: true, agentType: 'code-migrator', phase: 4 }));
      collector.record(makeMetric({ wasRetry: true, agentType: 'test-writer', phase: 5 }));
      const agg = collector.getAggregates();
      expect(agg.totalRetries).toBe(2);
      expect(agg.retriesByAgent['code-migrator']).toBe(1);
      expect(agg.retriesByAgent['test-writer']).toBe(1);
      expect(agg.retriesByPhase[4]).toBe(1);
      expect(agg.retriesByPhase[5]).toBe(1);
    });

    it('should sum tokens and cost by agent', () => {
      collector.record(makeMetric({ agentType: 'code-migrator', tokensTotal: 1000, costUsd: 0.03 }));
      collector.record(makeMetric({ agentType: 'code-migrator', tokensTotal: 2000, costUsd: 0.06 }));
      collector.record(makeMetric({ agentType: 'test-writer', tokensTotal: 500, costUsd: 0.015 }));
      const agg = collector.getAggregates();
      expect(agg.totalTokens).toBe(3500);
      expect(agg.totalCost).toBeCloseTo(0.105, 6);
      expect(agg.tokensByAgent['code-migrator']).toBe(3000);
      expect(agg.costByAgent['code-migrator']).toBeCloseTo(0.09, 6);
      expect(agg.tokensByAgent['test-writer']).toBe(500);
    });

    it('should use externally-provided peakConcurrency when larger', () => {
      collector.record(makeMetric());
      const agg = collector.getAggregates(10);
      expect(agg.peakParallelInvocations).toBe(10);
    });

    it('should use time-series peak when external peak is smaller', () => {
      // Two overlapping invocations → concurrency = 2
      collector.record(
        makeMetric({
          startTime: '2026-02-27T06:00:00.000Z',
          endTime: '2026-02-27T06:00:05.000Z',
        }),
      );
      collector.record(
        makeMetric({
          startTime: '2026-02-27T06:00:01.000Z',
          endTime: '2026-02-27T06:00:04.000Z',
        }),
      );
      const agg = collector.getAggregates(1);
      expect(agg.peakParallelInvocations).toBeGreaterThanOrEqual(2);
    });

    it('should compute parallelism buckets for overlapping invocations', () => {
      collector.record(
        makeMetric({
          startTime: '2026-02-27T06:00:00.000Z',
          endTime: '2026-02-27T06:00:03.000Z',
        }),
      );
      collector.record(
        makeMetric({
          startTime: '2026-02-27T06:00:01.000Z',
          endTime: '2026-02-27T06:00:02.000Z',
        }),
      );
      const agg = collector.getAggregates();
      expect(agg.parallelismOverTime.length).toBeGreaterThan(0);
      const peakBucket = agg.parallelismOverTime.reduce(
        (max, b) => (b.concurrency > max.concurrency ? b : max),
        { epochSecond: 0, concurrency: 0 },
      );
      expect(peakBucket.concurrency).toBeGreaterThanOrEqual(2);
    });

    it('should return zero routing aggregates when no routing metrics present', () => {
      collector.record(makeMetric());
      const agg = collector.getAggregates();
      expect(agg.escalationCount).toBe(0);
      expect(agg.escalationsByTier).toEqual({});
      expect(agg.totalEscalationCostUsd).toBe(0);
      expect(agg.retriesAvoidedByRouting).toBe(0);
    });

    it('should compute routing aggregates from routed invocations', () => {
      // Normal tier — not counted as escalation
      collector.record(makeMetric({ routingTier: 'normal', attemptNumber: 1, status: 'success' }));
      // Heavy tier, success on first attempt → escalation + retry avoided
      collector.record(
        makeMetric({
          routingTier: 'heavy',
          attemptNumber: 1,
          status: 'success',
          escalationCostUsd: 0.02,
        }),
      );
      // Critical tier, success on first attempt → escalation + retry avoided
      collector.record(
        makeMetric({
          routingTier: 'critical',
          attemptNumber: 1,
          status: 'success',
          escalationCostUsd: 0.05,
        }),
      );
      // Heavy tier, second attempt (retry) → escalation, no retry avoided
      collector.record(
        makeMetric({
          routingTier: 'heavy',
          attemptNumber: 2,
          wasRetry: true,
          status: 'success',
          escalationCostUsd: 0.03,
        }),
      );
      // Critical tier, failed → escalation, no retry avoided
      collector.record(
        makeMetric({
          routingTier: 'critical',
          attemptNumber: 1,
          status: 'failed',
          escalationCostUsd: 0.04,
        }),
      );
      // No routingTier set at all — not counted
      collector.record(makeMetric());

      const agg = collector.getAggregates();
      expect(agg.escalationCount).toBe(4);
      expect(agg.escalationsByTier).toEqual({ heavy: 2, critical: 2 });
      expect(agg.totalEscalationCostUsd).toBeCloseTo(0.14, 6);
      expect(agg.retriesAvoidedByRouting).toBe(2);
    });

    it('should incorporate orchestrator-provided phase 4 wave snapshot fields', () => {
      collector.record(makeMetric({ phase: 4, taskId: 'task-001', wasRetry: true }));
      collector.record(makeMetric({ phase: 4, taskId: 'task-002', wasRetry: false }));
      collector.setPhase4Snapshot({
        executionMode: 'wave-barrier',
        phase4DurationMs: 9000,
        completedTaskCount: 2,
        waveCount: 1,
        waveValidationRuns: 2,
        waveConvergenceIterations: 2,
        waveConvergenceFailures: 1,
        waveConvergenceLimitHits: 0,
        buildCommandRuns: 2,
        testCommandRuns: 1,
        commandRecoveryAttempts: 1,
        commandInfraRetries: 1,
        recoveryLoopTimeMs: 1200,
        parityRetryContinuedCount: 3,
        parityEarlyStopCount: 2,
        parityTargetedRecoveryCount: 1,
        parityRetryReductions: 4,
      });

      const agg = collector.getAggregates();
      expect(agg.phase4ExecutionMode).toBe('wave-barrier');
      expect(agg.phase4DurationMs).toBe(9000);
      expect(agg.completedPhase4Tasks).toBe(2);
      expect(agg.waveCount).toBe(1);
      expect(agg.waveValidationRuns).toBe(2);
      expect(agg.waveConvergenceIterations).toBe(2);
      expect(agg.waveConvergenceFailures).toBe(1);
      expect(agg.buildCommandRuns).toBe(2);
      expect(agg.testCommandRuns).toBe(1);
      expect(agg.commandRecoveryAttempts).toBe(1);
      expect(agg.commandInfraRetries).toBe(1);
      expect(agg.recoveryLoopTimeMs).toBe(1200);
      expect(agg.buildTestInvocationsPerCompletedTask).toBeCloseTo(1.5, 6);
      expect(agg.retryVolumePerCompletedTask).toBeCloseTo(0.5, 6);
      expect(agg.parityRetryContinuedCount).toBe(3);
      expect(agg.parityEarlyStopCount).toBe(2);
      expect(agg.parityTargetedRecoveryCount).toBe(1);
      expect(agg.parityRetryReductions).toBe(4);
    });

    it('should derive phase 4 completion metrics from non-wave task IDs when no snapshot is set', () => {
      collector.record(makeMetric({ phase: 4, taskId: 'task-001', wasRetry: false }));
      collector.record(makeMetric({ phase: 4, taskId: 'task-001', wasRetry: true }));
      collector.record(makeMetric({ phase: 4, taskId: 'task-002', wasRetry: false }));
      collector.record(makeMetric({ phase: 4, taskId: 'wave-1', wasRetry: false }));
      collector.record(makeMetric({ phase: 4, taskId: '   ', wasRetry: false }));

      const agg = collector.getAggregates();
      expect(agg.phase4ExecutionMode).toBe('unknown');
      expect(agg.completedPhase4Tasks).toBe(2);
      expect(agg.buildCommandRuns).toBe(0);
      expect(agg.testCommandRuns).toBe(0);
      expect(agg.buildTestInvocationsPerCompletedTask).toBe(0);
      expect(agg.retryVolumePerCompletedTask).toBeCloseTo(0.5, 6);
    });

    it('should count zero escalations when all metrics have normal tier', () => {
      collector.record(makeMetric({ routingTier: 'normal', attemptNumber: 1, status: 'success' }));
      collector.record(makeMetric({ routingTier: 'normal', attemptNumber: 1, status: 'success' }));
      const agg = collector.getAggregates();
      expect(agg.escalationCount).toBe(0);
      expect(agg.escalationsByTier).toEqual({});
      expect(agg.retriesAvoidedByRouting).toBe(0);
    });

    it('should sum escalationCostUsd from all metrics regardless of tier', () => {
      // Normal tier with escalationCostUsd — still summed
      collector.record(
        makeMetric({ routingTier: 'normal', escalationCostUsd: 0.01 }),
      );
      // No routingTier with escalationCostUsd — still summed
      collector.record(makeMetric({ escalationCostUsd: 0.02 }));
      // Heavy tier with escalationCostUsd
      collector.record(
        makeMetric({
          routingTier: 'heavy',
          attemptNumber: 1,
          status: 'success',
          escalationCostUsd: 0.03,
        }),
      );
      const agg = collector.getAggregates();
      expect(agg.totalEscalationCostUsd).toBeCloseTo(0.06, 6);
    });

    it('should not count retriesAvoidedByRouting for cancelled status', () => {
      collector.record(
        makeMetric({
          routingTier: 'heavy',
          attemptNumber: 1,
          status: 'cancelled',
        }),
      );
      const agg = collector.getAggregates();
      expect(agg.escalationCount).toBe(1);
      expect(agg.retriesAvoidedByRouting).toBe(0);
    });

    it('should include routing aggregate fields in writeSummary output', async () => {
      collector.record(
        makeMetric({
          routingTier: 'heavy',
          attemptNumber: 1,
          status: 'success',
          escalationCostUsd: 0.05,
        }),
      );
      await collector.writeSummary(tmpDir);
      const raw = await readFile(join(tmpDir, 'metrics', 'summary.json'), 'utf-8');
      const summary = JSON.parse(raw);
      expect(summary).toHaveProperty('escalationCount', 1);
      expect(summary).toHaveProperty('escalationsByTier');
      expect(summary.escalationsByTier).toEqual({ heavy: 1 });
      expect(summary).toHaveProperty('totalEscalationCostUsd');
      expect(summary.totalEscalationCostUsd).toBeCloseTo(0.05, 6);
      expect(summary).toHaveProperty('retriesAvoidedByRouting', 1);
    });

    it('should compute parallelism of 1 for non-overlapping invocations', () => {
      collector.record(
        makeMetric({
          startTime: '2026-02-27T06:00:00.000Z',
          endTime: '2026-02-27T06:00:01.000Z',
        }),
      );
      collector.record(
        makeMetric({
          startTime: '2026-02-27T06:00:05.000Z',
          endTime: '2026-02-27T06:00:06.000Z',
        }),
      );
      const agg = collector.getAggregates();
      const maxConcurrency = agg.parallelismOverTime.reduce(
        (max, b) => Math.max(max, b.concurrency),
        0,
      );
      expect(maxConcurrency).toBeLessThanOrEqual(1);
    });
  });
});
