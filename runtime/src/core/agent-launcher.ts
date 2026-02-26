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
  IdiomaticReviewerOutput,
  IdiomaticRefactorerOutput,
} from '../agents/result-parser.js';
import { Logger } from '../logging/logger.js';
import { TokenTracker } from '../budget/token-tracker.js';
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
  'idiomatic-reviewer': IdiomaticReviewerOutput,
  'idiomatic-refactorer': IdiomaticRefactorerOutput,
};

/**
 * Strip VS Code / Electron IPC environment variables so that CLI
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

/** Shared helper: write stdout/stderr to a per-agent log file. */
async function writeAgentLog(logDir: string, agent: string, taskId: string, stdout: string, stderr: string): Promise<void> {
  await ensureDir(logDir);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${agent}-${taskId}-${timestamp}.log`;
  const content = `=== STDOUT ===\n${stdout}\n\n=== STDERR ===\n${stderr}\n`;
  await atomicWrite(join(logDir, filename), content);
}

/** Shared helper: detect output files created by the agent in the progress directory. */
async function detectOutputFiles(invocation: AgentInvocation): Promise<string[]> {
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

/** Shared helper: resolve PATH from login shell or extraPath entries. */
async function resolveRunnerPath(
  envCfg: MigrationConfig['environment'],
  logger: Logger,
): Promise<string | undefined> {
  if (envCfg.inheritShellPath) {
    logger.info('Resolving PATH from login shell…');
    const resolved = await resolveLoginPath({
      shell: envCfg.shell,
      extraPath: envCfg.extraPath,
    });
    logger.debug(`Resolved PATH: ${resolved}`);
    return resolved;
  } else if (envCfg.extraPath.length > 0) {
    const home = process.env.HOME ?? '';
    const expanded = envCfg.extraPath.map(p => p.replace(/^~(?=\/|$)/, home));
    const resolved = [...expanded, process.env.PATH ?? ''].join(':');
    logger.debug(`Extended PATH with extraPath entries: ${resolved}`);
    return resolved;
  }
  return undefined;
}

/** Shared helper: finalise an AgentResult by parsing aamf-json output and estimating tokens. */
function finaliseResult(
  agentResult: AgentResult,
  stdout: string,
  prompt: string,
  logger: Logger,
): AgentResult {
  const schema = agentOutputSchemas[agentResult.agent];
  const parseResult = ResultParser.parseAamfOutput(stdout, schema);
  if (parseResult.parsed) {
    agentResult.structuredOutput = parseResult.data as Record<string, unknown>;
    agentResult.outputParsed = true;
    // Prefer tokenUsage from structured output over regex-based parsing
    if (parseResult.data.tokenUsage) {
      agentResult.tokenUsage = parseResult.data.tokenUsage;
    }
  } else if (parseResult.error === MISSING_BLOCK_ERROR) {
    // Block absent — warn but leave success unchanged
    logger.warn(`Agent ${agentResult.agent} did not emit an aamf-json block`);
    agentResult.outputParsed = false;
  } else {
    // Block present but malformed or invalid — force failure
    agentResult.outputParsed = false;
    agentResult.parseError = parseResult.error;
    agentResult.success = false;
  }

  // Fallback: if token usage is still unknown, estimate from prompt length
  if (!agentResult.tokenUsage) {
    const estimatedTotal = TokenTracker.estimateTokens(prompt);
    agentResult.tokenUsage = { prompt: estimatedTotal, completion: 0, total: estimatedTotal };
  }

  return agentResult;
}

// ─── AgentRunner interface ────────────────────────────────────────────────────

/**
 * Abstraction over agent execution backends (e.g. Copilot CLI, Claude Code CLI).
 * Implementations handle PATH resolution in `init()` and subprocess spawning in `run()`.
 */
export interface AgentRunner {
  /** Resolve environment (e.g. login-shell PATH). Call once before first `run()`. */
  init(): Promise<void>;
  /** Execute a single agent invocation and return the result. */
  run(invocation: AgentInvocation): Promise<AgentResult>;
  /** Return the resolved PATH string, or undefined if not yet resolved. */
  getResolvedPath(): string | undefined;
}

// ─── CopilotRunner ────────────────────────────────────────────────────────────

/**
 * Spawns `copilot --agent <name>` as a child process for each invocation.
 * Implements the existing CLI-mode behaviour.
 */
export class CopilotRunner implements AgentRunner {
  private resolvedPath: string | undefined;
  private readonly logDir: string;

  constructor(
    private readonly config: MigrationConfig,
    private readonly projectRoot: string,
    private readonly logger: Logger,
  ) {
    this.logDir = join(projectRoot, '.aamf', 'migration', config.projectName, 'logs');
  }

  getResolvedPath(): string | undefined {
    return this.resolvedPath;
  }

  async init(): Promise<void> {
    this.resolvedPath = await resolveRunnerPath(this.config.environment, this.logger);
  }

  async run(invocation: AgentInvocation): Promise<AgentResult> {
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

    // Inject MCP config for KB server access
    // Copilot CLI uses --additional-mcp-config with { mcpServers: { name: { url } } } format
    if (invocation.mcpConfig) {
      const mcpServersDef = {
        mcpServers: {
          'aamf-kb': { url: invocation.mcpConfig.url, type: 'http' },
        },
      };
      args.push('--additional-mcp-config', JSON.stringify(mcpServersDef));
    }

    const env: NodeJS.ProcessEnv = {
      ...stripVSCodeEnv(process.env),
      ...(this.resolvedPath ? { PATH: this.resolvedPath } : {}),
      AAMF_PROGRESS_DIR: invocation.progressDir,
      AAMF_CONTEXT_FILE: invocation.contextFile,
      ...(invocation.kbDbPath ? { KB_DB_PATH: invocation.kbDbPath } : {}),
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

      const taskId = invocation.taskId ?? 'main';
      await writeAgentLog(this.logDir, invocation.agent, taskId, result.stdout, result.stderr);

      const outputFiles = await detectOutputFiles(invocation);
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

      return finaliseResult(agentResult, result.stdout, prompt, this.logger);
    } catch (err) {
      stopTimers();
      const duration = Date.now() - startTime;
      const estimatedTotal = TokenTracker.estimateTokens(prompt);
      return {
        agent: invocation.agent,
        taskId: invocation.taskId,
        exitCode: 1,
        success: false,
        outputFiles: [],
        duration,
        tokenUsage: { prompt: estimatedTotal, completion: 0, total: estimatedTotal },
        outputParsed: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

// ─── ClaudeCodeRunner ─────────────────────────────────────────────────────────

/**
 * Spawns `claude --agent <name> -p <prompt>` as a child process for each invocation.
 * Uses Claude's JSON-based token usage format for accurate accounting.
 */
export class ClaudeCodeRunner implements AgentRunner {
  private resolvedPath: string | undefined;
  private readonly logDir: string;

  constructor(
    private readonly config: MigrationConfig,
    private readonly projectRoot: string,
    private readonly logger: Logger,
  ) {
    this.logDir = join(projectRoot, '.aamf', 'migration', config.projectName, 'logs');
  }

  getResolvedPath(): string | undefined {
    return this.resolvedPath;
  }

  async init(): Promise<void> {
    this.resolvedPath = await resolveRunnerPath(this.config.environment, this.logger);
  }

  async run(invocation: AgentInvocation): Promise<AgentResult> {
    const timeout = invocation.timeout ?? this.config.claudeCode.timeout;
    const cliCommand = this.config.claudeCode.cliCommand;
    const agentDir = this.config.claudeCode.agentDir;

    // Build the prompt that instructs the agent to read its context file
    const prompt = `Read your context file at: ${invocation.contextFile}\nExecute the task described in the context. Write all output files to the paths specified in the context.`;

    // Log the agent definition file path for observability
    const agentFilePath = join(this.projectRoot, agentDir, `${invocation.agent}.md`);
    this.logger.debug(`Claude agent definition: ${agentFilePath}`);

    const args = [
      '--agent', invocation.agent,
      '-p', prompt,
    ];

    if (this.config.claudeCode.model) {
      args.push('--model', this.config.claudeCode.model);
    }

    // Inject MCP config for KB server access
    // Claude Code uses --mcp-config with a JSON string containing the server definition
    if (invocation.mcpConfig) {
      const mcpServersDef = {
        mcpServers: {
          'aamf-kb': { url: invocation.mcpConfig.url, type: 'http' },
        },
      };
      args.push('--mcp-config', JSON.stringify(mcpServersDef));
    }

    const env: NodeJS.ProcessEnv = {
      ...stripVSCodeEnv(process.env),
      ...(this.resolvedPath ? { PATH: this.resolvedPath } : {}),
      AAMF_PROGRESS_DIR: invocation.progressDir,
      AAMF_CONTEXT_FILE: invocation.contextFile,
      ...(invocation.kbDbPath ? { KB_DB_PATH: invocation.kbDbPath } : {}),
    };
    if (invocation.phase !== undefined) env.AAMF_PHASE = String(invocation.phase);
    if (invocation.taskId) env.AAMF_TASK_ID = invocation.taskId;

    const startTime = Date.now();
    this.logger.info(`Launching Claude Code agent: ${cliCommand} ${args.join(' ')}`);

    // ── Heartbeat & output-directory watcher ─────────────────────────
    const HEARTBEAT_INTERVAL_MS = 30_000;
    const OUTPUT_POLL_INTERVAL_MS = 10_000;
    const agentName = invocation.agent;
    const seenFiles = new Set<string>();

    const heartbeatTimer = setInterval(() => {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      this.logger.info(`Agent ${agentName} still running (${elapsed}s elapsed)`);
    }, HEARTBEAT_INTERVAL_MS);

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

      const taskId = invocation.taskId ?? 'main';
      await writeAgentLog(this.logDir, invocation.agent, taskId, result.stdout, result.stderr);

      const outputFiles = await detectOutputFiles(invocation);
      // Use claude-code runtime to parse Claude's JSON token usage format
      const tokenUsage = ResultParser.parseTokenUsage(result.stdout + '\n' + result.stderr, 'claude-code');

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

      return finaliseResult(agentResult, result.stdout, prompt, this.logger);
    } catch (err) {
      stopTimers();
      const duration = Date.now() - startTime;
      const estimatedTotal = TokenTracker.estimateTokens(prompt);
      return {
        agent: invocation.agent,
        taskId: invocation.taskId,
        exitCode: 1,
        success: false,
        outputFiles: [],
        duration,
        tokenUsage: { prompt: estimatedTotal, completion: 0, total: estimatedTotal },
        outputParsed: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

// ─── AgentLauncher ────────────────────────────────────────────────────────────

/**
 * The critical bridge between the runtime and agent prompt files.
 * Delegates to the runner selected by `config.agentRuntime` (default: CopilotRunner).
 */
export class AgentLauncher {
  private lastInvocationTime = 0;
  private initialized = false;
  private readonly runner: AgentRunner;

  /** Return the resolved PATH (after init), or undefined if not resolved. */
  getResolvedPath(): string | undefined {
    return this.runner.getResolvedPath();
  }

  constructor(
    private readonly config: MigrationConfig,
    private readonly projectRoot: string,
    private readonly logger: Logger,
  ) {
    this.runner = config.agentRuntime === 'claude-code'
      ? new ClaudeCodeRunner(config, projectRoot, logger)
      : new CopilotRunner(config, projectRoot, logger);
  }

  /**
   * Resolve the user's login-shell PATH based on the `environment` config.
   * Must be called once before the first `launchAgent` invocation.
   */
  async init(): Promise<void> {
    if (this.initialized) return;
    await this.runner.init();
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
    return this.runner.run(invocation);
  }
}
