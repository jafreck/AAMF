import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile, readdir, stat, appendFile } from 'node:fs/promises';
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
  MigrationPlannerOutput,
  TaskDecomposerOutput,
  AdjudicatorOutput,
  CodeMigratorOutput,
  ParityVerifierOutput,
  TestWriterOutput,
  FailureAdjudicatorOutput,
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
import { buildRuntimePaths } from './runtime-paths.js';

/** Map each known agent name to its Zod output schema. */
const agentOutputSchemas: Record<AgentName, z.ZodTypeAny> = {
  'migration-orchestrator': MigrationOrchestratorOutput,
  'impact-assessor': ImpactAssessorOutput,
  'knowledge-builder': KnowledgeBuilderOutput,
  'migration-planner': MigrationPlannerOutput,
  'task-decomposer': TaskDecomposerOutput,
  'adjudicator': AdjudicatorOutput,
  'code-migrator': CodeMigratorOutput,
  'parity-verifier': ParityVerifierOutput,
  'test-writer': TestWriterOutput,
  'failure-adjudicator': FailureAdjudicatorOutput,
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
async function writeAgentLog(logDir: string, agent: string, taskId: string, stdout: string, stderr: string, invocationId?: string): Promise<void> {
  const targetDir = join(logDir, agent, taskId);
  await ensureDir(targetDir);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = invocationId ? `${invocationId}-${timestamp}.log` : `${timestamp}.log`;
  const content = `=== STDOUT ===\n${stdout}\n\n=== STDERR ===\n${stderr}\n`;
  await atomicWrite(join(targetDir, filename), content);
}

// ─── Live output streaming ────────────────────────────────────────────────────

/**
 * Create a pair of callbacks that stream agent stdout/stderr line-by-line to:
 *  1. A live log file (`.live.log`) in the agent log directory
 *  2. The runtime logger as `agent-output-line` events (debug level)
 *
 * Chunks from the child process may not be line-aligned, so each callback
 * maintains a residual buffer and flushes complete lines only.
 *
 * Returns `{ onStdoutData, onStderrData, flush }`. Call `flush()` after the
 * process exits to write any remaining partial line.
 */
function createLiveOutputCallbacks(
  logDir: string,
  agent: string,
  taskId: string,
  invocationId: string,
  logger: Logger,
): {
  onStdoutData: (chunk: Buffer) => void;
  onStderrData: (chunk: Buffer) => void;
  flush: () => Promise<void>;
} {
  const targetDir = join(logDir, agent, taskId);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const liveLogPath = join(targetDir, `${invocationId}-${timestamp}.live.log`);

  // Serialise writes so they never interleave
  let writeChain: Promise<void> = ensureDir(targetDir);

  const enqueueWrite = (text: string): void => {
    writeChain = writeChain
      .then(() => appendFile(liveLogPath, text, 'utf-8'))
      .catch(() => {/* best-effort */});
  };

  // Per-stream residual buffers for incomplete lines
  let stdoutResidue = '';
  let stderrResidue = '';

  const processChunk = (
    chunk: Buffer,
    residue: string,
    stream: 'stdout' | 'stderr',
  ): string => {
    const text = residue + chunk.toString('utf-8');
    const lines = text.split('\n');
    // Last element is either empty (if text ended with \n) or an incomplete line
    const remaining = lines.pop()!;

    for (const line of lines) {
      const prefixed = `[${stream}] ${line}\n`;
      enqueueWrite(prefixed);
      logger.event({
        type: 'agent-output-line',
        agent,
        taskId,
        invocationId,
        stream,
        line,
      });
    }

    return remaining;
  };

  return {
    onStdoutData: (chunk: Buffer) => {
      stdoutResidue = processChunk(chunk, stdoutResidue, 'stdout');
    },
    onStderrData: (chunk: Buffer) => {
      stderrResidue = processChunk(chunk, stderrResidue, 'stderr');
    },
    flush: async () => {
      // Flush any remaining partial lines
      if (stdoutResidue) {
        enqueueWrite(`[stdout] ${stdoutResidue}\n`);
        stdoutResidue = '';
      }
      if (stderrResidue) {
        enqueueWrite(`[stderr] ${stderrResidue}\n`);
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
  const schema = agentOutputSchemas[agentResult.agent];
  const parseResult = ResultParser.parseAamfOutput(stdout, schema);
  if (parseResult.parsed) {
    const parsedData = parseResult.data as Record<string, unknown> & {
      tokenUsage?: AgentResult['tokenUsage'];
    };
    agentResult.structuredOutput = parsedData;
    agentResult.outputParsed = true;
    // Prefer tokenUsage from structured output over regex-based parsing
    if (parsedData.tokenUsage) {
      agentResult.tokenUsage = parsedData.tokenUsage;
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
    agentResult.error = `aamf-json parse failed: ${parseResult.error}`;
  }

  // Fallback: if token usage is still unknown, estimate from prompt length
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
    const timeout = invocation.timeout ?? this.config.copilot.timeout;
    const cliCommand = this.config.copilot.cliCommand;

    // Child logger with invocationId context for correlation
    const invLogger = this.logger.child('copilot-runner');
    invLogger.setInvocationId(invocationId);
    invLogger.setAgent(invocation.agent);
    if (invocation.taskId) invLogger.setTaskId(invocation.taskId);
    if (invocation.phase !== undefined) invLogger.setPhase(invocation.phase);

    // Build the prompt that instructs the agent to read its context file
    const prompt = `Read your context file at: ${invocation.contextFile}\nExecute the task described in the context. Write all output files to the paths specified in the context.`;

    const args = [
      '--agent', invocation.agent,
      '-p', prompt,
      '--allow-all-tools',
      '--allow-all-paths',
      '--no-ask-user',
    ];

    const model = invocation.modelOverride ?? this.config.copilot.model;
    if (model) {
      args.push('--model', model);
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
    invLogger.info(`Launching CLI agent: ${cliCommand} --agent ${invocation.agent}`);
    invLogger.debug(`Full CLI command: ${cliCommand} ${args.join(' ')}`);

    // ── Heartbeat & output-directory watcher ─────────────────────────
    const HEARTBEAT_INTERVAL_MS = 30_000;
    const OUTPUT_POLL_INTERVAL_MS = 10_000;
    const agentName = invocation.agent;
    // Seed with files that already exist so only truly new files are reported.
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
    // ────────────────────────────────────────────────────────────────

    // ── Live output streaming ────────────────────────────────────────
    const liveTaskId = invocation.taskId ?? 'main';
    const liveCallbacks = createLiveOutputCallbacks(
      this.logDir, invocation.agent, liveTaskId, invocationId, invLogger,
    );
    // ────────────────────────────────────────────────────────────────

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
      const tokenUsage = ResultParser.parseTokenUsage(result.stdout + '\n' + result.stderr, 'copilot-cli');

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
    const timeout = invocation.timeout ?? this.config.claudeCode.timeout;
    const cliCommand = this.config.claudeCode.cliCommand;
    const agentDir = this.config.claudeCode.agentDir;

    // Child logger with invocationId context for correlation
    const invLogger = this.logger.child('claude-code-runner');
    invLogger.setInvocationId(invocationId);
    invLogger.setAgent(invocation.agent);
    if (invocation.taskId) invLogger.setTaskId(invocation.taskId);
    if (invocation.phase !== undefined) invLogger.setPhase(invocation.phase);

    // Build the prompt that instructs the agent to read its context file
    const prompt = `Read your context file at: ${invocation.contextFile}\nExecute the task described in the context. Write all output files to the paths specified in the context.`;

    // Log the agent definition file path for observability
    const agentFilePath = join(this.projectRoot, agentDir, `${invocation.agent}.md`);
    invLogger.debug(`Claude agent definition: ${agentFilePath}`);

    const args = [
      '--agent', invocation.agent,
      '-p', prompt,
    ];

    const model = invocation.modelOverride ?? this.config.claudeCode.model;
    if (model) {
      args.push('--model', model);
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
    invLogger.info(`Launching Claude Code agent: ${cliCommand} --agent ${invocation.agent}`);
    invLogger.debug(`Full CLI command: ${cliCommand} ${args.join(' ')}`);

    // ── Heartbeat & output-directory watcher ─────────────────────────
    const HEARTBEAT_INTERVAL_MS = 30_000;
    const OUTPUT_POLL_INTERVAL_MS = 10_000;
    const agentName = invocation.agent;
    // Seed with files that already exist so only truly new files are reported.
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
    // ────────────────────────────────────────────────────────────────

    // ── Live output streaming ────────────────────────────────────────
    const liveTaskId = invocation.taskId ?? 'main';
    const liveCallbacks = createLiveOutputCallbacks(
      this.logDir, invocation.agent, liveTaskId, invocationId, invLogger,
    );
    // ────────────────────────────────────────────────────────────────

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
      // Use claude-code runtime to parse Claude's JSON token usage format
      const tokenUsage = ResultParser.parseTokenUsage(result.stdout + '\n' + result.stderr, 'claude-code');

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
