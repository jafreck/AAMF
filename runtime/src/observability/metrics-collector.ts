/**
 * @module observability/metrics-collector
 *
 * Accumulates InvocationMetric records in memory, persists them as
 * append-only JSONL, and computes aggregate summaries for reporting.
 */

import { readFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureDir, fileExists } from '../util/fs.js';
import type { InvocationMetric } from '../agents/types.js';

// ─── Aggregate Types ─────────────────────────────────────────────────────────

export interface MetricsAggregate {
  totalInvocations: number;
  invocationsByAgent: Record<string, number>;
  totalRetries: number;
  retriesByAgent: Record<string, number>;
  retriesByPhase: Record<number, number>;
  totalTokens: number;
  totalCost: number;
  tokensByAgent: Record<string, number>;
  costByAgent: Record<string, number>;
  peakParallelInvocations: number;
  parallelismOverTime: ParallelismBucket[];
  /** Number of invocations routed to a non-normal tier (heavy or critical). */
  escalationCount: number;
  /** Escalation count broken down by tier. */
  escalationsByTier: Record<string, number>;
  /** Sum of escalationCostUsd across all metrics that carry it. */
  totalEscalationCostUsd: number;
  /** Routed invocations (tier != normal) that succeeded on first attempt. */
  retriesAvoidedByRouting: number;
  /** Count of invocations carrying repeated-signature dedup stop metadata. */
  totalRepeatedFailureStops: number;
  /** Repeated-signature stop counts grouped by explicit stop reason. */
  repeatedFailureStopsByReason: Record<string, number>;
  /** Number of invocation records that carried each failure signature hash. */
  repeatedFailureSignaturesByHash: Record<string, number>;
}

export interface ParallelismBucket {
  /** Epoch second (floored) */
  epochSecond: number;
  /** Number of concurrent invocations during this second */
  concurrency: number;
}

// ─── MetricsCollector ────────────────────────────────────────────────────────

const JSONL_FILE = 'invocations.jsonl';
const SUMMARY_FILE = 'summary.json';

export class MetricsCollector {
  private metrics: InvocationMetric[] = [];

  /** Record a single invocation metric into the in-memory store. */
  record(metric: InvocationMetric): void {
    this.metrics.push(metric);
  }

  /** Return all recorded metrics. */
  getMetrics(): InvocationMetric[] {
    return this.metrics;
  }

  /**
   * Append the last recorded metric as a single JSON line to
   * `<dir>/metrics/invocations.jsonl`. Does not rewrite the full file.
   */
  async writeJsonl(dir: string): Promise<void> {
    const metricsDir = join(dir, 'metrics');
    await ensureDir(metricsDir);
    const filePath = join(metricsDir, JSONL_FILE);
    const last = this.metrics[this.metrics.length - 1];
    if (!last) return;
    await appendFile(filePath, JSON.stringify(last) + '\n', 'utf-8');
  }

  /**
   * Write `<dir>/metrics/summary.json` with aggregated metrics.
   *
   * @param peakConcurrency - externally-tracked peak concurrency (e.g. from ParallelExecutor).
   *   If provided, it overrides the time-series–derived peak.
   */
  async writeSummary(dir: string, peakConcurrency?: number): Promise<void> {
    const metricsDir = join(dir, 'metrics');
    await ensureDir(metricsDir);
    const agg = this.getAggregates(peakConcurrency);
    const filePath = join(metricsDir, SUMMARY_FILE);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(filePath, JSON.stringify(agg, null, 2) + '\n', 'utf-8');
  }

  /**
   * Load metrics from an existing JSONL file, populating the in-memory array.
   *
   * @param dir - progress directory (the file is at `<dir>/metrics/invocations.jsonl`).
   * @param skipCount - number of leading records to skip (for checkpoint resume).
   */
  async loadFromJsonl(dir: string, skipCount?: number): Promise<void> {
    const filePath = join(dir, 'metrics', JSONL_FILE);
    if (!(await fileExists(filePath))) return;
    const raw = await readFile(filePath, 'utf-8');
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    const skip = skipCount ?? 0;
    for (let i = skip; i < lines.length; i++) {
      this.metrics.push(JSON.parse(lines[i]!) as InvocationMetric);
    }
  }

  /**
   * Compute aggregate summaries from the in-memory metrics.
   *
   * @param peakConcurrency - optional externally-tracked peak; overrides
   *   the value derived from the parallelism time-series if larger.
   */
  getAggregates(peakConcurrency?: number): MetricsAggregate {
    const invocationsByAgent: Record<string, number> = {};
    const retriesByAgent: Record<string, number> = {};
    const retriesByPhase: Record<number, number> = {};
    const tokensByAgent: Record<string, number> = {};
    const costByAgent: Record<string, number> = {};
    let totalRetries = 0;
    let totalTokens = 0;
    let totalCost = 0;

    const escalationsByTier: Record<string, number> = {};
    let escalationCount = 0;
    let totalEscalationCostUsd = 0;
    let retriesAvoidedByRouting = 0;
    let totalRepeatedFailureStops = 0;
    const repeatedFailureStopsByReason: Record<string, number> = {};
    const repeatedFailureSignaturesByHash: Record<string, number> = {};

    for (const m of this.metrics) {
      invocationsByAgent[m.agentType] = (invocationsByAgent[m.agentType] ?? 0) + 1;
      tokensByAgent[m.agentType] = (tokensByAgent[m.agentType] ?? 0) + m.tokensTotal;
      costByAgent[m.agentType] = (costByAgent[m.agentType] ?? 0) + m.costUsd;
      totalTokens += m.tokensTotal;
      totalCost += m.costUsd;

      if (m.wasRetry) {
        totalRetries++;
        retriesByAgent[m.agentType] = (retriesByAgent[m.agentType] ?? 0) + 1;
        retriesByPhase[m.phase] = (retriesByPhase[m.phase] ?? 0) + 1;
      }

      if (m.routingTier && m.routingTier !== 'normal') {
        escalationCount++;
        escalationsByTier[m.routingTier] = (escalationsByTier[m.routingTier] ?? 0) + 1;
        if (m.status === 'success' && m.attemptNumber === 1) {
          retriesAvoidedByRouting++;
        }
      }

      if (m.escalationCostUsd != null) {
        totalEscalationCostUsd += m.escalationCostUsd;
      }

      if (m.failureSignatureHash) {
        repeatedFailureSignaturesByHash[m.failureSignatureHash] =
          (repeatedFailureSignaturesByHash[m.failureSignatureHash] ?? 0) + 1;
      }

      if (m.repeatedFailureStopReason) {
        totalRepeatedFailureStops++;
        repeatedFailureStopsByReason[m.repeatedFailureStopReason] =
          (repeatedFailureStopsByReason[m.repeatedFailureStopReason] ?? 0) + 1;
      }
    }

    const parallelismOverTime = this.computeParallelism();
    const timeSeriesPeak = parallelismOverTime.reduce(
      (max, b) => Math.max(max, b.concurrency),
      0,
    );
    const peak = Math.max(timeSeriesPeak, peakConcurrency ?? 0);

    return {
      totalInvocations: this.metrics.length,
      invocationsByAgent,
      totalRetries,
      retriesByAgent,
      retriesByPhase,
      totalTokens,
      totalCost,
      tokensByAgent,
      costByAgent,
      peakParallelInvocations: peak,
      parallelismOverTime,
      escalationCount,
      escalationsByTier,
      totalEscalationCostUsd,
      retriesAvoidedByRouting,
      totalRepeatedFailureStops,
      repeatedFailureStopsByReason,
      repeatedFailureSignaturesByHash,
    };
  }

  // ─── Private helpers ─────────────────────────────────────────────────────

  /**
   * Compute 1-second-bucketed concurrency from the startTime/endTime of
   * each metric.
   */
  private computeParallelism(): ParallelismBucket[] {
    if (this.metrics.length === 0) return [];

    // Build a sorted event list: +1 at start, -1 at end
    const events: Array<{ time: number; delta: number }> = [];
    for (const m of this.metrics) {
      const start = new Date(m.startTime).getTime();
      const end = new Date(m.endTime).getTime();
      events.push({ time: start, delta: 1 });
      events.push({ time: end, delta: -1 });
    }
    events.sort((a, b) => a.time - b.time || a.delta - b.delta);

    const minEpochMs = events[0]!.time;
    const maxEpochMs = events[events.length - 1]!.time;
    const minSecond = Math.floor(minEpochMs / 1000);
    const maxSecond = Math.floor(maxEpochMs / 1000);

    // Sweep through events and record concurrency per second bucket
    const buckets = new Map<number, number>();
    let concurrency = 0;
    let eventIdx = 0;

    for (let sec = minSecond; sec <= maxSecond; sec++) {
      const bucketStart = sec * 1000;
      const bucketEnd = bucketStart + 1000;

      // Process all events up to and including this bucket
      while (eventIdx < events.length && events[eventIdx]!.time < bucketEnd) {
        concurrency += events[eventIdx]!.delta;
        eventIdx++;
      }

      buckets.set(sec, Math.max(concurrency, buckets.get(sec) ?? 0));
    }

    const result: ParallelismBucket[] = [];
    for (const [epochSecond, conc] of buckets) {
      result.push({ epochSecond, concurrency: conc });
    }
    return result;
  }
}
