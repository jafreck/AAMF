import { join } from 'node:path';
import { readFile, readdir, stat } from 'node:fs/promises';
import { AgentInvocation, AgentResult } from '../agents/types.js';
import { MigrationConfig } from '../config/schema.js';
import { spawnWithTimeout } from '../util/process.js';
import { ensureDir, atomicWrite, fileExists } from '../util/fs.js';
import { ResultParser } from '../agents/result-parser.js';
import { Logger } from '../logging/logger.js';

/**
 * The critical bridge between the runtime and agent prompt files.
 * Spawns `copilot --agent <name>` as a child process for each invocation.
 */
export class AgentLauncher {
  private readonly logDir: string;

  constructor(
    private readonly config: MigrationConfig,
    private readonly projectRoot: string,
    private readonly logger: Logger,
  ) {
    this.logDir = join(projectRoot, '.copilot', 'migration', config.projectName, 'logs');
  }

  /** Launch an agent invocation and return the result */
  async launchAgent(invocation: AgentInvocation): Promise<AgentResult> {
    return this.launchCliMode(invocation);
  }

  /** Spawn copilot CLI as child process */
  private async launchCliMode(invocation: AgentInvocation): Promise<AgentResult> {
    const timeout = invocation.timeout ?? this.config.copilot.timeout;
    const cliCommand = this.config.copilot.cliCommand;

    const args = [
      '--agent', invocation.agent,
      '--context', invocation.contextFile,
    ];

    if (this.config.copilot.model) {
      args.push('--model', this.config.copilot.model);
    }

    // Add additional args
    if (invocation.additionalArgs) {
      for (const [key, value] of Object.entries(invocation.additionalArgs)) {
        args.push(`--${key}`, value);
      }
    }

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      AAMF_PROGRESS_DIR: invocation.progressDir,
      AAMF_CONTEXT_FILE: invocation.contextFile,
    };
    if (invocation.phase !== undefined) env.AAMF_PHASE = String(invocation.phase);
    if (invocation.taskId) env.AAMF_TASK_ID = invocation.taskId;

    const startTime = Date.now();
    this.logger.info(`Launching CLI agent: ${cliCommand} ${args.join(' ')}`);

    try {
      const result = await spawnWithTimeout(cliCommand, args, {
        cwd: this.projectRoot,
        env,
        timeout,
      });

      const duration = Date.now() - startTime;

      // Write agent log
      const taskId = invocation.taskId ?? 'main';
      await this.writeAgentLog(invocation.agent, taskId, result.stdout, result.stderr);

      // Detect output files created by the agent
      const outputFiles = await this.detectOutputFiles(invocation);

      // Parse token usage from output
      const tokenUsage = ResultParser.parseTokenUsage(result.stdout + '\n' + result.stderr);

      const agentResult: AgentResult = {
        agent: invocation.agent,
        taskId: invocation.taskId,
        exitCode: result.exitCode,
        success: result.exitCode === 0 && !result.killed,
        outputFiles,
        duration,
        tokenUsage,
        error: result.killed
          ? `Agent timed out after ${timeout}ms`
          : result.exitCode !== 0
            ? result.stderr || `Exit code ${result.exitCode}`
            : undefined,
      };

      return agentResult;
    } catch (err) {
      const duration = Date.now() - startTime;
      return {
        agent: invocation.agent,
        taskId: invocation.taskId,
        exitCode: 1,
        success: false,
        outputFiles: [],
        duration,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** Write stdout/stderr to a per-agent log file */
  private async writeAgentLog(agent: string, taskId: string, stdout: string, stderr: string): Promise<void> {
    await ensureDir(this.logDir);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${agent}-${taskId}-${timestamp}.log`;
    const content = `=== STDOUT ===\n${stdout}\n\n=== STDERR ===\n${stderr}\n`;
    await atomicWrite(join(this.logDir, filename), content);
  }

  /** Detect output files created by the agent in the progress directory */
  private async detectOutputFiles(invocation: AgentInvocation): Promise<string[]> {
    try {
      const context = JSON.parse(await readFile(invocation.contextFile, 'utf-8')) as { outputPath?: string };
      if (context.outputPath && await fileExists(context.outputPath)) {
        const s = await stat(context.outputPath);
        if (s.isDirectory()) {
          const files = await readdir(context.outputPath);
          return files.map(f => join(context.outputPath!, f));
        }
        return [context.outputPath];
      }
    } catch {
      // Context parsing failed, return empty
    }
    return [];
  }
}
