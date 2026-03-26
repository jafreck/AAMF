/**
 * Shared step helpers — extracted from MigrationOrchestrator.
 *
 * These are utility functions used by multiple phase-step implementations:
 * agent invocation, token recording, git automation, command execution,
 * model routing, error classification, and quality-gate logic.
 */

import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import pLimit from 'p-limit';
import type { FlowExecutionContext } from '@cadre-dev/framework/flow';
import type {
  AgentInvocation,
  AgentResult,
  AgentName,
  MigrationTask,
  RemediationContext,
  AgentRemediationContext,
  RoutingDecision,
  ModelTier,
  InvocationMetric,
  TerminalReasonCode,
} from '../../agents/types.js';
import { toAgentRemediationContext } from '../../agents/types.js';
import { CostEstimator } from '../../budget/cost-estimator.js';
import { spawnWithTimeout } from '../../util/process.js';
import { ensureDir, atomicWrite } from '../../util/fs.js';
import type {
  MigrationFlowContext,
  ParityResultData,
  CommandExecutionResult,
  QualityGateMode,
  RetryTargetDetails,
  TerminalExhaustionDetails,
} from '../context.js';
import { formatDuration } from '../../util/format.js';

// ─── Constants ─────────────────────────────────────────────────────────

/** Hardcoded average token estimate per migration task for cost projections. */
export const AVG_TOKENS_PER_TASK = 100_000;
/** Hardcoded retry-overhead multiplier for aggregate Phase 4 cost projections. */
export const RETRY_OVERHEAD_MULTIPLIER = 1.25;

// ─── Infrastructure Error Detection ──────────────────────────────────────

const INFRASTRUCTURE_ERROR_PATTERNS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /blocking waiting for file lock/i, label: 'file-lock' },
  { pattern: /could not acquire lock/i, label: 'file-lock' },
  { pattern: /lock file .* is locked/i, label: 'file-lock' },
  { pattern: /ELOCK|ELOCKED/i, label: 'file-lock' },
  { pattern: /signal:\s*killed|SIGKILL|killed by signal 9/i, label: 'process-killed' },
  { pattern: /out of memory|OOM|Cannot allocate memory/i, label: 'oom' },
  { pattern: /no space left on device|ENOSPC/i, label: 'disk-full' },
  { pattern: /read-only file system|EROFS/i, label: 'fs-readonly' },
  { pattern: /network error|connection (refused|reset|timed out)/i, label: 'network' },
  { pattern: /could not resolve host|DNS resolution failed/i, label: 'network' },
  { pattern: /failed to download|registry .* unavailable/i, label: 'network' },
  { pattern: /HTTP\/2 GOAWAY|connection_error|\b503\b|service unavailable/i, label: 'network' },
  { pattern: /timed? ?out|deadline exceeded/i, label: 'timeout' },
  { pattern: /command hung|timed out.*command/i, label: 'hung' },
  { pattern: /permission denied|EACCES/i, label: 'permission' },
];

export function classifyError(errorOutput: string): string | undefined {
  for (const { pattern, label } of INFRASTRUCTURE_ERROR_PATTERNS) {
    if (pattern.test(errorOutput)) return label;
  }
  return undefined;
}

// ─── Terminal Exhaustion ───────────────────────────────────────────────

export class TerminalExhaustionError extends Error {
  constructor(public readonly details: TerminalExhaustionDetails) {
    const locationParts = [
      details.taskId ? `task=${details.taskId}` : undefined,
      details.wave !== undefined ? `wave=${details.wave}` : undefined,
      details.check ? `check=${details.check}` : undefined,
    ].filter((part): part is string => !!part);
    const location = locationParts.length > 0 ? ` (${locationParts.join(', ')})` : '';
    super(`Phase 4 terminal exhaustion: ${details.reasonCode}${location} - ${details.summary}`);
    this.name = 'TerminalExhaustionError';
  }
}

/** Error thrown when a critical phase fails. */
export class MigrationError extends Error {
  constructor(
    public readonly phaseId: number,
    public readonly phaseName: string,
    public readonly result: import('../../agents/types.js').PhaseResult,
  ) {
    super(`Phase ${phaseId} (${phaseName}) failed: ${result.error ?? 'unknown error'}`);
    this.name = 'MigrationError';
  }
}

/**
 * Assert that a phase result is successful, throwing a {@link MigrationError}
 * if it is not.  Every phase is critical — a failure halts the flow.
 */
export function assertPhaseSuccess(result: import('../../agents/types.js').PhaseResult): void {
  if (!result.success) {
    throw new MigrationError(result.phase, result.name, result);
  }
}

// ─── Helper Functions ──────────────────────────────────────────────────

export function getConfiguredRuntimeModel(ctx: MigrationFlowContext): string {
  return ctx.config.models?.default ?? ctx.config.agentBackend.model ?? 'claude-sonnet-4';
}

export function getRuntimeTimeout(ctx: MigrationFlowContext): number {
  return ctx.config.agentBackend.timeout;
}

export function getPhaseTimeout(ctx: MigrationFlowContext, phase: number): number {
  return ctx.config.agentBackend.phaseTimeouts?.[phase] ?? getRuntimeTimeout(ctx);
}

export function getQualityGateMode(ctx: MigrationFlowContext): QualityGateMode {
  const policy = ctx.config.options.qualityPolicy;
  if (policy === 'strict') return 'enforce';
  if (policy === 'balanced') return 'advisory';
  if (policy === 'deferred-strict') return 'advisory';
  return 'skip';
}

export function isGitAutomationEnabled(ctx: MigrationFlowContext): boolean {
  return ctx.config.options.git?.enabled === true;
}

export function getFailureRecoveryModel(ctx: MigrationFlowContext): string | undefined {
  return ctx.config.models?.failureRecovery ?? ctx.config.agentBackend.failureRecoveryModel;
}

export function getDefaultRoutingModel(ctx: MigrationFlowContext): string {
  return ctx.config.models?.default
    ?? ctx.config.options.modelRouting?.defaultModel
    ?? ctx.config.agentBackend.model
    ?? 'unknown';
}

function getRoutingConfig(ctx: MigrationFlowContext) {
  return ctx.config.models?.routing ?? ctx.config.options.modelRouting;
}

type RoutingConfig = NonNullable<ReturnType<typeof getRoutingConfig>>;
type LegacyRoutingConfig = NonNullable<MigrationFlowContext['config']['options']['modelRouting']>;

function isLegacyRoutingConfig(routing: RoutingConfig): routing is LegacyRoutingConfig {
  return 'heavyModel' in routing || 'criticalModel' in routing || 'maxCriticalTasks' in routing;
}

function getRoutingHeavyModel(routing: ReturnType<typeof getRoutingConfig>): string | undefined {
  if (!routing) return undefined;
  return isLegacyRoutingConfig(routing) ? routing.heavyModel : routing.heavy;
}

function getRoutingCriticalModel(routing: ReturnType<typeof getRoutingConfig>): string | undefined {
  if (!routing) return undefined;
  return isLegacyRoutingConfig(routing) ? routing.criticalModel : routing.critical;
}

function getRoutingMaxEscalatedTasks(routing: ReturnType<typeof getRoutingConfig>): number {
  if (!routing) return 0;
  return isLegacyRoutingConfig(routing) ? routing.maxCriticalTasks : routing.maxEscalatedTasks;
}

export function isTransientModelFailure(errorText: string): boolean {
  return /\b503\b|HTTP\/2 GOAWAY|connection_error|Failed to get response from the AI model|service unavailable/i
    .test(errorText);
}

export function normalizeFailureSummary(summary: string): string {
  return summary.replace(/\s+/g, ' ').trim().slice(0, 240);
}

// ─── Agent Invocation Building ─────────────────────────────────────────

const KB_AWARE_AGENTS: AgentName[] = [
  'knowledge-builder', 'migration-planner', 'adjudicator',
  'code-migrator', 'parity-verifier', 'test-writer', 'parity-failure-resolver',
  'final-parity-checker', 'e2e-test-crafter', 'documentation-writer',
  'idiomatic-reviewer', 'idiomatic-refactorer',
];

export function buildInvocation(
  ctx: MigrationFlowContext,
  agent: AgentName,
  contextInfo: { contextPath: string; outputPath: string },
  phase: number,
  taskId?: string,
  task?: MigrationTask,
): AgentInvocation {
  const timeout = getPhaseTimeout(ctx, phase);
  const mcpConfig = (KB_AWARE_AGENTS.includes(agent) && ctx.kbServer)
    ? ctx.kbServer.mcpConfig : undefined;
  const kbDbPath = (KB_AWARE_AGENTS.includes(agent) && ctx.kbServer)
    ? ctx.paths.kbDbFile : undefined;
  const targetMcpConfig = (KB_AWARE_AGENTS.includes(agent) && ctx.targetKbServer)
    ? ctx.targetKbServer.mcpConfig : undefined;
  const targetKbDbPath = (KB_AWARE_AGENTS.includes(agent) && ctx.targetKbServer)
    ? ctx.paths.kbTargetDbFile : undefined;

  const failureRecoveryOverride = agent === 'parity-failure-resolver'
    ? getFailureRecoveryModel(ctx) : undefined;

  let modelOverride = failureRecoveryOverride;
  let routingTier: ModelTier | undefined;
  let routingReason: string | undefined;

  const routing = getRoutingConfig(ctx);
  if (!failureRecoveryOverride && routing?.enabled) {
    const decision = applyRoutingCaps(
      ctx, selectModelForInvocation(ctx, task, agent), taskId,
    );
    routingTier = decision.tier;
    routingReason = decision.reason;

    if (decision.tier !== 'normal') {
      modelOverride = decision.selectedModel;
      if (taskId) ctx.routedTaskIds.add(taskId);
      const defaultModel = getDefaultRoutingModel(ctx);
      const projectedCost = ctx.costEstimator.projectCost(decision.selectedModel, AVG_TOKENS_PER_TASK).total;
      const baseCost = ctx.costEstimator.projectCost(defaultModel, AVG_TOKENS_PER_TASK).total;
      ctx.escalationCostUsd += Math.max(0, projectedCost - baseCost);

      ctx.logger.info(
        `Model routing: ${taskId ?? agent} → ${decision.tier} (${decision.selectedModel}), ` +
        `score=${decision.score}, reason=${decision.reason}`,
      );
      ctx.logger.event({
        type: 'model-routing-decision',
        taskId: taskId ?? '', tier: decision.tier,
        selectedModel: decision.selectedModel,
        reason: decision.reason, score: decision.score,
      });
    }
  }

  return {
    agent,
    contextPath: contextInfo.contextPath,
    outputPath: contextInfo.outputPath,
    phase,
    workItemId: taskId ?? '',
    timeout,
    ...(modelOverride ? { modelOverride } : {}),
    extensions: {
      progressDir: ctx.paths.root,
      ...(routingTier ? { routingTier, routingReason } : {}),
      ...(mcpConfig ? { mcpConfig } : {}),
      ...(kbDbPath ? { kbDbPath } : {}),
      ...(targetMcpConfig ? { targetMcpConfig } : {}),
      ...(targetKbDbPath ? { targetKbDbPath } : {}),
    },
  };
}

// ─── Model Routing ─────────────────────────────────────────────────────

function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const regexStr = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${regexStr}$`);
}

export function selectModelForInvocation(
  ctx: MigrationFlowContext,
  task: MigrationTask | undefined,
  agent: AgentName,
): RoutingDecision {
  const routing = getRoutingConfig(ctx);
  const defaultModel = getDefaultRoutingModel(ctx);

  if (!routing?.enabled) {
    return { tier: 'normal', selectedModel: defaultModel, reason: 'routing-disabled', score: 0, escalated: false };
  }

  let score = 0;
  if (task) {
    score += Math.min(task.sourceFiles.length, 10) * 1.5;
    score += Math.min(task.targetFiles.length, 10);
    if (task.lineRange) {
      const span = task.lineRange.end - task.lineRange.start;
      score += Math.min(span / 1000, 1) * 20;
    }
    score += Math.min(task.dependencies.length, 10) * 1.5;
    const complexityScores: Record<string, number> = { simple: 0, moderate: 20, complex: 40 };
    score += complexityScores[task.complexity] ?? 0;
  }
  score = Math.round(Math.min(score, 100));

  if (task && routing.criticalTaskPatterns?.length) {
    for (const pattern of routing.criticalTaskPatterns) {
      if (globToRegex(pattern).test(task.id)) {
        return { tier: 'critical', selectedModel: getRoutingCriticalModel(routing) ?? defaultModel, reason: 'critical-task-pattern', score, escalated: false };
      }
    }
  }
  if (routing.criticalAgents?.length && routing.criticalAgents.includes(agent)) {
    return { tier: 'critical', selectedModel: getRoutingCriticalModel(routing) ?? defaultModel, reason: 'critical-agent', score, escalated: false };
  }
  if (score >= routing.criticalThreshold) {
    return { tier: 'critical', selectedModel: getRoutingCriticalModel(routing) ?? defaultModel, reason: 'score-critical', score, escalated: false };
  }
  if (score >= routing.heavyThreshold) {
    return { tier: 'heavy', selectedModel: getRoutingHeavyModel(routing) ?? defaultModel, reason: 'score-heavy', score, escalated: false };
  }
  return { tier: 'normal', selectedModel: defaultModel, reason: 'score-normal', score, escalated: false };
}

export function applyRoutingCaps(
  ctx: MigrationFlowContext,
  decision: RoutingDecision,
  taskId?: string,
): RoutingDecision {
  if (decision.tier === 'normal') return decision;
  const routing = getRoutingConfig(ctx);
  if (!routing?.enabled) return decision;
  const defaultModel = getDefaultRoutingModel(ctx);

  const isNewRoutedTask = Boolean(taskId && !ctx.routedTaskIds.has(taskId));
  const routedTaskCountAfterDecision = ctx.routedTaskIds.size + (isNewRoutedTask ? 1 : 0);
  const maxEscalatedTasks = getRoutingMaxEscalatedTasks(routing);
  if (maxEscalatedTasks > 0 && routedTaskCountAfterDecision > maxEscalatedTasks) {
    return { ...decision, tier: 'normal', selectedModel: defaultModel, reason: `${decision.reason}:capped-max-tasks` };
  }
  if (routing.maxEscalationCostUsd > 0) {
    const projectedCost = ctx.costEstimator.projectCost(decision.selectedModel, AVG_TOKENS_PER_TASK).total;
    const baseCost = ctx.costEstimator.projectCost(defaultModel, AVG_TOKENS_PER_TASK).total;
    const incrementalCost = Math.max(0, projectedCost - baseCost);
    if (ctx.escalationCostUsd + incrementalCost > routing.maxEscalationCostUsd) {
      return { ...decision, tier: 'normal', selectedModel: defaultModel, reason: `${decision.reason}:capped-cost` };
    }
  }
  return decision;
}

// ─── Agent Launch + Metrics ────────────────────────────────────────────

export async function launchAgentWithEvents(
  ctx: MigrationFlowContext,
  invocation: AgentInvocation,
): Promise<AgentResult> {
  const invocationId = randomUUID();
  const taggedInvocation = { ...invocation, invocationId };
  const startTime = new Date().toISOString();
  const taskId = invocation.workItemId || undefined;

  ctx.logger.event({
    type: 'agent-launched', agent: invocation.agent,
    taskId, phase: invocation.phase, invocationId,
  });

  const result = await ctx.launcher.launchAgent(taggedInvocation);

  if (result.success) {
    ctx.logger.event({
      type: 'agent-completed', agent: result.agent,
      taskId: result.workItemId || undefined, success: true,
      duration: result.duration, invocationId: result.invocationId,
    });
  } else {
    ctx.logger.event({
      type: 'agent-failed', agent: result.agent,
      taskId: result.workItemId || undefined, error: result.error ?? 'unknown',
      invocationId: result.invocationId,
    });
  }

  const endTime = new Date().toISOString();
  const configModel = getConfiguredRuntimeModel(ctx);
  const model = invocation.modelOverride ?? configModel;
  const tokensInput = result.tokenUsage?.input ?? 0;
  const tokensOutput = result.tokenUsage?.output ?? 0;
  const tokensTotal = tokensInput + tokensOutput;
  const costEstimate = ctx.costEstimator.estimate(
    model, tokensInput, tokensOutput, result.tokenUsage?.cachedInput,
  );

  const routingTier = invocation.extensions?.routingTier;
  const routingReason = invocation.extensions?.routingReason;
  const routing = getRoutingConfig(ctx);
  const routingDecision = routing?.enabled && routingTier
    ? (() => {
        const defaultModel = getDefaultRoutingModel(ctx);
        const projectedCost = ctx.costEstimator.projectCost(model, AVG_TOKENS_PER_TASK).total;
        const baseCost = ctx.costEstimator.projectCost(defaultModel, AVG_TOKENS_PER_TASK).total;
        return { incrementalCost: Math.max(0, projectedCost - baseCost) };
      })()
    : undefined;

  const attemptNumber = invocation.extensions?.attemptNumber ?? 1;
  const maxAttempts = invocation.extensions?.maxAttempts ?? 1;

  const metric: InvocationMetric = {
    runId: ctx.runId, phase: invocation.phase,
    taskId: taskId ?? '', agentType: invocation.agent,
    invocationId, startTime, endTime,
    durationMs: result.duration,
    attemptNumber,
    maxAttempts,
    wasRetry: attemptNumber > 1,
    status: result.success ? 'success' : 'failed',
    model, tokensPrompt: tokensInput, tokensCompletion: tokensOutput, tokensTotal,
    costUsd: costEstimate.total,
    ...(result.tokenUsage?.cachedInput != null ? { cachedTokens: result.tokenUsage.cachedInput } : {}),
    ...(result.extensions?.premiumRequests != null ? { premiumRequests: result.extensions.premiumRequests } : {}),
    ...(routingTier ? { routingTier, routingReason } : {}),
    ...(routingDecision ? { escalationCostUsd: routingDecision.incrementalCost } : {}),
  };

  ctx.metricsCollector.record(metric);
  try {
    await ctx.metricsCollector.writeJsonl(ctx.paths.root);
    const st = ctx.checkpoint.getState();
    st.metricsCount = (st.metricsCount ?? 0) + 1;
    await ctx.checkpoint.save(st);
  } catch {
    // Non-fatal
  }

  return result;
}

export function recordTokens(ctx: MigrationFlowContext, result: AgentResult, phase: number): void {
  if (result.tokenUsage) {
    const total = result.tokenUsage.input + result.tokenUsage.output;
    ctx.tokenTracker.record(result.agent, phase, total, result.tokenUsage.cachedInput, result.workItemId || undefined);
    const state = ctx.checkpoint.getState();
    state.tokenUsage = ctx.tokenTracker.toCheckpointData();
  }
}

// ─── Budget Gate ───────────────────────────────────────────────────────

/** Returns true if budget is OK, false if exceeded. */
export function checkBudget(ctx: MigrationFlowContext): boolean {
  if (!ctx.config.options.tokenBudget) return true;
  const threshold = ctx.tokenTracker.checkThreshold(ctx.config.options.tokenBudget);
  if (threshold === 'exceeded') {
    ctx.logger.event({
      type: 'budget-exceeded',
      usage: ctx.tokenTracker.getTotal(),
      budget: ctx.config.options.tokenBudget,
    });
    return false;
  }
  if (threshold === 'warning') {
    const pct = Math.round(
      (ctx.tokenTracker.getTotal() / ctx.config.options.tokenBudget) * 100,
    );
    ctx.logger.event({
      type: 'budget-warning',
      usage: ctx.tokenTracker.getTotal(),
      budget: ctx.config.options.tokenBudget,
      percentage: pct,
    });
  }
  return true;
}

// ─── Git Automation ────────────────────────────────────────────────────

async function runGit(
  ctx: MigrationFlowContext,
  args: string[],
): Promise<{ success: boolean; stdout: string; stderr: string; exitCode: number }> {
  try {
    const resolvedPath = ctx.launcher.getResolvedPath();
    const result = await spawnWithTimeout('git', args, {
      cwd: ctx.config.target.outputPath,
      timeout: getRuntimeTimeout(ctx),
      env: {
        ...process.env,
        ...(resolvedPath ? { PATH: resolvedPath } : {}),
      },
    });
    return {
      success: result.exitCode === 0 && !result.killed,
      stdout: result.stdout, stderr: result.stderr,
      exitCode: result.exitCode,
    };
  } catch (err) {
    return {
      success: false, stdout: '',
      stderr: err instanceof Error ? err.message : String(err),
      exitCode: -1,
    };
  }
}

async function commitIfDirty(
  ctx: MigrationFlowContext,
  message: string,
  allowEmpty = false,
): Promise<void> {
  await ctx.gitLimiter(async () => {
    await ensureGitRepositoryReady(ctx);
    const status = await runGit(ctx, ['status', '--porcelain']);
    if (!status.success) {
      ctx.logger.warn(`Unable to inspect git status: ${status.stderr || status.stdout}`);
      return;
    }
    const hasChanges = !!status.stdout.trim();
    if (!hasChanges && !allowEmpty) return;
    if (hasChanges) {
      const add = await runGit(ctx, ['add', '-A']);
      if (!add.success) { ctx.logger.warn(`Unable to stage: ${add.stderr}`); return; }
    }
    const staged = await runGit(ctx, ['diff', '--cached', '--name-only']);
    if (!staged.success) return;
    const stagedCount = staged.stdout.split('\n').filter(Boolean).length;
    if (stagedCount === 0 && !allowEmpty) return;
    const commitArgs = allowEmpty
      ? ['commit', '--allow-empty', '-m', message]
      : ['commit', '-m', message];
    const commit = await runGit(ctx, commitArgs);
    if (!commit.success) {
      ctx.logger.warn(`Git commit failed: ${commit.stderr || commit.stdout}`);
      return;
    }
    ctx.logger.info(`Created git commit (${stagedCount} file(s)): ${message}`);
  });
}

import { fileExists } from '../../util/fs.js';
import { gitignoreForLanguage } from '../../util/gitignore-templates.js';

export async function ensureGitRepositoryReady(ctx: MigrationFlowContext): Promise<void> {
  if (!isGitAutomationEnabled(ctx)) return;
  const gitCfg = ctx.config.options.git;
  if (!gitCfg?.autoInit) return;
  await ensureDir(ctx.config.target.outputPath);
  const outputPath = resolve(ctx.config.target.outputPath);
  const probe = await runGit(ctx, ['rev-parse', '--show-toplevel']);
  if (probe.success && resolve(probe.stdout.trim()) === outputPath) return;
  const init = await runGit(ctx, ['init']);
  if (!init.success) {
    ctx.logger.warn(`Failed to initialize git: ${init.stderr || init.stdout}`);
    return;
  }
  await runGit(ctx, ['config', 'user.name', gitCfg.authorName]);
  await runGit(ctx, ['config', 'user.email', gitCfg.authorEmail]);
  const gitignorePath = join(outputPath, '.gitignore');
  if (!(await fileExists(gitignorePath))) {
    const content = gitignoreForLanguage(ctx.config.target.language);
    await atomicWrite(gitignorePath, content);
    ctx.logger.info(`Wrote .gitignore for "${ctx.config.target.language}"`);
  }
  ctx.logger.info(`Initialized git repository at ${ctx.config.target.outputPath}`);
}

export async function commitForAgent(
  ctx: MigrationFlowContext,
  agent: AgentName, phase: number, taskId?: string, detail?: string,
): Promise<void> {
  if (!isGitAutomationEnabled(ctx) || !ctx.config.options.git?.commitByAgent) return;
  if (ctx.deferGitCommits) return;
  const scope = taskId ? `task ${taskId}` : `phase ${phase}`;
  const suffix = detail ? ` (${detail})` : '';
  await commitIfDirty(ctx, `aamf: ${agent} updated output for ${scope}${suffix}`);
}

export async function commitForTask(ctx: MigrationFlowContext, task: MigrationTask): Promise<void> {
  if (!isGitAutomationEnabled(ctx) || !ctx.config.options.git?.commitPerTask) return;
  if (ctx.deferGitCommits) return;
  const allowEmpty = ctx.config.options.git?.allowEmptyTaskCommits ?? true;
  await commitIfDirty(ctx, `aamf: complete ${task.id} - ${task.name}`, allowEmpty);
}

export async function commitForWave(ctx: MigrationFlowContext, wave: number, taskIds: string[]): Promise<void> {
  if (!isGitAutomationEnabled(ctx)) return;
  const taskList = taskIds.join(', ');
  await commitIfDirty(ctx, `aamf: wave ${wave} — ${taskIds.length} task(s) [${taskList}]`);
}

// ─── Command Execution ─────────────────────────────────────────────────

export async function runCommand(
  ctx: MigrationFlowContext,
  label: string,
  command: string,
  taskId: string,
): Promise<CommandExecutionResult> {
  if (ctx.phase4Snapshot) {
    if (label === 'build') ctx.phase4Snapshot.buildCommandRuns++;
    if (label === 'test') ctx.phase4Snapshot.testCommandRuns++;
    if (label === 'format') ctx.phase4Snapshot.formatCommandRuns++;
    if (label === 'lint') ctx.phase4Snapshot.lintCommandRuns++;
  }
  return ctx.buildLimiter(async () => {
    const commandTimeout = ctx.config.options.commandTimeout;
    const timeout = commandTimeout > 0 ? commandTimeout : getRuntimeTimeout(ctx);
    ctx.logger.info(`Running ${label} command for task ${taskId}: ${command}`);
    try {
      const resolvedPath = ctx.launcher.getResolvedPath();
      const result = await spawnWithTimeout('sh', ['-c', command], {
        cwd: ctx.config.target.outputPath,
        timeout,
        env: { ...process.env, ...(resolvedPath ? { PATH: resolvedPath } : {}) },
      });

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const commandLogDir = {
        build: ctx.paths.logsCommandBuildDir,
        test: ctx.paths.logsCommandTestDir,
        format: ctx.paths.logsCommandFormatDir,
        lint: ctx.paths.logsCommandLintDir,
      }[label] ?? ctx.paths.logsCommandBuildDir;
      await ensureDir(commandLogDir);
      const logPath = join(commandLogDir, `${taskId}-${timestamp}.log`);
      const logContent = `=== COMMAND: ${command} ===\n=== EXIT CODE: ${result.exitCode} ===\n\n=== STDOUT ===\n${result.stdout}\n\n=== STDERR ===\n${result.stderr}\n`;
      await atomicWrite(logPath, logContent);

      if (result.exitCode !== 0 || result.killed) {
        const combinedOutput = `${result.stdout}\n${result.stderr}`;
        const errorText = result.killed
          ? `${label} command hung (timed out after ${timeout}ms). See full output: ${logPath}`
          : `${label} failed (exit code ${result.exitCode}). See full output: ${logPath}`;
        ctx.logger.error(errorText);
        const infraLabel = classifyError(combinedOutput);
        return { success: false, error: errorText, infraError: infraLabel, rawError: combinedOutput, logPath };
      }

      ctx.logger.info(`${label} command succeeded for task ${taskId}`);
      return { success: true };
    } catch (err) {
      const errorText = `${label} command error: ${err instanceof Error ? err.message : String(err)}`;
      ctx.logger.error(errorText);
      return { success: false, error: errorText, infraError: classifyError(errorText) };
    }
  });
}

export async function runCommandWithRecovery(
  ctx: MigrationFlowContext,
  label: string,
  command: string,
  task: MigrationTask,
  options?: {
    initialFailure?: CommandExecutionResult;
    wave?: number;
    retryScope?: RetryTargetDetails['scope'];
    artifactPaths?: string[];
    failureSummary?: string;
    expectedSuccessCondition?: string;
    suppressTerminalOnExhaustion?: boolean;
  },
): Promise<boolean> {
  const maxAttempts = ctx.config.options.maxRetriesPerTask;
  const maxInfraRetries = ctx.config.options.maxInfraRetries ?? 3;
  const retryScope = options?.retryScope ?? 'command';
  const artifactPaths = options?.artifactPaths ?? [...task.sourceFiles, ...task.targetFiles];
  const expectedSuccessCondition = options?.expectedSuccessCondition ?? `${label} command succeeds for ${task.id}`;

  let cmdResult = options?.initialFailure ?? await runCommand(ctx, label, command, task.id);
  if (cmdResult.success) return true;
  const recoveryLoopStartedAt = Date.now();

  // Infrastructure retry loop
  let infraAttempt = 0;
  while (cmdResult.infraError && infraAttempt < maxInfraRetries) {
    infraAttempt++;
    if (ctx.phase4Snapshot) ctx.phase4Snapshot.commandInfraRetries++;
    const backoffMs = Math.min(1000 * Math.pow(2, infraAttempt - 1), 30_000);
    ctx.logger.warn(
      `${label} failed for ${task.id} with infra error "${cmdResult.infraError}", ` +
      `infra retry ${infraAttempt}/${maxInfraRetries} (backoff ${backoffMs}ms)`,
    );
    await new Promise(resolve => setTimeout(resolve, backoffMs));
    cmdResult = await runCommand(ctx, label, command, task.id);
    if (cmdResult.success) {
      if (ctx.phase4Snapshot) ctx.phase4Snapshot.recoveryLoopTimeMs += Date.now() - recoveryLoopStartedAt;
      ctx.logger.info(`${label} recovered for ${task.id} after infra retry ${infraAttempt}`);
      return true;
    }
  }
  if (cmdResult.success) return true;

  // Code-quality recovery loop
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (ctx.phase4Snapshot) ctx.phase4Snapshot.commandRecoveryAttempts++;
    await recordRetryTarget(ctx, {
      scope: retryScope, attempt, maxAttempts,
      taskId: task.id, wave: options?.wave, check: label,
      summary: options?.failureSummary ?? cmdResult.error ?? `${label} command failed`,
    });

    const remediationContext = buildRemediationContext({
      failureKind: label,
      failureSummary: options?.failureSummary ?? cmdResult.error ?? `${label} command failed`,
      taskId: task.id, wave: options?.wave, check: label,
      artifactPaths, expectedSuccessCondition,
    });

    const recoveryCtx = await ctx.contextBuilder.buildContext(
      'parity-failure-resolver', 5, task.id,
      {
        failureReport: cmdResult.logPath ?? cmdResult.rawError ?? cmdResult.error,
        failureType: label,
        sourceFile: task.sourceFiles[0], targetFile: task.targetFiles[0],
        kbEntry: task.knowledgeBaseRef,
        attemptNumber: attempt,
        ...taskScopePayload(task),
        remediationContext: toAgentRemediationContext(remediationContext),
      },
    );
    const recoveryInv = buildInvocation(ctx, 'parity-failure-resolver', recoveryCtx, 5, task.id);
    const recoveryResult = await launchAgentWithEvents(ctx, recoveryInv);
    recordTokens(ctx, recoveryResult, 5);
    if (!recoveryResult.success) {
      ctx.logger.warn(`Parity-failure-resolver failed for ${task.id} on attempt ${attempt}`);
      continue;
    }

    const reMigrateCtx = await ctx.contextBuilder.buildContext(
      'code-migrator', 5, task.id,
      {
        sourceFiles: task.sourceFiles, targetFiles: task.targetFiles,
        kbEntry: task.knowledgeBaseRef,
        ...taskScopePayload(task),
        remediationContext: toAgentRemediationContext(remediationContext),
      },
    );
    const reMigrateInv = buildInvocation(ctx, 'code-migrator', reMigrateCtx, 5, task.id);
    const reMigrateResult = await launchAgentWithEvents(ctx, reMigrateInv);
    recordTokens(ctx, reMigrateResult, 5);
    if (!reMigrateResult.success) {
      ctx.logger.warn(`Re-migration failed for ${task.id} on ${label} recovery attempt ${attempt}`);
      continue;
    }
    await commitForAgent(ctx, 'code-migrator', 5, task.id, task.name);

    cmdResult = await runCommand(ctx, label, command, task.id);
    if (cmdResult.success) {
      if (ctx.phase4Snapshot) ctx.phase4Snapshot.recoveryLoopTimeMs += Date.now() - recoveryLoopStartedAt;
      ctx.logger.info(`${label} recovered for ${task.id} on attempt ${attempt}`);
      return true;
    }
  }

  if (ctx.phase4Snapshot) ctx.phase4Snapshot.recoveryLoopTimeMs += Date.now() - recoveryLoopStartedAt;

  if (options?.suppressTerminalOnExhaustion) {
    ctx.logger.warn(
      `${label} recovery exhausted for ${task.id} after ${maxAttempts} attempt(s); deferring to wave convergence limits`,
    );
    return false;
  }
  await raiseTerminalExhaustion(ctx, {
    reasonCode: 'command-recovery-exhausted', taskId: task.id, check: label,
    summary: cmdResult.error ?? `${label} command failed after ${maxAttempts} recovery attempts`,
  });
  return false;
}

// ─── Remediation & Retry ───────────────────────────────────────────────

export function buildRemediationContext(input: {
  failureKind: string; failureSummary: string;
  taskId?: string; wave?: number; check?: string;
  artifactPaths: string[]; expectedSuccessCondition: string;
}): RemediationContext {
  return {
    failureKind: input.failureKind,
    failureSummary: normalizeFailureSummary(input.failureSummary),
    failureTarget: { taskId: input.taskId, wave: input.wave, check: input.check },
    artifactPaths: Array.from(new Set(input.artifactPaths.filter(Boolean))),
    expectedSuccessCondition: input.expectedSuccessCondition,
  };
}

export function taskScopePayload(task: MigrationTask): Record<string, unknown> {
  return {
    taskScope: {
      description: task.description,
      acceptanceCriteria: task.acceptanceCriteria,
      parityChecks: task.parityChecks,
      ...(task.lineRange ? { lineRange: task.lineRange } : {}),
      ...(task.symbols ? { symbols: task.symbols } : {}),
      ...(task.knowledgeBaseRef ? { knowledgeBaseRef: task.knowledgeBaseRef } : {}),
    },
  };
}

export async function recordRetryTarget(ctx: MigrationFlowContext, details: RetryTargetDetails): Promise<void> {
  const normalizedSummary = normalizeFailureSummary(details.summary);
  const parts = [
    details.taskId ? `task=${details.taskId}` : undefined,
    details.wave !== undefined ? `wave=${details.wave}` : undefined,
    details.check ? `check=${details.check}` : undefined,
  ].filter((part): part is string => !!part);
  const target = parts.length > 0 ? parts.join(', ') : 'unscoped';
  ctx.logger.warn(
    `Recovery retry ${details.attempt}/${details.maxAttempts} targeting ${details.scope} (${target}): ${normalizedSummary}`,
  );
  await ctx.progress.appendRetryTarget({ ...details, summary: normalizedSummary });
}

export async function raiseTerminalExhaustion(ctx: MigrationFlowContext, details: TerminalExhaustionDetails): Promise<never> {
  const normalizedSummary = normalizeFailureSummary(details.summary);
  const normalized: TerminalExhaustionDetails = { ...details, summary: normalizedSummary };
  ctx.logger.event({
    type: 'terminal-exhaustion', reasonCode: normalized.reasonCode,
    wave: normalized.wave, taskId: normalized.taskId, check: normalized.check,
  });
  await ctx.checkpoint.setTerminalExhaustion(normalized);
  await ctx.progress.setTerminalExhaustion(normalized);
  await ctx.progress.appendEvent(`Terminal exhaustion (${normalized.reasonCode}): ${normalizedSummary}`);
  throw new TerminalExhaustionError(normalized);
}

// ─── Parity Helpers ────────────────────────────────────────────────────

export function storeParityResult(ctx: MigrationFlowContext, agentResult: AgentResult, taskId: string): void {
  if (!agentResult.extensions.outputParsed || !agentResult.extensions.structuredOutput) return;
  const out = agentResult.extensions.structuredOutput as Record<string, unknown>;
  const parity = out.parity;
  if (parity !== 'pass' && parity !== 'partial' && parity !== 'fail') return;
  const issues = Array.isArray(out.issues) ? out.issues as ParityResultData['issues'] : [];
  ctx.parityResults.set(taskId, { parity, issues });
}

export function checkParityResult(ctx: MigrationFlowContext, taskId: string): boolean {
  const result = ctx.parityResults.get(taskId) ?? rehydrateParityFromLog(ctx, taskId);
  if (!result) {
    ctx.logger.warn(`Parity result missing for ${taskId} — treating as failed`);
    return false;
  }
  if (result.parity === 'pass') return true;
  if (result.parity === 'partial') return result.issues.every(i => i.severity === 'minor');
  return false;
}

export function hasNonMinorParityIssues(ctx: MigrationFlowContext, taskId: string): boolean {
  const result = ctx.parityResults.get(taskId) ?? rehydrateParityFromLog(ctx, taskId);
  if (!result) {
    ctx.logger.warn(`Parity result missing for ${taskId} — assuming blocking`);
    return true;
  }
  return result.issues.some(i => i.severity !== 'minor');
}

export function getParityIssueSummary(ctx: MigrationFlowContext, taskId: string): string | undefined {
  const result = ctx.parityResults.get(taskId) ?? rehydrateParityFromLog(ctx, taskId);
  if (!result || result.issues.length === 0) return undefined;
  const bySeverity = { critical: 0, major: 0, minor: 0 };
  for (const issue of result.issues) bySeverity[issue.severity] = (bySeverity[issue.severity] ?? 0) + 1;
  const counts = Object.entries(bySeverity).filter(([, n]) => n > 0).map(([sev, n]) => `${n} ${sev}`).join(', ');
  const nonMinor = result.issues
    .filter(i => i.severity !== 'minor')
    .map(i => {
      let s = i.description;
      if (i.sourceLocation) s += ` [source: ${i.sourceLocation}]`;
      if (i.targetLocation) s += ` [target: ${i.targetLocation}]`;
      return s;
    })
    .slice(0, 5);
  return `${counts}: ${nonMinor.join('; ')}`;
}

export function resolverReducedScope(result: AgentResult): boolean {
  if (!result.extensions.outputParsed || !result.extensions.structuredOutput) return false;
  return (result.extensions.structuredOutput as Record<string, unknown>).scopeReduced === true;
}

function rehydrateParityFromLog(ctx: MigrationFlowContext, taskId: string): ParityResultData | undefined {
  try {
    const taskLogDir = join(ctx.paths.logsAgentsDir, 'parity-verifier', taskId);
    let entries: string[];
    try { entries = readdirSync(taskLogDir); } catch { return undefined; }
    const logFiles = entries.filter(f => f.endsWith('.log') && !f.endsWith('.live.log')).sort();
    if (logFiles.length === 0) return undefined;
    const latestLog = readFileSync(join(taskLogDir, logFiles[logFiles.length - 1]!), 'utf-8');
    const blockRegex = /```aamf-json\r?\n([\s\S]*?)```/g;
    let lastMatch: RegExpExecArray | null = null;
    let match: RegExpExecArray | null;
    while ((match = blockRegex.exec(latestLog)) !== null) lastMatch = match;
    if (!lastMatch) return undefined;
    const raw = JSON.parse(lastMatch[1]!.trim()) as Record<string, unknown>;
    const parity = raw.parity;
    if (parity !== 'pass' && parity !== 'partial' && parity !== 'fail') return undefined;
    const issues = Array.isArray(raw.issues) ? raw.issues as ParityResultData['issues'] : [];
    const data: ParityResultData = { parity, issues };
    ctx.parityResults.set(taskId, data);
    ctx.logger.info(`Rehydrated parity result for ${taskId} (${parity}, ${issues.length} issues)`);
    return data;
  } catch (err) {
    ctx.logger.warn(`Failed to rehydrate parity for ${taskId}: ${(err as Error).message}`);
    return undefined;
  }
}

// ─── Phase 4 Checkpoint Helpers ──────────────────────────────────────────

function getPhaseCursors(ctx: MigrationFlowContext) {
  const state = ctx.checkpoint.getState();
  state.phaseCursors ??= {};
  return state.phaseCursors;
}

export function getPhase4TaskState(ctx: MigrationFlowContext, taskId: string): { completedSubsteps: string[]; lastSuccessfulStep?: string } {
  const phaseCursors = getPhaseCursors(ctx);
  phaseCursors['4'] ??= { tasks: {} };
  phaseCursors['4'].tasks ??= {};
  phaseCursors['4'].tasks[taskId] ??= { completedSubsteps: [] };
  return phaseCursors['4'].tasks[taskId];
}

export function hasPhase4Substep(ctx: MigrationFlowContext, taskId: string, substep: string): boolean {
  return getPhase4TaskState(ctx, taskId).completedSubsteps.includes(substep);
}

export async function markPhase4Substep(ctx: MigrationFlowContext, taskId: string, substep: string): Promise<void> {
  const taskState = getPhase4TaskState(ctx, taskId);
  if (!taskState.completedSubsteps.includes(substep)) taskState.completedSubsteps.push(substep);
  taskState.lastSuccessfulStep = substep;
  await ctx.checkpoint.save(ctx.checkpoint.getState());
}

// Phase 5/6/7 cursors

export function getPhase5Cursor(ctx: MigrationFlowContext): { iteration: number; fixIndex: number; lastSuccessfulStep?: string; hadUnresolvedFixes?: boolean } {
  const phaseCursors = getPhaseCursors(ctx);
  phaseCursors['5'] ??= { iteration: 0, fixIndex: 0 };
  phaseCursors['5'].iteration ??= 0;
  phaseCursors['5'].fixIndex ??= 0;
  phaseCursors['5'].hadUnresolvedFixes ??= false;
  return phaseCursors['5'];
}

export async function savePhase5Cursor(ctx: MigrationFlowContext, cursor: { iteration: number; fixIndex: number; lastSuccessfulStep?: string; hadUnresolvedFixes?: boolean }): Promise<void> {
  getPhaseCursors(ctx)['5'] = cursor;
  await ctx.checkpoint.save(ctx.checkpoint.getState());
}

export function getPhase6Cursor(ctx: MigrationFlowContext): { completedAgents: string[]; completedSuites: string[]; lastSuccessfulStep?: string } {
  const phaseCursors = getPhaseCursors(ctx);
  phaseCursors['6'] ??= { completedAgents: [] };
  phaseCursors['6'].completedAgents ??= [];
  phaseCursors['6'].completedSuites ??= [];
  return phaseCursors['6'] as { completedAgents: string[]; completedSuites: string[]; lastSuccessfulStep?: string };
}

export async function savePhase6Cursor(ctx: MigrationFlowContext, cursor: { completedAgents: string[]; completedSuites?: string[]; lastSuccessfulStep?: string }): Promise<void> {
  getPhaseCursors(ctx)['6'] = cursor;
  await ctx.checkpoint.save(ctx.checkpoint.getState());
}

export function getPhase7Cursor(ctx: MigrationFlowContext): { iteration: number; issueIndex: number; currentFile?: string; lastSuccessfulStep?: string } {
  const phaseCursors = getPhaseCursors(ctx);
  phaseCursors['7'] ??= { iteration: 0, issueIndex: 0 };
  phaseCursors['7'].iteration ??= 0;
  phaseCursors['7'].issueIndex ??= 0;
  return phaseCursors['7'];
}

export async function savePhase7Cursor(ctx: MigrationFlowContext, cursor: { iteration: number; issueIndex: number; currentFile?: string; lastSuccessfulStep?: string }): Promise<void> {
  getPhaseCursors(ctx)['7'] = cursor;
  await ctx.checkpoint.save(ctx.checkpoint.getState());
}
