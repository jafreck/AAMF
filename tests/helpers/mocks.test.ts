import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createMockLauncher,
  createFailingLauncher,
  MockAgentLauncher,
  createMockConfig,
  makeTask,
} from './mocks.js';
import type { AgentInvocation } from '../../src/agents/types.js';

function makeInvocation(overrides?: Partial<AgentInvocation>): AgentInvocation {
  return {
    agent: 'code-migrator',
    contextPath: '/tmp/context.json',
    outputPath: '/tmp/output',
    phase: 5,
    workItemId: 'task-001',
    ...overrides,
  };
}

// ─── createMockLauncher ───────────────────────────────────────────────────────

describe('createMockLauncher', () => {
  it('should return a successful AgentResult by default', async () => {
    const launcher = createMockLauncher();
    const inv = makeInvocation();
    const result = await launcher(inv);
    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.agent).toBe('code-migrator');
    expect(result.workItemId).toBe('task-001');
  });

  it('should include outputParsed: false by default', async () => {
    const launcher = createMockLauncher();
    const result = await launcher(makeInvocation());
    expect(result.extensions.outputParsed).toBe(false);
  });

  it('should include tokenUsage by default', async () => {
    const launcher = createMockLauncher();
    const result = await launcher(makeInvocation());
    expect(result.tokenUsage).toBeDefined();
    expect(result.tokenUsage!.input + result.tokenUsage!.output).toBeGreaterThan(0);
  });

  it('should apply per-agent object overrides', async () => {
    const launcher = createMockLauncher({
      'code-migrator': { extensions: { outputParsed: true, structuredOutput: { key: 'val' } } },
    });
    const result = await launcher(makeInvocation({ agent: 'code-migrator' }));
    expect(result.extensions.outputParsed).toBe(true);
    expect(result.extensions.structuredOutput).toEqual({ key: 'val' });
  });

  it('should not apply overrides for non-matching agents', async () => {
    const launcher = createMockLauncher({
      'parity-verifier': { extensions: { outputParsed: true } },
    });
    const result = await launcher(makeInvocation({ agent: 'code-migrator' }));
    expect(result.extensions.outputParsed).toBe(false);
  });

  it('should apply function overrides', async () => {
    const launcher = createMockLauncher((inv) => ({
      extensions: { outputParsed: true, structuredOutput: { agent: inv.agent } },
    }));
    const result = await launcher(makeInvocation({ agent: 'test-writer' }));
    expect(result.extensions.outputParsed).toBe(true);
    expect(result.extensions.structuredOutput?.['agent']).toBe('test-writer');
  });

  it('should support setting outputParsed: true via function override', async () => {
    const launcher = createMockLauncher(() => ({
      extensions: { outputParsed: true, structuredOutput: { status: 'done' } },
    }));
    const result = await launcher(makeInvocation());
    expect(result.extensions.outputParsed).toBe(true);
    expect(result.extensions.structuredOutput).toEqual({ status: 'done' });
  });

  it('should support setting parseError via function override', async () => {
    const launcher = createMockLauncher(() => ({
      extensions: { outputParsed: false, parseError: 'missing aamf-json block' },
    }));
    const result = await launcher(makeInvocation());
    expect(result.extensions.outputParsed).toBe(false);
    expect(result.extensions.parseError).toBe('missing aamf-json block');
  });
});

// ─── createFailingLauncher ────────────────────────────────────────────────────

describe('createFailingLauncher', () => {
  it('should return failure for listed agents', async () => {
    const launcher = createFailingLauncher(['code-migrator']);
    const result = await launcher(makeInvocation({ agent: 'code-migrator' }));
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.error).toBe('Agent failed');
  });

  it('should return success for non-listed agents', async () => {
    const launcher = createFailingLauncher(['parity-verifier']);
    const result = await launcher(makeInvocation({ agent: 'code-migrator' }));
    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it('should use a custom error message when provided', async () => {
    const launcher = createFailingLauncher(['test-writer'], 'Custom error');
    const result = await launcher(makeInvocation({ agent: 'test-writer' }));
    expect(result.error).toBe('Custom error');
  });

  it('should preserve outputParsed: false for failed agents', async () => {
    const launcher = createFailingLauncher(['code-migrator']);
    const result = await launcher(makeInvocation({ agent: 'code-migrator' }));
    expect(result.extensions.outputParsed).toBe(false);
  });
});

// ─── MockAgentLauncher ────────────────────────────────────────────────────────

describe('MockAgentLauncher', () => {
  it('should track invocations', async () => {
    const fn = createMockLauncher();
    const mock = new MockAgentLauncher(fn);
    const inv = makeInvocation();
    await mock.launchAgent(inv);
    expect(mock.invocations).toHaveLength(1);
    expect(mock.invocations[0]).toBe(inv);
  });

  it('should accumulate multiple invocations', async () => {
    const fn = createMockLauncher();
    const mock = new MockAgentLauncher(fn);
    await mock.launchAgent(makeInvocation({ agent: 'code-migrator' }));
    await mock.launchAgent(makeInvocation({ agent: 'test-writer' }));
    expect(mock.invocations).toHaveLength(2);
    expect(mock.invocations[1]?.agent).toBe('test-writer');
  });

  it('should return the result from the underlying function', async () => {
    const fn = createMockLauncher(() => ({ extensions: { outputParsed: true } }));
    const mock = new MockAgentLauncher(fn);
    const result = await mock.launchAgent(makeInvocation());
    expect(result.extensions.outputParsed).toBe(true);
  });

  it('getResolvedPath should return undefined', () => {
    const mock = new MockAgentLauncher(createMockLauncher());
    expect(mock.getResolvedPath()).toBeUndefined();
  });
});

// ─── createMockConfig ─────────────────────────────────────────────────────────

describe('createMockConfig', () => {
  it('should return a valid MigrationConfig', () => {
    const config = createMockConfig();
    expect(config.projectName).toBe('test-project');
    expect(config.source.language).toBe('python');
    expect(config.target.language).toBe('typescript');
    expect(config.options.maxParallelAgents).toBeGreaterThan(0);
    expect(config.options.dryRun).toBe(false);
  });

  it('should apply overrides', () => {
    const config = createMockConfig({ projectName: 'my-project' });
    expect(config.projectName).toBe('my-project');
  });

  it('should default keepArtifacts to false', () => {
    const config = createMockConfig();
    expect(config.options.keepArtifacts).toBe(false);
  });
});

// ─── makeTask ─────────────────────────────────────────────────────────────────

describe('makeTask', () => {
  it('should create a MigrationTask with the given id', () => {
    const task = makeTask('task-042');
    expect(task.id).toBe('task-042');
    expect(task.name).toBe('Task task-042');
    expect(task.sourceFiles).toContain('src/task-042.py');
    expect(task.targetFiles).toContain('src/task-042.ts');
  });

  it('should default to no dependencies', () => {
    const task = makeTask('task-001');
    expect(task.dependencies).toEqual([]);
  });

  it('should accept specified dependencies', () => {
    const task = makeTask('task-002', ['task-001']);
    expect(task.dependencies).toEqual(['task-001']);
  });
});
