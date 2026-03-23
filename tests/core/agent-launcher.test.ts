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
import { describe, it, expect } from 'vitest';
import { buildBackendRuntimeConfig, toFrameworkInvocation } from '../../src/core/agent-launcher.js';
import { createMockConfig } from '../helpers/mocks.js';
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
    const config = createMockConfig({ agentBackend: { runtime: 'copilot', model: 'gpt-4.1', timeout: 300_000 } });
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
