import { chmod, mkdir, readFile, realpath, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { delimiter, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockLauncher, setupFlowTest, type FlowTestEnv } from '../../helpers/flow-mocks.js';

const loreMocks = vi.hoisted(() => ({
  providerDevice: 'cpu' as string | undefined,
  providerDims: 768,
  getLoreMeta: vi.fn(),
  setLoreMeta: vi.fn(),
  validateIndex: vi.fn(),
  walkFiles: vi.fn(),
  detectLanguageForPath: vi.fn(),
  discoverCompilationDatabase: vi.fn(),
  loadScipSettingsFromLoreConfig: vi.fn(),
  resolveEffectiveScipSettings: vi.fn(),
  openDb: vi.fn(),
  closeDb: vi.fn(),
  initLogger: vi.fn(),
  indexBuilderConstructor: vi.fn(),
  resolveConfiguration: vi.fn(),
  build: vi.fn(),
  providerConstructor: vi.fn(),
  providerInit: vi.fn(),
  providerDispose: vi.fn(),
}));

const lifecycleMocks = vi.hoisted(() => ({
  startKbServer: vi.fn(),
}));

vi.mock('@jafreck/lore', () => ({
  DEFAULT_EMBEDDING_MODEL: 'default-embedding-model',
  LOG_LEVEL_NAMES: { debug: 10, info: 20, warn: 30, error: 40, silent: 50 },
  LogLevel: { DEBUG: 10 },
  getLoreMeta: loreMocks.getLoreMeta,
  setLoreMeta: loreMocks.setLoreMeta,
  validateIndex: loreMocks.validateIndex,
  walkFiles: loreMocks.walkFiles,
  detectLanguageForPath: loreMocks.detectLanguageForPath,
  discoverCompilationDatabase: loreMocks.discoverCompilationDatabase,
  loadScipSettingsFromLoreConfig: loreMocks.loadScipSettingsFromLoreConfig,
  resolveEffectiveScipSettings: loreMocks.resolveEffectiveScipSettings,
  openDb: loreMocks.openDb,
  initLogger: loreMocks.initLogger,
  IndexValidationError: class extends Error {
    readonly report: any;

    constructor(report: any) {
      super(`Index validation failed: ${report.errors[0]?.message ?? report.status}`);
      this.name = 'IndexValidationError';
      this.report = report;
    }
  },
  IndexBuilder: class {
    readonly dbPath: string;

    constructor(...args: unknown[]) {
      this.dbPath = args[0] as string;
      loreMocks.indexBuilderConstructor(...args);
    }

    resolveConfiguration(): Promise<unknown> {
      return loreMocks.resolveConfiguration();
    }

    build(): Promise<void> {
      return loreMocks.build(this.dbPath);
    }
  },
  TransformersJsProvider: class {
    readonly dims = loreMocks.providerDims;

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

vi.mock('../../../src/flow/steps/kb-server-lifecycle.js', () => ({
  startKbServer: lifecycleMocks.startKbServer,
}));

import {
  buildKbIndex,
  computeKbInputFingerprint,
  KbIndexTimeoutError,
  prepareExistingKbForUse,
  runKbBuildAttempt,
} from '../../../src/flow/steps/kb-indexing.js';

const environments: FlowTestEnv[] = [];

function healthyReport() {
  return {
    ok: true,
    status: 'healthy',
    coverage: {
      overall: {
        files: 2,
        symbols: 4,
        calls: { total: 2, resolved: 2 },
        types: { total: 1, resolved: 1 },
      },
    },
    provenance: {
      compilationDatabases: [],
      indexers: [],
      diagnostics: { compiler: [], positionConversions: [], supplementation: [] },
    },
    errors: [],
    warnings: [],
  };
}

function walkerConfigFor(env: FlowTestEnv) {
  return {
    rootDir: join(env.tempDir, 'source'),
    branch: env.ctx.config.source.branch,
    includeGlobs: [...env.ctx.config.source.includePatterns],
    excludeGlobs: [...env.ctx.config.source.excludePatterns],
  };
}

function scipScopeFor(env: FlowTestEnv) {
  return {
    languages: env.ctx.config.source.languages ?? [env.ctx.config.source.language],
    includeGlobs: [...env.ctx.config.source.includePatterns],
    excludeGlobs: [...env.ctx.config.source.excludePatterns],
  };
}

function executionFor(env: FlowTestEnv) {
  const execution = env.ctx.config.options.kbIndex?.execution;
  return {
    allowSubprocessExecution: execution?.allowSubprocessExecution ?? false,
    allowBuildExecution: execution?.allowBuildExecution ?? false,
    allowCustomIndexerCommands: execution?.allowCustomIndexerCommands ?? false,
    allowCustomLspCommands: execution?.allowCustomLspCommands ?? false,
    allowAutoInstall: execution?.allowAutoInstall ?? false,
    allowedCwdRoots: (execution?.allowedCwdRoots ?? []).map(root => resolve(env.tempDir, root)),
  };
}

function migrationGradePolicy(env: FlowTestEnv) {
  const configured = env.ctx.config.options.kbIndex?.validation;
  const requiredGlobs = [...new Set([
    ...(env.ctx.config.source.entryPoints ?? []),
    ...(configured?.requiredGlobs ?? []),
  ])];
  return {
    profile: 'migration-grade',
    requireStructuralIndex: true,
    requireValidSpans: true,
    requireIndexerSuccess: true,
    requireProvenance: true,
    ...configured,
    includeGlobs: [...env.ctx.config.source.includePatterns],
    excludeGlobs: [...env.ctx.config.source.excludePatterns],
    thresholds: {
      minCallRefs: 1,
      maxSymbolLessFiles: 0,
      ...configured?.thresholds,
    },
    ...(requiredGlobs.length > 0 ? { requiredGlobs } : {}),
  };
}

function validationOptionsFor(env: FlowTestEnv) {
  return {
    rootDir: join(env.tempDir, 'source'),
    branch: env.ctx.config.source.branch,
    walkerConfig: walkerConfigFor(env),
    scipScope: scipScopeFor(env),
    policy: migrationGradePolicy(env),
  };
}

function candidatePathFor(env: FlowTestEnv): string {
  return `${env.ctx.paths.kbDbFile}.rebuild`;
}

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

async function fingerprintFor(env: FlowTestEnv): Promise<string> {
  const sourceRoot = join(env.tempDir, 'source');
  const embeddings = env.ctx.config.options.kbIndex?.embeddings;
  const embeddingModel = embeddings?.enabled
    ? (embeddings.model ?? 'Qwen/Qwen3-Embedding-0.6B')
    : undefined;
  const walkerConfig = walkerConfigFor(env);
  const scipScope = scipScopeFor(env);
  return computeKbInputFingerprint(sourceRoot, walkerConfig, {
    loreVersion: '0.4.2',
    sourceLanguage: env.ctx.config.source.language,
    sourceLanguages: scipScope.languages,
    scipScope,
    embeddingModel,
    scip: true,
    lsp: false,
    execution: executionFor(env),
    validation: migrationGradePolicy(env),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  loreMocks.providerDevice = 'cpu';
  loreMocks.providerDims = 768;
  loreMocks.getLoreMeta.mockReturnValue(undefined);
  loreMocks.openDb.mockImplementation(() => ({ close: loreMocks.closeDb }));
  loreMocks.validateIndex.mockReturnValue(healthyReport());
  loreMocks.walkFiles.mockResolvedValue([]);
  loreMocks.detectLanguageForPath.mockReturnValue(undefined);
  loreMocks.discoverCompilationDatabase.mockReturnValue({ database: null, candidates: [] });
  loreMocks.loadScipSettingsFromLoreConfig.mockReturnValue({});
  loreMocks.resolveEffectiveScipSettings.mockReturnValue({
    indexers: {
      c: { command: 'mock-scip-clang', args: ['--output={output}'] },
      cpp: { command: 'mock-scip-clang', args: ['--output={output}'] },
      python: { command: 'mock-scip-python', args: ['index'] },
    },
  });
  loreMocks.resolveConfiguration.mockResolvedValue({
    scip: { enabled: true },
    scipScope: null,
    lsp: null,
    execution: {
      allowSubprocessExecution: false,
      allowBuildExecution: false,
      allowCustomIndexerCommands: false,
      allowCustomLspCommands: false,
      allowAutoInstall: false,
      allowIndexerExecution: false,
      allowLspExecution: false,
      allowedCwdRoots: [],
    },
  });
  loreMocks.build.mockImplementation(async (dbPath: string) => {
    await writeFile(dbPath, 'candidate-kb');
  });
  loreMocks.providerInit.mockResolvedValue(undefined);
  loreMocks.providerDispose.mockResolvedValue(undefined);
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
  it('invalidates fingerprints when source, indexing configuration, or compdb content changes', async () => {
    const env = await createKbHarness();
    const sourceRoot = join(env.tempDir, 'source');
    const walkerConfig = {
      rootDir: sourceRoot,
      excludeGlobs: ['.lore-compdb', '.lore-compdb/**'],
    };
    await writeFile(join(sourceRoot, 'main.c'), 'int main(void) { return 0; }\n');
    loreMocks.walkFiles.mockResolvedValue([{
      path: join(sourceRoot, 'main.c'),
      language: 'c',
    }]);
    const initial = await computeKbInputFingerprint(sourceRoot, walkerConfig, { scip: true });

    await writeFile(join(sourceRoot, 'main.c'), 'int main(void) { return 1; }\n');
    const sourceChanged = await computeKbInputFingerprint(sourceRoot, walkerConfig, { scip: true });
    const configChanged = await computeKbInputFingerprint(sourceRoot, walkerConfig, { scip: true, lsp: false });
    const scopeChanged = await computeKbInputFingerprint(sourceRoot, walkerConfig, {
      scip: true,
      scipScope: { languages: ['c'], includeGlobs: ['src/**'] },
    });
    const branchChanged = await computeKbInputFingerprint(sourceRoot, {
      ...walkerConfig,
      branch: 'other',
    }, { scip: true });
    await mkdir(join(sourceRoot, '.lore-compdb'), { recursive: true });
    await writeFile(join(sourceRoot, '.lore-compdb', 'compile_commands.json'), '[]\n');
    const compdbChanged = await computeKbInputFingerprint(sourceRoot, walkerConfig, { scip: true, lsp: false });

    expect(new Set([
      initial,
      sourceChanged,
      configChanged,
      scopeChanged,
      branchChanged,
      compdbChanged,
    ])).toHaveLength(6);
  });

  it('invalidates fingerprints when the source Git revision changes without content changes', async () => {
    const env = await createKbHarness();
    const sourceRoot = join(env.tempDir, 'source');
    const sourceFile = join(sourceRoot, 'main.c');
    await writeFile(sourceFile, 'int main(void) { return 0; }\n');
    loreMocks.walkFiles.mockResolvedValue([{ path: sourceFile, language: 'c' }]);
    execFileSync('git', ['init', '--quiet'], { cwd: sourceRoot });
    execFileSync('git', ['config', 'user.name', 'AAMF Test'], { cwd: sourceRoot });
    execFileSync('git', ['config', 'user.email', 'aamf-test@local.invalid'], { cwd: sourceRoot });
    execFileSync('git', ['add', 'main.c'], { cwd: sourceRoot });
    execFileSync('git', ['commit', '--quiet', '-m', 'initial'], { cwd: sourceRoot });
    const initial = await computeKbInputFingerprint(
      sourceRoot,
      { rootDir: sourceRoot, branch: 'main' },
      { scip: true },
    );

    execFileSync('git', ['commit', '--quiet', '--allow-empty', '-m', 'new revision'], { cwd: sourceRoot });
    const changed = await computeKbInputFingerprint(
      sourceRoot,
      { rootDir: sourceRoot, branch: 'main' },
      { scip: true },
    );

    expect(changed).not.toBe(initial);
  });

  it('rejects a compilation database symlink that resolves outside the source root', async () => {
    const env = await createKbHarness();
    const sourceRoot = join(env.tempDir, 'source');
    const externalCompdb = join(env.tempDir, 'external-compile-commands.json');
    await mkdir(join(sourceRoot, '.lore-compdb'), { recursive: true });
    await writeFile(externalCompdb, '[]\n');
    await symlink(externalCompdb, join(sourceRoot, '.lore-compdb', 'compile_commands.json'));

    await expect(computeKbInputFingerprint(sourceRoot, {
      rootDir: sourceRoot,
    }, { scip: true })).rejects.toThrow(
      'Compilation database must resolve inside the source root',
    );
  });

  it('hashes an external compilation database only when its root is explicitly approved', async () => {
    const env = await createKbHarness();
    const sourceRoot = join(env.tempDir, 'source');
    const externalRoot = join(env.tempDir, 'approved-compdb');
    const externalCompdb = join(externalRoot, 'compile_commands.json');
    await mkdir(externalRoot, { recursive: true });
    await writeFile(externalCompdb, '[]\n');
    await symlink(externalCompdb, join(sourceRoot, 'compile_commands.json'));
    const configuration = {
      scip: true,
      execution: { allowedCwdRoots: [externalRoot] },
    };

    const initial = await computeKbInputFingerprint(
      sourceRoot,
      { rootDir: sourceRoot },
      configuration,
    );
    await writeFile(externalCompdb, '[ ]\n');
    const changed = await computeKbInputFingerprint(
      sourceRoot,
      { rootDir: sourceRoot },
      configuration,
    );

    expect(changed).not.toBe(initial);
    expect(loreMocks.discoverCompilationDatabase).toHaveBeenLastCalledWith(
      await realpath(sourceRoot),
      undefined,
      { approvedExternalRoots: [await realpath(externalRoot)] },
    );
  });

  it('invalidates fingerprints when response-file expansion changes', async () => {
    const env = await createKbHarness();
    const sourceRoot = join(env.tempDir, 'source');
    const compdbPath = join(sourceRoot, '.lore-compdb', 'compile_commands.json');
    await mkdir(join(sourceRoot, '.lore-compdb'), { recursive: true });
    await writeFile(join(sourceRoot, 'main.c'), 'int main(void) { return 0; }\n');
    await writeFile(compdbPath, '[{"file":"main.c","arguments":["cc","@flags.rsp"]}]\n');
    const compdb = (arguments_: string[]) => ({
      database: {
        path: compdbPath,
        sha256: 'same-compdb-bytes',
        validation: { valid: true },
        entries: [{
          filePath: join(sourceRoot, 'main.c'),
          workingDirectory: sourceRoot,
          arguments: arguments_,
          includePaths: [],
          language: 'c',
          responseFiles: { status: 'complete', filesRead: 1 },
        }],
      },
      candidates: [],
    });
    loreMocks.discoverCompilationDatabase.mockReturnValue(compdb(['cc', '-DFLAG=1']));
    const initial = await computeKbInputFingerprint(sourceRoot, { rootDir: sourceRoot }, { scip: true });
    loreMocks.discoverCompilationDatabase.mockReturnValue(compdb(['cc', '-DFLAG=2']));

    const changed = await computeKbInputFingerprint(sourceRoot, { rootDir: sourceRoot }, { scip: true });

    expect(changed).not.toBe(initial);
  });

  it('invalidates fingerprints when the compiler executable identity changes', async () => {
    const env = await createKbHarness();
    const sourceRoot = join(env.tempDir, 'source');
    const compilerPath = join(env.tempDir, 'compiler-wrapper');
    const sourceFile = join(sourceRoot, 'main.c');
    const compdbPath = join(sourceRoot, 'compile_commands.json');
    await writeFile(sourceFile, 'int main(void) { return 0; }\n');
    await writeFile(compilerPath, 'compiler-v1');
    await chmod(compilerPath, 0o755);
    const initialCompilerStat = await stat(compilerPath);
    loreMocks.discoverCompilationDatabase.mockReturnValue({
      database: {
        path: compdbPath,
        sha256: 'stable-compdb',
        validation: { valid: true },
        entries: [{
          filePath: sourceFile,
          workingDirectory: sourceRoot,
          arguments: [compilerPath, '-c', sourceFile],
          includePaths: [],
          language: 'c',
          responseFiles: { status: 'complete', filesRead: 0 },
        }],
      },
      candidates: [],
    });
    const initial = await computeKbInputFingerprint(sourceRoot, { rootDir: sourceRoot }, { scip: true });

    await writeFile(compilerPath, 'compiler-v2');
    await utimes(compilerPath, initialCompilerStat.atime, initialCompilerStat.mtime);
    const changed = await computeKbInputFingerprint(sourceRoot, { rootDir: sourceRoot }, { scip: true });

    expect(changed).not.toBe(initial);
  });

  it('invalidates fingerprints when the effective scoped indexer binary changes', async () => {
    const env = await createKbHarness();
    const sourceRoot = join(env.tempDir, 'source');
    const indexerPath = join(env.tempDir, 'scip-wrapper');
    await writeFile(indexerPath, 'indexer-v1');
    await chmod(indexerPath, 0o755);
    const initialIndexerStat = await stat(indexerPath);
    loreMocks.resolveEffectiveScipSettings.mockReturnValue({
      indexers: {
        c: { command: indexerPath, args: ['--compdb={compdb}', '--output={output}'] },
      },
    });
    const configuration = {
      scip: true,
      scipScope: { languages: ['c'], includeGlobs: ['src/**'] },
      execution: { allowSubprocessExecution: true },
    };
    const initial = await computeKbInputFingerprint(
      sourceRoot,
      { rootDir: sourceRoot },
      configuration,
    );

    await writeFile(indexerPath, 'indexer-v2');
    await utimes(indexerPath, initialIndexerStat.atime, initialIndexerStat.mtime);
    const changed = await computeKbInputFingerprint(
      sourceRoot,
      { rootDir: sourceRoot },
      configuration,
    );

    expect(changed).not.toBe(initial);
  });

  it('ignores non-executable PATH shadows when fingerprinting a scoped indexer', async () => {
    const env = await createKbHarness();
    const sourceRoot = join(env.tempDir, 'source');
    const shadowDir = join(env.tempDir, 'shadow-bin');
    const executableDir = join(env.tempDir, 'executable-bin');
    const command = 'aamf-test-scip-indexer';
    const shadowPath = join(shadowDir, command);
    const executablePath = join(executableDir, command);
    await mkdir(shadowDir, { recursive: true });
    await mkdir(executableDir, { recursive: true });
    await writeFile(shadowPath, 'shadow-v1');
    await writeFile(executablePath, 'actual-v1');
    await chmod(shadowPath, 0o644);
    await chmod(executablePath, 0o755);
    const executableStat = await stat(executablePath);
    loreMocks.resolveEffectiveScipSettings.mockReturnValue({
      indexers: { c: { command, args: ['--output={output}'] } },
    });
    const configuration = {
      scip: true,
      scipScope: { languages: ['c'], includeGlobs: ['src/**'] },
      execution: { allowSubprocessExecution: true },
    };
    const originalPath = process.env.PATH;

    try {
      process.env.PATH = [shadowDir, executableDir].join(delimiter);
      const initial = await computeKbInputFingerprint(
        sourceRoot,
        { rootDir: sourceRoot },
        configuration,
      );
      await writeFile(shadowPath, 'shadow-v2');
      const shadowChanged = await computeKbInputFingerprint(
        sourceRoot,
        { rootDir: sourceRoot },
        configuration,
      );
      await writeFile(executablePath, 'actual-v2');
      await utimes(executablePath, executableStat.atime, executableStat.mtime);
      const executableChanged = await computeKbInputFingerprint(
        sourceRoot,
        { rootDir: sourceRoot },
        configuration,
      );

      expect(shadowChanged).toBe(initial);
      expect(executableChanged).not.toBe(initial);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it('invalidates fingerprints when a configured precomputed SCIP index changes', async () => {
    const env = await createKbHarness();
    const sourceRoot = join(env.tempDir, 'source');
    const indexDir = join(sourceRoot, 'scip-index');
    await mkdir(indexDir, { recursive: true });
    await writeFile(join(indexDir, 'c.scip'), 'first');
    loreMocks.loadScipSettingsFromLoreConfig.mockReturnValue({ indexDir: 'scip-index' });
    const initial = await computeKbInputFingerprint(sourceRoot, { rootDir: sourceRoot }, { scip: true });

    await writeFile(join(indexDir, 'c.scip'), 'second');
    const changed = await computeKbInputFingerprint(sourceRoot, { rootDir: sourceRoot }, { scip: true });

    expect(changed).not.toBe(initial);
  });

  it('reuses an existing KB only when its content fingerprint and validation match', async () => {
    const env = await createKbHarness({ options: { reuseKb: true } });
    await writeFile(env.ctx.paths.kbDbFile, 'existing-kb');
    const expectedFingerprint = await fingerprintFor(env);
    loreMocks.getLoreMeta.mockReturnValue(expectedFingerprint);

    const result = await buildKbIndex(env.flowCtx);

    expect(result).toMatchObject({
      phase: 0,
      name: 'KB Indexing',
      success: true,
      outputPath: env.ctx.paths.kbDbFile,
    });
    expect(loreMocks.getLoreMeta).toHaveBeenCalledWith(
      expect.objectContaining({ close: loreMocks.closeDb }),
      'aamf_index_fingerprint_v2',
    );
    expect(loreMocks.validateIndex).toHaveBeenCalledWith(
      expect.anything(),
      validationOptionsFor(env),
    );
    expect(loreMocks.closeDb).toHaveBeenCalledOnce();
    expect(loreMocks.indexBuilderConstructor).not.toHaveBeenCalled();
    expect(env.checkpoint.getState().phase0Fingerprint).toBe(expectedFingerprint);
    expect(lifecycleMocks.startKbServer).toHaveBeenCalledWith(env.ctx);
  });

  it('initializes the configured embedding provider before serving a reused KB', async () => {
    const env = await createKbHarness({
      options: {
        reuseKb: true,
        kbIndex: { embeddings: { enabled: true, model: 'test/cache-model' } },
      },
    });
    await writeFile(env.ctx.paths.kbDbFile, 'existing-kb');
    const expectedFingerprint = await fingerprintFor(env);
    loreMocks.getLoreMeta.mockImplementation((_db, key) => {
      if (key === 'aamf_index_fingerprint_v2') return expectedFingerprint;
      if (key === 'embedding_model') return 'test/cache-model';
      if (key === 'embedding_dims') return '768';
      return undefined;
    });

    await expect(buildKbIndex(env.flowCtx)).resolves.toMatchObject({ success: true });

    expect(loreMocks.providerConstructor).toHaveBeenCalledWith('test/cache-model');
    expect(loreMocks.providerInit).toHaveBeenCalledOnce();
    expect(env.ctx.embedder).toBeDefined();
    expect(loreMocks.build).not.toHaveBeenCalled();
    expect(lifecycleMocks.startKbServer).toHaveBeenCalledWith(env.ctx);
  });

  it('rebuilds a matching cache when configured embeddings were not persisted', async () => {
    const env = await createKbHarness({
      options: {
        reuseKb: true,
        kbIndex: { embeddings: { enabled: true, model: 'test/cache-model' } },
      },
    });
    await writeFile(env.ctx.paths.kbDbFile, 'existing-kb');
    const expectedFingerprint = await fingerprintFor(env);
    loreMocks.getLoreMeta.mockImplementation((_db, key) =>
      key === 'aamf_index_fingerprint_v2' ? expectedFingerprint : undefined);

    await expect(buildKbIndex(env.flowCtx)).resolves.toMatchObject({ success: true });

    expect(loreMocks.build).toHaveBeenCalledOnce();
    expect(loreMocks.validateIndex).toHaveBeenCalledOnce();
  });

  it('rebuilds a schema-compatible legacy cache without the v2 scope identity', async () => {
    const env = await createKbHarness({ options: { reuseKb: true } });
    await writeFile(env.ctx.paths.kbDbFile, 'legacy-kb');
    loreMocks.getLoreMeta.mockReturnValue(undefined);

    await expect(buildKbIndex(env.flowCtx)).resolves.toMatchObject({ success: true });

    expect(loreMocks.validateIndex).not.toHaveBeenCalledWith(
      expect.objectContaining({ close: loreMocks.closeDb }),
      expect.anything(),
    );
    expect(loreMocks.build).toHaveBeenCalledOnce();
    await expect(readFile(env.ctx.paths.kbDbFile, 'utf8')).resolves.toBe('candidate-kb');
  });

  it('persists and immediately reuses a post-build identity when Lore generates a compdb', async () => {
    const env = await createKbHarness({
      options: {
        reuseKb: true,
        kbIndex: {
          execution: {
            allowSubprocessExecution: true,
            allowBuildExecution: true,
          },
        },
      },
    });
    const sourceRoot = join(env.tempDir, 'source');
    const compdbPath = join(sourceRoot, 'compile_commands.json');
    let compdbReady = false;
    let storedFingerprint: string | undefined;
    loreMocks.discoverCompilationDatabase.mockImplementation(() => compdbReady ? {
      database: {
        path: compdbPath,
        sha256: 'generated-compdb',
        validation: { valid: true },
        entries: [],
      },
      candidates: [],
    } : { database: null, candidates: [] });
    loreMocks.build.mockImplementation(async (dbPath: string) => {
      await writeFile(dbPath, 'candidate-kb');
      await writeFile(compdbPath, '[]\n');
      compdbReady = true;
    });
    loreMocks.setLoreMeta.mockImplementation((_db, key, value) => {
      if (key === 'aamf_index_fingerprint_v2') storedFingerprint = value;
    });
    loreMocks.getLoreMeta.mockImplementation((_db, key) =>
      key === 'aamf_index_fingerprint_v2' ? storedFingerprint : undefined);
    const preBuildFingerprint = await fingerprintFor(env);

    await expect(buildKbIndex(env.flowCtx)).resolves.toMatchObject({ success: true });
    const postBuildFingerprint = await fingerprintFor(env);
    await expect(buildKbIndex(env.flowCtx)).resolves.toMatchObject({ success: true });

    expect(storedFingerprint).toBe(postBuildFingerprint);
    expect(storedFingerprint).not.toBe(preBuildFingerprint);
    expect(env.checkpoint.getState().phase0Fingerprint).toBe(postBuildFingerprint);
    expect(loreMocks.build).toHaveBeenCalledOnce();
  });

  it('rejects stale resume identity before validating or starting the KB server', async () => {
    const env = await createKbHarness();
    await writeFile(env.ctx.paths.kbDbFile, 'existing-kb');
    loreMocks.getLoreMeta.mockReturnValue('stale-fingerprint');

    await expect(prepareExistingKbForUse(env.ctx)).rejects.toThrow(
      'Resume KB validation failed: knowledge-base inputs changed',
    );

    expect(loreMocks.validateIndex).not.toHaveBeenCalled();
    expect(lifecycleMocks.startKbServer).not.toHaveBeenCalled();
  });

  it('does not reuse an existing KB when reuseKb is false', async () => {
    const env = await createKbHarness();
    await writeFile(env.ctx.paths.kbDbFile, 'existing-kb');

    const result = await buildKbIndex(env.flowCtx);

    expect(result.success).toBe(true);
    expect(loreMocks.getLoreMeta).not.toHaveBeenCalled();
    expect(loreMocks.build).toHaveBeenCalledOnce();
  });

  it('rejects Lore widening indexer execution from a separate build grant', async () => {
    const env = await createKbHarness({
      options: {
        kbIndex: {
          execution: {
            allowSubprocessExecution: false,
            allowBuildExecution: true,
          },
        },
      },
    });
    loreMocks.resolveConfiguration.mockResolvedValue({
      scip: { enabled: true },
      scipScope: scipScopeFor(env),
      lsp: null,
      execution: {
        ...executionFor(env),
        allowIndexerExecution: true,
        allowLspExecution: false,
      },
    });

    await expect(buildKbIndex(env.flowCtx)).rejects.toThrow(
      'Lore widened process execution beyond options.kbIndex.execution.allowSubprocessExecution',
    );

    expect(loreMocks.build).not.toHaveBeenCalled();
    expect(lifecycleMocks.startKbServer).not.toHaveBeenCalled();
  });

  it('uses trusted source scope while authorizing only built-in SCIP subprocesses', async () => {
    const env = await createKbHarness({
      source: {
        language: 'c',
        languages: ['c', 'cpp'],
        branch: 'release',
        includePatterns: ['lib/**/*.{c,h}', 'programs/**/*.{c,h}'],
        excludePatterns: ['vendor'],
      },
      target: { language: 'python' },
      options: {
        kbIndex: {
          logLevel: 'info',
          embeddings: { enabled: true, model: 'test/embedding-model' },
          lsp: { enabled: false },
          execution: { allowSubprocessExecution: true },
          validation: {
            requiredSymbols: [
              { name: 'create', path: 'lib/create.c', kind: 'function' },
              { name: 'create_advanced', path: 'lib/create.c', kind: 'function' },
            ],
            requiredCalls: [{
              caller: { name: 'create', path: 'lib/create.c', kind: 'function' },
              callee: { name: 'create_advanced', path: 'lib/create.c', kind: 'function' },
              resolutionMethod: 'scip_definition',
            }],
          },
        },
      },
    });
    loreMocks.loadScipSettingsFromLoreConfig.mockReturnValue({
      scipScope: { languages: ['python'], includeGlobs: ['scripts/**'] },
    });
    loreMocks.getLoreMeta.mockImplementation((_db, key) => {
      if (key === 'embedding_model') return 'test/embedding-model';
      if (key === 'embedding_dims') return '768';
      return undefined;
    });

    const result = await buildKbIndex(env.flowCtx);

    expect(result.success).toBe(true);
    expect(loreMocks.providerConstructor).toHaveBeenCalledWith('test/embedding-model');
    expect(loreMocks.indexBuilderConstructor).toHaveBeenCalledWith(
      candidatePathFor(env),
      walkerConfigFor(env),
      expect.objectContaining({ dims: 768 }),
      {
        scip: true,
        scipScope: scipScopeFor(env),
        lsp: false,
        embeddings: true,
        execution: executionFor(env),
        validation: migrationGradePolicy(env),
      },
    );
    expect(scipScopeFor(env).languages).toEqual(['c', 'cpp']);
    expect(scipScopeFor(env).languages).not.toContain(env.ctx.config.target.language);
    expect(scipScopeFor(env).includeGlobs).toEqual([
      'lib/**/*.{c,h}',
      'programs/**/*.{c,h}',
    ]);
    expect(migrationGradePolicy(env).requiredCalls).toEqual([
      expect.objectContaining({ resolutionMethod: 'scip_definition' }),
    ]);
    expect(executionFor(env)).toMatchObject({
      allowSubprocessExecution: true,
      allowBuildExecution: false,
      allowCustomIndexerCommands: false,
      allowCustomLspCommands: false,
      allowAutoInstall: false,
    });
    expect(loreMocks.initLogger).toHaveBeenCalledWith({
      level: 20,
      logFile: env.ctx.paths.loreLogFile,
    });
    expect(loreMocks.setLoreMeta).toHaveBeenCalledWith(
      expect.anything(),
      'aamf_index_fingerprint_v2',
      expect.stringMatching(/^[a-f0-9]{64}$/),
    );
    expect(lifecycleMocks.startKbServer).toHaveBeenCalledOnce();
  });

  it('disposes a failed configured embedding provider and halts before indexing', async () => {
    const env = await createKbHarness({
      options: {
        kbIndex: {
          embeddings: { enabled: true, model: 'broken/model' },
        },
      },
    });
    loreMocks.providerInit.mockRejectedValue('model unavailable');
    loreMocks.providerDispose.mockRejectedValue(new Error('dispose failed'));

    await expect(buildKbIndex(env.flowCtx)).rejects.toThrow(
      'Embedding initialization failed for configured model broken/model: model unavailable',
    );

    expect(loreMocks.providerDispose).toHaveBeenCalledOnce();
    expect(env.ctx.embedder).toBeUndefined();
    expect(loreMocks.indexBuilderConstructor).not.toHaveBeenCalled();
    expect(lifecycleMocks.startKbServer).not.toHaveBeenCalled();
  });

  it('rebuilds when a reusable database cannot be opened', async () => {
    const env = await createKbHarness({ options: { reuseKb: true } });
    await writeFile(env.ctx.paths.kbDbFile, 'corrupt');
    loreMocks.openDb
      .mockImplementationOnce(() => { throw new Error('corrupt database'); })
      .mockImplementation(() => ({ close: loreMocks.closeDb }));

    const result = await buildKbIndex(env.flowCtx);

    expect(result.success).toBe(true);
    expect(loreMocks.build).toHaveBeenCalledOnce();
  });

  it('preserves the last valid KB when a candidate fails validation', async () => {
    const env = await createKbHarness();
    await writeFile(env.ctx.paths.kbDbFile, 'last-valid-kb');
    const report = {
      ...healthyReport(),
      ok: false,
      status: 'invalid',
      errors: [{
        severity: 'error',
        code: 'REQUIRED_CALL_MISSING',
        message: 'A required call edge is absent.',
      }],
    };
    loreMocks.build.mockImplementation(async (dbPath: string) => {
      await writeFile(dbPath, 'failed-candidate');
      throw Object.assign(new Error('Index validation failed'), { report });
    });

    await expect(buildKbIndex(env.flowCtx)).rejects.toThrow('Index validation failed');

    await expect(readFile(env.ctx.paths.kbDbFile, 'utf8')).resolves.toBe('last-valid-kb');
    await expect(readFile(candidatePathFor(env), 'utf8')).resolves.toBe('failed-candidate');
    expect(loreMocks.setLoreMeta).not.toHaveBeenCalled();
    expect(lifecycleMocks.startKbServer).not.toHaveBeenCalled();
  });

  it('rejects source changes during indexing and preserves the last valid KB', async () => {
    const env = await createKbHarness();
    const sourceRoot = join(env.tempDir, 'source');
    const sourceFile = join(sourceRoot, 'main.py');
    await writeFile(sourceFile, 'VALUE = 1\n');
    await writeFile(env.ctx.paths.kbDbFile, 'last-valid-kb');
    loreMocks.walkFiles.mockResolvedValue([{ path: sourceFile, language: 'python' }]);
    loreMocks.build.mockImplementation(async (dbPath: string) => {
      await writeFile(dbPath, 'stale-candidate');
      await writeFile(sourceFile, 'VALUE = 2\n');
    });

    await expect(buildKbIndex(env.flowCtx)).rejects.toThrow(
      'KB immutable source, revision, configuration, or tool inputs changed during indexing',
    );

    await expect(readFile(env.ctx.paths.kbDbFile, 'utf8')).resolves.toBe('last-valid-kb');
    expect(loreMocks.validateIndex).not.toHaveBeenCalled();
    expect(loreMocks.setLoreMeta).not.toHaveBeenCalled();
    expect(lifecycleMocks.startKbServer).not.toHaveBeenCalled();
  });

  it('rejects precomputed C indexes that lack native compiler evidence', async () => {
    const env = await createKbHarness({
      source: { language: 'c', languages: ['c'], includePatterns: ['src/**/*.{c,h}'] },
      options: { kbIndex: { execution: { allowSubprocessExecution: true } } },
    });
    await writeFile(env.ctx.paths.kbDbFile, 'last-valid-kb');
    loreMocks.validateIndex.mockReturnValue({
      ...healthyReport(),
      ok: true,
      status: 'degraded',
      provenance: {
        compilationDatabases: [],
        scipScope: {
          languageCounts: { c: 2 },
        },
        indexers: [{
          provider: 'scip',
          indexer: 'scip-clang',
          languages: ['c'],
          status: 'succeeded',
          attempted: false,
          fallback: false,
          files: 2,
          symbols: 4,
          callRefs: 2,
          typeRefs: 1,
          imports: 0,
          message: null,
          details: { source: 'precomputed' },
          runId: 'precomputed-run',
        }],
        diagnostics: { compiler: [], positionConversions: [], supplementation: [] },
      },
      warnings: [{
        severity: 'warning',
        code: 'SCIP_COMPILER_DIAGNOSTICS_UNVERIFIED',
        message: 'Precomputed SCIP data has no verified compiler-output history.',
      }],
    });

    await expect(buildKbIndex(env.flowCtx)).rejects.toThrow(
      'SCIP_COMPILER_DIAGNOSTICS_UNVERIFIED',
    );

    await expect(readFile(env.ctx.paths.kbDbFile, 'utf8')).resolves.toBe('last-valid-kb');
    expect(loreMocks.setLoreMeta).not.toHaveBeenCalled();
    expect(lifecycleMocks.startKbServer).not.toHaveBeenCalled();
  });

  it('rebuilds a matching cached index that fails migration-grade validation', async () => {
    const env = await createKbHarness({ options: { reuseKb: true } });
    await writeFile(env.ctx.paths.kbDbFile, 'degraded-kb');
    loreMocks.getLoreMeta.mockReturnValue(await fingerprintFor(env));
    loreMocks.validateIndex
      .mockReturnValueOnce({
        ...healthyReport(),
        ok: false,
        status: 'degraded',
        errors: [{
          severity: 'error',
          code: 'BASELINE_RUN_FALLBACK_DEGRADED',
          message: 'Latest baseline used a degraded fallback.',
        }],
      })
      .mockReturnValue(healthyReport());

    await expect(buildKbIndex(env.flowCtx)).resolves.toMatchObject({ success: true });

    expect(loreMocks.build).toHaveBeenCalledOnce();
    expect(loreMocks.validateIndex).toHaveBeenCalledTimes(2);
  });

  it('retries a failed index build only after the retry delay', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
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
      .mockImplementationOnce(async (dbPath: string) => {
        await writeFile(dbPath, 'candidate-kb');
      });

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
    await writeFile(env.ctx.paths.kbDbFile, 'last-valid-kb');
    loreMocks.build.mockRejectedValue('permanent index failure');

    await expect(buildKbIndex(env.flowCtx)).rejects.toThrow(
      'Phase 0 (KB Indexing) failed: permanent index failure',
    );
    await expect(readFile(env.ctx.paths.kbDbFile, 'utf8')).resolves.toBe('last-valid-kb');
    expect(lifecycleMocks.startKbServer).not.toHaveBeenCalled();
  });

  it('rejects a fulfilled build whose persisted index is degraded', async () => {
    const env = await createKbHarness({ options: { maxRetriesPerTask: 3 } });
    loreMocks.validateIndex.mockReturnValue({
      ...healthyReport(),
      ok: false,
      status: 'degraded',
      errors: [{
        severity: 'error',
        code: 'BASELINE_RUN_FALLBACK_DEGRADED',
        message: 'Latest baseline used a degraded fallback.',
      }],
    });

    await expect(buildKbIndex(env.flowCtx)).rejects.toThrow(
      'BASELINE_RUN_FALLBACK_DEGRADED',
    );

    expect(loreMocks.build).toHaveBeenCalledOnce();
    expect(loreMocks.setLoreMeta).not.toHaveBeenCalled();
    expect(lifecycleMocks.startKbServer).not.toHaveBeenCalled();
    expect(env.checkpoint.getState().phase0Fingerprint).toBeUndefined();
  });

  it('rejects and logs a SCIP build denied by host execution policy', async () => {
    const env = await createKbHarness({ options: { maxRetriesPerTask: 3 } });
    const report = {
      ...healthyReport(),
      ok: false,
      status: 'invalid',
      provenance: {
        compilationDatabases: [],
        indexers: [{
          provider: 'scip',
          indexer: 'scip-clang',
          status: 'skipped',
          attempted: false,
          fallback: true,
          files: null,
          symbols: null,
          callRefs: null,
          typeRefs: null,
          imports: null,
          message: 'execution denied by host policy',
          details: { allowIndexerExecution: false },
        }],
        diagnostics: { compiler: [], positionConversions: [], supplementation: [] },
      },
      errors: [{
        severity: 'error',
        code: 'STRUCTURAL_INDEX_MISSING',
        message: 'No successful structural indexer run is available.',
      }],
    };
    loreMocks.build.mockRejectedValue(Object.assign(
      new Error('Index validation failed'),
      { report },
    ));
    const warn = vi.spyOn(env.ctx.logger, 'warn');

    await expect(buildKbIndex(env.flowCtx)).rejects.toThrow('Index validation failed');

    expect(loreMocks.build).toHaveBeenCalledOnce();
    expect(loreMocks.indexBuilderConstructor).toHaveBeenCalledWith(
      candidatePathFor(env),
      walkerConfigFor(env),
      undefined,
      expect.objectContaining({
        lsp: false,
        execution: executionFor(env),
      }),
    );
    expect(executionFor(env).allowSubprocessExecution).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('execution denied by host policy'));
    expect(lifecycleMocks.startKbServer).not.toHaveBeenCalled();
  });
});
