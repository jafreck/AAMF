/**
 * @module observability/report-generator
 *
 * Produces a human-readable Markdown observability report and a
 * machine-readable metrics.json artifact from collected invocation metrics.
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureDir } from '../util/fs.js';
import type { InvocationMetric } from '../agents/types.js';
import type { MetricsAggregate } from './metrics-collector.js';

export class ReportGenerator {
  /**
   * Generate the observability report and metrics artifact.
   *
   * @param metricsDir - directory containing raw metrics (for reference links).
   * @param reportDir - output directory for the report (e.g. `reports/observability`).
   * @param metrics - all invocation metrics.
   * @param aggregates - pre-computed aggregate summary.
   */
  async generate(
    metricsDir: string,
    reportDir: string,
    metrics: InvocationMetric[],
    aggregates: MetricsAggregate,
  ): Promise<void> {
    await ensureDir(reportDir);

    const md = this.buildMarkdown(metrics, aggregates);
    await writeFile(join(reportDir, 'index.md'), md, 'utf-8');

    const json = JSON.stringify({ metrics, aggregates }, null, 2) + '\n';
    await writeFile(join(reportDir, 'metrics.json'), json, 'utf-8');
  }

  // ─── Markdown builder ──────────────────────────────────────────────────

  private buildMarkdown(
    metrics: InvocationMetric[],
    aggregates: MetricsAggregate,
  ): string {
    const sections: string[] = [];

    sections.push('# Observability Report\n');

    sections.push(this.buildGanttSection(metrics));
    sections.push(this.buildParallelismSection(aggregates));
    sections.push(this.buildCostTokenTable(aggregates));
    sections.push(this.buildRetrySummary(metrics));

    return sections.join('\n');
  }

  // ─── Mermaid Gantt ─────────────────────────────────────────────────────

  private buildGanttSection(metrics: InvocationMetric[]): string {
    if (metrics.length === 0) return '## Agent Invocation Timeline\n\n_No invocations recorded._\n';

    const lines: string[] = [
      '## Agent Invocation Timeline\n',
      '```mermaid',
      'gantt',
      '  title Agent Invocation Timeline',
      '  dateFormat x',
      '  axisFormat %H:%M:%S',
    ];

    // Group by agent type for readability
    const byAgent = new Map<string, InvocationMetric[]>();
    for (const m of metrics) {
      let group = byAgent.get(m.agentType);
      if (!group) {
        group = [];
        byAgent.set(m.agentType, group);
      }
      group.push(m);
    }

    for (const [agent, items] of byAgent) {
      lines.push(`  section ${agent}`);
      for (const m of items) {
        const start = new Date(m.startTime).getTime();
        const end = new Date(m.endTime).getTime();
        const label = m.taskId ? `${m.taskId}` : m.invocationId.slice(0, 8);
        const statusTag = m.status === 'failed' ? 'crit, ' : m.wasRetry ? 'active, ' : '';
        lines.push(`  ${label} :${statusTag}${start}, ${end}`);
      }
    }

    lines.push('```\n');
    return lines.join('\n');
  }

  // ─── Parallelism over time ─────────────────────────────────────────────

  private buildParallelismSection(aggregates: MetricsAggregate): string {
    const lines: string[] = [
      '## Parallelism Over Time\n',
      `**Peak concurrent invocations:** ${aggregates.peakParallelInvocations}\n`,
    ];

    if (aggregates.parallelismOverTime.length > 0) {
      lines.push('| Second (epoch) | Concurrency |');
      lines.push('|---|---|');
      for (const b of aggregates.parallelismOverTime) {
        lines.push(`| ${b.epochSecond} | ${b.concurrency} |`);
      }
    } else {
      lines.push('_No parallelism data._');
    }

    lines.push('');
    return lines.join('\n');
  }

  // ─── Cost / Token breakdown ────────────────────────────────────────────

  private buildCostTokenTable(aggregates: MetricsAggregate): string {
    const lines: string[] = [
      '## Cost & Token Breakdown by Agent Type\n',
      `**Total tokens:** ${aggregates.totalTokens.toLocaleString()}  `,
      `**Total cost:** $${aggregates.totalCost.toFixed(4)}\n`,
      '| Agent | Invocations | Tokens | Cost (USD) |',
      '|---|---|---|---|',
    ];

    const agents = Object.keys(aggregates.invocationsByAgent).sort();
    for (const agent of agents) {
      const invocations = aggregates.invocationsByAgent[agent] ?? 0;
      const tokens = aggregates.tokensByAgent[agent] ?? 0;
      const cost = aggregates.costByAgent[agent] ?? 0;
      lines.push(`| ${agent} | ${invocations} | ${tokens.toLocaleString()} | $${cost.toFixed(4)} |`);
    }

    lines.push('');
    return lines.join('\n');
  }

  // ─── Retry summary ────────────────────────────────────────────────────

  private buildRetrySummary(metrics: InvocationMetric[]): string {
    const lines: string[] = [
      '## Retry Summary\n',
    ];

    // Group by invocation logical key (agentType + taskId + phase) to show retry chains
    const chains = new Map<string, InvocationMetric[]>();
    for (const m of metrics) {
      const key = `${m.agentType}|${m.taskId}|${m.phase}`;
      let chain = chains.get(key);
      if (!chain) {
        chain = [];
        chains.set(key, chain);
      }
      chain.push(m);
    }

    // Only show chains that include at least one retry
    const retryChains = [...chains.entries()].filter(([, chain]) =>
      chain.some((m) => m.wasRetry),
    );

    if (retryChains.length === 0) {
      lines.push('_No retries recorded._\n');
      return lines.join('\n');
    }

    lines.push('| Agent | Task | Phase | Attempts | Final Status | Failed → Succeeded |');
    lines.push('|---|---|---|---|---|---|');

    for (const [, chain] of retryChains) {
      const sorted = chain.sort((a, b) => a.attemptNumber - b.attemptNumber);
      const first = sorted[0]!;
      const last = sorted[sorted.length - 1]!;
      const hadFailure = sorted.some((m) => m.status === 'failed');
      const finalSuccess = last.status === 'success';
      const failedThenSucceeded = hadFailure && finalSuccess;
      lines.push(
        `| ${first.agentType} | ${first.taskId} | ${first.phase} | ${sorted.length} | ${last.status} | ${failedThenSucceeded ? '✅ Yes' : '❌ No'} |`,
      );
    }

    lines.push('');
    return lines.join('\n');
  }
}
