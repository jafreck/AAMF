import { join } from 'node:path';
import { readFile, readdir, stat } from 'node:fs/promises';
import { AgentInvocation, AgentName, AgentResult } from '../agents/types.js';
import { MigrationConfig } from '../config/schema.js';
import { spawnWithTimeout, resolveLoginPath } from '../util/process.js';
import { ensureDir, atomicWrite, fileExists } from '../util/fs.js';
import {
  ResultParser,
  MISSING_BLOCK_ERROR,
  MigrationOrchestratorOutput,
  ImpactAssessorOutput,
  KnowledgeBuilderOutput,
  LargeFileAnalyzerOutput,
  MigrationPlannerOutput,
  AdjudicatorOutput,
  CodeMigratorOutput,
  ParityVerifierOutput,
  TestWriterOutput,
  FailureRecoveryOutput,
  FinalParityCheckerOutput,
  E2eTestCrafterOutput,
  DocumentationWriterOutput,
  MigrationRunnerOutput,
} from '../agents/result-parser.js';
import { Logger } from '../logging/logger.js';
import { z } from 'zod';

/** Map each known agent name to its Zod output schema. */
const agentOutputSchemas: Record<AgentName, z.ZodTypeAny> = {
  'migration-orchestrator': MigrationOrchestratorOutput,
  'impact-assessor': ImpactAssessorOutput,
  'knowledge-builder': KnowledgeBuilderOutput,
  'large-file-analyzer': LargeFileAnalyzerOutput,
  'migration-planner': MigrationPlannerOutput,
  'adjudicator': AdjudicatorOutput,
  'code-migrator': CodeMigratorOutput,
  'parity-verifier': ParityVerifierOutput,
  'test-writer': TestWriterOutput,
  'failure-recovery': FailureRecoveryOutput,
  'final-parity-checker': FinalParityCheckerOutput,
  'e2e-test-crafter': E2eTestCrafterOutput,
  'documentation-writer': DocumentationWriterOutput,
  'migration-runner': MigrationRunnerOutput,
};

/**
 * Strip VS Code / Electron IPC environment variables so that `copilot` CLI
 * invocations don't register with the running VS Code instance and instead
 * run in a truly headless, out-of-process mode.
 */
function stripVSCodeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const stripped: NodeJS.ProcessEnv = {};
  const blocklist = [
    'VSCODE_IPC_HOOK_CLI',
    'VSCODE_IPC_HOOK',
    'VSCODE_GIT_IPC_HANDLE',
    'VSCODE_GIT_ASKPASS_NODE',
    'VSCODE_GIT_ASKPASS_EXTRA_ARGS',
    'VSCODE_GIT_ASKPASS_MAIN',
    'VSCODE_INJECTION',
    'VSCODE_PID',
    'VSCODE_CWD',
    'VSCODE_NLS_CONFIG',
    'VSCODE_HANDLES_SIGPIPE',
    'VSCODE_HANDLES_UNCAUGHT_ERRORS',
    'ELECTRON_RUN_AS_NODE',
    'ELECTRON_NO_ASAR',
    'GIT_ASKPASS',
    'TERM_PROGRAM',          // Often set to 'vscode'
  ];
  for (const [key, value] of Object.entries(env)) {
    if (!blocklist.includes(key) && !key.startsWith('VSCODE_')) {
      stripped[key] = value;
    }
  }
  return stripped;
}

/**
 * The critical bridge between the runtime and agent prompt files.
 * Spawns `copilot --agent <name>` as a child process for each invocation.
 */
export class AgentLauncher {
  private readonly logDir: string;
  private lastInvocationTime = 0;
  private resolvedPath: string | undefined;
  private initialized = false;

  /** Return the resolved PATH (after init), or undefined if not resolved. */
  getResolvedPath(): string | undefined {
    return this.resolvedPath;
  }

  constructor(
    private readonly config: MigrationConfig,
    private readonly projectRoot: string,
    private readonly logger: Logger,
  ) {
    this.logDir = join(projectRoot, '.aamf', 'migration', config.projectName, 'logs');
  }

  /**
   * Resolve the user's login-shell PATH based on the `environment` config.
   * Must be called once before the first `launchAgent` invocation.
   */
  async init(): Promise<void> {
    if (this.initialized) return;
    const envCfg = this.config.environment;

    if (envCfg.inheritShellPath) {
      this.logger.info('Resolving PATH from login shell…');
      this.resolvedPath = await resolveLoginPath({
        shell: envCfg.shell,
        extraPath: envCfg.extraPath,
      });
      this.logger.debug(`Resolved PATH: ${this.resolvedPath}`);
    } else if (envCfg.extraPath.length > 0) {
      // Not inheriting login PATH, but still apply extraPath on top of current PATH
      const home = process.env.HOME ?? '';
      const expanded = envCfg.extraPath.map(p => p.replace(/^~(?=\/|$)/, home));
      this.resolvedPath = [...expanded, process.env.PATH ?? ''].join(':');
      this.logger.debug(`Extended PATH with extraPath entries: ${this.resolvedPath}`);
    }

    this.initialized = true;
  }

  /** Launch an agent invocation and return the result */
  async launchAgent(invocation: AgentInvocation): Promise<AgentResult> {
    const delay = this.config.options.invocationDelayMs;
    if (delay > 0) {
      const elapsed = Date.now() - this.lastInvocationTime;
      if (elapsed < delay) {
        await new Promise(resolve => setTimeout(resolve, delay - elapsed));
      }
    }
    this.lastInvocationTime = Date.now();
    return this.launchCliMode(invocation);
  }

  /** Spawn copilot CLI as child process */
  private async launchCliMode(invocation: AgentInvocation): Promise<AgentResult> {
    const timeout = invocation.timeout ?? this.config.copilot.timeout;
    const cliCommand = this.config.copilot.cliCommand;

    // Build the prompt that instructs the agent to read its context file
    const prompt = `Read your context file at: ${invocation.contextFile}\nExecute the task described in the context. Write all output files to the paths specified in the context.`;

    const args = [
      '--agent', invocation.agent,
      '-p', prompt,
      '--allow-all-tools',
      '--allow-all-paths',
      '--no-ask-user',
      '-s',
    ];

    if (this.config.copilot.model) {
      args.push('--model', this.config.copilot.model);
    }

    // Grant access to source and output directories
    if (this.config.source.path) {
      args.push('--add-dir', this.config.source.path);
    }
    if (this.config.target.outputPath) {
      args.push('--add-dir', this.config.target.outputPath);
    }
    args.push('--add-dir', invocation.progressDir);

    // Add additional args
    if (invocation.additionalArgs) {
      for (const [key, value] of Object.entries(invocation.additionalArgs)) {
        args.push(`--${key}`, value);
      }
    }

    const env: NodeJS.ProcessEnv = {
      ...stripVSCodeEnv(process.env),
      ...(this.resolvedPath ? { PATH: this.resolvedPath } : {}),
      AAMF_PROGRESS_DIR: invocation.progressDir,
      AAMF_CONTEXT_FILE: invocation.contextFile,
    };
    if (invocation.phase !== undefined) env.AAMF_PHASE = String(invocation.phase);
    if (invocation.taskId) env.AAMF_TASK_ID = invocation.taskId;

    const startTime = Date.now();
    this.logger.info(`Launching CLI agent: ${cliCommand} ${args.join(' ')}`);

    // ── Heartbeat & output-directory watcher ─────────────────────────
    const HEARTBEAT_INTERVAL_MS = 30_000;
    const OUTPUT_POLL_INTERVAL_MS = 10_000;
    const agentName = invocation.agent;
    const seenFiles = new Set<string>();

    const heartbeatTimer = setInterval(() => {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      this.logger.info(`Agent ${agentName} still running (${elapsed}s elapsed)`);
    }, HEARTBEAT_INTERVAL_MS);

    // Poll for new output files appearing in the agent's expected output directory
    const outputPollTimer = setInterval(async () => {
      try {
        const context = JSON.parse(await readFile(invocation.contextFile, 'utf-8')) as { outputPath?: string };
        if (context.outputPath && await fileExists(context.outputPath)) {
          const s = await stat(context.outputPath);
          if (s.isDirectory()) {
            const files = await readdir(context.outputPath);
            for (const f of files) {
              if (!seenFiles.has(f)) {
                seenFiles.add(f);
                this.logger.info(`Agent ${agentName} produced new file: ${f}`);
              }
            }
          }
        }
      } catch {
        // Ignore polling errors — context file may not exist yet
      }
    }, OUTPUT_POLL_INTERVAL_MS);

    const stopTimers = () => {
      clearInterval(heartbeatTimer);
      clearInterval(outputPollTimer);
    };
    // ────────────────────────────────────────────────────────────────

    try {
      const result = await spawnWithTimeout(cliCommand, args, {
        cwd: this.projectRoot,
        env,
        timeout,
      });

      stopTimers();
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
        outputParsed: false,
        error: result.killed
          ? `Agent timed out after ${timeout}ms`
          : result.exitCode !== 0
            ? result.stderr || `Exit code ${result.exitCode}`
            : undefined,
        stderr: (result.killed || result.exitCode !== 0) ? result.stderr : undefined,
      };

      // Parse structured aamf-json output block from stdout
      const schema = agentOutputSchemas[invocation.agent];
      const parseResult = ResultParser.parseAamfOutput(result.stdout, schema);
      if (parseResult.parsed) {
        agentResult.structuredOutput = parseResult.data as Record<string, unknown>;
        agentResult.outputParsed = true;
        // Prefer tokenUsage from structured output over regex-based parsing
        if (parseResult.data.tokenUsage) {
          agentResult.tokenUsage = parseResult.data.tokenUsage;
        }
      } else if (parseResult.error === MISSING_BLOCK_ERROR) {
        // Block absent — warn but leave success unchanged
        this.logger.warn(`Agent ${invocation.agent} did not emit an aamf-json block`);
        agentResult.outputParsed = false;
      } else {
        // Block present but malformed or invalid — force failure
        agentResult.outputParsed = false;
        agentResult.parseError = parseResult.error;
        agentResult.success = false;
      }

      return agentResult;
    } catch (err) {
      stopTimers();
      const duration = Date.now() - startTime;
      return {
        agent: invocation.agent,
        taskId: invocation.taskId,
        exitCode: 1,
        success: false,
        outputFiles: [],
        duration,
        outputParsed: false,
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
