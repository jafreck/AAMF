import { describe, it, expect } from 'vitest';
import type {
  AgentResult,
  AgentInvocation,
  AgentContext,
  MigrationTask,
  ModuleGroup,
  MigrationResult,
  PhaseResult,
  FailedTask,
  TaskDetails,
  McpServerConfig,
  InvocationMetric,
  ModelTier,
  RoutingDecision,
  RemediationContext,
  TerminalReasonCode,
} from '../../src/agents/types.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeBaseAgentResult(overrides?: Partial<AgentResult>): AgentResult {
  return {
    agent: 'code-migrator',
    exitCode: 0,
    success: true,
    outputFiles: [],
    duration: 100,
    outputParsed: false,
    ...overrides,
  };
}

// ─── AgentResult ──────────────────────────────────────────────────────────────

describe('AgentResult', () => {
  describe('outputParsed field', () => {
    it('should be false when output was not parsed', () => {
      const result = makeBaseAgentResult({ outputParsed: false });
      expect(result.outputParsed).toBe(false);
    });

    it('should be true when output was successfully parsed', () => {
      const result = makeBaseAgentResult({ outputParsed: true });
      expect(result.outputParsed).toBe(true);
    });
  });

  describe('structuredOutput field', () => {
    it('should be undefined when not provided', () => {
      const result = makeBaseAgentResult();
      expect(result.structuredOutput).toBeUndefined();
    });

    it('should hold arbitrary key-value data when parsed successfully', () => {
      const structured = { tasks: ['task-001', 'task-002'], count: 2 };
      const result = makeBaseAgentResult({
        outputParsed: true,
        structuredOutput: structured,
      });
      expect(result.structuredOutput).toEqual(structured);
      expect(result.structuredOutput?.['tasks']).toEqual(['task-001', 'task-002']);
      expect(result.structuredOutput?.['count']).toBe(2);
    });

    it('should support nested objects', () => {
      const nested = { meta: { version: '1.0', phase: 3 } };
      const result = makeBaseAgentResult({
        outputParsed: true,
        structuredOutput: nested,
      });
      expect(result.structuredOutput?.['meta']).toEqual({ version: '1.0', phase: 3 });
    });
  });

  describe('parseError field', () => {
    it('should be undefined when not provided', () => {
      const result = makeBaseAgentResult();
      expect(result.parseError).toBeUndefined();
    });

    it('should carry an error message when output parsing failed', () => {
      const result = makeBaseAgentResult({
        outputParsed: false,
        parseError: 'No aamf-json block found in agent output',
      });
      expect(result.parseError).toBe('No aamf-json block found in agent output');
    });
  });

  describe('combination: successful parse', () => {
    it('should have outputParsed=true, structuredOutput set, and no parseError', () => {
      const result = makeBaseAgentResult({
        outputParsed: true,
        structuredOutput: { key: 'value' },
      });
      expect(result.outputParsed).toBe(true);
      expect(result.structuredOutput).toBeDefined();
      expect(result.parseError).toBeUndefined();
    });
  });

  describe('combination: failed parse', () => {
    it('should have outputParsed=false, no structuredOutput, and parseError set', () => {
      const result = makeBaseAgentResult({
        outputParsed: false,
        parseError: 'Malformed JSON in aamf-json block',
      });
      expect(result.outputParsed).toBe(false);
      expect(result.structuredOutput).toBeUndefined();
      expect(result.parseError).toBe('Malformed JSON in aamf-json block');
    });
  });

  describe('stderr field', () => {
    it('should be undefined when not provided', () => {
      const result = makeBaseAgentResult();
      expect(result.stderr).toBeUndefined();
    });

    it('should carry raw stderr output when set', () => {
      const result = makeBaseAgentResult({ stderr: 'raw error line\nanother line' });
      expect(result.stderr).toBe('raw error line\nanother line');
    });

    it('should be independent from the error field', () => {
      const result = makeBaseAgentResult({
        error: 'Formatted error message',
        stderr: 'raw process output with stack trace',
      });
      expect(result.error).toBe('Formatted error message');
      expect(result.stderr).toBe('raw process output with stack trace');
    });

    it('should allow stderr without error field', () => {
      const result = makeBaseAgentResult({ stderr: 'some warning output' });
      expect(result.stderr).toBe('some warning output');
      expect(result.error).toBeUndefined();
    });
  });

  describe('invocationId field', () => {
    it('should be undefined when not provided', () => {
      const result = makeBaseAgentResult();
      expect(result.invocationId).toBeUndefined();
    });

    it('should carry a correlation identifier when set', () => {
      const result = makeBaseAgentResult({ invocationId: 'inv-abc-123' });
      expect(result.invocationId).toBe('inv-abc-123');
    });
  });

  describe('queueDelay field', () => {
    it('should be undefined when not provided', () => {
      const result = makeBaseAgentResult();
      expect(result.queueDelay).toBeUndefined();
    });

    it('should carry milliseconds spent in queue', () => {
      const result = makeBaseAgentResult({ queueDelay: 250 });
      expect(result.queueDelay).toBe(250);
    });

    it('should accept zero for immediate execution', () => {
      const result = makeBaseAgentResult({ queueDelay: 0 });
      expect(result.queueDelay).toBe(0);
    });
  });

  describe('spawnToFirstOutput field', () => {
    it('should be undefined when not provided', () => {
      const result = makeBaseAgentResult();
      expect(result.spawnToFirstOutput).toBeUndefined();
    });

    it('should carry milliseconds from spawn to first output', () => {
      const result = makeBaseAgentResult({ spawnToFirstOutput: 1500 });
      expect(result.spawnToFirstOutput).toBe(1500);
    });

    it('should accept zero for immediate output', () => {
      const result = makeBaseAgentResult({ spawnToFirstOutput: 0 });
      expect(result.spawnToFirstOutput).toBe(0);
    });
  });

  describe('combination: all duration breakdown fields', () => {
    it('should carry invocationId with queueDelay and spawnToFirstOutput', () => {
      const result = makeBaseAgentResult({
        invocationId: 'inv-full',
        queueDelay: 50,
        spawnToFirstOutput: 800,
        duration: 5000,
      });
      expect(result.invocationId).toBe('inv-full');
      expect(result.queueDelay).toBe(50);
      expect(result.spawnToFirstOutput).toBe(800);
      expect(result.duration).toBe(5000);
    });
  });

  describe('existing fields', () => {
    it('should include required fields: agent, exitCode, success, outputFiles, duration', () => {
      const result = makeBaseAgentResult();
      expect(result.agent).toBe('code-migrator');
      expect(result.exitCode).toBe(0);
      expect(result.success).toBe(true);
      expect(result.outputFiles).toEqual([]);
      expect(result.duration).toBe(100);
    });

    it('should support optional taskId, tokenUsage, and error fields', () => {
      const result = makeBaseAgentResult({
        taskId: 'task-001',
        tokenUsage: { prompt: 100, completion: 50, total: 150 },
        error: 'agent stderr',
      });
      expect(result.taskId).toBe('task-001');
      expect(result.tokenUsage?.total).toBe(150);
      expect(result.error).toBe('agent stderr');
    });
  });
});

// ─── AgentInvocation ─────────────────────────────────────────────────────────

describe('AgentInvocation', () => {
  it('should construct with required fields only', () => {
    const inv: AgentInvocation = {
      agent: 'impact-assessor',
      contextFile: '/tmp/context.json',
      progressDir: '/tmp/progress',
    };
    expect(inv.agent).toBe('impact-assessor');
    expect(inv.contextFile).toBe('/tmp/context.json');
    expect(inv.progressDir).toBe('/tmp/progress');
    expect(inv.phase).toBeUndefined();
    expect(inv.taskId).toBeUndefined();
    expect(inv.timeout).toBeUndefined();
  });

  it('should support all optional fields', () => {
    const inv: AgentInvocation = {
      agent: 'code-migrator',
      contextFile: '/tmp/context.json',
      progressDir: '/tmp/progress',
      phase: 3,
      taskId: 'task-001',
      additionalArgs: { '--dry-run': 'true' },
      timeout: 60_000,
    };
    expect(inv.phase).toBe(3);
    expect(inv.taskId).toBe('task-001');
    expect(inv.additionalArgs?.['--dry-run']).toBe('true');
    expect(inv.timeout).toBe(60_000);
  });

  it('should accept failure-adjudicator as a valid agent name', () => {
    const inv: AgentInvocation = {
      agent: 'failure-adjudicator',
      contextFile: '/tmp/context.json',
      progressDir: '/tmp/progress',
    };
    expect(inv.agent).toBe('failure-adjudicator');
  });

  it('should support optional mcpConfig field', () => {
    const mcpConfig: McpServerConfig = {
      url: 'http://localhost:4321/mcp',
    };
    const inv: AgentInvocation = {
      agent: 'impact-assessor',
      contextFile: '/tmp/context.json',
      progressDir: '/tmp/progress',
      mcpConfig,
    };
    expect(inv.mcpConfig).toBeDefined();
    expect(inv.mcpConfig?.url).toBe('http://localhost:4321/mcp');
  });

  it('should omit mcpConfig when not provided', () => {
    const inv: AgentInvocation = {
      agent: 'knowledge-builder',
      contextFile: '/tmp/ctx.json',
      progressDir: '/tmp/progress',
    };
    expect(inv.mcpConfig).toBeUndefined();
  });

  it('should support optional routing, retry, and correlation fields', () => {
    const inv: AgentInvocation = {
      agent: 'code-migrator',
      contextFile: '/tmp/context.json',
      progressDir: '/tmp/progress',
      modelOverride: 'gpt-4.1',
      kbDbPath: '/tmp/progress/kb.sqlite',
      invocationId: 'inv-123',
      routingTier: 'critical',
      routingReason: 'retry escalation at attempt 2',
      attemptNumber: 2,
      maxAttempts: 3,
    };
    expect(inv.modelOverride).toBe('gpt-4.1');
    expect(inv.kbDbPath).toBe('/tmp/progress/kb.sqlite');
    expect(inv.invocationId).toBe('inv-123');
    expect(inv.routingTier).toBe('critical');
    expect(inv.routingReason).toContain('escalation');
    expect(inv.attemptNumber).toBe(2);
    expect(inv.maxAttempts).toBe(3);
  });
});

// ─── McpServerConfig ──────────────────────────────────────────────────────────

describe('McpServerConfig', () => {
  it('should require a url field', () => {
    const cfg: McpServerConfig = {
      url: 'http://localhost:4321/mcp',
    };
    expect(cfg.url).toBe('http://localhost:4321/mcp');
  });

  it('should accept any localhost URL', () => {
    const cfg: McpServerConfig = {
      url: 'http://127.0.0.1:9999/mcp',
    };
    expect(cfg.url).toContain('9999');
  });
});

// ─── AgentContext ─────────────────────────────────────────────────────────────

describe('AgentContext', () => {
  it('should construct with all required fields', () => {
    const ctx: AgentContext = {
      agent: 'knowledge-builder',
      projectName: 'my-project',
      phase: 2,
      config: {
        source: { path: '/src', language: 'python' },
        target: { language: 'typescript', outputPath: '/out' },
      },
      inputFiles: ['src/foo.py'],
      outputPath: '/out',
    };
    expect(ctx.agent).toBe('knowledge-builder');
    expect(ctx.phase).toBe(2);
    expect(ctx.config.source.language).toBe('python');
    expect(ctx.taskId).toBeUndefined();
    expect(ctx.payload).toBeUndefined();
  });
});

// ─── MigrationTask ────────────────────────────────────────────────────────────

describe('MigrationTask', () => {
  it('should construct with all required fields', () => {
    const task: MigrationTask = {
      id: 'task-001',
      name: 'Migrate auth module',
      sourceFiles: ['src/auth.py'],
      targetFiles: ['src/auth.ts'],
      knowledgeBaseRef: 'kb/auth.md',
      dependencies: [],
      complexity: 'moderate',
      description: 'Migrates the auth module',
      acceptanceCriteria: ['tests pass'],
      parityChecks: ['check-auth'],
    };
    expect(task.id).toBe('task-001');
    expect(task.complexity).toBe('moderate');
    expect(task.lineRange).toBeUndefined();
    expect(task.parentTaskId).toBeUndefined();
  });

  it('should support optional parentTaskId field', () => {
    const task: MigrationTask = {
      id: 'task-001a',
      name: 'Sub-task of auth module',
      sourceFiles: ['src/auth.py'],
      targetFiles: ['src/auth.ts'],
      knowledgeBaseRef: 'kb/auth.md',
      dependencies: [],
      complexity: 'simple',
      description: 'Sub-task created via replanning',
      acceptanceCriteria: ['tests pass'],
      parityChecks: ['check-auth'],
      parentTaskId: 'task-001',
    };
    expect(task.parentTaskId).toBe('task-001');
  });

  it('should accept all complexity values', () => {
    const complexities: MigrationTask['complexity'][] = ['simple', 'moderate', 'complex'];
    for (const complexity of complexities) {
      const task: MigrationTask = {
        id: 'task-x',
        name: 'Task',
        sourceFiles: [],
        targetFiles: [],
        knowledgeBaseRef: '',
        dependencies: [],
        complexity,
        description: '',
        acceptanceCriteria: [],
        parityChecks: [],
      };
      expect(task.complexity).toBe(complexity);
    }
  });
});

// ─── ModuleGroup ──────────────────────────────────────────────────────────────

describe('ModuleGroup', () => {
  it('should construct with required fields', () => {
    const group: ModuleGroup = {
      id: 'core',
      name: 'Core Modules',
      analysisFiles: ['/tmp/progress/knowledge-base/core.md'],
    };
    expect(group.id).toBe('core');
    expect(group.name).toBe('Core Modules');
    expect(group.analysisFiles).toEqual(['/tmp/progress/knowledge-base/core.md']);
    expect(group.description).toBeUndefined();
  });

  it('should support an optional description field', () => {
    const group: ModuleGroup = {
      id: 'api',
      name: 'API',
      analysisFiles: ['/tmp/progress/knowledge-base/api.md'],
      description: 'External API surface modules',
    };
    expect(group.description).toBe('External API surface modules');
  });
});

// ─── FailedTask ───────────────────────────────────────────────────────────────

describe('FailedTask', () => {
  it('should construct with all required fields', () => {
    const failed: FailedTask = {
      taskId: 'task-001',
      attempts: 2,
      lastError: 'Process exited with code 1',
      recoveryAttempted: false,
    };
    expect(failed.taskId).toBe('task-001');
    expect(failed.attempts).toBe(2);
    expect(failed.recoveryAttempted).toBe(false);
  });
});

// ─── MigrationResult ─────────────────────────────────────────────────────────

describe('MigrationResult', () => {
  function makeBaseMigrationResult(overrides?: Partial<MigrationResult>): MigrationResult {
    return {
      success: true,
      projectName: 'test-project',
      phases: [],
      totalDuration: 1000,
      tokenUsage: { total: 0, byPhase: {}, byAgent: {} },
      failedTasks: [],
      blockedTasks: [],
      ...overrides,
    };
  }

  it('should construct with required fields and no cumulativeDuration', () => {
    const result = makeBaseMigrationResult();
    expect(result.success).toBe(true);
    expect(result.projectName).toBe('test-project');
    expect(result.totalDuration).toBe(1000);
    expect(result.cumulativeDuration).toBeUndefined();
  });

  it('should accept cumulativeDuration when provided', () => {
    const result = makeBaseMigrationResult({ cumulativeDuration: 5000 });
    expect(result.cumulativeDuration).toBe(5000);
  });

  it('should accept cumulativeDuration of 0', () => {
    const result = makeBaseMigrationResult({ cumulativeDuration: 0 });
    expect(result.cumulativeDuration).toBe(0);
  });

  it('should represent accumulated duration across multiple resume runs', () => {
    // Simulate three resume runs of 1000ms each
    const result = makeBaseMigrationResult({ cumulativeDuration: 3000 });
    expect(result.cumulativeDuration).toBe(3000);
    expect(result.totalDuration).toBe(1000); // current run only
  });

  it('should allow cumulativeDuration to be omitted (optional field)', () => {
    const result: MigrationResult = {
      success: false,
      projectName: 'failing-project',
      phases: [],
      totalDuration: 500,
      tokenUsage: { total: 100, byPhase: { 1: 100 }, byAgent: { 'code-migrator': 100 } },
      failedTasks: ['task-001'],
      blockedTasks: ['task-002'],
    };
    expect(result.cumulativeDuration).toBeUndefined();
  });
});

// ─── TaskDetails ──────────────────────────────────────────────────────────────

describe('TaskDetails', () => {
  it('should allow all fields to be optional', () => {
    const details: TaskDetails = {};
    expect(details.sourceFiles).toBeUndefined();
    expect(details.targetFiles).toBeUndefined();
    expect(details.parityScore).toBeUndefined();
    expect(details.testsGenerated).toBeUndefined();
    expect(details.error).toBeUndefined();
  });

  it('should hold a parityScore between 0 and 1', () => {
    const details: TaskDetails = { parityScore: 0.95 };
    expect(details.parityScore).toBe(0.95);
  });
});

// ─── InvocationMetric ─────────────────────────────────────────────────────────

describe('InvocationMetric', () => {
  function makeBaseMetric(overrides?: Partial<InvocationMetric>): InvocationMetric {
    return {
      runId: 'run-001',
      phase: 4,
      taskId: 'task-001',
      agentType: 'code-migrator',
      invocationId: 'inv-abc-123',
      startTime: '2026-02-27T06:00:00.000Z',
      endTime: '2026-02-27T06:00:05.000Z',
      durationMs: 5000,
      attemptNumber: 1,
      maxAttempts: 3,
      wasRetry: false,
      status: 'success',
      model: 'claude-opus-4',
      tokensPrompt: 1000,
      tokensCompletion: 500,
      tokensTotal: 1500,
      costUsd: 0.045,
      ...overrides,
    };
  }

  it('should construct with all 17 required fields', () => {
    const metric = makeBaseMetric();
    expect(metric.runId).toBe('run-001');
    expect(metric.phase).toBe(4);
    expect(metric.taskId).toBe('task-001');
    expect(metric.agentType).toBe('code-migrator');
    expect(metric.invocationId).toBe('inv-abc-123');
    expect(metric.startTime).toBe('2026-02-27T06:00:00.000Z');
    expect(metric.endTime).toBe('2026-02-27T06:00:05.000Z');
    expect(metric.durationMs).toBe(5000);
    expect(metric.attemptNumber).toBe(1);
    expect(metric.maxAttempts).toBe(3);
    expect(metric.wasRetry).toBe(false);
    expect(metric.status).toBe('success');
    expect(metric.model).toBe('claude-opus-4');
    expect(metric.tokensPrompt).toBe(1000);
    expect(metric.tokensCompletion).toBe(500);
    expect(metric.tokensTotal).toBe(1500);
    expect(metric.costUsd).toBe(0.045);
  });

  it('should accept status "success"', () => {
    const metric = makeBaseMetric({ status: 'success' });
    expect(metric.status).toBe('success');
  });

  it('should accept status "failed"', () => {
    const metric = makeBaseMetric({ status: 'failed' });
    expect(metric.status).toBe('failed');
  });

  it('should accept status "cancelled"', () => {
    const metric = makeBaseMetric({ status: 'cancelled' });
    expect(metric.status).toBe('cancelled');
  });

  it('should represent a retry with wasRetry true and attemptNumber > 1', () => {
    const metric = makeBaseMetric({ wasRetry: true, attemptNumber: 2 });
    expect(metric.wasRetry).toBe(true);
    expect(metric.attemptNumber).toBe(2);
  });

  it('should allow zero tokens and zero cost', () => {
    const metric = makeBaseMetric({
      tokensPrompt: 0,
      tokensCompletion: 0,
      tokensTotal: 0,
      costUsd: 0,
    });
    expect(metric.tokensTotal).toBe(0);
    expect(metric.costUsd).toBe(0);
  });

  it('should accept optional routingTier field', () => {
    const metric = makeBaseMetric({ routingTier: 'heavy' });
    expect(metric.routingTier).toBe('heavy');
  });

  it('should accept optional routingReason field', () => {
    const metric = makeBaseMetric({ routingReason: 'high complexity score' });
    expect(metric.routingReason).toBe('high complexity score');
  });

  it('should accept optional escalationCostUsd field', () => {
    const metric = makeBaseMetric({ escalationCostUsd: 0.12 });
    expect(metric.escalationCostUsd).toBe(0.12);
  });

  it('should leave routing fields undefined when not provided', () => {
    const metric = makeBaseMetric();
    expect(metric.routingTier).toBeUndefined();
    expect(metric.routingReason).toBeUndefined();
    expect(metric.escalationCostUsd).toBeUndefined();
  });
});

// ─── ModelTier ─────────────────────────────────────────────────────────────────

describe('ModelTier', () => {
  it('should accept all three tier values', () => {
    const tiers: ModelTier[] = ['normal', 'heavy', 'critical'];
    expect(tiers).toEqual(['normal', 'heavy', 'critical']);
  });
});

// ─── Remediation Contracts ────────────────────────────────────────────────────

describe('RemediationContext', () => {
  it('should include failure kind, summary, target context, artifacts, and success condition', () => {
    const remediation: RemediationContext = {
      failureKind: 'parity',
      failureSummary: 'Normalized parity mismatch on auth flow',
      failureTarget: { wave: 2, taskId: 'task-001', check: 'auth-parity-check' },
      artifactPaths: ['progress/parity-reports/task-001.md', 'src/auth.py'],
      expectedSuccessCondition: 'Parity checker returns minor-or-better delta',
    };
    expect(remediation.failureKind).toBe('parity');
    expect(remediation.failureSummary).toContain('Normalized parity mismatch');
    expect(remediation.failureTarget.wave).toBe(2);
    expect(remediation.failureTarget.taskId).toBe('task-001');
    expect(remediation.failureTarget.check).toBe('auth-parity-check');
    expect(remediation.artifactPaths).toContain('src/auth.py');
    expect(remediation.expectedSuccessCondition).toContain('Parity checker');
  });
});

describe('TerminalReasonCode', () => {
  it('should cover canonical terminal exhaustion reason codes', () => {
    const codes: TerminalReasonCode[] = [
      'wave-convergence-exhausted',
      'task-retries-exhausted',
      'parity-non-minor-exhausted',
      'command-recovery-exhausted',
      'replanned',
    ];
    expect(codes).toEqual([
      'wave-convergence-exhausted',
      'task-retries-exhausted',
      'parity-non-minor-exhausted',
      'command-recovery-exhausted',
      'replanned',
    ]);
  });
});

// ─── RoutingDecision ──────────────────────────────────────────────────────────

describe('RoutingDecision', () => {
  it('should construct with all required fields', () => {
    const decision: RoutingDecision = {
      tier: 'heavy',
      selectedModel: 'claude-opus-4.5',
      reason: 'complexity score exceeded heavy threshold',
      score: 55,
      escalated: false,
    };
    expect(decision.tier).toBe('heavy');
    expect(decision.selectedModel).toBe('claude-opus-4.5');
    expect(decision.reason).toBe('complexity score exceeded heavy threshold');
    expect(decision.score).toBe(55);
    expect(decision.escalated).toBe(false);
  });

  it('should represent an escalated decision', () => {
    const decision: RoutingDecision = {
      tier: 'critical',
      selectedModel: 'claude-opus-4.6',
      reason: 'retry escalation at attempt 2',
      score: 80,
      escalated: true,
    };
    expect(decision.escalated).toBe(true);
  });
});
