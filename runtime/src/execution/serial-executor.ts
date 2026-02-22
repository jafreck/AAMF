import { AgentInvocation, AgentResult } from '../agents/types.js';
import { Logger } from '../logging/logger.js';

/** Function signature for launching an agent invocation and returning its result. */
export interface AgentLauncherFn {
  (invocation: AgentInvocation): Promise<AgentResult>;
}

/** Executes agent invocations sequentially, one at a time, preserving order. */
export class SerialExecutor {
  constructor(private launcher: AgentLauncherFn, private logger: Logger) {}

  /** Execute invocations one at a time, in order. Returns results in the same order. */
  async executeAll(invocations: AgentInvocation[]): Promise<AgentResult[]> {
    const results: AgentResult[] = [];
    for (const inv of invocations) {
      this.logger.info(`Launching ${inv.agent}${inv.taskId ? ` (${inv.taskId})` : ''}`);
      const result = await this.launcher(inv);
      results.push(result);
      if (result.success) {
        this.logger.info(`Completed ${inv.agent}${inv.taskId ? ` (${inv.taskId})` : ''} in ${result.duration}ms`);
      } else {
        this.logger.error(`Failed ${inv.agent}${inv.taskId ? ` (${inv.taskId})` : ''}: ${result.error ?? 'unknown error'}`);
      }
    }
    return results;
  }
}
