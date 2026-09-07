import { afterEach, describe, expect, it, vi } from 'vitest';
import { startKbServer, startTargetKbServer } from '../../../src/flow/steps/kb-server-lifecycle.js';
import { createMockLauncher, setupFlowTest, type FlowTestEnv } from '../../helpers/flow-mocks.js';

const serverMocks = vi.hoisted(() => ({
  start: vi.fn<() => Promise<void>>(),
}));

vi.mock('../../../src/core/kb-server-process.js', () => ({
  KbServerProcess: class {
    readonly mcpConfig = { url: 'http://localhost:1/mcp' };
    start = serverMocks.start;
    stop = vi.fn().mockResolvedValue(undefined);
  },
}));

let env: FlowTestEnv | undefined;

afterEach(async () => {
  serverMocks.start.mockReset();
  if (env) await env.cleanup();
  env = undefined;
});

describe('KB server failure policy', () => {
  it('fails the required source server startup instead of continuing without Lore', async () => {
    env = await setupFlowTest(createMockLauncher());
    serverMocks.start.mockRejectedValueOnce(new Error('bind failed'));

    await expect(startKbServer(env.ctx)).rejects.toThrow(
      'Required source KB server failed to start: bind failed',
    );
    expect(env.ctx.kbServer).toBeUndefined();
  });

  it('records target-server enrichment failure as explicitly advisory', async () => {
    env = await setupFlowTest(createMockLauncher());
    serverMocks.start.mockRejectedValueOnce(new Error('target bind failed'));
    const warn = vi.spyOn(env.logger, 'warn');

    await expect(startTargetKbServer(env.ctx)).resolves.toBeUndefined();

    expect(env.ctx.targetKbServer).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      '[advisory:target-kb-server] target bind failed',
    );
  });
});
