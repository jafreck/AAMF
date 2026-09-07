import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockLauncher, setupFlowTest, type FlowTestEnv } from '../../helpers/flow-mocks.js';

const loreMocks = vi.hoisted(() => ({
  fingerprintApi: 'modern' as 'modern' | 'fallback',
  metadataApi: 'modern' as 'modern' | 'fingerprint' | 'meta',
  providerDevice: 'cpu' as string | undefined,
  providerDims: 768,
  computeSourceFingerprint: vi.fn(),
  getLoreMeta: vi.fn(),
  getKbFingerprint: vi.fn(),
  getKbMeta: vi.fn(),
  openDb: vi.fn(),
  closeDb: vi.fn(),
  initLogger: vi.fn(),
  indexBuilderConstructor: vi.fn(),
  build: vi.fn(),
  providerConstructor: vi.fn(),
  providerInit: vi.fn(),
  providerDispose: vi.fn(),
  execFileSync: vi.fn(),
}));

const lifecycleMocks = vi.hoisted(() => ({
  startKbServer: vi.fn(),
}));

vi.mock('@jafreck/lore', () => ({
  DEFAULT_EMBEDDING_MODEL: 'default-embedding-model',
  LOG_LEVEL_NAMES: { debug: 10, info: 20, warn: 30, error: 40, silent: 50 },
  LogLevel: { DEBUG: 10 },
  get computeSourceFingerprint() {
    return loreMocks.fingerprintApi === 'modern'
      ? loreMocks.computeSourceFingerprint
      : undefined;
  },
  get getLoreMeta() {
    return loreMocks.metadataApi === 'modern' ? loreMocks.getLoreMeta : undefined;
  },
  get getKbFingerprint() {
    return loreMocks.metadataApi === 'fingerprint' ? loreMocks.getKbFingerprint : undefined;
  },
  get getKbMeta() {
    return loreMocks.metadataApi === 'meta' ? loreMocks.getKbMeta : undefined;
  },
  openDb: loreMocks.openDb,
  initLogger: loreMocks.initLogger,
  IndexBuilder: class {
    constructor(...args: unknown[]) {
      loreMocks.indexBuilderConstructor(...args);
    }

    build(): Promise<void> {
      return loreMocks.build();
    }
  },
  TransformersJsProvider: class {
    readonly dims = loreMocks.providerDims;
    readonly device = loreMocks.providerDevice;

    constructor(model: string) {
      loreMocks.providerConstructor(model);
    }

    init(): Promise<void> {
      return loreMocks.providerInit();
    }

    dispose(): Promise<void> {
      return loreMocks.providerDispose();
    }
  },
}));

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return { ...original, execFileSync: loreMocks.execFileSync };
});

vi.mock('../../../src/flow/steps/kb-server-lifecycle.js', () => ({
  startKbServer: lifecycleMocks.startKbServer,
}));

import {
  buildKbIndex,
  KbIndexTimeoutError,
  runKbBuildAttempt,
} from '../../../src/flow/steps/kb-indexing.js';

const environments: FlowTestEnv[] = [];

async function createKbHarness(overrides: Record<string, unknown> = {}): Promise<FlowTestEnv> {
  const typedOverrides = overrides as any;
  const env = await setupFlowTest(createMockLauncher(), {
    ...typedOverrides,
    source: { path: 'source', ...typedOverrides.source },
    options: { maxRetriesPerTask: 1, ...typedOverrides.options },
  });
  await mkdir(join(env.tempDir, 'source'), { recursive: true });
  environments.push(env);
  return env;
}

beforeEach(() => {
  vi.resetAllMocks();
  loreMocks.fingerprintApi = 'modern';
  loreMocks.metadataApi = 'modern';
  loreMocks.providerDevice = 'cpu';
  loreMocks.providerDims = 768;
  loreMocks.computeSourceFingerprint.mockReturnValue('current-fingerprint');
  loreMocks.getLoreMeta.mockReturnValue(undefined);
  loreMocks.getKbFingerprint.mockReturnValue(undefined);
  loreMocks.getKbMeta.mockReturnValue(undefined);
  loreMocks.openDb.mockImplementation(() => ({ close: loreMocks.closeDb }));
  loreMocks.build.mockResolvedValue(undefined);
  loreMocks.providerInit.mockResolvedValue(undefined);
  loreMocks.providerDispose.mockResolvedValue(undefined);
  loreMocks.execFileSync.mockReturnValue(Buffer.from('/mock/bin/server'));
  lifecycleMocks.startKbServer.mockResolvedValue(undefined);
});

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(environments.splice(0).map(env => env.cleanup()));
});

describe('runKbBuildAttempt', () => {
  it('clears deadline and heartbeat handles after a successful build', async () => {
    vi.useFakeTimers();
    const heartbeat = vi.fn();

    await runKbBuildAttempt(async () => undefined, 1_000, false, heartbeat);

    expect(heartbeat).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('emits a heartbeat while a healthy long-running build is pending', async () => {
    vi.useFakeTimers();
    const heartbeat = vi.fn();
    let settleBuild!: () => void;
    const build = new Promise<void>(resolve => { settleBuild = resolve; });
    const outcome = runKbBuildAttempt(() => build, 100, false, heartbeat);

    await vi.advanceTimersByTimeAsync(50);
    expect(heartbeat).toHaveBeenCalledOnce();

    settleBuild();
    await outcome;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('propagates a builder rejection and clears diagnostic timers', async () => {
    vi.useFakeTimers();
    const failure = new Error('builder failed');

    await expect(runKbBuildAttempt(
      () => Promise.reject(failure),
      100,
      false,
      vi.fn(),
    )).rejects.toBe(failure);

    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports an LSP-aware timeout and waits for the delayed builder to settle', async () => {
    vi.useFakeTimers();
    let settleBuild!: () => void;
    const build = new Promise<void>(resolve => { settleBuild = resolve; });
    let completed = false;
    const outcome = runKbBuildAttempt(() => build, 100, true, () => undefined)
      .then(() => ({ error: undefined }), error => ({ error }))
      .finally(() => { completed = true; });

    await vi.advanceTimersByTimeAsync(100);
    expect(completed).toBe(false);

    settleBuild();
    const { error } = await outcome;
    expect(error).toBeInstanceOf(KbIndexTimeoutError);
    expect((error as Error).message).toContain('LSP may be stalled');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not start a retry until a timed-out attempt has settled', async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    let settleFirst!: () => void;
    const firstBuild = new Promise<void>(resolve => { settleFirst = resolve; });

    const run = (async () => {
      try {
        await runKbBuildAttempt(() => {
          order.push('first-start');
          return firstBuild.then(() => { order.push('first-settled'); });
        }, 100, false, () => undefined);
      } catch {
        order.push('first-timeout-returned');
      }
      order.push('retry-start');
      await runKbBuildAttempt(async () => undefined, 100, false, () => undefined);
    })();

    await vi.advanceTimersByTimeAsync(100);
    expect(order).toEqual(['first-start']);
    settleFirst();
    await run;
    expect(order).toEqual([
      'first-start', 'first-settled', 'first-timeout-returned', 'retry-start',
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('buildKbIndex', () => {
  it('reuses an existing KB when the modern Lore fingerprint matches', async () => {
    const env = await createKbHarness();
    await writeFile(env.ctx.paths.kbDbFile, 'existing-kb');
    loreMocks.getLoreMeta.mockReturnValue('current-fingerprint');

    const result = await buildKbIndex(env.flowCtx);

    expect(result).toMatchObject({
      phase: 0,
      name: 'KB Indexing',
      success: true,
      outputPath: env.ctx.paths.kbDbFile,
    });
    expect(loreMocks.getLoreMeta).toHaveBeenCalledWith(
      expect.objectContaining({ close: loreMocks.closeDb }),
      'source_fingerprint',
    );
    expect(loreMocks.closeDb).toHaveBeenCalledOnce();
    expect(loreMocks.indexBuilderConstructor).not.toHaveBeenCalled();
    expect(env.checkpoint.getState().phase0Fingerprint).toBe('current-fingerprint');
    expect(lifecycleMocks.startKbServer).toHaveBeenCalledWith(env.ctx);
  });

  it.each([
    ['getKbFingerprint', 'fingerprint'] as const,
    ['getKbMeta', 'meta'] as const,
  ])('supports fallback source and metadata helpers via %s', async (helper, metadataApi) => {
    const env = await createKbHarness();
    const sourceRoot = join(env.tempDir, 'source');
    const expectedFingerprint = createHash('sha256').update(JSON.stringify({
      rootDir: sourceRoot,
      includeGlobs: [],
      excludeGlobs: [],
      embeddingModel: '',
    })).digest('hex');
    loreMocks.fingerprintApi = 'fallback';
    loreMocks.metadataApi = metadataApi;
    loreMocks[helper].mockReturnValue(expectedFingerprint);
    await writeFile(env.ctx.paths.kbDbFile, 'legacy-kb');

    const result = await buildKbIndex(env.flowCtx);

    expect(result.success).toBe(true);
    expect(loreMocks.computeSourceFingerprint).not.toHaveBeenCalled();
    if (helper === 'getKbMeta') {
      expect(loreMocks.getKbMeta).toHaveBeenCalledWith(expect.anything(), 'source_fingerprint');
    } else {
      expect(loreMocks.getKbFingerprint).toHaveBeenCalledWith(expect.anything());
    }
    expect(env.checkpoint.getState().phase0Fingerprint).toBe(expectedFingerprint);
    expect(loreMocks.build).not.toHaveBeenCalled();
  });

  it('rebuilds stale files with embeddings and normalized LSP settings', async () => {
    const env = await createKbHarness({
      options: {
        kbIndex: {
          logLevel: 'info',
          embeddings: { enabled: true, model: 'test/embedding-model' },
          lsp: {
            enabled: true,
            requestTimeoutMs: 750,
            servers: {
              typescript: { command: 'typescript-language-server' },
              python: { command: 'pyright-langserver', args: ['--stdio'] },
            },
          },
        },
      },
      agentBackend: { phaseTimeouts: { 0: 2_000 } },
    });
    await Promise.all([
      writeFile(env.ctx.paths.kbDbFile, 'stale'),
      writeFile(env.ctx.paths.kbDbFile + '-wal', 'stale-wal'),
      writeFile(env.ctx.paths.kbDbFile + '-shm', 'stale-shm'),
    ]);
    loreMocks.getLoreMeta.mockReturnValue('old-fingerprint');
    loreMocks.execFileSync.mockImplementation((_command, args) => {
      if (args[0] === 'pyright-langserver') throw new Error('not found');
      return Buffer.from('/mock/bin/server');
    });
    const warn = vi.spyOn(env.ctx.logger, 'warn');

    const result = await buildKbIndex(env.flowCtx);

    expect(result.success).toBe(true);
    expect(loreMocks.providerConstructor).toHaveBeenCalledWith('test/embedding-model');
    expect(loreMocks.providerInit).toHaveBeenCalledOnce();
    expect(loreMocks.indexBuilderConstructor).toHaveBeenCalledWith(
      env.ctx.paths.kbDbFile,
      { rootDir: join(env.tempDir, 'source') },
      expect.objectContaining({ dims: 768, device: 'cpu' }),
      {
        lsp: {
          enabled: true,
          requestTimeoutMs: 750,
          servers: {
            typescript: { command: 'typescript-language-server', args: [] },
            python: { command: 'pyright-langserver', args: ['--stdio'] },
          },
        },
      },
    );
    expect(loreMocks.initLogger).toHaveBeenCalledWith({
      level: 20,
      logFile: env.ctx.paths.loreLogFile,
    });
    expect(warn).toHaveBeenCalledWith(
      "LSP server 'pyright-langserver' for 'python' not found on PATH",
    );
    expect(loreMocks.build).toHaveBeenCalledOnce();
    expect(lifecycleMocks.startKbServer).toHaveBeenCalledOnce();
  });

  it('disposes a failed embedding provider and continues without embeddings', async () => {
    const env = await createKbHarness({
      options: {
        kbIndex: {
          embeddings: { enabled: true, model: 'broken/model' },
        },
      },
    });
    loreMocks.providerInit.mockRejectedValue('model unavailable');
    loreMocks.providerDispose.mockRejectedValue(new Error('dispose failed'));

    const result = await buildKbIndex(env.flowCtx);

    expect(result.success).toBe(true);
    expect(loreMocks.providerDispose).toHaveBeenCalledOnce();
    expect(env.ctx.embedder).toBeUndefined();
    expect(loreMocks.indexBuilderConstructor).toHaveBeenCalledWith(
      env.ctx.paths.kbDbFile,
      expect.anything(),
      undefined,
      { lsp: undefined },
    );
  });

  it('rebuilds when an existing database cannot be opened', async () => {
    const env = await createKbHarness();
    await writeFile(env.ctx.paths.kbDbFile, 'corrupt');
    loreMocks.openDb.mockImplementation(() => { throw new Error('corrupt database'); });

    const result = await buildKbIndex(env.flowCtx);

    expect(result.success).toBe(true);
    expect(loreMocks.build).toHaveBeenCalledOnce();
    expect(loreMocks.closeDb).not.toHaveBeenCalled();
  });

  it('retries a failed index build only after the retry delay', async () => {
    vi.useFakeTimers();
    const env = await createKbHarness({ options: { maxRetriesPerTask: 2 } });
    let markFirstAttemptStarted!: () => void;
    const firstAttemptStarted = new Promise<void>(resolve => {
      markFirstAttemptStarted = resolve;
    });
    loreMocks.build
      .mockImplementationOnce(async () => {
        markFirstAttemptStarted();
        throw new Error('transient index failure');
      })
      .mockResolvedValueOnce(undefined);

    const outcome = buildKbIndex(env.flowCtx);
    await firstAttemptStarted;
    await vi.advanceTimersByTimeAsync(0);
    expect(loreMocks.build).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(loreMocks.build).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(outcome).resolves.toMatchObject({ success: true });
    expect(loreMocks.build).toHaveBeenCalledTimes(2);
    expect(loreMocks.indexBuilderConstructor).toHaveBeenCalledTimes(2);
  });

  it('raises the critical phase error after the final failed attempt', async () => {
    const env = await createKbHarness();
    loreMocks.build.mockRejectedValue('permanent index failure');

    await expect(buildKbIndex(env.flowCtx)).rejects.toThrow(
      'Phase 0 (KB Indexing) failed: permanent index failure',
    );
    expect(lifecycleMocks.startKbServer).not.toHaveBeenCalled();
  });
});
