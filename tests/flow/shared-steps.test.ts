import { describe, it, expect } from 'vitest';
import {
  classifyError,
  MigrationError,
  TerminalExhaustionError,
  assertPhaseSuccess,
  normalizeFailureSummary,
  isTransientModelFailure,
  getConfiguredRuntimeModel,
  getRuntimeTimeout,
  getPhaseTimeout,
  getQualityGateMode,
  isGitAutomationEnabled,
  getFailureRecoveryModel,
  getDefaultRoutingModel,
  selectModelForInvocation,
  applyRoutingCaps,
  checkBudget,
  taskScopePayload,
  buildRemediationContext,
  AVG_TOKENS_PER_TASK,
  RETRY_OVERHEAD_MULTIPLIER,
} from '../../src/flow/steps/shared.js';
import type { MigrationFlowContext } from '../../src/flow/context.js';
import type { MigrationTask } from '../../src/agents/types.js';

// ─── Minimal mock context factory ────────────────────────────────────────────

function mockContext(overrides: Record<string, unknown> = {}): MigrationFlowContext {
  const defaults: Record<string, unknown> = {
    config: {
      projectName: 'test-project',
      source: { path: '/src', language: 'python' },
      target: { language: 'typescript', outputPath: '/out', framework: 'node' },
      agentBackend: { runtime: 'copilot', model: 'claude-sonnet-4', timeout: 300_000 },
      options: {
        git: { enabled: false },
        modelRouting: { enabled: false },
        qualityPolicy: 'strict',
        ...(overrides.options ?? {}),
      },
    },
    logger: {
      info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
      event: () => {}, setPhase: () => {},
    },
    tokenTracker: {
      getTotal: () => overrides.tokenTotal ?? 0,
      checkThreshold: (budget: number) => {
        const total = (overrides.tokenTotal ?? 0) as number;
        if (total > budget) return 'exceeded';
        if (total > budget * 0.8) return 'warning';
        return 'ok';
      },
      record: () => {},
      toCheckpointData: () => ({}),
    },
    costEstimator: {
      projectCost: (_model: string, _tokens: number) => ({ total: 0.01 }),
    },
    routedTaskIds: new Set<string>(),
    escalationCostUsd: 0,
    checkpoint: { getState: () => ({}), save: async () => {} },
    paths: { root: '/tmp/test', kbDbFile: '/tmp/test/kb.db' },
    kbServer: undefined,
    launcher: { getResolvedPath: () => undefined },
    gitLimiter: async (fn: () => unknown) => fn(),
  };

  // Deep merge config.options
  if (overrides.options) {
    (defaults.config as Record<string, unknown>).options = {
      ...((defaults.config as Record<string, unknown>).options as Record<string, unknown>),
      ...(overrides.options as Record<string, unknown>),
    };
    delete overrides.options;
  }

  // Deep merge config.agentBackend
  if (overrides.agentBackend) {
    (defaults.config as Record<string, unknown>).agentBackend = {
      ...((defaults.config as Record<string, unknown>).agentBackend as Record<string, unknown>),
      ...(overrides.agentBackend as Record<string, unknown>),
    };
    delete overrides.agentBackend;
  }

  return { ...defaults, ...overrides } as unknown as MigrationFlowContext;
}

function mockTask(overrides: Partial<MigrationTask> = {}): MigrationTask {
  return {
    id: 'task-001',
    name: 'Auth Module',
    sourceFiles: ['src/auth.py'],
    targetFiles: ['src/auth.ts'],
    knowledgeBaseRef: 'kb/auth.md',
    dependencies: [],
    complexity: 'moderate',
    description: 'Migrate auth',
    acceptanceCriteria: ['works'],
    parityChecks: ['matches'],
    lineRange: { start: 1, end: 200 },
    ...overrides,
  };
}

// ─── Constants ───────────────────────────────────────────────────────────────

describe('Constants', () => {
  it('should export AVG_TOKENS_PER_TASK as 100_000', () => {
    expect(AVG_TOKENS_PER_TASK).toBe(100_000);
  });

  it('should export RETRY_OVERHEAD_MULTIPLIER as 1.25', () => {
    expect(RETRY_OVERHEAD_MULTIPLIER).toBe(1.25);
  });
});

// ─── classifyError ───────────────────────────────────────────────────────────

describe('classifyError', () => {
  it('should return undefined for normal errors', () => {
    expect(classifyError('TypeError: undefined is not a function')).toBeUndefined();
  });

  it.each([
    ['blocking waiting for file lock on artifact', 'file-lock'],
    ['could not acquire lock on file', 'file-lock'],
    ['process killed by signal: killed', 'process-killed'],
    ['out of memory', 'oom'],
    ['Cannot allocate memory', 'oom'],
    ['no space left on device', 'disk-full'],
    ['ENOSPC', 'disk-full'],
    ['read-only file system', 'fs-readonly'],
    ['connection refused', 'network'],
    ['DNS resolution failed', 'network'],
    ['HTTP/2 GOAWAY', 'network'],
    ['503 service unavailable', 'network'],
    ['timed out', 'timeout'],
    ['deadline exceeded', 'timeout'],
    ['permission denied', 'permission'],
    ['EACCES', 'permission'],
  ])('should classify "%s" as %s', (input, expected) => {
    expect(classifyError(input)).toBe(expected);
  });
});

// ─── assertPhaseSuccess ──────────────────────────────────────────────────────

describe('assertPhaseSuccess', () => {
  it('should not throw for successful result', () => {
    expect(() => assertPhaseSuccess({ phase: 0, name: 'KB Indexing', success: true, duration: 100 })).not.toThrow();
  });

  it('should throw MigrationError for failed result', () => {
    const result = { phase: 3, name: 'KB Construction', success: false, duration: 100, error: 'build failed' };
    expect(() => assertPhaseSuccess(result)).toThrow(MigrationError);
  });
});

// ─── MigrationError ──────────────────────────────────────────────────────────

describe('MigrationError', () => {
  it('should construct with phase, name, and result', () => {
    const result = { phase: 3, name: 'KB Construction', success: false, duration: 100, error: 'something' };
    const err = new MigrationError(3, 'KB Construction', result);
    expect(err.phaseId).toBe(3);
    expect(err.phaseName).toBe('KB Construction');
    expect(err.result).toBe(result);
    expect(err.message).toContain('Phase 3');
    expect(err.message).toContain('something');
    expect(err.name).toBe('MigrationError');
  });
});

// ─── normalizeFailureSummary ─────────────────────────────────────────────────

describe('normalizeFailureSummary', () => {
  it('should collapse whitespace and trim', () => {
    expect(normalizeFailureSummary('  error  in\n  line  42  ')).toBe('error in line 42');
  });

  it('should truncate to 240 characters', () => {
    const long = 'a'.repeat(300);
    expect(normalizeFailureSummary(long).length).toBe(240);
  });
});

// ─── isTransientModelFailure ─────────────────────────────────────────────────

describe('isTransientModelFailure', () => {
  it.each([
    '503 Service Unavailable',
    'HTTP/2 GOAWAY received',
    'connection_error',
    'Failed to get response from the AI model',
    'service unavailable',
  ])('should detect "%s" as transient', (input) => {
    expect(isTransientModelFailure(input)).toBe(true);
  });

  it('should return false for non-transient errors', () => {
    expect(isTransientModelFailure('TypeError: something')).toBe(false);
    expect(isTransientModelFailure('invalid JSON')).toBe(false);
  });
});

// ─── Context helper functions ────────────────────────────────────────────────

describe('getConfiguredRuntimeModel', () => {
  it('should return config model', () => {
    const ctx = mockContext();
    expect(getConfiguredRuntimeModel(ctx)).toBe('claude-sonnet-4');
  });

  it('should fallback to claude-sonnet-4 when no model configured', () => {
    const ctx = mockContext({ agentBackend: { runtime: 'copilot', model: undefined, timeout: 300_000 } });
    expect(getConfiguredRuntimeModel(ctx)).toBe('claude-sonnet-4');
  });
});

describe('getRuntimeTimeout', () => {
  it('should return the configured timeout', () => {
    const ctx = mockContext();
    expect(getRuntimeTimeout(ctx)).toBe(300_000);
  });
});

describe('getPhaseTimeout', () => {
  it('should return runtime timeout when no phase-specific timeout', () => {
    const ctx = mockContext();
    expect(getPhaseTimeout(ctx, 3)).toBe(300_000);
  });

  it('should return phase-specific timeout when configured', () => {
    const ctx = mockContext({ agentBackend: { runtime: 'copilot', model: 'claude-sonnet-4', timeout: 300_000, phaseTimeouts: { 5: 600_000 } } });
    expect(getPhaseTimeout(ctx, 5)).toBe(600_000);
    expect(getPhaseTimeout(ctx, 3)).toBe(300_000);
  });
});

describe('getQualityGateMode', () => {
  it('should return enforce for strict policy', () => {
    const ctx = mockContext({ options: { qualityPolicy: 'strict' } });
    expect(getQualityGateMode(ctx)).toBe('enforce');
  });

  it('should return advisory for balanced policy', () => {
    const ctx = mockContext({ options: { qualityPolicy: 'balanced' } });
    expect(getQualityGateMode(ctx)).toBe('advisory');
  });

  it('should return advisory for deferred-strict policy', () => {
    const ctx = mockContext({ options: { qualityPolicy: 'deferred-strict' } });
    expect(getQualityGateMode(ctx)).toBe('advisory');
  });

  it('should return skip for unknown policy', () => {
    const ctx = mockContext({ options: { qualityPolicy: 'off' } });
    expect(getQualityGateMode(ctx)).toBe('skip');
  });
});

describe('isGitAutomationEnabled', () => {
  it('should return false when git is not enabled', () => {
    const ctx = mockContext();
    expect(isGitAutomationEnabled(ctx)).toBe(false);
  });

  it('should return true when git.enabled is true', () => {
    const ctx = mockContext({ options: { git: { enabled: true } } });
    expect(isGitAutomationEnabled(ctx)).toBe(true);
  });
});

describe('getFailureRecoveryModel', () => {
  it('should return undefined when not configured', () => {
    const ctx = mockContext();
    expect(getFailureRecoveryModel(ctx)).toBeUndefined();
  });

  it('should return the configured model', () => {
    const ctx = mockContext({ agentBackend: { runtime: 'copilot', model: 'claude-sonnet-4', timeout: 300_000, failureRecoveryModel: 'claude-opus-4' } });
    expect(getFailureRecoveryModel(ctx)).toBe('claude-opus-4');
  });
});

describe('getDefaultRoutingModel', () => {
  it('should use routing defaultModel when routing is configured', () => {
    const ctx = mockContext({ options: { modelRouting: { enabled: true, defaultModel: 'gpt-4o' } } });
    expect(getDefaultRoutingModel(ctx)).toBe('gpt-4o');
  });

  it('should fall back to agentBackend model', () => {
    const ctx = mockContext();
    expect(getDefaultRoutingModel(ctx)).toBe('claude-sonnet-4');
  });
});

// ─── Model Routing ───────────────────────────────────────────────────────────

describe('selectModelForInvocation', () => {
  it('should return normal when routing is disabled', () => {
    const ctx = mockContext();
    const result = selectModelForInvocation(ctx, undefined, 'code-migrator');
    expect(result.tier).toBe('normal');
    expect(result.reason).toBe('routing-disabled');
  });

  it('should score based on task complexity', () => {
    const routing = {
      enabled: true, defaultModel: 'base', criticalModel: 'critical',
      heavyModel: 'heavy', criticalThreshold: 60, heavyThreshold: 30,
      criticalTaskPatterns: [], criticalAgents: [],
      maxCriticalTasks: 10, maxEscalationCostUsd: 100,
    };
    const ctx = mockContext({ options: { modelRouting: routing } });
    const simple = mockTask({ complexity: 'simple', sourceFiles: ['a.py'], targetFiles: ['a.ts'], dependencies: [] });
    const complex = mockTask({ complexity: 'complex', sourceFiles: Array(10).fill('a.py'), targetFiles: Array(10).fill('a.ts'), dependencies: Array(10).fill('dep') });

    const simpleResult = selectModelForInvocation(ctx, simple, 'code-migrator');
    const complexResult = selectModelForInvocation(ctx, complex, 'code-migrator');

    expect(complexResult.score).toBeGreaterThan(simpleResult.score);
  });

  it('should route to critical for task matching criticalTaskPatterns', () => {
    const routing = {
      enabled: true, defaultModel: 'base', criticalModel: 'opus',
      heavyModel: 'heavy', criticalThreshold: 60, heavyThreshold: 30,
      criticalTaskPatterns: ['task-auth-*'], criticalAgents: [],
      maxCriticalTasks: 10, maxEscalationCostUsd: 100,
    };
    const ctx = mockContext({ options: { modelRouting: routing } });
    const task = mockTask({ id: 'task-auth-001' });
    const result = selectModelForInvocation(ctx, task, 'code-migrator');
    expect(result.tier).toBe('critical');
    expect(result.reason).toBe('critical-task-pattern');
  });

  it('should route to critical for agents in criticalAgents list', () => {
    const routing = {
      enabled: true, defaultModel: 'base', criticalModel: 'opus',
      heavyModel: 'heavy', criticalThreshold: 60, heavyThreshold: 30,
      criticalTaskPatterns: [], criticalAgents: ['adjudicator'],
      maxCriticalTasks: 10, maxEscalationCostUsd: 100,
    };
    const ctx = mockContext({ options: { modelRouting: routing } });
    const result = selectModelForInvocation(ctx, undefined, 'adjudicator');
    expect(result.tier).toBe('critical');
    expect(result.reason).toBe('critical-agent');
  });
});

describe('applyRoutingCaps', () => {
  it('should pass through normal tier decisions', () => {
    const ctx = mockContext();
    const decision = { tier: 'normal' as const, selectedModel: 'base', reason: 'score-normal', score: 10, escalated: false };
    expect(applyRoutingCaps(ctx, decision)).toBe(decision);
  });

  it('should cap when maxCriticalTasks is exceeded', () => {
    const routing = {
      enabled: true, defaultModel: 'base', criticalModel: 'opus',
      heavyModel: 'heavy', criticalThreshold: 60, heavyThreshold: 30,
      criticalTaskPatterns: [], criticalAgents: [],
      maxCriticalTasks: 1, maxEscalationCostUsd: 100,
    };
    const ctx = mockContext({ options: { modelRouting: routing } });
    // Already have one routed task
    ctx.routedTaskIds.add('task-existing');
    const decision = { tier: 'critical' as const, selectedModel: 'opus', reason: 'score-critical', score: 70, escalated: false };
    const result = applyRoutingCaps(ctx, decision, 'task-new');
    expect(result.tier).toBe('normal');
    expect(result.reason).toContain('capped-max-tasks');
  });
});

// ─── checkBudget ─────────────────────────────────────────────────────────────

describe('checkBudget', () => {
  it('should return true when no budget configured', () => {
    const ctx = mockContext();
    expect(checkBudget(ctx)).toBe(true);
  });

  it('should return true when under budget', () => {
    const ctx = mockContext({ options: { tokenBudget: 1_000_000 }, tokenTotal: 100_000 });
    expect(checkBudget(ctx)).toBe(true);
  });

  it('should return false when budget is exceeded', () => {
    const ctx = mockContext({ options: { tokenBudget: 100_000 }, tokenTotal: 200_000 });
    expect(checkBudget(ctx)).toBe(false);
  });
});

// ─── taskScopePayload ────────────────────────────────────────────────────────

describe('taskScopePayload', () => {
  it('should produce expected payload with taskScope wrapper', () => {
    const task = mockTask();
    const payload = taskScopePayload(task);
    expect(payload).toHaveProperty('taskScope');
    const scope = (payload as any).taskScope;
    expect(scope).toHaveProperty('description', 'Migrate auth');
    expect(scope).toHaveProperty('acceptanceCriteria');
    expect(scope).toHaveProperty('parityChecks');
    expect(scope).toHaveProperty('lineRange');
  });
});

// ─── buildRemediationContext ─────────────────────────────────────────────────

describe('buildRemediationContext', () => {
  it('should build from failure input', () => {
    const ctx = buildRemediationContext({
      failureKind: 'compile-error',
      failureSummary: 'Build failed on line 42',
      taskId: 'task-001',
      wave: 1,
      check: 'build',
      artifactPaths: ['/out/task-001.ts', '/out/task-001.ts'],
      expectedSuccessCondition: 'builds without errors',
    });

    expect(ctx.failureKind).toBe('compile-error');
    expect(ctx.failureSummary).toBe('Build failed on line 42');
    expect(ctx.failureTarget.taskId).toBe('task-001');
    expect(ctx.failureTarget.wave).toBe(1);
    // Deduplicates artifact paths
    expect(ctx.artifactPaths).toEqual(['/out/task-001.ts']);
  });
});
