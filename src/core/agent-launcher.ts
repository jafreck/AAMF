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
        '--output-format', 'json',
      ];
      if (model) args.push('--model', model);
      if (cfg.source.path) args.push('--add-dir', cfg.source.path);
      if (cfg.target.outputPath) args.push('--add-dir', cfg.target.outputPath);
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

import { stripVSCodeEnv as frameworkStripVSCodeEnv } from '@cadre-dev/framework/runtime';

/**
 * Strip VS Code / Electron IPC environment variables so that CLI
 * invocations don't register with the running VS Code instance and instead
 * run in a truly headless, out-of-process mode.
 *
 * Delegates to @cadre-dev/framework's stripVSCodeEnv (which strips all
 * VSCODE_* and ELECTRON_* prefixed variables) and additionally strips
 * GIT_ASKPASS and TERM_PROGRAM for full headless isolation.
 */
function stripVSCodeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const stripped = frameworkStripVSCodeEnv(env as Record<string, string | undefined>) as NodeJS.ProcessEnv;
  delete stripped['GIT_ASKPASS'];
  delete stripped['TERM_PROGRAM'];
  return stripped;
}

// ─── Copilot JSONL event parsing ──────────────────────────────────────────────

/** A single JSONL event emitted by `copilot --output-format json`. */
interface CopilotEvent {
  type: string;
  data?: Record<string, unknown>;
  id?: string;
  timestamp?: string;
  [key: string]: unknown;
}

/** Summary extracted from the copilot `result` event. */
interface CopilotResultSummary {
  exitCode: number;
  premiumRequests?: number;
  totalApiDurationMs?: number;
  sessionDurationMs?: number;
  codeChanges?: { linesAdded: number; linesRemoved: number; filesModified: string[] };
}

/**
 * Parse copilot JSONL stdout into structured events and reconstruct the
 * text content the agent produced (for backward-compatible aamf-json parsing).
 */
function parseCopilotJsonl(stdout: string): {
  events: CopilotEvent[];
  textContent: string;
  toolCalls: Array<{ name: string; status: string }>;
  resultSummary: CopilotResultSummary | undefined;
  errorEvents: CopilotEvent[];
} {
  const events: CopilotEvent[] = [];
  const toolCalls: Array<{ name: string; status: string }> = [];
  const errorEvents: CopilotEvent[] = [];
  let resultSummary: CopilotResultSummary | undefined;
  let textContent = '';

  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      // Only treat as a copilot event if it has the expected `type` field.
      // Otherwise it's likely text-mode output that happens to be valid JSON
      // (e.g., an aamf-json payload line).
      if (typeof parsed !== 'object' || parsed === null || typeof parsed.type !== 'string') {
        textContent += line + '\n';
        continue;
      }
      const event = parsed as CopilotEvent;
      events.push(event);

      switch (event.type) {
        case 'assistant.message': {
          const data = event.data as { content?: string } | undefined;
          if (data?.content) textContent += data.content;
          break;
        }
        case 'assistant.tool_call': {
          const data = event.data as { toolName?: string } | undefined;
          if (data?.toolName) toolCalls.push({ name: data.toolName, status: 'called' });
          break;
        }
        case 'assistant.tool_call_result': {
          const data = event.data as { toolName?: string; status?: string } | undefined;
          if (data?.toolName) toolCalls.push({ name: data.toolName, status: data.status ?? 'completed' });
          break;
        }
        case 'result': {
          const data = event as { exitCode?: number; usage?: Record<string, unknown> };
          const usage = data.usage as {
            premiumRequests?: number;
            totalApiDurationMs?: number;
            sessionDurationMs?: number;
            codeChanges?: { linesAdded: number; linesRemoved: number; filesModified: string[] };
          } | undefined;
          resultSummary = {
            exitCode: data.exitCode ?? -1,
            premiumRequests: usage?.premiumRequests,
            totalApiDurationMs: usage?.totalApiDurationMs,
            sessionDurationMs: usage?.sessionDurationMs,
            codeChanges: usage?.codeChanges,
          };
          break;
        }
        case 'error': {
          errorEvents.push(event);
          break;
        }
      }
    } catch {
      // Not valid JSON — may be text-mode output if --output-format json wasn't applied.
      textContent += line + '\n';
    }
  }

  return { events, textContent, toolCalls, resultSummary, errorEvents };
}

/** Produce a human-readable summary of tool calls for logging. */
function summarizeToolCalls(toolCalls: Array<{ name: string; status: string }>): string {
  const counts = new Map<string, number>();
  for (const tc of toolCalls) {
    counts.set(tc.name, (counts.get(tc.name) ?? 0) + 1);
  }
  return [...counts.entries()].map(([name, count]) => `${name}(${count})`).join(', ');
}

/** Convert a copilot result summary to the internal TokenUsage shape. */
function tokenUsageFromResult(summary: CopilotResultSummary): AgentResult['tokenUsage'] | undefined {
  // The copilot result event doesn't provide raw token counts, only premium
  // requests and timing.  We return undefined so the caller falls back to
  // the text-based token parser which does extract per-model token counts.
  return undefined;
}

/** Shared helper: write stdout/stderr to a per-agent log file. */
async function writeAgentLog(logDir: string, agent: string, taskId: string, stdout: string, stderr: string, invocationId?: string, events?: CopilotEvent[]): Promise<void> {
  const targetDir = join(logDir, agent, taskId);
  await ensureDir(targetDir);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = invocationId ? `${invocationId}-${timestamp}.log` : `${timestamp}.log`;
  const content = `=== STDOUT ===\n${stdout}\n\n=== STDERR ===\n${stderr}\n`;
  await atomicWrite(join(targetDir, filename), content);

  // Write structured JSONL event log when available.
  if (events && events.length > 0) {
    const eventsFilename = invocationId ? `${invocationId}-${timestamp}.events.jsonl` : `${timestamp}.events.jsonl`;
    const eventsContent = events.map(e => JSON.stringify(e)).join('\n') + '\n';
    await atomicWrite(join(targetDir, eventsFilename), eventsContent);
  }
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

    const prompt = `Read your context file at: ${invocation.contextFile}\nExecute the task described in the context. Write all output files to the paths specified in the context.`;

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
    invLogger.info(`Launching CLI agent: ${cliCommand} ${args.join(' ')}`);

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

      // Parse JSONL events when copilot outputs structured JSON.
      const parsed = parseCopilotJsonl(result.stdout);
      // Use reconstructed text content for aamf-json extraction (backward compat).
      const stdoutForParsing = parsed.textContent || result.stdout;

      const taskId = invocation.taskId ?? 'main';
      await writeAgentLog(this.logDir, invocation.agent, taskId, result.stdout, result.stderr, invocationId, parsed.events);

      if (parsed.toolCalls.length > 0) {
        const toolSummary = summarizeToolCalls(parsed.toolCalls);
        invLogger.info(`Agent tool calls: ${toolSummary}`);
      }
      if (parsed.errorEvents.length > 0) {
        for (const errEvt of parsed.errorEvents) {
          invLogger.warn(`Agent error event: ${JSON.stringify(errEvt.data)}`);
        }
      }

      const outputFiles = await detectOutputFiles(invocation);
      // Prefer structured usage from the copilot result event when available.
      let tokenUsage = parsed.resultSummary
        ? tokenUsageFromResult(parsed.resultSummary)
        : undefined;
      if (!tokenUsage) {
        tokenUsage = parseTokenUsage(
          result.stdout + '\n' + result.stderr,
          this.backend.tokenParserRuntime,
        );
      }

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
        copilotEvents: parsed.events.length > 0 ? {
          totalEvents: parsed.events.length,
          toolCalls: parsed.toolCalls,
          resultSummary: parsed.resultSummary,
          errorCount: parsed.errorEvents.length,
        } : undefined,
      };

      return finaliseResult(agentResult, stdoutForParsing, prompt, invLogger);
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
    const result = await this.runner.run(invocation);
    if (delay > 0) {
      result.queueDelay = Date.now() - queueStart;
    }
    return result;
  }
}
