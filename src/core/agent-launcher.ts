import { join } from 'node:path';
import { readFile, readdir, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import {
  AgentLauncher as FrameworkAgentLauncher,
  registerAgentBackendFactory,
  isCopilotCliInvocationError,
  trackProcess,
  type BackendRuntimeConfig,
  type BackendLoggerLike,
  type AgentBackend,
} from '@cadre-dev/framework/runtime';
import type {
  AgentInvocation as FrameworkInvocation,
  AgentResult as FrameworkResult,
} from '@cadre-dev/framework/runtime';
import { AgentInvocation, AgentName, AgentResult } from '../agents/types.js';
import { MigrationConfig } from '../config/schema.js';
import { ensureDir, atomicWrite, fileExists } from '../util/fs.js';
import { parseAamfOutput, MISSING_BLOCK_ERROR } from '../agents/agent-output-schemas.js';
import { parseTokenUsage } from '../agents/token-usage-parser.js';
import { getOutputSchema } from '../agents/registry.js';
import { Logger } from '../logging/logger.js';
import { TokenTracker } from '../budget/token-tracker.js';
import { buildRuntimePaths } from './runtime-paths.js';

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
  tokenUsage?: { input: number; output: number; cachedInput?: number };
  premiumRequests?: number;
  totalApiDurationMs?: number;
  sessionDurationMs?: number;
  codeChanges?: { linesAdded: number; linesRemoved: number; filesModified: string[] };
}

function readNumericField(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number') {
      return value;
    }
  }
  return undefined;
}

function extractCopilotTokenUsage(usage: Record<string, unknown> | undefined): CopilotResultSummary['tokenUsage'] {
  if (!usage) return undefined;

  const input = readNumericField(usage, ['input', 'inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens', 'tokensIn', 'tokens_in']);
  const output = readNumericField(usage, ['output', 'outputTokens', 'output_tokens', 'completionTokens', 'completion_tokens', 'tokensOut', 'tokens_out']);
  const cachedInput = readNumericField(usage, ['cachedInput', 'cachedInputTokens', 'cached_input_tokens', 'cache_read_input_tokens', 'tokensCached', 'tokens_cached']);

  if (input == null || output == null) {
    return undefined;
  }

  return {
    input,
    output,
    ...(cachedInput != null ? { cachedInput } : {}),
  };
}

function hasMeaningfulTokenUsage(tokenUsage: AgentResult['tokenUsage']): boolean {
  if (!tokenUsage) return false;
  return tokenUsage.input > 0 || tokenUsage.output > 0 || (tokenUsage.cachedInput ?? 0) > 0;
}

function normalizeStructuredTokenUsage(raw: unknown): AgentResult['tokenUsage'] {
  if (!raw || typeof raw !== 'object') return null;

  const tokenUsage = raw as Record<string, unknown>;
  const input = typeof tokenUsage.input === 'number'
    ? tokenUsage.input
    : typeof tokenUsage.prompt === 'number'
      ? tokenUsage.prompt
      : undefined;
  const output = typeof tokenUsage.output === 'number'
    ? tokenUsage.output
    : typeof tokenUsage.completion === 'number'
      ? tokenUsage.completion
      : undefined;
  const cachedInput = typeof tokenUsage.cachedInput === 'number' ? tokenUsage.cachedInput : undefined;

  if (input == null || output == null) {
    return null;
  }

  return {
    input,
    output,
    ...(cachedInput != null ? { cachedInput } : {}),
  };
}

function getTokenUsageRuntime(runtime: MigrationConfig['agentBackend']['runtime']): 'claude-code' | 'copilot-cli' | undefined {
  if (runtime === 'claude-code') return 'claude-code';
  if (runtime === 'copilot') return 'copilot-cli';
  return undefined;
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
        case 'assistant.message_delta': {
          const data = event.data as { deltaContent?: string } | undefined;
          if (data?.deltaContent) textContent += data.deltaContent;
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
          const eventData = (event.data && typeof event.data === 'object')
            ? event.data as Record<string, unknown>
            : undefined;
          const usage = (eventData?.usage && typeof eventData.usage === 'object'
            ? eventData.usage
            : ('usage' in event && typeof event.usage === 'object' ? event.usage : undefined)) as {
            input?: number;
            inputTokens?: number;
            input_tokens?: number;
            output?: number;
            outputTokens?: number;
            output_tokens?: number;
            cachedInput?: number;
            cachedInputTokens?: number;
            cached_input_tokens?: number;
            cache_read_input_tokens?: number;
            tokensCached?: number;
            tokens_cached?: number;
            premiumRequests?: number;
            totalApiDurationMs?: number;
            sessionDurationMs?: number;
            codeChanges?: { linesAdded: number; linesRemoved: number; filesModified: string[] };
          } | undefined;
          resultSummary = {
            exitCode: typeof eventData?.exitCode === 'number'
              ? eventData.exitCode
              : (typeof event.exitCode === 'number' ? event.exitCode : -1),
            tokenUsage: extractCopilotTokenUsage(usage),
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

/** Shared helper: write stdout/stderr to a per-agent log file. */
async function writeAgentLog(logDir: string, agent: string, taskId: string, stdout: string, stderr: string, invocationId?: string, events?: CopilotEvent[]): Promise<void> {
  const targetDir = join(logDir, agent, taskId);
  await ensureDir(targetDir);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = invocationId ? `${invocationId}-${timestamp}.log` : `${timestamp}.log`;
  const content = `=== STDOUT ===\n${stdout}\n\n=== STDERR ===\n${stderr}\n`;
  await atomicWrite(join(targetDir, filename), content);

  if (events && events.length > 0) {
    const eventsFilename = invocationId ? `${invocationId}-${timestamp}.events.jsonl` : `${timestamp}.events.jsonl`;
    const eventsContent = events.map(e => JSON.stringify(e)).join('\n') + '\n';
    await atomicWrite(join(targetDir, eventsFilename), eventsContent);
  }
}

/** Shared helper: detect output files created by the agent in the progress directory. */
async function detectOutputFiles(contextPath: string): Promise<string[]> {
  try {
    const context = JSON.parse(await readFile(contextPath, 'utf-8')) as { outputPath?: string };
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

// ─── Custom Copilot backend (--output-format json) ───────────────────────────

/**
 * Strip VS Code / Electron env vars that leak through when launched from
 * the VS Code integrated terminal — mirrors the framework's stripVSCodeEnv.
 */
function stripVSCodeEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const stripped = { ...env };
  for (const key of Object.keys(stripped)) {
    if (key.startsWith('VSCODE_') || key.startsWith('ELECTRON_') || key === 'TERM_PROGRAM_VERSION' || key === 'ORIGINAL_XDG_CURRENT_DESKTOP') {
      delete stripped[key];
    }
  }
  return stripped;
}

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

function spawnAgent(command: string, args: string[], opts: { cwd: string; env: Record<string, string | undefined>; timeout: number }): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    trackProcess(child);
    child.unref();

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    if (opts.timeout > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try { process.kill(-child.pid!, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
        setTimeout(() => { if (!child.killed) { try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); } } }, 5000);
      }, opts.timeout);
    }

    child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString(),
        stderr: Buffer.concat(stderrChunks).toString(),
        exitCode: code,
        timedOut,
      });
    });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString(),
        stderr: err.message,
        exitCode: null,
        timedOut: false,
      });
    });
  });
}

/**
 * Custom Copilot CLI backend that uses `--output-format json` to get JSONL
 * output with token usage data, instead of the framework's `-s` (silent)
 * which only emits plain text with no usage info.
 *
 * Also passes `--effort` when configured.
 */
class AamfCopilotBackend implements AgentBackend {
  readonly name = 'copilot';
  private readonly cliCommand: string;
  private readonly defaultTimeout: number;
  private readonly defaultModel: string | undefined;
  private readonly allowAllTools: boolean;
  private readonly allowAllPaths: boolean;
  private readonly effort: string | undefined;
  private readonly extraPath: string[];
  private readonly logger: BackendLoggerLike;

  constructor(config: BackendRuntimeConfig, logger: BackendLoggerLike) {
    this.logger = logger;
    const copilotOpts = config.agent.copilot as Record<string, unknown> | undefined;
    this.cliCommand = (typeof copilotOpts?.cliCommand === 'string' && copilotOpts.cliCommand.trim()) || 'copilot';
    this.defaultTimeout = config.agent.timeout ?? 120_000;
    this.defaultModel = config.agent.model;
    this.allowAllTools = (copilotOpts?.allowAllTools as boolean) ?? false;
    this.allowAllPaths = (copilotOpts?.allowAllPaths as boolean) ?? false;
    this.effort = copilotOpts?.effort as string | undefined;
    this.extraPath = config.environment.extraPath ?? [];
  }

  async init(): Promise<void> {
    this.logger.debug(`AamfCopilotBackend initialized (cli: ${this.cliCommand}, outputFormat: json)`);
  }

  async invoke(invocation: FrameworkInvocation, worktreePath: string): Promise<FrameworkResult> {
    const startTime = Date.now();
    const prompt = `Read your context file at: ${invocation.contextPath}`;
    const args: string[] = [
      '--agent', invocation.agent,
      '-p', prompt,
      '--no-ask-user',
      '--output-format', 'json',
    ];
    if (this.allowAllTools) args.push('--allow-all-tools');
    if (this.allowAllPaths) args.push('--allow-all-paths');
    if (this.defaultModel) args.push('--model', this.defaultModel);
    if (this.effort) args.push('--effort', this.effort);
    if (invocation.mcpServers) {
      for (const [name, cfg] of Object.entries(invocation.mcpServers)) {
        args.push('--additional-mcp-config', JSON.stringify({ mcpServers: { [name]: cfg } }));
      }
    }

    const timeout = invocation.timeout ?? this.defaultTimeout;
    const env = this.buildEnv(invocation, worktreePath);

    this.logger.info(`Launching agent (copilot): ${invocation.agent}`, {
      workItemId: invocation.workItemId,
      phase: invocation.phase,
    });

    const result = await spawnAgent(this.cliCommand, args, { cwd: worktreePath, env, timeout });

    const invocationError = isCopilotCliInvocationError(result.stderr);
    const success = result.exitCode === 0 && !result.timedOut && !invocationError;
    const duration = Date.now() - startTime;

    const outputExists = await fileExists(invocation.outputPath);

    if (success) {
      this.logger.info(`Agent ${invocation.agent} completed in ${duration}ms`, {
        workItemId: invocation.workItemId,
        phase: invocation.phase,
        data: { tokenUsage: 0, outputExists },
      });
    } else {
      this.logger.error(`Agent ${invocation.agent} failed (exit: ${result.exitCode}, timeout: ${result.timedOut})`, {
        workItemId: invocation.workItemId,
        phase: invocation.phase,
        data: { stderr: result.stderr.slice(0, 500) },
      });
    }

    return {
      agent: invocation.agent,
      success,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      duration,
      stdout: result.stdout,
      stderr: result.stderr,
      tokenUsage: null,
      outputPath: invocation.outputPath,
      outputExists,
      error: success ? undefined : (result.stderr.trim() || `Exit code: ${result.exitCode}`),
    };
  }

  private buildEnv(invocation: FrameworkInvocation, worktreePath: string): Record<string, string | undefined> {
    let env = stripVSCodeEnv({ ...process.env });
    env['CADRE_WORK_ITEM_ID'] = invocation.workItemId;
    env['CADRE_WORKTREE_PATH'] = worktreePath;
    env['CADRE_PHASE'] = String(invocation.phase);
    if (invocation.sessionId) env['CADRE_SESSION_ID'] = invocation.sessionId;
    if (this.extraPath.length > 0) {
      const sep = process.platform === 'win32' ? ';' : ':';
      env['PATH'] = [...this.extraPath, env['PATH'] ?? ''].join(sep);
    }
    return env;
  }
}

/** Register the AAMF copilot backend so the framework uses --output-format json. */
export function registerAamfCopilotBackend(): void {
  registerAgentBackendFactory('copilot', (config, logger) => new AamfCopilotBackend(config, logger));
}

// ─── AAMF ↔ Framework type mapping ───────────────────────────────────────────

/** Build a BackendRuntimeConfig from AAMF's MigrationConfig. */
export function buildBackendRuntimeConfig(config: MigrationConfig): BackendRuntimeConfig {
  const backendName = config.agentBackend.runtime === 'claude-code' ? 'claude' : 'copilot';
  return {
    agent: {
      backend: backendName,
      model: config.models?.default ?? config.agentBackend.model,
      timeout: config.agentBackend.timeout,
      copilot: {
        cliCommand: backendName === 'copilot' ? config.agentBackend.cliCommand : undefined,
        agentDir: config.agentBackend.agentDir,
        allowAllPaths: true,
        allowAllTools: true,
        effort: config.agentBackend.effort,
      },
      claude: {
        cliCommand: backendName === 'claude' ? config.agentBackend.cliCommand : undefined,
      },
    },
    environment: {
      extraPath: config.environment.extraPath,
    },
  };
}

/** Adapt AAMF's Logger to the framework's BackendLoggerLike interface. */
function adaptLogger(logger: Logger): BackendLoggerLike {
  return {
    info: (msg, ctx) => logger.info(msg, ctx),
    warn: (msg, ctx) => logger.warn(msg, ctx),
    error: (msg, ctx) => logger.error(msg, ctx),
    debug: (msg, ctx) => logger.debug(msg, ctx),
  };
}

/** Map an AAMF AgentInvocation to the framework's AgentInvocation. */
export function toFrameworkInvocation(inv: AgentInvocation): FrameworkInvocation {
  // Build mcpServers map from AAMF extension fields.
  // The framework passes these through directly to the CLI, so include
  // `type: 'http'` as required by the Copilot CLI's --additional-mcp-config.
  let mcpServers: Record<string, Record<string, unknown>> | undefined;
  if (inv.extensions?.mcpConfig) {
    mcpServers = { 'aamf-kb': { type: 'http', url: inv.extensions.mcpConfig.url } };
  }
  if (inv.extensions?.targetMcpConfig) {
    mcpServers = { ...mcpServers, 'aamf-kb-target': { type: 'http', url: inv.extensions.targetMcpConfig.url } };
  }

  return {
    agent: inv.agent,
    workItemId: inv.workItemId ?? '',
    phase: inv.phase,
    contextPath: inv.contextPath,
    outputPath: inv.outputPath,
    timeout: inv.timeout,
    modelOverride: inv.modelOverride,
    ...(mcpServers ? { mcpServers } : {}),
  } as FrameworkInvocation;
}

/** Map a framework AgentResult back to an AAMF AgentResult, preserving post-processing hooks. */
function toAamfResult(
  fwResult: FrameworkResult,
  invocation: AgentInvocation,
): AgentResult {
  // Normalize token usage from framework shape to AAMF shape
  let tokenUsage: AgentResult['tokenUsage'] = null;
  if (fwResult.tokenUsage != null) {
    if (typeof fwResult.tokenUsage === 'number') {
      tokenUsage = { input: fwResult.tokenUsage, output: 0 };
    } else {
      tokenUsage = {
        input: fwResult.tokenUsage.input,
        output: fwResult.tokenUsage.output,
        ...(fwResult.tokenUsage.cachedInput != null ? { cachedInput: fwResult.tokenUsage.cachedInput } : {}),
      };
    }
  }

  return {
    agent: invocation.agent,
    workItemId: invocation.workItemId,
    invocationId: invocation.invocationId,
    exitCode: fwResult.exitCode,
    success: fwResult.success,
    timedOut: fwResult.timedOut,
    duration: fwResult.duration,
    stdout: fwResult.stdout,
    stderr: fwResult.stderr,
    tokenUsage,
    outputPath: fwResult.outputPath,
    outputExists: fwResult.outputExists,
    error: fwResult.error,
    extensions: {},
  };
}

// ─── AAMF post-processing ────────────────────────────────────────────────────

/** Finalise an AgentResult by parsing aamf-json output and estimating tokens. */
function finaliseResult(
  agentResult: AgentResult,
  stdout: string,
  stderr: string,
  runtime: MigrationConfig['agentBackend']['runtime'],
  logger: Logger,
): AgentResult {
  const schema = getOutputSchema(agentResult.agent);
  const parseResult = parseAamfOutput(stdout, schema);
  if (parseResult.parsed) {
    const parsedData = parseResult.data as Record<string, unknown>;
    agentResult.extensions.structuredOutput = parsedData;
    agentResult.extensions.outputParsed = true;
    const normalizedTokenUsage = normalizeStructuredTokenUsage(parsedData.tokenUsage);
    if (normalizedTokenUsage) {
      agentResult.tokenUsage = normalizedTokenUsage;
    }
  } else if (parseResult.error === MISSING_BLOCK_ERROR) {
    logger.warn(`Agent ${agentResult.agent} did not emit an aamf-json block`);
    agentResult.extensions.outputParsed = false;
  } else {
    agentResult.extensions.outputParsed = false;
    agentResult.extensions.parseError = parseResult.error;
    agentResult.success = false;
    agentResult.error = `aamf-json parse failed: ${parseResult.error}`;
  }

  if (!hasMeaningfulTokenUsage(agentResult.tokenUsage)) {
    const parsedTokenUsage = parseTokenUsage(`${stdout}\n${stderr}`, getTokenUsageRuntime(runtime));
    if (parsedTokenUsage) {
      agentResult.tokenUsage = {
        input: parsedTokenUsage.input,
        output: parsedTokenUsage.output,
        ...(parsedTokenUsage.cachedInput != null ? { cachedInput: parsedTokenUsage.cachedInput } : {}),
      };
      if (parsedTokenUsage.premiumRequests != null) {
        agentResult.extensions.premiumRequests = parsedTokenUsage.premiumRequests;
      }
      return agentResult;
    }

    const estimatedTotal = TokenTracker.estimateTokens(stdout);
    logger.warn(
      `Token usage unavailable for ${agentResult.agent}; falling back to prompt-length estimate`,
      { estimatedPromptTokens: estimatedTotal },
    );
    agentResult.tokenUsage = { input: estimatedTotal, output: 0 };
  }

  return agentResult;
}

// ─── AgentLauncher ────────────────────────────────────────────────────────────

/**
 * The critical bridge between the AAMF runtime and agent prompt files.
 * Delegates to the framework's `AgentLauncher` for CLI process spawning,
 * then applies AAMF-specific post-processing (aamf-json parsing, copilot
 * event extraction, output file detection).
 */
export class AgentLauncher {
  private lastInvocationTime = 0;
  private initialized = false;
  private readonly frameworkLauncher: FrameworkAgentLauncher;
  private readonly logDir: string;

  constructor(
    private readonly config: MigrationConfig,
    private readonly projectRoot: string,
    private readonly logger: Logger,
  ) {
    // Register AAMF's copilot backend (uses --output-format json for token usage)
    // before the framework creates its launcher — must happen before FrameworkAgentLauncher ctor.
    if (config.agentBackend.runtime === 'copilot') {
      registerAamfCopilotBackend();
    }
    const runtimeConfig = buildBackendRuntimeConfig(config);
    this.frameworkLauncher = new FrameworkAgentLauncher(runtimeConfig, adaptLogger(logger));
    this.logDir = buildRuntimePaths(projectRoot, config.projectName).logsAgentsDir;
  }

  /** Return the resolved PATH (after init), or undefined if not resolved. */
  getResolvedPath(): string | undefined {
    // The framework's launcher handles PATH resolution internally.
    // We no longer expose it; callers that need PATH for git/build commands
    // can resolve it themselves from config.environment.
    return undefined;
  }

  /**
   * Initialize the framework backend (resolves CLI availability, PATH, etc.).
   * Must be called once before the first `launchAgent` invocation.
   */
  async init(): Promise<void> {
    if (this.initialized) return;
    await this.frameworkLauncher.init();
    this.initialized = true;
  }

  /** Launch an agent invocation and return the result. */
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

    const invLogger = this.logger.child('agent-launcher');
    if (invocation.invocationId) invLogger.setInvocationId(invocation.invocationId);
    invLogger.setAgent(invocation.agent);
    const taskId = invocation.workItemId || 'main';
    if (invocation.workItemId) invLogger.setTaskId(invocation.workItemId);
    invLogger.setPhase(invocation.phase);

    // Delegate to framework launcher
    const fwInvocation = toFrameworkInvocation(invocation);
    const fwResult = await this.frameworkLauncher.launchAgent(fwInvocation, this.projectRoot);

    // Map back to AAMF result
    const agentResult = toAamfResult(fwResult, invocation);

    // Measure queue delay
    if (delay > 0) {
      agentResult.extensions.queueDelay = Date.now() - queueStart;
    }

    // ── AAMF post-processing ──────────────────────────────────────
    const stdout = fwResult.stdout;

    // Parse copilot JSONL events
    const parsed = parseCopilotJsonl(stdout);
    const stdoutForParsing = parsed.textContent || stdout;

    // Write agent log
    await writeAgentLog(this.logDir, invocation.agent, taskId, stdout, fwResult.stderr, invocation.invocationId, parsed.events);

    if (parsed.toolCalls.length > 0) {
      invLogger.info(`Agent tool calls: ${summarizeToolCalls(parsed.toolCalls)}`);
    }
    if (parsed.errorEvents.length > 0) {
      for (const errEvt of parsed.errorEvents) {
        invLogger.warn(`Agent error event: ${JSON.stringify(errEvt.data)}`);
      }
    }

    // Detect output files
    agentResult.extensions.outputFiles = await detectOutputFiles(invocation.contextPath);

    // Copilot event summary
    if (parsed.events.length > 0) {
      agentResult.extensions.copilotEvents = {
        totalEvents: parsed.events.length,
        toolCalls: parsed.toolCalls,
        resultSummary: parsed.resultSummary,
        errorCount: parsed.errorEvents.length,
      };
      if (!hasMeaningfulTokenUsage(agentResult.tokenUsage) && parsed.resultSummary?.tokenUsage) {
        agentResult.tokenUsage = parsed.resultSummary.tokenUsage;
      }
      // Extract premiumRequests from copilot result summary
      if (parsed.resultSummary?.premiumRequests != null) {
        agentResult.extensions.premiumRequests = parsed.resultSummary.premiumRequests;
      }
    }

    // Parse aamf-json structured output and fill in token usage fallback
    return finaliseResult(agentResult, stdoutForParsing, fwResult.stderr, this.config.agentBackend.runtime, invLogger);
  }
}
