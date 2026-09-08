/**
 * AgentLauncher tests — post-framework-consolidation.
 *
 * CLI argument construction, env stripping, token parsing, and process
 * spawning are now handled by the @cadre-dev/framework AgentLauncher.
 * These tests cover only AAMF's wrapper layer:
 *   - BackendRuntimeConfig construction
 *   - Post-processing (aamf-json parsing, copilot events, output detection)
 *   - Invocation delay logic
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { AgentLauncher, buildBackendRuntimeConfig, toFrameworkInvocation, registerAamfCopilotBackend } from '../../src/core/agent-launcher.js';
import { createMockConfig, createSilentLogger } from '../helpers/mocks.js';
import type { AgentInvocation } from '../../src/agents/types.js';
import { TokenTracker } from '../../src/budget/token-tracker.js';
import { CostEstimator } from '../../src/budget/cost-estimator.js';

describe('buildBackendRuntimeConfig', () => {
  it('should map copilot runtime to "copilot" backend', () => {
    const config = createMockConfig({ agentBackend: { runtime: 'copilot', cliCommand: 'copilot', timeout: 300_000 } });
    const rtConfig = buildBackendRuntimeConfig(config);
    expect(rtConfig.agent.backend).toBe('copilot');
    expect(rtConfig.agent.timeout).toBe(300_000);
  });

  it('should map claude-code runtime to "claude" backend', () => {
    const config = createMockConfig({ agentBackend: { runtime: 'claude-code', cliCommand: 'claude', timeout: 600_000 } });
    const rtConfig = buildBackendRuntimeConfig(config);
    expect(rtConfig.agent.backend).toBe('claude');
    expect(rtConfig.agent.timeout).toBe(600_000);
  });

  it('should pass through model', () => {
    const config = createMockConfig({ models: { default: 'gpt-4.1' }, agentBackend: { runtime: 'copilot', timeout: 300_000 } });
    const rtConfig = buildBackendRuntimeConfig(config);
    expect(rtConfig.agent.model).toBe('gpt-4.1');
  });

  it('should include copilot cliCommand for copilot backend', () => {
    const config = createMockConfig({
      agentBackend: { runtime: 'copilot', cliCommand: '/usr/local/bin/copilot', agentDir: '.github/agents', timeout: 300_000 },
    });
    const rtConfig = buildBackendRuntimeConfig(config);
    expect(rtConfig.agent.copilot?.cliCommand).toBe('/usr/local/bin/copilot');
    expect(rtConfig.agent.copilot?.agentDir).toBe('.github/agents');
    expect(rtConfig.agent.copilot?.allowAllPaths).toBe(true);
    expect(rtConfig.agent.copilot?.allowAllTools).toBe(true);
  });

  it('should include claude cliCommand for claude backend', () => {
    const config = createMockConfig({
      agentBackend: { runtime: 'claude-code', cliCommand: '/usr/local/bin/claude', timeout: 300_000 },
    });
    const rtConfig = buildBackendRuntimeConfig(config);
    expect(rtConfig.agent.claude?.cliCommand).toBe('/usr/local/bin/claude');
  });

  it('should pass through environment extraPath', () => {
    const config = createMockConfig({
      environment: { extraPath: ['/usr/local/bin', '/opt/bin'] },
    });
    const rtConfig = buildBackendRuntimeConfig(config);
    expect(rtConfig.environment.extraPath).toEqual(['/usr/local/bin', '/opt/bin']);
  });
});

describe('toFrameworkInvocation', () => {
  function baseInvocation(overrides?: Partial<AgentInvocation>): AgentInvocation {
    return {
      agent: 'code-migrator',
      contextPath: '/tmp/context.json',
      outputPath: '/tmp/output',
      phase: 4,
      workItemId: 'task-001',
      ...overrides,
    };
  }

  it('should map basic fields without mcpServers when no extensions', () => {
    const inv = baseInvocation();
    const fw = toFrameworkInvocation(inv);
    expect(fw.agent).toBe('code-migrator');
    expect(fw.workItemId).toBe('task-001');
    expect(fw.phase).toBe(4);
    expect(fw.contextPath).toBe('/tmp/context.json');
    expect(fw.outputPath).toBe('/tmp/output');
    expect((fw as any).mcpServers).toBeUndefined();
  });

  it('should include aamf-kb mcpServer when mcpConfig is set', () => {
    const inv = baseInvocation({
      extensions: { mcpConfig: { url: 'http://localhost:3000/mcp' } },
    });
    const fw = toFrameworkInvocation(inv);
    expect((fw as any).mcpServers).toEqual({
      'aamf-kb': { type: 'http', url: 'http://localhost:3000/mcp' },
    });
  });

  it('should include aamf-kb-target mcpServer when targetMcpConfig is set', () => {
    const inv = baseInvocation({
      extensions: { targetMcpConfig: { url: 'http://localhost:3001/mcp' } },
    });
    const fw = toFrameworkInvocation(inv);
    expect((fw as any).mcpServers).toEqual({
      'aamf-kb-target': { type: 'http', url: 'http://localhost:3001/mcp' },
    });
  });

  it('should include both mcpServers when both configs are set', () => {
    const inv = baseInvocation({
      extensions: {
        mcpConfig: { url: 'http://localhost:3000/mcp' },
        targetMcpConfig: { url: 'http://localhost:3001/mcp' },
      },
    });
    const fw = toFrameworkInvocation(inv);
    expect((fw as any).mcpServers).toEqual({
      'aamf-kb': { type: 'http', url: 'http://localhost:3000/mcp' },
      'aamf-kb-target': { type: 'http', url: 'http://localhost:3001/mcp' },
    });
  });

  it('should default workItemId to empty string when undefined', () => {
    const inv = baseInvocation({ workItemId: undefined });
    const fw = toFrameworkInvocation(inv);
    expect(fw.workItemId).toBe('');
  });

  it('should preserve a per-invocation model override', () => {
    const fw = toFrameworkInvocation(baseInvocation({ modelOverride: 'gpt-5.6' }));
    expect(fw.modelOverride).toBe('gpt-5.6');
  });
});

describe('AgentLauncher token usage post-processing', () => {
  async function createHarness(configOverrides?: Parameters<typeof createMockConfig>[0]) {
    const tempDir = await mkdtemp(join(tmpdir(), 'aamf-agent-launcher-'));
    const contextPath = join(tempDir, 'context.json');
    const outputDir = join(tempDir, 'out');
    await mkdir(outputDir);
    await writeFile(join(outputDir, 'artifact.txt'), 'artifact', 'utf-8');
    await writeFile(contextPath, JSON.stringify({ outputPath: outputDir }), 'utf-8');

    const config = createMockConfig({
      projectName: 'launcher-test',
      source: { path: tempDir },
      target: { outputPath: join(tempDir, 'target') },
      ...configOverrides,
    });
    const logger = createSilentLogger(tempDir);
    const launcher = new AgentLauncher(config, tempDir, logger);

    return {
      contextPath,
      launcher,
      tempDir,
    };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should estimate token usage when the framework reports zero tokens', async () => {
    const { launcher, contextPath } = await createHarness();
    const launchAgent = vi.fn().mockResolvedValue({
      exitCode: 0,
      success: true,
      timedOut: false,
      duration: 100,
      stdout: 'Agent output with useful content\n```aamf-json\n{"status":"completed"}\n```',
      stderr: '',
      tokenUsage: 0,
      outputPath: '',
      outputExists: true,
    });
    (launcher as any).frameworkLauncher = { init: vi.fn(), launchAgent };

    const result = await launcher.launchAgent({
      agent: 'knowledge-builder',
      contextPath,
      outputPath: '',
      phase: 2,
      workItemId: '',
    });

    expect(result.tokenUsage).not.toBeNull();
    expect(result.tokenUsage?.input).toBeGreaterThan(0);
    expect(result.tokenUsage?.output).toBe(0);
  });

  it('should extract token usage from Copilot JSONL result events', async () => {
    const { launcher, contextPath } = await createHarness();
    const stdout = [
      JSON.stringify({
        type: 'assistant.message',
        data: { content: '```aamf-json\n{"status":"completed","tokenUsage":{"prompt":1,"completion":2,"total":3}}\n```' },
      }),
      JSON.stringify({
        type: 'result',
        data: {
          exitCode: 0,
          usage: {
            inputTokens: 1200,
            outputTokens: 300,
            cachedInputTokens: 100,
            premiumRequests: 2,
          },
        },
      }),
    ].join('\n');
    const launchAgent = vi.fn().mockResolvedValue({
      exitCode: 0,
      success: true,
      timedOut: false,
      duration: 100,
      stdout,
      stderr: '',
      tokenUsage: 0,
      outputPath: '',
      outputExists: true,
    });
    (launcher as any).frameworkLauncher = { init: vi.fn(), launchAgent };

    const result = await launcher.launchAgent({
      agent: 'migration-planner',
      contextPath,
      outputPath: '',
      phase: 3,
      workItemId: '',
    });

    expect(result.tokenUsage).toEqual({ input: 1200, output: 300, cachedInput: 100 });
    expect(result.extensions.tokenUsageSource).toBe('copilot-jsonl');
    expect(result.extensions.premiumRequests).toBe(2);
  });

  it('should use structured token usage only when no measured usage exists', async () => {
    const { launcher, contextPath } = await createHarness();
    const launchAgent = vi.fn().mockResolvedValue({
      exitCode: 0,
      success: true,
      timedOut: false,
      duration: 100,
      stdout: '```aamf-json\n{"status":"completed","tokenUsage":{"prompt":700,"completion":80,"total":780}}\n```',
      stderr: '',
      tokenUsage: null,
      outputPath: '',
      outputExists: true,
    });
    (launcher as any).frameworkLauncher = { init: vi.fn(), launchAgent };

    const result = await launcher.launchAgent({
      agent: 'knowledge-builder', contextPath, outputPath: '', phase: 2, workItemId: '',
    });

    expect(result.tokenUsage).toEqual({ input: 700, output: 80 });
    expect(result.extensions.tokenUsageSource).toBe('agent-reported');
  });

  it('should preserve meaningful backend usage over conflicting agent-reported usage', async () => {
    const { launcher, contextPath } = await createHarness();
    const launchAgent = vi.fn().mockResolvedValue({
      exitCode: 0,
      success: true,
      timedOut: false,
      duration: 100,
      stdout: '```aamf-json\n{"status":"completed","tokenUsage":{"prompt":1,"completion":2}}\n```',
      stderr: '',
      tokenUsage: { input: 900, output: 90, cachedInput: 45 },
      outputPath: '',
      outputExists: true,
    });
    (launcher as any).frameworkLauncher = { init: vi.fn(), launchAgent };

    const result = await launcher.launchAgent({
      agent: 'knowledge-builder', contextPath, outputPath: '', phase: 2, workItemId: '',
    });

    expect(result.tokenUsage).toEqual({ input: 900, output: 90, cachedInput: 45 });
    expect(result.extensions.tokenUsageSource).toBe('backend');

    const tracker = new TokenTracker();
    tracker.record('knowledge-builder', 2, result.tokenUsage!.input + result.tokenUsage!.output);
    expect(tracker.checkThreshold(500)).toBe('exceeded');

    const estimator = new CostEstimator();
    const measuredCost = estimator.estimate('gpt-5', result.tokenUsage!.input, result.tokenUsage!.output).total;
    const selfReportedCost = estimator.estimate('gpt-5', 1, 2).total;
    expect(measuredCost).toBeGreaterThan(selfReportedCost);
  });

  it('should normalize numeric backend usage before considering fallback sources', async () => {
    const { launcher, contextPath } = await createHarness();
    const launchAgent = vi.fn().mockResolvedValue({
      exitCode: 0,
      success: true,
      timedOut: false,
      duration: 100,
      stdout: '```aamf-json\n{"status":"completed","tokenUsage":{"input":1,"output":2}}\n```',
      stderr: '',
      tokenUsage: 77,
      outputPath: '',
      outputExists: true,
    });
    (launcher as any).frameworkLauncher = { init: vi.fn(), launchAgent };

    const result = await launcher.launchAgent({
      agent: 'knowledge-builder', contextPath, outputPath: '', phase: 2, workItemId: '',
    });

    expect(result.tokenUsage).toEqual({ input: 77, output: 0 });
    expect(result.extensions.tokenUsageSource).toBe('backend');
  });

  it('should prefer Copilot CLI summaries over conflicting structured usage', async () => {
    const { launcher, contextPath } = await createHarness();
    const launchAgent = vi.fn().mockResolvedValue({
      exitCode: 0,
      success: true,
      timedOut: false,
      duration: 100,
      stdout: [
        '```aamf-json',
        '{"status":"completed","tokenUsage":{"prompt":1,"completion":2,"total":3}}',
        '```',
        'Breakdown by AI model:',
        'gpt-5.6: 1.2k in, 300 out, 100 cached (Est. 2 Premium requests)',
      ].join('\n'),
      stderr: '',
      tokenUsage: null,
      outputPath: '',
      outputExists: true,
    });
    (launcher as any).frameworkLauncher = { init: vi.fn(), launchAgent };

    const result = await launcher.launchAgent({
      agent: 'knowledge-builder', contextPath, outputPath: '', phase: 2, workItemId: '',
    });

    expect(result.tokenUsage).toEqual({ input: 1200, output: 300, cachedInput: 100 });
    expect(result.extensions.tokenUsageSource).toBe('cli-parsed');
    expect(result.extensions.premiumRequests).toBe(2);
  });

  it('should parse Claude CLI usage when the Claude backend is selected', async () => {
    const { launcher, contextPath } = await createHarness({
      agentBackend: { runtime: 'claude-code', cliCommand: 'claude' },
    });
    const launchAgent = vi.fn().mockResolvedValue({
      exitCode: 0,
      success: true,
      timedOut: false,
      duration: 100,
      stdout: '```aamf-json\n{"status":"completed","tokenUsage":{"prompt":1,"completion":2,"total":3}}\n```',
      stderr: '{"usage":{"input_tokens":321,"output_tokens":45,"cache_read_input_tokens":12}}',
      tokenUsage: null,
      outputPath: '',
      outputExists: true,
    });
    (launcher as any).frameworkLauncher = { init: vi.fn(), launchAgent };

    const result = await launcher.launchAgent({
      agent: 'knowledge-builder', contextPath, outputPath: '', phase: 2, workItemId: '',
    });

    expect(result.tokenUsage).toEqual({ input: 321, output: 45, cachedInput: 12 });
    expect(result.extensions.tokenUsageSource).toBe('cli-parsed');
  });

  it('should parse Copilot CLI --output-format json usage with top-level usage fields', async () => {
    const { launcher, contextPath } = await createHarness();
    const stdout = [
      JSON.stringify({
        type: 'assistant.message',
        data: { content: 'Migrating code...\n```aamf-json\n{"status":"completed"}\n```' },
      }),
      JSON.stringify({
        type: 'result',
        data: {
          exitCode: 0,
          usage: {
            input: 5000,
            output: 1200,
          },
        },
      }),
    ].join('\n');
    const launchAgent = vi.fn().mockResolvedValue({
      exitCode: 0,
      success: true,
      timedOut: false,
      duration: 200,
      stdout,
      stderr: '',
      tokenUsage: null,
      outputPath: '',
      outputExists: true,
    });
    (launcher as any).frameworkLauncher = { init: vi.fn(), launchAgent };

    const result = await launcher.launchAgent({
      agent: 'code-migrator',
      contextPath,
      outputPath: '',
      phase: 5,
      workItemId: 'task-1',
    });

    expect(result.tokenUsage).toEqual({ input: 5000, output: 1200 });
  });

  it('should reconstruct deltas and audit tool calls, error events, and top-level result fields', async () => {
    const { launcher, contextPath } = await createHarness();
    const stdout = [
      'non-json diagnostic',
      JSON.stringify(7),
      JSON.stringify({ type: 'assistant.message', data: { outputTokens: 25 } }),
      JSON.stringify({
        type: 'assistant.message_delta',
        data: { deltaContent: '```aamf-json\n{"status":"completed"}\n```' },
      }),
      JSON.stringify({ type: 'assistant.tool_call', data: { toolName: 'read_file' } }),
      JSON.stringify({ type: 'assistant.tool_call_result', data: { toolName: 'read_file' } }),
      JSON.stringify({ type: 'assistant.tool_call_result', data: { toolName: 'grep_search', status: 'failed' } }),
      JSON.stringify({ type: 'error', data: { message: 'recoverable event' } }),
      JSON.stringify({
        type: 'result',
        exitCode: 0,
        usage: {
          input_tokens: 444,
          output_tokens: 55,
          tokens_cached: 22,
          premiumRequests: 3,
          totalApiDurationMs: 12,
          sessionDurationMs: 34,
          codeChanges: { linesAdded: 2, linesRemoved: 1, filesModified: ['src/a.ts'] },
        },
      }),
    ].join('\n');
    const launchAgent = vi.fn().mockResolvedValue({
      exitCode: 0,
      success: true,
      timedOut: false,
      duration: 100,
      stdout,
      stderr: '',
      tokenUsage: null,
      outputPath: '',
      outputExists: true,
    });
    (launcher as any).frameworkLauncher = { init: vi.fn(), launchAgent };

    const result = await launcher.launchAgent({
      agent: 'migration-planner', contextPath, outputPath: '', phase: 3, workItemId: '',
    });

    expect(result.tokenUsage).toEqual({ input: 444, output: 55, cachedInput: 22 });
    expect(result.extensions.tokenUsageSource).toBe('copilot-jsonl');
    expect(result.extensions.premiumRequests).toBe(3);
    expect(result.extensions.copilotEvents).toMatchObject({
      totalEvents: 7,
      errorCount: 1,
      toolCalls: [
        { name: 'read_file', status: 'called' },
        { name: 'read_file', status: 'completed' },
        { name: 'grep_search', status: 'failed' },
      ],
      resultSummary: {
        exitCode: 0,
        totalApiDurationMs: 12,
        sessionDurationMs: 34,
        codeChanges: { linesAdded: 2, linesRemoved: 1, filesModified: ['src/a.ts'] },
      },
    });
  });

  it('parses structured output from the Claude JSON result envelope', async () => {
    const { launcher, contextPath } = await createHarness({
      agentBackend: { runtime: 'claude-code', cliCommand: 'claude' },
    });
    const stdout = JSON.stringify({
      result: '```aamf-json\n{"status":"completed","fixes":[]}\n```',
    });
    (launcher as any).frameworkLauncher = {
      init: vi.fn(),
      launchAgent: vi.fn().mockResolvedValue({
        exitCode: 0, success: true, timedOut: false, duration: 1,
        stdout, stderr: '', tokenUsage: null, outputPath: '', outputExists: false,
      }),
    };

    const result = await launcher.launchAgent({
      agent: 'final-parity-checker', contextPath, outputPath: '', phase: 5, workItemId: '',
    });

    expect(result.success).toBe(true);
    expect(result.extensions.outputParsed).toBe(true);
    expect(result.extensions.structuredOutput?.fixes).toEqual([]);
  });

  it('should fall back to accumulated assistant output tokens in JSONL', async () => {
    const { launcher, contextPath } = await createHarness();
    const stdout = [
      JSON.stringify({
        type: 'assistant.message',
        data: {
          content: '```aamf-json\n{"status":"completed"}\n```',
          outputTokens: 42,
        },
      }),
      JSON.stringify({ type: 'result', data: { exitCode: 0 } }),
    ].join('\n');
    const launchAgent = vi.fn().mockResolvedValue({
      exitCode: 0,
      success: true,
      timedOut: false,
      duration: 100,
      stdout,
      stderr: '',
      tokenUsage: null,
      outputPath: '',
      outputExists: true,
    });
    (launcher as any).frameworkLauncher = { init: vi.fn(), launchAgent };

    const result = await launcher.launchAgent({
      agent: 'knowledge-builder', contextPath, outputPath: '', phase: 2, workItemId: '',
    });

    expect(result.tokenUsage).toEqual({ input: 0, output: 42 });
    expect(result.extensions.tokenUsageSource).toBe('copilot-jsonl');
  });

  it('should reject both missing and invalid structured output', async () => {
    const { launcher, contextPath } = await createHarness();
    const launchAgent = vi.fn()
      .mockResolvedValueOnce({
        exitCode: 0,
        success: true,
        timedOut: false,
        duration: 100,
        stdout: 'plain agent output',
        stderr: '',
        tokenUsage: null,
        outputPath: '',
        outputExists: false,
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        success: true,
        timedOut: false,
        duration: 100,
        stdout: '```aamf-json\n{"status":"not-a-valid-status"}\n```',
        stderr: '',
        tokenUsage: null,
        outputPath: '',
        outputExists: false,
      });
    (launcher as any).frameworkLauncher = { init: vi.fn(), launchAgent };
    const invocation: AgentInvocation = {
      agent: 'knowledge-builder', contextPath, outputPath: '', phase: 2, workItemId: '',
    };

    const missing = await launcher.launchAgent(invocation);
    const invalid = await launcher.launchAgent(invocation);

    expect(missing.success).toBe(false);
    expect(missing.extensions.outputParsed).toBe(false);
    expect(missing.extensions.parseError).toBe('missing aamf-json block');
    expect(missing.extensions.failureKind).toBe('structured-output');
    expect(invalid.success).toBe(false);
    expect(invalid.extensions.outputParsed).toBe(false);
    expect(invalid.extensions.parseError).toBeTruthy();
    expect(invalid.error).toContain('aamf-json parse failed');
  });

  it('preserves transient process diagnostics when structured output is missing', async () => {
    const { launcher, contextPath } = await createHarness();
    (launcher as any).frameworkLauncher = {
      init: vi.fn(),
      launchAgent: vi.fn().mockResolvedValue({
        exitCode: 1,
        success: false,
        timedOut: false,
        duration: 1,
        stdout: '',
        stderr: '503 service unavailable',
        tokenUsage: { input: 1, output: 1 },
        outputPath: '',
        outputExists: false,
        error: '503 service unavailable',
      }),
    };

    const result = await launcher.launchAgent({
      agent: 'code-migrator', contextPath, outputPath: '', phase: 4, workItemId: 'task-001',
    });

    expect(result.success).toBe(false);
    expect(result.extensions.failureKind).toBe('process');
    expect(result.error).toContain('503 service unavailable');
    expect(result.error).toContain('aamf-json parse failed');
  });

  it.each([
    {
      name: 'accepts exit zero plus completed output and a required artifact',
      agent: 'knowledge-builder' as const,
      exitCode: 0,
      processSuccess: true,
      stdout: '```aamf-json\n{"status":"completed"}\n```',
      removeArtifact: false,
      expectedSuccess: true,
      expectedFailureKind: undefined,
    },
    {
      name: 'rejects a nonzero process result even when structured output says completed',
      agent: 'knowledge-builder' as const,
      exitCode: 1,
      processSuccess: false,
      stdout: '```aamf-json\n{"status":"completed"}\n```',
      removeArtifact: false,
      expectedSuccess: false,
      expectedFailureKind: 'process',
    },
    {
      name: 'rejects structured failed status after exit zero',
      agent: 'knowledge-builder' as const,
      exitCode: 0,
      processSuccess: true,
      stdout: '```aamf-json\n{"status":"failed"}\n```',
      removeArtifact: false,
      expectedSuccess: false,
      expectedFailureKind: 'structured-output',
    },
    {
      name: 'routes needs-review as an explicit non-success outcome',
      agent: 'knowledge-builder' as const,
      exitCode: 0,
      processSuccess: true,
      stdout: '```aamf-json\n{"status":"needs-review"}\n```',
      removeArtifact: false,
      expectedSuccess: false,
      expectedFailureKind: 'review-required',
    },
    {
      name: 'rejects a completed artifact-producing agent without an artifact',
      agent: 'knowledge-builder' as const,
      exitCode: 0,
      processSuccess: true,
      stdout: '```aamf-json\n{"status":"completed"}\n```',
      removeArtifact: true,
      expectedSuccess: false,
      expectedFailureKind: 'required-artifact',
    },
    {
      name: 'accepts a structured-only agent without an artifact',
      agent: 'final-parity-checker' as const,
      exitCode: 0,
      processSuccess: true,
      stdout: '```aamf-json\n{"status":"completed","fixes":[]}\n```',
      removeArtifact: true,
      expectedSuccess: true,
      expectedFailureKind: undefined,
    },
    {
      name: 'accepts an adjudicator decision without a filesystem artifact',
      agent: 'adjudicator' as const,
      exitCode: 0,
      processSuccess: true,
      stdout: '```aamf-json\n{"status":"completed","outputFiles":[]}\n```',
      removeArtifact: true,
      expectedSuccess: true,
      expectedFailureKind: undefined,
    },
    {
      name: 'accepts parity scope reduction without a filesystem artifact',
      agent: 'parity-failure-resolver' as const,
      exitCode: 0,
      processSuccess: true,
      stdout: '```aamf-json\n{"status":"completed","scopeReduced":true,"outputFiles":[]}\n```',
      removeArtifact: true,
      expectedSuccess: true,
      expectedFailureKind: undefined,
    },
  ])('$name', async ({
    agent, exitCode, processSuccess, stdout, removeArtifact,
    expectedSuccess, expectedFailureKind,
  }) => {
    const { launcher, contextPath, tempDir } = await createHarness();
    if (removeArtifact) {
      await writeFile(contextPath, JSON.stringify({ outputPath: join(tempDir, 'missing-output') }), 'utf-8');
    }
    (launcher as any).frameworkLauncher = {
      init: vi.fn(),
      launchAgent: vi.fn().mockImplementation(async () => {
        if (!removeArtifact) {
          await writeFile(join(tempDir, 'out', 'artifact.txt'), `invocation-${Date.now()}`);
        }
        return {
        exitCode,
        success: processSuccess,
        timedOut: false,
        duration: 1,
        stdout,
        stderr: processSuccess ? '' : 'process failed',
        tokenUsage: { input: 1, output: 1 },
        outputPath: '',
        outputExists: !removeArtifact,
        };
      }),
    };

    const result = await launcher.launchAgent({
      agent,
      contextPath,
      outputPath: '',
      phase: agent === 'final-parity-checker' ? 5 : 2,
      workItemId: '',
    });

    expect(result.success).toBe(expectedSuccess);
    expect(result.extensions.failureKind).toBe(expectedFailureKind);
    expect(result.extensions.reviewRequired).toBe(
      expectedFailureKind === 'review-required' ? true : undefined,
    );
  });

  it('should discover directory and file outputs declared by the context', async () => {
    const { launcher, contextPath, tempDir } = await createHarness();
    const outputDir = join(tempDir, 'out');
    const outputFile = join(tempDir, 'single-output.json');
    let callCount = 0;
    const launchAgent = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        await Promise.all([
          writeFile(join(outputDir, 'a.json'), '{}'),
          writeFile(join(outputDir, 'b.json'), '{}'),
        ]);
      } else {
        await writeFile(outputFile, '{}');
      }
      return {
      exitCode: 0,
      success: true,
      timedOut: false,
      duration: 100,
      stdout: '```aamf-json\n{"status":"completed"}\n```',
      stderr: '',
      tokenUsage: { input: 1, output: 1 },
      outputPath: '',
      outputExists: true,
      };
    });
    (launcher as any).frameworkLauncher = { init: vi.fn(), launchAgent };
    const invocation: AgentInvocation = {
      agent: 'knowledge-builder', contextPath, outputPath: '', phase: 2, workItemId: '',
    };

    const directoryResult = await launcher.launchAgent(invocation);
    expect(directoryResult.extensions.outputFiles).toEqual(expect.arrayContaining([
      join(outputDir, 'a.json'),
      join(outputDir, 'b.json'),
    ]));

    await writeFile(contextPath, JSON.stringify({ outputPath: outputFile }));
    const fileResult = await launcher.launchAgent(invocation);
    expect(fileResult.extensions.outputFiles).toEqual([outputFile]);
  });

  it('attributes a test-writer file outside targetFiles when the agent declares it', async () => {
    const { launcher, contextPath, tempDir } = await createHarness();
    const targetRoot = join(tempDir, 'target');
    const applicationFile = join(targetRoot, 'src', 'auth.ts');
    const testFile = join(targetRoot, 'tests', 'auth.test.ts');
    const concurrentFile = join(targetRoot, 'tests', 'concurrent.test.ts');
    await mkdir(join(targetRoot, 'src'), { recursive: true });
    await mkdir(join(targetRoot, 'tests'), { recursive: true });
    await writeFile(applicationFile, 'export const auth = true;\n');
    await writeFile(contextPath, JSON.stringify({
      agent: 'test-writer',
      outputPath: targetRoot,
      config: { target: { outputPath: targetRoot } },
      payload: { targetFiles: ['src/auth.ts'] },
    }));
    (launcher as any).frameworkLauncher = {
      init: vi.fn(),
      launchAgent: vi.fn().mockImplementation(async () => {
        await Promise.all([
          writeFile(testFile, 'test auth\n'),
          writeFile(concurrentFile, 'unrelated concurrent output\n'),
        ]);
        return {
          exitCode: 0,
          success: true,
          timedOut: false,
          duration: 1,
          stdout: '```aamf-json\n{"status":"completed","outputFiles":["tests/auth.test.ts"]}\n```',
          stderr: '',
          tokenUsage: { input: 1, output: 1 },
          outputPath: targetRoot,
          outputExists: true,
        };
      }),
    };

    const result = await launcher.launchAgent({
      agent: 'test-writer', contextPath, outputPath: targetRoot, phase: 4, workItemId: 'task-001',
    });

    expect(result.success).toBe(true);
    expect(result.extensions.outputFiles).toEqual([testFile]);
  });

  it('does not attribute another idiomatic task file to an unchanged refactor task', async () => {
    const { launcher, contextPath, tempDir } = await createHarness();
    const targetRoot = join(tempDir, 'target');
    const taskFile = join(targetRoot, 'src', 'task.ts');
    const siblingFile = join(targetRoot, 'src', 'sibling.ts');
    await mkdir(join(targetRoot, 'src'), { recursive: true });
    await Promise.all([
      writeFile(taskFile, 'export const task = 1;\n'),
      writeFile(siblingFile, 'export const sibling = 1;\n'),
    ]);
    await writeFile(contextPath, JSON.stringify({
      agent: 'idiomatic-refactorer',
      outputPath: targetRoot,
      config: { target: { outputPath: targetRoot } },
      payload: { task: { files: ['src/task.ts'] } },
    }));
    (launcher as any).frameworkLauncher = {
      init: vi.fn(),
      launchAgent: vi.fn().mockImplementation(async () => {
        await writeFile(siblingFile, 'export const sibling = 200;\n');
        return {
          exitCode: 0,
          success: true,
          timedOut: false,
          duration: 1,
          stdout: '```aamf-json\n{"status":"completed","outputFiles":["src/sibling.ts"]}\n```',
          stderr: '',
          tokenUsage: { input: 1, output: 1 },
          outputPath: targetRoot,
          outputExists: true,
        };
      }),
    };

    const result = await launcher.launchAgent({
      agent: 'idiomatic-refactorer', contextPath, outputPath: targetRoot, phase: 7, workItemId: 'idiom-001',
    });

    expect(result.success).toBe(false);
    expect(result.extensions.failureKind).toBe('required-artifact');
    expect(result.extensions.outputFiles).toEqual([]);
  });

  it('does not accept pre-existing scaffold files as invocation artifacts', async () => {
    const { launcher, contextPath } = await createHarness();
    (launcher as any).frameworkLauncher = {
      init: vi.fn(),
      launchAgent: vi.fn().mockResolvedValue({
        exitCode: 0,
        success: true,
        timedOut: false,
        duration: 1,
        stdout: '```aamf-json\n{"status":"completed"}\n```',
        stderr: '',
        tokenUsage: { input: 1, output: 1 },
        outputPath: '',
        outputExists: true,
      }),
    };

    const result = await launcher.launchAgent({
      agent: 'knowledge-builder', contextPath, outputPath: '', phase: 2, workItemId: '',
    });

    expect(result.success).toBe(false);
    expect(result.extensions.failureKind).toBe('required-artifact');
    expect(result.extensions.outputFiles).toEqual([]);
  });

  it('should tolerate an unreadable context while detecting output files', async () => {
    const { launcher, contextPath } = await createHarness();
    await writeFile(contextPath, '{not-json');
    const launchAgent = vi.fn().mockResolvedValue({
      exitCode: 0,
      success: true,
      timedOut: false,
      duration: 100,
      stdout: '```aamf-json\n{"status":"completed"}\n```',
      stderr: '',
      tokenUsage: { input: 1, output: 1 },
      outputPath: '',
      outputExists: true,
    });
    (launcher as any).frameworkLauncher = { init: vi.fn(), launchAgent };

    const result = await launcher.launchAgent({
      agent: 'knowledge-builder', contextPath, outputPath: '', phase: 2, workItemId: '',
    });

    expect(result.extensions.outputFiles).toEqual([]);
  });

  it('should initialize the framework once and expose no wrapper-level resolved path', async () => {
    const { launcher } = await createHarness();
    const init = vi.fn().mockResolvedValue(undefined);
    (launcher as any).frameworkLauncher = { init, launchAgent: vi.fn() };

    await launcher.init();
    await launcher.init();

    expect(init).toHaveBeenCalledOnce();
    expect(launcher.getResolvedPath()).toBeUndefined();
  });

  it('should delay consecutive invocations and report queue delay', async () => {
    const { launcher, contextPath } = await createHarness({
      options: { invocationDelayMs: 100 },
    });
    const launchAgent = vi.fn().mockResolvedValue({
      exitCode: 0,
      success: true,
      timedOut: false,
      duration: 1,
      stdout: '```aamf-json\n{"status":"completed"}\n```',
      stderr: '',
      tokenUsage: { input: 1, output: 1 },
      outputPath: '',
      outputExists: true,
    });
    (launcher as any).frameworkLauncher = { init: vi.fn(), launchAgent };
    const invocation: AgentInvocation = {
      agent: 'knowledge-builder',
      contextPath,
      outputPath: '',
      phase: 2,
      workItemId: 'task-delay',
      invocationId: 'invocation-delay',
    };
    vi.useFakeTimers();

    await launcher.launchAgent(invocation);
    const second = launcher.launchAgent(invocation);
    await vi.advanceTimersByTimeAsync(99);
    expect(launchAgent).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    const result = await second;
    expect(launchAgent).toHaveBeenCalledTimes(2);
    expect(result.extensions.queueDelay).toBe(100);
  });
});

describe('registerAamfCopilotBackend', () => {
  it('should not throw when registering', () => {
    expect(() => registerAamfCopilotBackend()).not.toThrow();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.doUnmock('node:child_process');
    vi.resetModules();
    const { resetAgentBackendFactories } = await import('@cadre-dev/framework/runtime');
    resetAgentBackendFactories();
    delete process.env.VSCODE_AAMF_TEST;
    delete process.env.ELECTRON_AAMF_TEST;
    delete process.env.TERM_PROGRAM_VERSION;
    delete process.env.ORIGINAL_XDG_CURRENT_DESKTOP;
  });

  it('should invoke the registered copilot backend with json output, effort, and stripped VS Code env', async () => {
    const spawnOutcomes: Array<{
      stdout?: string;
      stderr?: string;
      exitCode?: number | null;
      error?: Error;
    }> = [
      { stdout: '{"type":"result","data":{"exitCode":0}}\n', exitCode: 0 },
      { stdout: '{"type":"result","data":{"exitCode":0}}\n', exitCode: 0 },
      { stderr: 'unknown option --bogus', exitCode: 0 },
      { stderr: 'agent process crashed', exitCode: 2 },
      { error: new Error('spawn ENOENT') },
      { stdout: 'minimal invocation', exitCode: 0 },
    ];
    const spawnMock = vi.fn((
      _command: string,
      _args: string[],
      _options: {
        cwd: string;
        env: Record<string, string | undefined>;
        detached: boolean;
        stdio: string[];
      },
    ) => {
      const stdoutHandlers: Array<(chunk: Buffer) => void> = [];
      const stderrHandlers: Array<(chunk: Buffer) => void> = [];
      const closeHandlers: Array<(code: number | null) => void> = [];
      const errorHandlers: Array<(error: Error) => void> = [];
      const outcome = spawnOutcomes.shift() ?? { exitCode: 0 };
      const child = {
        pid: 12345,
        killed: false,
        unref: vi.fn(),
        kill: vi.fn(() => true),
        stdout: {
          on: vi.fn((_event: string, handler: (chunk: Buffer) => void) => {
            stdoutHandlers.push(handler);
            return child.stdout;
          }),
        },
        stderr: {
          on: vi.fn((_event: string, handler: (chunk: Buffer) => void) => {
            stderrHandlers.push(handler);
            return child.stderr;
          }),
        },
        on: vi.fn((event: string, handler: ((code: number | null) => void) | ((error: Error) => void)) => {
          if (event === 'close') {
            closeHandlers.push(handler as (code: number | null) => void);
          } else if (event === 'error') {
            errorHandlers.push(handler as (error: Error) => void);
          }
          return child;
        }),
      };

      queueMicrotask(() => {
        if (outcome.error) {
          for (const handler of errorHandlers) handler(outcome.error);
          return;
        }
        for (const handler of stdoutHandlers) {
          handler(Buffer.from(outcome.stdout ?? ''));
        }
        for (const handler of stderrHandlers) {
          handler(Buffer.from(outcome.stderr ?? ''));
        }
        for (const handler of closeHandlers) {
          handler(outcome.exitCode ?? 0);
        }
      });

      return child;
    });

    vi.doMock('node:child_process', async (importOriginal) => {
      const original = await importOriginal<typeof import('node:child_process')>();
      return {
        ...original,
        spawn: spawnMock,
      };
    });

    const { resetAgentBackendFactories, createAgentBackend } = await import('@cadre-dev/framework/runtime');
    resetAgentBackendFactories();

    const {
      buildBackendRuntimeConfig: freshBuildBackendRuntimeConfig,
      registerAamfCopilotBackend: freshRegisterAamfCopilotBackend,
    } = await import('../../src/core/agent-launcher.js');

    freshRegisterAamfCopilotBackend();

    process.env.VSCODE_AAMF_TEST = 'present';
    process.env.ELECTRON_AAMF_TEST = 'present';
    process.env.TERM_PROGRAM_VERSION = '1.0.0';
    process.env.ORIGINAL_XDG_CURRENT_DESKTOP = 'vscode';

    const config = createMockConfig({
      models: { default: 'gpt-5.4' },
      agentBackend: {
        runtime: 'copilot',
        cliCommand: 'copilot-cli',
        timeout: 300_000,
        effort: 'xhigh',
      },
      environment: { extraPath: ['/opt/copilot/bin'] },
    });

    const backendLogger = {
      info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    };
    const backend = createAgentBackend(
      freshBuildBackendRuntimeConfig(config),
      backendLogger,
    );
    await backend.init();

    const tempDir = await mkdtemp(join(tmpdir(), 'aamf-copilot-backend-'));
    const contextPath = join(tempDir, 'context.json');
    const outputPath = join(tempDir, 'output.json');
    await writeFile(contextPath, JSON.stringify({ outputPath }), 'utf-8');
    await writeFile(outputPath, '{}', 'utf-8');

    const overrideResult = await backend.invoke({
      agent: 'code-migrator',
      workItemId: 'task-187-0',
      phase: 5,
      contextPath,
      outputPath,
      modelOverride: 'gpt-5.6',
      mcpServers: {
        'aamf-kb': { type: 'http', url: 'http://localhost:3000/mcp' },
      },
    }, tempDir);

    const defaultResult = await backend.invoke({
      agent: 'code-migrator',
      workItemId: 'task-default-model',
      phase: 4,
      contextPath,
      outputPath,
    }, tempDir);

    const invocationErrorResult = await backend.invoke({
      agent: 'code-migrator',
      workItemId: 'task-cli-error',
      phase: 4,
      contextPath,
      outputPath: join(tempDir, 'missing-output.json'),
      sessionId: 'session-123',
    }, tempDir);

    const nonzeroResult = await backend.invoke({
      agent: 'code-migrator',
      workItemId: 'task-process-error',
      phase: 4,
      contextPath,
      outputPath,
    }, tempDir);

    const spawnErrorResult = await backend.invoke({
      agent: 'code-migrator',
      workItemId: 'task-spawn-error',
      phase: 4,
      contextPath,
      outputPath,
    }, tempDir);

    const minimalBackend = createAgentBackend({
      agent: { backend: 'copilot' },
      environment: {},
    } as any, backendLogger);
    await minimalBackend.init();
    const minimalResult = await minimalBackend.invoke({
      agent: 'knowledge-builder',
      workItemId: 'task-minimal',
      phase: 2,
      contextPath,
      outputPath: join(tempDir, 'minimal-missing-output.json'),
    }, tempDir);

    expect(spawnMock).toHaveBeenCalledTimes(6);
    expect(overrideResult).toMatchObject({ success: true, outputExists: true });
    expect(defaultResult.success).toBe(true);
    expect(invocationErrorResult).toMatchObject({
      success: false,
      exitCode: 0,
      timedOut: false,
      outputExists: false,
      error: 'unknown option --bogus',
    });
    expect(nonzeroResult).toMatchObject({
      success: false,
      exitCode: 2,
      error: 'agent process crashed',
    });
    expect(spawnErrorResult).toMatchObject({
      success: false,
      exitCode: null,
      stderr: 'spawn ENOENT',
      error: 'spawn ENOENT',
    });
    expect(minimalResult).toMatchObject({ success: true, outputExists: false });
    expect(backendLogger.debug).toHaveBeenCalledWith(
      'AamfCopilotBackend initialized (cli: copilot-cli, outputFormat: json)',
    );
    expect(backendLogger.error).toHaveBeenCalledTimes(3);

    const [command, args, options] = spawnMock.mock.calls[0]!;
    expect(command).toBe('copilot-cli');
    expect(args).toEqual(expect.arrayContaining([
      '--agent', 'code-migrator',
      '--no-ask-user',
      '--output-format', 'json',
      '--allow-all-tools',
      '--allow-all-paths',
      '--model', 'gpt-5.6',
      '--effort', 'xhigh',
    ]));
    expect(args).toContain('--additional-mcp-config');
    expect(args).toContain(JSON.stringify({
      mcpServers: {
        'aamf-kb': { type: 'http', url: 'http://localhost:3000/mcp' },
      },
    }));

    expect(options.cwd).toBe(tempDir);
    expect(options.detached).toBe(true);
    expect(options.stdio).toEqual(['pipe', 'pipe', 'pipe']);
    expect(options.env.CADRE_WORK_ITEM_ID).toBe('task-187-0');
    expect(options.env.CADRE_WORKTREE_PATH).toBe(tempDir);
    expect(options.env.CADRE_PHASE).toBe('5');
    expect(options.env.PATH?.startsWith('/opt/copilot/bin:')).toBe(true);
    expect(options.env.VSCODE_AAMF_TEST).toBeUndefined();
    expect(options.env.ELECTRON_AAMF_TEST).toBeUndefined();
    expect(options.env.TERM_PROGRAM_VERSION).toBeUndefined();
    expect(options.env.ORIGINAL_XDG_CURRENT_DESKTOP).toBeUndefined();

    const defaultArgs = spawnMock.mock.calls[1]![1];
    expect(defaultArgs).toEqual(expect.arrayContaining(['--model', 'gpt-5.4']));

    const invocationErrorOptions = spawnMock.mock.calls[2]![2];
    expect(invocationErrorOptions.env.CADRE_SESSION_ID).toBe('session-123');

    const minimalArgs = spawnMock.mock.calls[5]![1];
    expect(spawnMock.mock.calls[5]![0]).toBe('copilot');
    expect(minimalArgs).toEqual(expect.arrayContaining([
      '--agent', 'knowledge-builder',
      '--no-ask-user',
      '--output-format', 'json',
    ]));
    expect(minimalArgs).not.toContain('--allow-all-tools');
    expect(minimalArgs).not.toContain('--allow-all-paths');
    expect(minimalArgs).not.toContain('--model');
    expect(minimalArgs).not.toContain('--effort');
    expect(minimalArgs).not.toContain('--additional-mcp-config');
  });
});

describe('buildBackendRuntimeConfig effort passthrough', () => {
  it('should include effort in copilot config when set', () => {
    const config = createMockConfig({
      agentBackend: { runtime: 'copilot', timeout: 300_000, effort: 'xhigh' },
    });
    const rtConfig = buildBackendRuntimeConfig(config);
    expect((rtConfig.agent.copilot as any)?.effort).toBe('xhigh');
  });

  it('should not include effort when not set', () => {
    const config = createMockConfig({
      agentBackend: { runtime: 'copilot', timeout: 300_000 },
    });
    const rtConfig = buildBackendRuntimeConfig(config);
    expect((rtConfig.agent.copilot as any)?.effort).toBeUndefined();
  });
});
