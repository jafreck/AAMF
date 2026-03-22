import { join } from 'node:path';
import { readFile, readdir, stat } from 'node:fs/promises';
import {
  AgentLauncher as FrameworkAgentLauncher,
  type BackendRuntimeConfig,
  type BackendLoggerLike,
} from '@cadre-dev/framework/runtime';
import type {
  AgentInvocation as FrameworkInvocation,
  AgentResult as FrameworkResult,
} from '@cadre-dev/framework/runtime';
import { AgentInvocation, AgentName, AgentResult } from '../agents/types.js';
import { MigrationConfig } from '../config/schema.js';
import { ensureDir, atomicWrite, fileExists } from '../util/fs.js';
import { parseAamfOutput, MISSING_BLOCK_ERROR } from '../agents/agent-output-schemas.js';
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

// ─── AAMF ↔ Framework type mapping ───────────────────────────────────────────

/** Build a BackendRuntimeConfig from AAMF's MigrationConfig. */
export function buildBackendRuntimeConfig(config: MigrationConfig): BackendRuntimeConfig {
  const backendName = config.agentBackend.runtime === 'claude-code' ? 'claude' : 'copilot';
  return {
    agent: {
      backend: backendName,
      model: config.agentBackend.model,
      timeout: config.agentBackend.timeout,
      copilot: {
        cliCommand: backendName === 'copilot' ? config.agentBackend.cliCommand : undefined,
        agentDir: config.agentBackend.agentDir,
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
  let mcpServers: Record<string, { url: string }> | undefined;
  if (inv.extensions?.mcpConfig) {
    mcpServers = { 'aamf-kb': { url: inv.extensions.mcpConfig.url } };
  }
  if (inv.extensions?.targetMcpConfig) {
    mcpServers = { ...mcpServers, 'aamf-kb-target': { url: inv.extensions.targetMcpConfig.url } };
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
      tokenUsage = { input: fwResult.tokenUsage.input, output: fwResult.tokenUsage.output };
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
  logger: Logger,
): AgentResult {
  const schema = getOutputSchema(agentResult.agent);
  const parseResult = parseAamfOutput(stdout, schema);
  if (parseResult.parsed) {
    const parsedData = parseResult.data as Record<string, unknown> & {
      tokenUsage?: { input: number; output: number; cachedInput?: number };
    };
    agentResult.extensions.structuredOutput = parsedData;
    agentResult.extensions.outputParsed = true;
    if (parsedData.tokenUsage) {
      agentResult.tokenUsage = parsedData.tokenUsage;
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

  if (!agentResult.tokenUsage) {
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
      // Extract premiumRequests from copilot result summary
      if (parsed.resultSummary?.premiumRequests != null) {
        agentResult.extensions.premiumRequests = parsed.resultSummary.premiumRequests;
      }
    }

    // Parse aamf-json structured output and fill in token usage fallback
    return finaliseResult(agentResult, stdoutForParsing, invLogger);
  }
}
