import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accessSync, constants, existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import {
  discoverCompilationDatabase,
  killAllTracked,
  listFiles,
  listResolvedEdges,
  listSymbols,
  listTypeRefs,
  openReadOnly,
  trackedCount,
  validateIndex,
  type IndexValidationPolicy,
  type ScipScope,
  type WalkerConfig,
} from '@jafreck/lore';
import { loadConfig } from '../../src/config/loader.js';
import type { MigrationConfig } from '../../src/config/schema.js';
import { buildTaskGraph } from '../../src/core/task-graph-builder.js';
import { buildKbIndex } from '../../src/flow/steps/kb-indexing.js';
import {
  createMockLauncher,
  setupFlowTest,
  type FlowTestEnv,
} from '../helpers/flow-mocks.js';

function executableAvailable(command: string): boolean {
  const candidates = [
    join(homedir(), '.lore', 'bin', command),
    ...(process.env.PATH ?? '').split(delimiter)
      .filter(pathEntry => pathEntry.length > 0)
      .map(pathEntry => join(pathEntry, command)),
  ];
  return candidates.some(candidate => {
    try {
      accessSync(candidate, constants.X_OK);
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

const fixtureRoot = resolve(
  import.meta.dirname ?? new URL('.', import.meta.url).pathname,
  '../fixtures/zstd-c-project',
);
const fixtureSourceRoot = join(fixtureRoot, 'zstd-src', 'zstd-1.5.7');
const runRequested = process.env.RUN_ZSTD_SCIP_INDEXING === '1';

describe.runIf(runRequested)('zstd SCIP indexing and task graph', () => {
  let config: MigrationConfig;
  let env: FlowTestEnv;

  beforeAll(async () => {
    if (!executableAvailable('scip-clang')) {
      throw new Error('RUN_ZSTD_SCIP_INDEXING=1 requires scip-clang on PATH or in ~/.lore/bin');
    }
    if (!existsSync(fixtureSourceRoot)) {
      throw new Error(`RUN_ZSTD_SCIP_INDEXING=1 requires the zstd source at ${fixtureSourceRoot}`);
    }
    if (!existsSync(join(fixtureSourceRoot, 'compile_commands.json'))) {
      throw new Error('RUN_ZSTD_SCIP_INDEXING=1 requires a current compdb; run npm run test:zstd-scip');
    }
    config = await loadConfig(join(fixtureRoot, 'migration.config.json'));
    env = await setupFlowTest(createMockLauncher(), {
      projectName: config.projectName,
      guidance: config.guidance,
      source: config.source,
      target: {
        language: config.target.language,
        framework: config.target.framework,
      },
      options: {
        ...config.options,
        maxRetriesPerTask: 1,
        reuseKb: false,
        git: { ...config.options.git, enabled: false },
      },
      agentBackend: {
        ...config.agentBackend,
        phaseTimeouts: { ...config.agentBackend.phaseTimeouts, 0: 20 * 60_000 },
      },
    });
  });

  afterAll(async () => {
    await env?.ctx.kbServer?.stop();
    killAllTracked();
    await env?.cleanup();
  });

  it('certifies the declared native source scope through AAMF Phase 0', async () => {
    const sourceRoot = realpathSync(resolve(fixtureRoot, config.source.path));
    const dbPath = env.ctx.paths.kbDbFile;
    const compdb = discoverCompilationDatabase(sourceRoot);
    expect(compdb.database?.validation).toMatchObject({
      valid: true,
      missingFiles: 0,
      missingDirectories: 0,
      entriesOutsideApprovedRoots: 0,
    });

    await expect(buildKbIndex(env.flowCtx)).resolves.toMatchObject({
      phase: 0,
      success: true,
      outputPath: dbPath,
    });

    const walkerConfig: WalkerConfig = {
      rootDir: sourceRoot,
      branch: config.source.branch,
      includeGlobs: config.source.includePatterns,
      excludeGlobs: config.source.excludePatterns,
    };
    const scipScope: ScipScope = {
      languages: config.source.languages ?? [config.source.language],
      includeGlobs: config.source.includePatterns,
      excludeGlobs: config.source.excludePatterns,
    };
    const configuredValidation = config.options.kbIndex?.validation;
    const validationPolicy: IndexValidationPolicy = {
      profile: 'migration-grade',
      includeGlobs: config.source.includePatterns,
      excludeGlobs: config.source.excludePatterns,
      requiredGlobs: [...new Set([
        ...(config.source.entryPoints ?? []),
        ...(configuredValidation?.requiredGlobs ?? []),
      ])],
      thresholds: {
        minCallRefs: 1,
        maxSymbolLessFiles: 0,
        ...configuredValidation?.thresholds,
      },
      requireStructuralIndex: true,
      requireValidSpans: true,
      requireIndexerSuccess: true,
      requireProvenance: true,
      requiredSymbols: configuredValidation?.requiredSymbols,
      requiredCalls: configuredValidation?.requiredCalls,
      languages: configuredValidation?.languages,
      failOnWarnings: configuredValidation?.failOnWarnings,
      maxBaselineAgeSeconds: configuredValidation?.maxBaselineAgeSeconds,
      maxDirtyFiles: configuredValidation?.maxDirtyFiles,
    };
    const report = validateIndex(dbPath, {
      rootDir: sourceRoot,
      branch: config.source.branch,
      walkerConfig,
      scipScope,
      policy: validationPolicy,
    });
    expect(report.ok).toBe(true);
    expect(report.provenance.latestBaselineRun).toMatchObject({
      status: 'succeeded',
      fallbackDegraded: false,
    });
    expect(report.provenance.indexers).toEqual(expect.arrayContaining([
      expect.objectContaining({ indexer: 'scip-clang', status: 'succeeded', attempted: true }),
      expect.objectContaining({ indexer: 'lsp', status: 'disabled', attempted: false }),
    ]));
    expect(report.provenance.indexers.some(row =>
      row.indexer.includes('scip-python') && row.attempted)).toBe(false);
    expect(report.provenance.indexers.filter(row => row.provider === 'lsp')
      .every(row => !row.attempted)).toBe(true);
    expect(report.selection.requiredGlobs).toEqual(config.source.entryPoints);

    const resolvedScope = report.provenance.scipScope;
    expect(resolvedScope).toBeTruthy();
    expect(resolvedScope?.requested.languages).toEqual(['c', 'cpp']);
    expect(resolvedScope?.effectiveFiles).toHaveLength(report.selection.selectedFiles);
    expect(resolvedScope?.effectiveFiles.some(file =>
      file.path === 'programs/windres/verrsrc.h')).toBe(true);
    expect(resolvedScope?.effectiveFiles.every(file =>
      (file.path.startsWith('lib/') || file.path.startsWith('programs/')) &&
      (file.language === 'c' || file.language === 'cpp'))).toBe(true);

    const attemptedScip = report.provenance.indexers.filter(row =>
      row.provider === 'scip' && row.attempted);
    expect(attemptedScip.length).toBeGreaterThan(0);
    const providerCoveredFiles = new Set<string>();
    for (const row of attemptedScip) {
      const details = row.details as {
        coveredFiles?: string[];
        compilerDiagnostics?: {
          requested: boolean;
          complete: boolean;
          summary: { errors: number; failedTranslationUnits: number; skippedTranslationUnits: number };
        };
      };
      for (const coveredFile of details.coveredFiles ?? []) {
        providerCoveredFiles.add(coveredFile);
      }
      expect(details.compilerDiagnostics).toMatchObject({
        requested: true,
        complete: true,
        summary: { errors: 0, failedTranslationUnits: 0, skippedTranslationUnits: 0 },
      });
    }
    expect(resolvedScope?.effectiveFiles.every(file =>
      providerCoveredFiles.has(file.path))).toBe(true);
    expect(report.provenance.diagnostics.compiler.length).toBeGreaterThan(0);
    for (const diagnostic of report.provenance.diagnostics.compiler) {
      expect(diagnostic.details).toMatchObject({
        compilerDiagnostics: {
          requested: true,
          complete: true,
          summary: { errors: 0, failedTranslationUnits: 0, skippedTranslationUnits: 0 },
        },
      });
    }

    const db = openReadOnly(dbPath);
    let counts: {
      files: number;
      symbols: number;
      nonMacroCSymbols: number;
      callRefs: number;
      resolvedCallRefs: number;
      typeRefs: number;
    };
    try {
      const files = listFiles(db);
      const symbols = listSymbols(db, { limit: 100_000 });
      const resolvedEdges = listResolvedEdges(db, { resolvedOnly: true, limit: 100_000 });
      const allEdges = listResolvedEdges(db, { limit: 100_000 });
      const typeRefs = listTypeRefs(db, { limit: 100_000 });
      const cFileIds = new Set(files.filter(file => file.language === 'c').map(file => file.id));
      const knownEdge = resolvedEdges.find(edge =>
        edge.caller_name === 'ZSTD_createCCtx' &&
        edge.callee_name === 'ZSTD_createCCtx_advanced' &&
        edge.caller_file_path === join(sourceRoot, 'lib/compress/zstd_compress.c') &&
        edge.callee_file_path === join(sourceRoot, 'lib/compress/zstd_compress.c'));
      expect(knownEdge).toMatchObject({ resolution_method: 'scip_definition' });

      counts = {
        files: files.length,
        symbols: symbols.length,
        nonMacroCSymbols: symbols.filter(symbol =>
          cFileIds.has(symbol.file_id) && symbol.kind !== 'macro').length,
        callRefs: allEdges.length,
        resolvedCallRefs: resolvedEdges.length,
        typeRefs: typeRefs.length,
      };
      expect(counts.nonMacroCSymbols).toBeGreaterThan(0);
      expect(counts.resolvedCallRefs).toBeGreaterThan(0);
    } finally {
      db.close();
    }

    const graphOptions = {
      kbDbPath: dbPath,
      sourceRoot,
      maxLinesPerTask: config.options.maxLinesPerTask,
      targetLanguage: config.target.language,
      outputPath: config.target.outputPath,
    };
    const firstGraph = await buildTaskGraph(graphOptions);
    const secondGraph = await buildTaskGraph(graphOptions);
    expect(secondGraph).toEqual(firstGraph);
    const taskDependencies = firstGraph.tasks.reduce(
      (total, task) => total + task.dependencies.length,
      0,
    );
    expect(taskDependencies).toBeGreaterThan(0);
    expect(trackedCount()).toBe(0);

    console.log(JSON.stringify({
      ...counts,
      tasks: firstGraph.tasks.length,
      taskDependencies,
      validationOk: report.ok,
      validationStatus: report.status,
      validationWarnings: report.warnings.map(warning => warning.code),
      scopeHash: resolvedScope?.scopeHash,
      languageCounts: resolvedScope?.languageCounts,
      compilerDiagnostics: report.provenance.diagnostics.compiler.map(row => row.details),
      scipClang: report.provenance.indexers.find(row => row.indexer === 'scip-clang'),
    }, null, 2));
  }, 20 * 60_000);
});