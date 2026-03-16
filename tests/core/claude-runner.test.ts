/**
 * Claude Code runner tests — post-framework-consolidation.
 *
 * Claude-specific CLI argument construction and process spawning are now
 * handled by ClaudeBackend in @cadre-dev/framework.
 * This file is kept as a placeholder — specific claude-code behavior is
 * tested by the framework's own test suite.
 */
import { describe, it, expect } from 'vitest';
import { buildBackendRuntimeConfig } from '../../src/core/agent-launcher.js';
import { createMockConfig } from '../helpers/mocks.js';

describe('ClaudeBackend via buildBackendRuntimeConfig', () => {
  it('should configure claude backend with correct cliCommand', () => {
    const config = createMockConfig({
      agentBackend: { runtime: 'claude-code', cliCommand: 'claude', timeout: 600_000, model: 'claude-opus-4' },
    });
    const rtConfig = buildBackendRuntimeConfig(config);
    expect(rtConfig.agent.backend).toBe('claude');
    expect(rtConfig.agent.model).toBe('claude-opus-4');
    expect(rtConfig.agent.claude?.cliCommand).toBe('claude');
  });
});
