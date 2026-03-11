import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile, readdir, stat, appendFile } from 'node:fs/promises';
import { AgentInvocation, AgentName, AgentResult } from '../agents/types.js';
import { MigrationConfig } from '../config/schema.js';
import { spawnWithTimeout, resolveLoginPath } from '../util/process.js';
import { ensureDir, atomicWrite, fileExists } from '../util/fs.js';
import { parseAamfOutput, MISSING_BLOCK_ERROR } from '../agents/agent-output-schemas.js';
import { getOutputSchema } from '../agents/registry.js';
import { parseTokenUsage } from '../agents/token-usage-parser.js';
import { Logger } from '../logging/logger.js';
import { TokenTracker } from '../budget/token-tracker.js';
import { z } from 'zod';
import { buildRuntimePaths } from './runtime-paths.js';

// ─── Backend Descriptor ───────────────────────────────────────────────────────

/**
 * Describes the differences between CLI agent backends (Copilot, Claude Code).
 * The generic `CliAgentRunner` uses this to build args, resolve config, and
 * select the correct token parser.
 */
interface CliBackendDescriptor {
  /** Human-readable name for log messages. */
  name: string;
  /** The CLI command to invoke. */
  cliCommand: string;
  /** Default timeout in milliseconds. */
  timeout: number;
  /** The model to use (from config). */
  model: string | undefined;
  /** Token usage runtime identifier for `parseTokenUsage()`. */
  tokenParserRuntime: string;
  /** Build CLI args for a given invocation and prompt. */
  buildArgs(invocation: AgentInvocation, prompt: string, model: string | undefined, config: MigrationConfig): string[];
}

/** Build a backend descriptor for the Copilot CLI. */
function copilotDescriptor(config: MigrationConfig): CliBackendDescriptor {
  return {
    name: 'copilot-runner',
    cliCommand: config.agentBackend.cliCommand,
    timeout: config.agentBackend.timeout,
    model: config.agentBackend.model,
    tokenParserRuntime: 'copilot-cli',
    buildArgs(invocation, prompt, model, cfg) {
      const args = [
        '--agent', invocation.agent,
        '-p', prompt,
        '--allow-all-tools',
        '--allow-all-paths',
        '--no-ask-user',
      ];
      if (model) args.push('--model', model);
      if (invocation.scopedDirs && invocation.scopedDirs.length > 0) {
        // Task-scoped directories — expose only what this task needs
        const seen = new Set<string>();
        for (const dir of invocation.scopedDirs) {
          if (dir && !seen.has(dir)) {
            seen.add(dir);
            args.push('--add-dir', dir);
          }
        }
      } else {
        // Fallback: expose full source/target trees
        if (cfg.source.path) args.push('--add-dir', cfg.source.path);
        if (cfg.target.outputPath) args.push('--add-dir', cfg.target.outputPath);
      }
      args.push('--add-dir', invocation.progressDir);
      if (invocation.additionalArgs) {
        for (const [key, value] of Object.entries(invocation.additionalArgs)) {
          args.push(`--${key}`, value);
        }
      }
      if (invocation.mcpConfig) {
        const mcpServersDef = {
          mcpServers: { 'aamf-kb': { url: invocation.mcpConfig.url, type: 'http' } },
        };
        args.push('--additional-mcp-config', JSON.stringify(mcpServersDef));
      }
      return args;
    },
  };
}

/** Build a backend descriptor for the Claude Code CLI. */
function claudeCodeDescriptor(config: MigrationConfig): CliBackendDescriptor {
  return {
    name: 'claude-code-runner',
    cliCommand: config.agentBackend.cliCommand,
    timeout: config.agentBackend.timeout,
    model: config.agentBackend.model,
    tokenParserRuntime: 'claude-code',
    buildArgs(invocation, prompt, model, _cfg) {
      const args = [
        '--agent', invocation.agent,
        '-p', prompt,
      ];
      if (model) args.push('--model', model);
      if (invocation.mcpConfig) {
        const mcpServersDef = {
          mcpServers: { 'aamf-kb': { url: invocation.mcpConfig.url, type: 'http' } },
        };
        args.push('--mcp-config', JSON.stringify(mcpServersDef));
      }
      return args;
    },
  };
}

// ─── Shared Helpers ───────────────────────────────────────────────────────────

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
async function writeAgentLog(logDir: string, agent: string, taskId: string, stdout: string, stderr: string, invocationId?: string): Promise<void> {
  const targetDir = join(logDir, agent, taskId);
  await ensureDir(targetDir);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = invocationId ? `${invocationId}-${timestamp}.log` : `${timestamp}.log`;
  const content = `=== STDOUT ===\n${stdout}\n\n=== STDERR ===\n${stderr}\n`;
  await atomicWrite(join(targetDir, filename), content);
}

// ─── Live output streaming ────────────────────────────────────────────────────

function createLiveOutputCallbacks(
  logDir: string,
  agent: string,
  taskId: string,
  invocationId: string,
): {
  onStdoutData: (chunk: Buffer) => void;
  onStderrData: (chunk: Buffer) => void;
  flush: () => Promise<void>;
} {
  const targetDir = join(logDir, agent, taskId);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const liveLogPath = join(targetDir, `${invocationId}-${timestamp}.live.log`);

  let writeChain: Promise<void> = ensureDir(targetDir);

  const enqueueWrite = (text: string): void => {
    writeChain = writeChain
      .then(() => appendFile(liveLogPath, text, 'utf-8'))
      .catch(() => {/* best-effort */});
  };

  let stdoutResidue = '';
  let stderrResidue = '';

  const processChunk = (
    chunk: Buffer,
    residue: string,
  ): string => {
    const text = residue + chunk.toString('utf-8');
    const lines = text.split('\n');
    const remaining = lines.pop()!;

    for (const line of lines) {
      enqueueWrite(line + '\n');
    }

    return remaining;
  };

  return {
    onStdoutData: (chunk: Buffer) => {
      stdoutResidue = processChunk(chunk, stdoutResidue);
    },
    onStderrData: (chunk: Buffer) => {
      stderrResidue = processChunk(chunk, stderrResidue);
    },
    flush: async () => {
      if (stdoutResidue) {
        enqueueWrite(stdoutResidue + '\n');
        stdoutResidue = '';
      }
      if (stderrResidue) {
        enqueueWrite(stderrResidue + '\n');
        stderrResidue = '';
      }
      await writeChain;
    },
  };
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
  const schema = getOutputSchema(agentResult.agent);
  const parseResult = parseAamfOutput(stdout, schema);
  if (parseResult.parsed) {
    const parsedData = parseResult.data as Record<string, unknown> & {
      tokenUsage?: AgentResult['tokenUsage'];
    };
    agentResult.structuredOutput = parsedData;
    agentResult.outputParsed = true;
    if (parsedData.tokenUsage) {
      agentResult.tokenUsage = parsedData.tokenUsage;
    }
  } else if (parseResult.error === MISSING_BLOCK_ERROR) {
    logger.warn(`Agent ${agentResult.agent} did not emit an aamf-json block`);
    agentResult.outputParsed = false;
  } else {
    agentResult.outputParsed = false;
    agentResult.parseError = parseResult.error;
    agentResult.success = false;
    agentResult.error = `aamf-json parse failed: ${parseResult.error}`;
  }

  if (!agentResult.tokenUsage) {
    const estimatedTotal = TokenTracker.estimateTokens(prompt);
    logger.warn(
      `Token usage unavailable for ${agentResult.agent}; falling back to prompt-length estimate`,
      { estimatedPromptTokens: estimatedTotal },
    );
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

// ─── CliAgentRunner ───────────────────────────────────────────────────────────

/**
 * Generic CLI agent runner parameterized by a backend descriptor.
 * Consolidates the shared behavior that was previously duplicated between
 * CopilotRunner and ClaudeCodeRunner: PATH resolution, env setup, heartbeat
 * timers, output polling, live log streaming, result shaping, and fallback
 * token estimation.
 */
export class CliAgentRunner implements AgentRunner {
  private resolvedPath: string | undefined;
  private readonly logDir: string;

  constructor(
    private readonly config: MigrationConfig,
    private readonly projectRoot: string,
    private readonly logger: Logger,
    private readonly backend: CliBackendDescriptor,
  ) {
    this.logDir = buildRuntimePaths(projectRoot, config.projectName).logsAgentsDir;
  }

  getResolvedPath(): string | undefined {
    return this.resolvedPath;
  }

  async init(): Promise<void> {
    this.resolvedPath = await resolveRunnerPath(this.config.environment, this.logger);
  }

  async run(invocation: AgentInvocation): Promise<AgentResult> {
    const invocationId = invocation.invocationId ?? randomUUID();
    const timeout = invocation.timeout ?? this.backend.timeout;
    const cliCommand = this.backend.cliCommand;

    const invLogger = this.logger.child(this.backend.name);
    invLogger.setInvocationId(invocationId);
    invLogger.setAgent(invocation.agent);
    if (invocation.taskId) invLogger.setTaskId(invocation.taskId);
    if (invocation.phase !== undefined) invLogger.setPhase(invocation.phase);

    const loreHint = invocation.mcpConfig
      ? ' IMPORTANT: Use the Lore MCP tools (aamf-kb server) as your first action — call lore_lookup or lore_search before reading any source files directly.'
      : '';
    const prompt = `Read your context file at: ${invocation.contextFile}\nExecute the task described in the context. Write all output files to the paths specified in the context.${loreHint}`;

    const model = invocation.modelOverride ?? this.backend.model;
    const args = this.backend.buildArgs(invocation, prompt, model, this.config);

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
    invLogger.info(`Launching CLI agent: ${cliCommand} --agent ${invocation.agent}`);
    invLogger.debug(`Full CLI command: ${cliCommand} ${args.join(' ')}`);

    // ── Heartbeat & output-directory watcher ─────────────────────────
    const HEARTBEAT_INTERVAL_MS = 30_000;
    const OUTPUT_POLL_INTERVAL_MS = 10_000;
    const agentName = invocation.agent;
    const seenFiles = new Set<string>();
    try {
      const ctx = JSON.parse(await readFile(invocation.contextFile, 'utf-8')) as { outputPath?: string };
      if (ctx.outputPath && await fileExists(ctx.outputPath)) {
        const s = await stat(ctx.outputPath);
        if (s.isDirectory()) {
          for (const f of await readdir(ctx.outputPath)) seenFiles.add(f);
        }
      }
    } catch { /* context file may not exist yet */ }
    let firstOutputDetectedAt: number | undefined;

    const heartbeatTimer = setInterval(() => {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      invLogger.debug(`Agent ${agentName} still running (${elapsed}s elapsed)`);
    }, HEARTBEAT_INTERVAL_MS);

    const outputPollTimer = setInterval(async () => {
      try {
        const context = JSON.parse(await readFile(invocation.contextFile, 'utf-8')) as { outputPath?: string };
        if (context.outputPath && await fileExists(context.outputPath)) {
          const s = await stat(context.outputPath);
          if (s.isDirectory()) {
            const files = await readdir(context.outputPath);
            const newFiles: string[] = [];
            for (const f of files) {
              if (!seenFiles.has(f)) {
                seenFiles.add(f);
                if (firstOutputDetectedAt === undefined) firstOutputDetectedAt = Date.now();
                newFiles.push(f);
              }
            }
            if (newFiles.length > 0) {
              invLogger.debug(`Agent ${agentName} produced ${newFiles.length} new file(s): ${newFiles.join(', ')}`);
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

    // ── Live output streaming ────────────────────────────────────────
    const liveTaskId = invocation.taskId ?? 'main';
    const liveCallbacks = createLiveOutputCallbacks(
      this.logDir, invocation.agent, liveTaskId, invocationId,
    );

    try {
      const result = await spawnWithTimeout(cliCommand, args, {
        cwd: this.projectRoot,
        env,
        timeout,
        onStdoutData: liveCallbacks.onStdoutData,
        onStderrData: liveCallbacks.onStderrData,
      });

      stopTimers();
      await liveCallbacks.flush();
      const duration = Date.now() - startTime;

      const taskId = invocation.taskId ?? 'main';
      await writeAgentLog(this.logDir, invocation.agent, taskId, result.stdout, result.stderr, invocationId);

      const outputFiles = await detectOutputFiles(invocation);
      const tokenUsage = parseTokenUsage(
        result.stdout + '\n' + result.stderr,
        this.backend.tokenParserRuntime,
      );

      const agentResult: AgentResult = {
        agent: invocation.agent,
        taskId: invocation.taskId,
        invocationId,
        exitCode: result.exitCode,
        success: result.exitCode === 0 && !result.killed,
        outputFiles,
        duration,
        tokenUsage,
        outputParsed: false,
        spawnToFirstOutput: firstOutputDetectedAt !== undefined ? firstOutputDetectedAt - startTime : undefined,
        error: result.killed
          ? `Agent timed out after ${timeout}ms`
          : result.exitCode !== 0
            ? result.stderr || `Exit code ${result.exitCode}`
            : undefined,
        stderr: (result.killed || result.exitCode !== 0) ? result.stderr : undefined,
      };

      return finaliseResult(agentResult, result.stdout, prompt, invLogger);
    } catch (err) {
      stopTimers();
      await liveCallbacks.flush().catch(() => {});
      const duration = Date.now() - startTime;
      const estimatedTotal = TokenTracker.estimateTokens(prompt);
      invLogger.warn(
        `Token usage unavailable for ${invocation.agent} due to runner error; falling back to prompt-length estimate`,
        {
          estimatedPromptTokens: estimatedTotal,
          error: err instanceof Error ? err.message : String(err),
        },
      );
      return {
        agent: invocation.agent,
        taskId: invocation.taskId,
        invocationId,
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

// ─── Legacy wrappers (backward-compatible) ────────────────────────────────────

/** @deprecated Use CliAgentRunner with copilotDescriptor. Kept for backward compatibility. */
export class CopilotRunner extends CliAgentRunner {
  constructor(config: MigrationConfig, projectRoot: string, logger: Logger) {
    super(config, projectRoot, logger, copilotDescriptor(config));
  }
}

/** @deprecated Use CliAgentRunner with claudeCodeDescriptor. Kept for backward compatibility. */
export class ClaudeCodeRunner extends CliAgentRunner {
  constructor(config: MigrationConfig, projectRoot: string, logger: Logger) {
    super(config, projectRoot, logger, claudeCodeDescriptor(config));
  }
}

// ─── AgentLauncher ────────────────────────────────────────────────────────────

/**
 * The critical bridge between the runtime and agent prompt files.
 * Delegates to the runner selected by `config.agentBackend.runtime` (default: CopilotRunner).
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
    this.runner = config.agentBackend.runtime === 'claude-code'
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
    const queueStart = Date.now();
    const delay = this.config.options.invocationDelayMs;
    if (delay > 0) {
      const elapsed = Date.now() - this.lastInvocationTime;
      if (elapsed < delay) {
        await new Promise(resolve => setTimeout(resolve, delay - elapsed));
      }
    }
    this.lastInvocationTime = Date.now();
    const queueDelay = Date.now() - queueStart;
    const result = await this.runner.run(invocation);
    if (queueDelay > 0) {
      result.queueDelay = queueDelay;
    }
    return result;
  }
}
