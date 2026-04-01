import { describe, expect, it } from 'vitest';
import { buildLoreIndexSettings } from '../../src/core/lore-index-settings.js';

describe('buildLoreIndexSettings', () => {
  it('always enables SCIP with Lore 0.4 defaults', () => {
    const settings = buildLoreIndexSettings(undefined);

    expect(settings.scip.enabled).toBe(true);
    expect(settings.scip.timeoutMs).toBe(120_000);
    expect(settings.scip.indexDir).toBeNull();
    expect(settings.scip.indexers.c.command).toBe('scip-clang');
    expect(settings.scip.indexers.rust.args).toEqual(['scip', '.']);
  });

  it('keeps LSP opt-in and merges custom server overrides', () => {
    const kbIndex = {
      lsp: {
        enabled: true,
        requestTimeoutMs: 9_000,
        servers: {
          c: { command: 'clangd', args: ['--compile-commands-dir=build'] },
        },
      },
    } satisfies NonNullable<Parameters<typeof buildLoreIndexSettings>[0]>;

    const settings = buildLoreIndexSettings(kbIndex);

    expect(settings.lsp.enabled).toBe(true);
    expect(settings.lsp.requestTimeoutMs).toBe(9_000);
    expect(settings.lsp.servers.c.args).toEqual(['--compile-commands-dir=build']);
    expect(settings.lsp.servers.rust.command).toBe('rust-analyzer');
  });
});