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
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { AgentLauncher, buildBackendRuntimeConfig, toFrameworkInvocation, registerAamfCopilotBackend } from '../../src/core/agent-launcher.js';
import { createMockConfig, createSilentLogger } from '../helpers/mocks.js';
import type { AgentInvocation } from '../../src/agents/types.js';

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
});

describe('AgentLauncher token usage post-processing', () => {
  async function createHarness(configOverrides?: Parameters<typeof createMockConfig>[0]) {
    const tempDir = await mkdtemp(join(tmpdir(), 'aamf-agent-launcher-'));
    const contextPath = join(tempDir, 'context.json');
    await writeFile(contextPath, JSON.stringify({ outputPath: join(tempDir, 'out') }), 'utf-8');

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
        data: { content: '```aamf-json\n{"status":"completed"}\n```' },
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
    expect(result.extensions.premiumRequests).toBe(2);
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
});

describe('registerAamfCopilotBackend', () => {
  it('should not throw when registering', () => {
    expect(() => registerAamfCopilotBackend()).not.toThrow();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    const { resetAgentBackendFactories } = await import('@cadre-dev/framework/runtime');
    resetAgentBackendFactories();
    delete process.env.VSCODE_AAMF_TEST;
    delete process.env.ELECTRON_AAMF_TEST;
    delete process.env.TERM_PROGRAM_VERSION;
    delete process.env.ORIGINAL_XDG_CURRENT_DESKTOP;
  });

  it('should invoke the registered copilot backend with json output, effort, and stripped VS Code env', async () => {
    const spawnMock = vi.fn(() => {
      const stdoutHandlers: Array<(chunk: Buffer) => void> = [];
      const stderrHandlers: Array<(chunk: Buffer) => void> = [];
      const closeHandlers: Array<(code: number | null) => void> = [];
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
          }
          return child;
        }),
      };

      queueMicrotask(() => {
        for (const handler of stdoutHandlers) {
          handler(Buffer.from('{"type":"result","data":{"exitCode":0}}\n'));
        }
        for (const handler of stderrHandlers) {
          handler(Buffer.from(''));
        }
        for (const handler of closeHandlers) {
          handler(0);
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

    const backend = createAgentBackend(
      freshBuildBackendRuntimeConfig(config),
      { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    );

    const tempDir = await mkdtemp(join(tmpdir(), 'aamf-copilot-backend-'));
    const contextPath = join(tempDir, 'context.json');
    const outputPath = join(tempDir, 'output.json');
    await writeFile(contextPath, JSON.stringify({ outputPath }), 'utf-8');

    await backend.invoke({
      agent: 'code-migrator',
      workItemId: 'task-187-0',
      phase: 5,
      contextPath,
      outputPath,
      mcpServers: {
        'aamf-kb': { type: 'http', url: 'http://localhost:3000/mcp' },
      },
    }, tempDir);

    expect(spawnMock).toHaveBeenCalledTimes(1);

    const [command, args, options] = spawnMock.mock.calls[0] as [string, string[], { cwd: string; env: Record<string, string | undefined>; detached: boolean; stdio: string[] }];
    expect(command).toBe('copilot-cli');
    expect(args).toEqual(expect.arrayContaining([
      '--agent', 'code-migrator',
      '--no-ask-user',
      '--output-format', 'json',
      '--allow-all-tools',
      '--allow-all-paths',
      '--model', 'gpt-5.4',
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
