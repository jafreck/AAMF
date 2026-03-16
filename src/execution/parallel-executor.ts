import pLimit from 'p-limit';
import { AgentInvocation, AgentResult, AgentLauncherFn } from '../agents/types.js';
import { Logger } from '../logging/logger.js';
import { MigrationConfig } from '../config/schema.js';

/** Executes agent invocations in parallel with configurable concurrency via p-limit. */
export class ParallelExecutor {
  private limit: ReturnType<typeof pLimit>;
  private _activeCount = 0;
  private _peakConcurrency = 0;

  /** Maximum number of concurrently running invocations observed during executeAll. */
  get peakConcurrency(): number {
    return this._peakConcurrency;
  }

  constructor(
    private concurrency: number,
    private launcher: AgentLauncherFn,
    private logger: Logger,
    private config?: MigrationConfig,
  ) {
    this.limit = pLimit(concurrency);
  }

  /** Execute all invocations concurrently (up to the concurrency limit). Returns results in invocation order. */
  async executeAll(invocations: AgentInvocation[]): Promise<AgentResult[]> {
    this.logger.info(`Executing ${invocations.length} agent invocations with concurrency ${this.concurrency}`);
    const promises = invocations.map((inv, i) =>
      this.limit(async () => {
        this._activeCount++;
        if (this._activeCount > this._peakConcurrency) {
          this._peakConcurrency = this._activeCount;
        }
        this.logger.info(`[${i + 1}/${invocations.length}] Launching ${inv.agent}${inv.workItemId ? ` (${inv.workItemId})` : ''}`);
        try {
          const result = await this.launcher(inv);
          if (result.success) {
            this.logger.info(`Completed ${inv.agent}${inv.workItemId ? ` (${inv.workItemId})` : ''} in ${result.duration}ms`);
          } else {
            this.logger.error(`Failed ${inv.agent}${inv.workItemId ? ` (${inv.workItemId})` : ''}: ${result.error ?? 'unknown'}`);
          }
          return result;
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          this.logger.error(`Exception in ${inv.agent}: ${error}`);
          return {
            agent: inv.agent,
            workItemId: inv.workItemId,
            exitCode: 1,
            success: false,
            timedOut: false,
            duration: 0,
            stdout: '',
            stderr: '',
            tokenUsage: null,
            outputPath: inv.outputPath,
            outputExists: false,
            error,
            extensions: {},
          } satisfies AgentResult;
        } finally {
          this._activeCount--;
        }
      })
    );
    return Promise.all(promises);
  }
}
