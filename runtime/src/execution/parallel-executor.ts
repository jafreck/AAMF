import pLimit from 'p-limit';
import { AgentInvocation, AgentResult } from '../agents/types.js';
import { Logger } from '../logging/logger.js';

/** Function signature for launching an agent invocation and returning its result. */
export interface AgentLauncherFn {
  (invocation: AgentInvocation): Promise<AgentResult>;
}

/** Executes agent invocations in parallel with configurable concurrency via p-limit. */
export class ParallelExecutor {
  private limit: ReturnType<typeof pLimit>;

  constructor(private concurrency: number, private launcher: AgentLauncherFn, private logger: Logger) {
    this.limit = pLimit(concurrency);
  }

  /** Execute all invocations concurrently (up to the concurrency limit). Returns results in invocation order. */
  async executeAll(invocations: AgentInvocation[]): Promise<AgentResult[]> {
    this.logger.info(`Executing ${invocations.length} agent invocations with concurrency ${this.concurrency}`);
    const promises = invocations.map((inv, i) =>
      this.limit(async () => {
        this.logger.info(`[${i + 1}/${invocations.length}] Launching ${inv.agent}${inv.taskId ? ` (${inv.taskId})` : ''}`);
        try {
          const result = await this.launcher(inv);
          if (result.success) {
            this.logger.info(`Completed ${inv.agent}${inv.taskId ? ` (${inv.taskId})` : ''} in ${result.duration}ms`);
          } else {
            this.logger.error(`Failed ${inv.agent}${inv.taskId ? ` (${inv.taskId})` : ''}: ${result.error ?? 'unknown'}`);
          }
          return result;
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          this.logger.error(`Exception in ${inv.agent}: ${error}`);
          return {
            agent: inv.agent,
            taskId: inv.taskId,
            exitCode: 1,
            success: false,
            outputFiles: [],
            duration: 0,
            error,
          } satisfies AgentResult;
        }
      })
    );
    return Promise.all(promises);
  }
}
