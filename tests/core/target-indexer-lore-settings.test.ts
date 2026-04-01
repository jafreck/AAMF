import { describe, expect, it, vi, beforeEach } from 'vitest';
import { TargetIndexer } from '../../src/core/target-indexer.js';
import { buildLoreIndexSettings } from '../../src/core/lore-index-settings.js';
import { createSilentLogger } from '../helpers/mocks.js';

const builderMethods = vi.hoisted(() => ({
  build: vi.fn().mockResolvedValue(undefined),
  update: vi.fn().mockResolvedValue(undefined),
  baselineRebuild: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@jafreck/lore', () => ({
  IndexBuilder: class {
    build = builderMethods.build;
    update = builderMethods.update;
    baselineRebuild = builderMethods.baselineRebuild;
  },
}));

describe('TargetIndexer Lore integration', () => {
  beforeEach(() => {
    builderMethods.build.mockClear();
    builderMethods.update.mockClear();
    builderMethods.baselineRebuild.mockClear();
  });

  it('uses baseline rebuilds for follow-up updates when LSP is disabled', async () => {
    const logger = createSilentLogger(process.cwd());
    const indexer = new TargetIndexer(
      '/tmp/aamf-target.db',
      '/tmp/aamf-target-root',
      logger,
      buildLoreIndexSettings(undefined),
    );

    indexer.markBuilt();
    await indexer.updateForFiles(['/tmp/aamf-target-root/lib.rs']);

    expect(builderMethods.update).not.toHaveBeenCalled();
    expect(builderMethods.baselineRebuild).toHaveBeenCalledTimes(1);
  });

  it('uses overlay updates when LSP is enabled', async () => {
    const logger = createSilentLogger(process.cwd());
    const indexer = new TargetIndexer(
      '/tmp/aamf-target.db',
      '/tmp/aamf-target-root',
      logger,
      buildLoreIndexSettings({ lsp: { enabled: true } }),
    );

    indexer.markBuilt();
    await indexer.updateForFiles(['/tmp/aamf-target-root/lib.rs']);

    expect(builderMethods.update).toHaveBeenCalledTimes(1);
    expect(builderMethods.baselineRebuild).not.toHaveBeenCalled();
  });
});