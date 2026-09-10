/**
 * Phase 0 — KB Indexing (deterministic)
 *
 * Builds the local knowledge-base SQLite index from the source directory.
 * Includes retry logic, fingerprint caching, and embedding setup.
 */

import { delimiter, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants, createReadStream } from 'node:fs';
import { access, readFile, realpath, rename, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import fg from 'fast-glob';
import type { FlowExecutionContext } from '@cadre-dev/framework/flow';
import type {
  IndexExecutionOptions,
  IndexHealthReport,
  IndexHealthIssue,
  IndexValidationPolicy,
  ScipScope,
  ValidateIndexOptions,
  WalkerConfig,
} from '@jafreck/lore';
import type { MigrationFlowContext } from '../context.js';
import type { PhaseResult } from '../../agents/types.js';
import { assertPhaseSuccess } from './shared.js';
import { startKbServer } from './kb-server-lifecycle.js';
import { fileExists } from '../../util/fs.js';

const loadLore = () => import('@jafreck/lore');
type LoreModule = Awaited<ReturnType<typeof loadLore>>;
const execFileAsync = promisify(execFile);

const DEFAULT_INDEX_TIMEOUT_MS = 5 * 60_000;
const LORE_VERSION = '0.4.2';
const AAMF_INDEX_FINGERPRINT_KEY = 'aamf_index_fingerprint_v2';
const COMPILATION_DATABASE_PATHS = [
  'compile_commands.json',
  'build/compile_commands.json',
  'builddir/compile_commands.json',
  '.lore-compdb/compile_commands.json',
] as const;
const SCIP_CONFIGURATION_PATHS = [
  '.lore.config',
  'package.json',
  'tsconfig.json',
  'setup.py',
  'pyproject.toml',
  'requirements.txt',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'Cargo.toml',
  'Makefile',
  'CMakeLists.txt',
  'meson.build',
  'configure',
  'configure.ac',
  'Gemfile',
  'go.mod',
  'composer.json',
  'pubspec.yaml',
] as const;
const INDEX_VALIDATION_POLICY = {
  profile: 'migration-grade' as const,
  thresholds: { minCallRefs: 1, maxSymbolLessFiles: 0 },
  requireStructuralIndex: true,
  requireValidSpans: true,
  requireIndexerSuccess: true,
  requireProvenance: true,
} satisfies IndexValidationPolicy;

function stableJson(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (!input || typeof input !== 'object') return input;
    return Object.fromEntries(
      Object.entries(input)
        .filter(([, nested]) => nested !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, normalize(nested)]),
    );
  };
  return JSON.stringify(normalize(value));
}

function isPathWithin(rootDir: string, candidate: string): boolean {
  const pathFromRoot = relative(rootDir, candidate);
  return pathFromRoot === '' || (
    !isAbsolute(pathFromRoot) &&
    pathFromRoot !== '..' &&
    !pathFromRoot.startsWith(`..${sep}`)
  );
}

interface SourceRevision {
  repositoryRoot: string;
  sourcePath: string;
  headSha: string;
}

async function resolveSourceRevision(rootDir: string): Promise<SourceRevision | null> {
  try {
    const [{ stdout: repositoryRootOutput }, { stdout: headOutput }] = await Promise.all([
      execFileAsync('git', ['-C', rootDir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }),
      execFileAsync('git', ['-C', rootDir, 'rev-parse', '--verify', 'HEAD'], { encoding: 'utf8' }),
    ]);
    const repositoryRoot = await realpath(repositoryRootOutput.trim());
    const canonicalRoot = await realpath(rootDir);
    if (!isPathWithin(repositoryRoot, canonicalRoot)) return null;
    return {
      repositoryRoot,
      sourcePath: relative(repositoryRoot, canonicalRoot).replaceAll('\\', '/'),
      headSha: headOutput.trim(),
    };
  } catch {
    return null;
  }
}

interface KbFingerprintOptions {
  /** Ignore only generated identities covered by explicit build/install grants. */
  stabilityCheck?: boolean;
}

export class KbIndexTimeoutError extends Error {
  constructor(timeoutMs: number, lspEnabled: boolean) {
    super(lspEnabled
      ? `KB index timed out after ${Math.round(timeoutMs / 1000)}s — LSP may be stalled.`
      : `KB index timed out after ${Math.round(timeoutMs / 1000)}s`);
    this.name = 'KbIndexTimeoutError';
  }
}

/**
 * Run one non-cancellable Lore build with a diagnostic deadline. If the
 * deadline wins, wait for the build to settle before returning the timeout so
 * callers can safely delete/recreate SQLite files for a retry.
 */
export async function runKbBuildAttempt(
  build: () => Promise<void>,
  timeoutMs: number,
  lspEnabled: boolean,
  onHeartbeat: () => void,
): Promise<void> {
  let settled = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let heartbeatHandle: ReturnType<typeof setTimeout> | undefined;
  const buildPromise = build().then(
    () => { settled = true; },
    (error) => { settled = true; throw error; },
  );

  try {
    heartbeatHandle = setTimeout(onHeartbeat, Math.max(1, Math.round(timeoutMs / 2)));
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new KbIndexTimeoutError(timeoutMs, lspEnabled)),
        timeoutMs,
      );
    });
    await Promise.race([buildPromise, timeoutPromise]);
  } catch (error) {
    if (!settled) await Promise.allSettled([buildPromise]);
    throw error;
  } finally {
    if (heartbeatHandle) clearTimeout(heartbeatHandle);
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

export async function computeKbInputFingerprint(
  rootDir: string,
  walkerConfig: WalkerConfig,
  indexConfiguration: unknown,
  options: KbFingerprintOptions = {},
): Promise<string> {
  const lore = await loadLore();
  const canonicalRoot = await realpath(rootDir);
  const normalizedWalkerConfig = { ...walkerConfig, rootDir: canonicalRoot };
  const execution = fingerprintExecution(indexConfiguration);
  const ignoreGeneratedCompdb = options.stabilityCheck === true &&
    execution.allowBuildExecution === true;
  const ignoreInstalledIndexers = options.stabilityCheck === true &&
    execution.allowAutoInstall === true;
  const approvedExternalRoots = await Promise.all(
    (execution.allowedCwdRoots ?? []).map(async root => {
      const absoluteRoot = resolve(root);
      return await fileExists(absoluteRoot) ? realpath(absoluteRoot) : absoluteRoot;
    }),
  );
  const hash = createHash('sha256');
  hash.update('aamf-lore-index-v2\0');
  hash.update(stableJson({
    rootDir: canonicalRoot,
    sourceRevision: await resolveSourceRevision(canonicalRoot),
    walkerConfig: normalizedWalkerConfig,
    indexConfiguration,
    stabilityCheck: options.stabilityCheck === true,
  }));

  const indexedInputs = new Map<string, string>();
  const addInput = async (
    candidate: string,
    options: { rejectExternalTarget?: boolean; allowApprovedExternalTarget?: boolean } = {},
  ): Promise<void> => {
    if (!(await fileExists(candidate))) return;
    const canonicalPath = await realpath(candidate);
    const insideRoot = isPathWithin(canonicalRoot, canonicalPath);
    const insideApprovedRoot = options.allowApprovedExternalTarget &&
      approvedExternalRoots.some(root => isPathWithin(root, canonicalPath));
    if (!insideRoot && !insideApprovedRoot) {
      if (options.rejectExternalTarget) {
        throw new Error(
          `Compilation database must resolve inside the source root: ${candidate} -> ${canonicalPath}`,
        );
      }
      return;
    }
    const inputKey = insideRoot
      ? relative(canonicalRoot, canonicalPath).replaceAll('\\', '/')
      : `@external/${canonicalPath.replaceAll('\\', '/')}`;
    indexedInputs.set(inputKey, canonicalPath);
  };

  const discoveredFiles = await lore.walkFiles(normalizedWalkerConfig);
  for (const file of discoveredFiles) await addInput(file.path);

  const compilationDatabase = lore.discoverCompilationDatabase(canonicalRoot, undefined, {
    approvedExternalRoots,
  });
  const toolchains = !ignoreGeneratedCompdb && compilationDatabase.database
    ? await collectToolchainIdentities(compilationDatabase.database.entries)
    : [];
  const indexers = ignoreInstalledIndexers
    ? []
    : await collectIndexerIdentities(lore, canonicalRoot, indexConfiguration);
  hash.update(stableJson({
    compilationDatabase: !ignoreGeneratedCompdb && compilationDatabase.database ? {
      path: isPathWithin(canonicalRoot, compilationDatabase.database.path)
        ? relative(canonicalRoot, compilationDatabase.database.path)
        : compilationDatabase.database.path,
      sha256: compilationDatabase.database.sha256,
      validation: compilationDatabase.database.validation,
      entries: compilationDatabase.database.entries.map(entry => ({
        filePath: entry.filePath,
        workingDirectory: entry.workingDirectory,
        arguments: entry.arguments,
        includePaths: entry.includePaths,
        language: entry.language,
        responseFiles: entry.responseFiles,
      })),
    } : null,
    candidates: ignoreGeneratedCompdb ? [] : compilationDatabase.candidates,
    toolchains,
    indexers,
  }));
  if (!ignoreGeneratedCompdb && compilationDatabase.database) {
    await addInput(compilationDatabase.database.path, {
      rejectExternalTarget: true,
      allowApprovedExternalTarget: true,
    });
  }
  for (const relativePath of SCIP_CONFIGURATION_PATHS) {
    await addInput(resolve(canonicalRoot, relativePath), { rejectExternalTarget: true });
  }
  for (const relativePath of COMPILATION_DATABASE_PATHS) {
    if (ignoreGeneratedCompdb) continue;
    await addInput(resolve(canonicalRoot, relativePath), {
      rejectExternalTarget: true,
      allowApprovedExternalTarget: true,
    });
  }

  const scipSettings = lore.loadScipSettingsFromLoreConfig(canonicalRoot);
  if (scipSettings.indexDir) {
    const requestedIndexDir = resolve(canonicalRoot, scipSettings.indexDir);
    if (await fileExists(requestedIndexDir)) {
      const canonicalIndexDir = await realpath(requestedIndexDir);
      const indexDirAllowed = isPathWithin(canonicalRoot, canonicalIndexDir) ||
        approvedExternalRoots.some(root => isPathWithin(root, canonicalIndexDir));
      if (!indexDirAllowed) {
        throw new Error(
          `Precomputed SCIP directory must resolve inside an approved root: ` +
          `${requestedIndexDir} -> ${canonicalIndexDir}`,
        );
      }
      const precomputedIndexes = await fg('*.scip', {
        cwd: canonicalIndexDir,
        absolute: true,
        onlyFiles: true,
        followSymbolicLinks: true,
      });
      for (const indexPath of precomputedIndexes) {
        await addInput(indexPath, {
          rejectExternalTarget: true,
          allowApprovedExternalTarget: true,
        });
      }
    }
  }

  for (const [relativePath, absolutePath] of [...indexedInputs].sort(([a], [b]) => a.localeCompare(b))) {
    const contents = await readFile(absolutePath);
    hash.update(`\0${relativePath.length}:${relativePath}:${contents.byteLength}:`);
    hash.update(contents);
  }
  return hash.digest('hex');
}

interface ToolchainIdentity {
  command: string;
  resolvedPath: string | null;
  size: number | null;
  mtimeMs: number | null;
  sha256: string | null;
}

interface IndexerIdentity extends ToolchainIdentity {
  language: string;
  args: string[];
  cwd: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function fingerprintScope(indexConfiguration: unknown): ScipScope | undefined {
  if (!isRecord(indexConfiguration) || !isRecord(indexConfiguration.scipScope)) return undefined;
  const scope = indexConfiguration.scipScope;
  if (!Array.isArray(scope.languages) ||
      !scope.languages.every(language => typeof language === 'string')) return undefined;
  const includeGlobs = Array.isArray(scope.includeGlobs) &&
    scope.includeGlobs.every(glob => typeof glob === 'string')
    ? scope.includeGlobs as string[] : undefined;
  const excludeGlobs = Array.isArray(scope.excludeGlobs) &&
    scope.excludeGlobs.every(glob => typeof glob === 'string')
    ? scope.excludeGlobs as string[] : undefined;
  return {
    languages: scope.languages as string[],
    ...(includeGlobs ? { includeGlobs } : {}),
    ...(excludeGlobs ? { excludeGlobs } : {}),
  };
}

function fingerprintExecution(indexConfiguration: unknown): IndexExecutionOptions {
  if (!isRecord(indexConfiguration) || !isRecord(indexConfiguration.execution)) return {};
  const execution = indexConfiguration.execution;
  const boolean = (key: string): boolean | undefined =>
    typeof execution[key] === 'boolean' ? execution[key] : undefined;
  const allowedCwdRoots = Array.isArray(execution.allowedCwdRoots) &&
    execution.allowedCwdRoots.every(root => typeof root === 'string')
    ? execution.allowedCwdRoots as string[] : undefined;
  return {
    allowSubprocessExecution: boolean('allowSubprocessExecution'),
    allowBuildExecution: boolean('allowBuildExecution'),
    allowCustomIndexerCommands: boolean('allowCustomIndexerCommands'),
    allowCustomLspCommands: boolean('allowCustomLspCommands'),
    allowAutoInstall: boolean('allowAutoInstall'),
    ...(allowedCwdRoots ? { allowedCwdRoots } : {}),
  };
}

async function collectIndexerIdentities(
  lore: LoreModule,
  rootDir: string,
  indexConfiguration: unknown,
): Promise<IndexerIdentity[]> {
  const scope = fingerprintScope(indexConfiguration);
  if (!scope) return [];
  const settings = lore.resolveEffectiveScipSettings(
    lore.loadScipSettingsFromLoreConfig(rootDir),
    { enabled: true },
    fingerprintExecution(indexConfiguration),
  );
  const identities: IndexerIdentity[] = [];
  for (const language of [...new Set(scope.languages)].sort()) {
    const indexer = settings.indexers[language];
    if (!indexer) continue;
    const cwd = indexer.cwd ? resolve(rootDir, indexer.cwd) : rootDir;
    const executable = await resolveExecutableIdentity(indexer.command, cwd, true);
    identities.push({
      language,
      args: [...indexer.args],
      cwd,
      ...executable,
    });
  }
  return identities;
}

async function collectToolchainIdentities(
  entries: Array<{ arguments: string[]; workingDirectory: string }>,
): Promise<ToolchainIdentity[]> {
  const commands = new Map<string, string>();
  for (const entry of entries) {
    const command = entry.arguments[0];
    if (command) commands.set(`${command}\0${entry.workingDirectory}`, entry.workingDirectory);
  }

  const identities: ToolchainIdentity[] = [];
  for (const key of [...commands.keys()].sort()) {
    const separator = key.indexOf('\0');
    const command = key.slice(0, separator);
    const workingDirectory = commands.get(key)!;
    identities.push(await resolveExecutableIdentity(command, workingDirectory, false));
  }
  return identities;
}

function executableCandidates(
  command: string,
  workingDirectory: string,
  includeLoreLocations: boolean,
): string[] {
  if (isAbsolute(command) || command.includes('/') || command.includes('\\')) {
    return [isAbsolute(command) ? command : resolve(workingDirectory, command)];
  }
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
    : [''];
  const directories = [
    ...(includeLoreLocations ? [
      resolve(homedir(), '.lore', 'bin'),
      resolve(dirname(fileURLToPath(import.meta.resolve('@jafreck/lore'))), '..', 'node_modules', '.bin'),
    ] : []),
    ...(process.env.PATH ?? '').split(delimiter).filter(Boolean),
  ];
  return [...new Set(directories.flatMap(directory =>
    extensions.map(extension => resolve(
      directory,
      process.platform === 'win32' ? `${command}${extension}` : command,
    ))))];
}

async function resolveExecutableIdentity(
  command: string,
  workingDirectory: string,
  includeLoreLocations: boolean,
): Promise<ToolchainIdentity> {
  const unresolved: ToolchainIdentity = {
    command,
    resolvedPath: null,
    size: null,
    mtimeMs: null,
    sha256: null,
  };
  for (const candidate of executableCandidates(command, workingDirectory, includeLoreLocations)) {
    if (!(await fileExists(candidate))) continue;
    try {
      const canonicalPath = await realpath(candidate);
      await access(
        canonicalPath,
        process.platform === 'win32' ? constants.F_OK : constants.X_OK,
      );
      const metadata = await stat(canonicalPath);
      if (!metadata.isFile()) continue;
      return {
        command,
        resolvedPath: canonicalPath,
        size: metadata.size,
        mtimeMs: metadata.mtimeMs,
        sha256: await hashFile(canonicalPath),
      };
    } catch {
      // Preserve the command identity when an executable cannot be inspected.
    }
  }
  return unresolved;
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolveHash, rejectHash) => {
    const stream = createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', rejectHash);
    stream.on('end', resolveHash);
  });
  return hash.digest('hex');
}

function reportFromError(error: unknown): IndexHealthReport | undefined {
  if (!error || typeof error !== 'object' || !('report' in error)) return undefined;
  const report = (error as { report?: unknown }).report;
  return report && typeof report === 'object' && 'ok' in report
    ? report as IndexHealthReport
    : undefined;
}

interface CompilerEvidence {
  requested: boolean;
  complete: boolean;
  summary: {
    errors: number;
    fatalErrors: number;
    failedTranslationUnits: number;
    skippedTranslationUnits: number;
    samples?: Array<{ severity?: string; file?: string }>;
  };
}

function readCompilerEvidence(details: unknown): CompilerEvidence | undefined {
  if (!details || typeof details !== 'object') return undefined;
  const evidence = (details as { compilerDiagnostics?: unknown }).compilerDiagnostics;
  if (!evidence || typeof evidence !== 'object') return undefined;
  const candidate = evidence as Partial<CompilerEvidence>;
  const summary = candidate.summary;
  if (typeof candidate.requested !== 'boolean' ||
      typeof candidate.complete !== 'boolean' ||
      !summary ||
      typeof summary.errors !== 'number' ||
      typeof summary.fatalErrors !== 'number' ||
      typeof summary.failedTranslationUnits !== 'number' ||
      typeof summary.skippedTranslationUnits !== 'number') {
    return undefined;
  }
  return candidate as CompilerEvidence;
}

function cleanCompilerEvidence(evidence: CompilerEvidence | undefined): boolean {
  return evidence?.requested === true &&
    evidence.complete === true &&
    evidence.summary.errors === 0 &&
    evidence.summary.fatalErrors === 0 &&
    evidence.summary.failedTranslationUnits === 0 &&
    evidence.summary.skippedTranslationUnits === 0;
}

function enforceNativeCompilerEvidence(report: IndexHealthReport): IndexHealthReport {
  const nativeLanguages = new Set(
    Object.entries(report.provenance.scipScope?.languageCounts ?? {})
      .filter(([language, count]) => (language === 'c' || language === 'cpp') && count > 0)
      .map(([language]) => language),
  );
  if (nativeLanguages.size === 0) return report;

  const relevantProviders = report.provenance.indexers.filter(row =>
    row.provider === 'scip' &&
    row.languages.some(language => nativeLanguages.has(language)),
  );
  const attemptedProviders = relevantProviders.filter(row => row.attempted);
  const issues: IndexHealthIssue[] = [];

  const precomputedProviders = relevantProviders.filter(row =>
    !row.attempted && isRecord(row.details) && row.details.source === 'precomputed');
  if (precomputedProviders.length > 0 || attemptedProviders.length === 0) {
    issues.push({
      severity: 'error',
      code: 'SCIP_COMPILER_DIAGNOSTICS_UNVERIFIED',
      message: 'Scoped C/C++ certification requires an executed SCIP provider with compiler diagnostics; precomputed indexes cannot prove clean compilation.',
      scope: precomputedProviders.map(provider => provider.runId).filter(Boolean).join(',') || undefined,
    });
  }

  for (const provider of attemptedProviders) {
    const evidence = readCompilerEvidence(provider.details);
    if (!evidence?.requested || !evidence.complete) {
      issues.push({
        severity: 'error',
        code: 'SCIP_COMPILER_DIAGNOSTICS_UNVERIFIED',
        message: `${provider.indexer} lacks complete enabled compiler-diagnostic evidence.`,
        scope: provider.runId,
      });
      continue;
    }
    if (!cleanCompilerEvidence(evidence)) {
      issues.push({
        severity: 'error',
        code: 'SCIP_COMPILER_ERRORS',
        message: `${provider.indexer} reported ${evidence.summary.errors} compiler error(s), ${evidence.summary.failedTranslationUnits} failed and ${evidence.summary.skippedTranslationUnits} skipped translation unit(s).`,
        scope: provider.runId,
        actual: evidence.summary.errors,
        paths: [...new Set((evidence.summary.samples ?? [])
          .filter(sample => sample.severity === 'error' || sample.severity === 'fatal error')
          .flatMap(sample => sample.file ? [sample.file] : []))],
      });
    }
  }

  const compilerDiagnostics = report.provenance.diagnostics?.compiler ?? [];
  const relevantDiagnostics = compilerDiagnostics.filter(row =>
    row.languages.some(language => nativeLanguages.has(language)),
  );
  if (relevantDiagnostics.length === 0 ||
      relevantDiagnostics.some(row => !cleanCompilerEvidence(readCompilerEvidence(row.details)))) {
    issues.push({
      severity: 'error',
      code: 'SCIP_COMPILER_DIAGNOSTICS_UNVERIFIED',
      message: 'Scoped C/C++ certification requires complete clean compiler evidence in report.provenance.diagnostics.compiler.',
    });
  }

  const successfulProvider = attemptedProviders.some(provider =>
    provider.status === 'succeeded' && cleanCompilerEvidence(readCompilerEvidence(provider.details)));
  if (!successfulProvider && !issues.some(issue => issue.code === 'SCIP_COMPILER_DIAGNOSTICS_UNVERIFIED')) {
    issues.push({
      severity: 'error',
      code: 'SCIP_COMPILER_DIAGNOSTICS_UNVERIFIED',
      message: 'Scoped C/C++ certification has no successful SCIP provider with clean compiler evidence.',
    });
  }

  if (issues.length === 0) return report;
  const issueKeys = new Set(report.errors.map(issue => `${issue.code}\0${issue.scope ?? ''}`));
  const newIssues = issues.filter(issue => !issueKeys.has(`${issue.code}\0${issue.scope ?? ''}`));
  return {
    ...report,
    ok: false,
    status: 'invalid',
    errors: [...report.errors, ...newIssues],
    warnings: report.warnings.filter(issue =>
      !issues.some(nativeIssue => nativeIssue.code === issue.code)),
  };
}

function qualityError(lore: LoreModule, report: IndexHealthReport): Error {
  const error = new lore.IndexValidationError(report);
  const issueCodes = report.errors.map(issue => issue.code).join(', ');
  if (issueCodes) error.message += ` [${issueCodes}]`;
  return error;
}

function hasPersistedEmbeddings(
  lore: LoreModule,
  db: Parameters<LoreModule['getLoreMeta']>[0],
  embeddingModelName: string | undefined,
): boolean {
  if (!embeddingModelName) return true;
  const persistedModel = lore.getLoreMeta(db, 'embedding_model');
  const persistedDims = Number.parseInt(lore.getLoreMeta(db, 'embedding_dims') ?? '', 10);
  return persistedModel === embeddingModelName &&
    Number.isSafeInteger(persistedDims) && persistedDims > 0;
}

function logIndexHealth(ctx: MigrationFlowContext, report: IndexHealthReport, label: string): void {
  const overall = report.coverage.overall;
  ctx.logger.info(
    `${label}: status=${report.status}, files=${overall.files}, symbols=${overall.symbols}, ` +
    `calls=${overall.calls.total} (${overall.calls.resolved} resolved), ` +
    `types=${overall.types.total} (${overall.types.resolved} resolved)`,
  );

  if (report.provenance.scipScope) {
    ctx.logger.info(
      `Lore SCIP scope: hash=${report.provenance.scipScope.scopeHash}, ` +
      `branch=${report.branch ?? 'unknown'}, ` +
      `languages=${JSON.stringify(report.provenance.scipScope.languageCounts)}`,
    );
  }

  const diagnostics = [
    ...report.provenance.compilationDatabases,
    ...report.provenance.indexers,
  ];
  for (const diagnostic of diagnostics) {
    const summary =
      `Lore ${diagnostic.provider}/${diagnostic.indexer}: status=${diagnostic.status}, ` +
      `attempted=${diagnostic.attempted}, files=${diagnostic.files ?? 0}, ` +
      `symbols=${diagnostic.symbols ?? 0}, calls=${diagnostic.callRefs ?? 0}, ` +
      `types=${diagnostic.typeRefs ?? 0}` +
      (diagnostic.message ? `, message=${diagnostic.message}` : '') +
      (diagnostic.details ? `, details=${JSON.stringify(diagnostic.details)}` : '');
    if (diagnostic.status === 'succeeded') ctx.logger.info(summary);
    else ctx.logger.warn(summary);
  }

  for (const diagnostic of report.provenance.diagnostics?.compiler ?? []) {
    const summary =
      `Lore compiler diagnostics ${diagnostic.indexer}: status=${diagnostic.status}, ` +
      `languages=${diagnostic.languages.join(',')}, details=${JSON.stringify(diagnostic.details)}`;
    if (diagnostic.status === 'succeeded') ctx.logger.info(summary);
    else ctx.logger.warn(summary);
  }

  for (const issue of [...report.errors, ...report.warnings]) {
    const message = `Lore validation ${issue.severity} ${issue.code}: ${issue.message}` +
      (issue.guidance ? ` Guidance: ${issue.guidance}` : '');
    if (issue.severity === 'error') ctx.logger.error(message);
    else ctx.logger.warn(message);
  }
}

interface KbIndexInputs {
  sourceRoot: string;
  sourceRevision: SourceRevision | null;
  walkerConfig: WalkerConfig;
  scipScope: ScipScope;
  execution: IndexExecutionOptions;
  embeddingModelName: string | undefined;
  validationPolicy: IndexValidationPolicy & { profile: 'migration-grade' };
  fingerprintConfiguration: unknown;
  stableFingerprint: string;
  currentFingerprint: string;
}

async function resolveKbIndexInputs(ctx: MigrationFlowContext): Promise<KbIndexInputs> {
  const sourceRoot = resolve(ctx.projectRoot, ctx.config.source.path);
  const sourceRevision = await resolveSourceRevision(sourceRoot);
  const embCfg = ctx.config.options.kbIndex?.embeddings;
  const embeddingModelName = embCfg?.enabled
    ? (embCfg.model ?? 'Qwen/Qwen3-Embedding-0.6B') : undefined;
  const includeGlobs = [...ctx.config.source.includePatterns];
  const excludeGlobs = [...ctx.config.source.excludePatterns];
  const walkerConfig: WalkerConfig = {
    rootDir: sourceRoot,
    branch: ctx.config.source.branch,
    includeGlobs,
    excludeGlobs,
  };
  const scipScope: ScipScope = {
    languages: [...new Set(
      (ctx.config.source.languages ?? [ctx.config.source.language])
        .map(language => language.trim().toLowerCase()),
    )],
    includeGlobs,
    excludeGlobs,
  };
  const configuredExecution = ctx.config.options.kbIndex?.execution;
  const execution: IndexExecutionOptions = {
    allowSubprocessExecution: configuredExecution?.allowSubprocessExecution ?? false,
    allowBuildExecution: configuredExecution?.allowBuildExecution ?? false,
    allowCustomIndexerCommands: configuredExecution?.allowCustomIndexerCommands ?? false,
    allowCustomLspCommands: configuredExecution?.allowCustomLspCommands ?? false,
    allowAutoInstall: configuredExecution?.allowAutoInstall ?? false,
    allowedCwdRoots: (configuredExecution?.allowedCwdRoots ?? [])
      .map(root => resolve(ctx.projectRoot, root)),
  };
  const entryPoints = ctx.config.source.entryPoints ?? [];
  const configuredValidation = ctx.config.options.kbIndex?.validation;
  const requiredGlobs = [...new Set([
    ...entryPoints,
    ...(configuredValidation?.requiredGlobs ?? []),
  ])];
  const validationPolicy: IndexValidationPolicy & { profile: 'migration-grade' } = {
    ...INDEX_VALIDATION_POLICY,
    ...configuredValidation,
    profile: 'migration-grade',
    includeGlobs,
    excludeGlobs,
    thresholds: {
      ...INDEX_VALIDATION_POLICY.thresholds,
      ...configuredValidation?.thresholds,
    },
    ...(requiredGlobs.length > 0 ? { requiredGlobs } : {}),
  };
  const fingerprintConfiguration = {
    loreVersion: LORE_VERSION,
    sourceLanguage: ctx.config.source.language,
    sourceLanguages: scipScope.languages,
    scipScope,
    embeddingModel: embeddingModelName,
    scip: true,
    lsp: false,
    execution,
    validation: validationPolicy,
  };
  const currentFingerprint = await computeKbInputFingerprint(
    sourceRoot,
    walkerConfig,
    fingerprintConfiguration,
  );
  const stableFingerprint = await computeKbInputFingerprint(
    sourceRoot,
    walkerConfig,
    fingerprintConfiguration,
    { stabilityCheck: true },
  );
  return {
    sourceRoot,
    sourceRevision,
    walkerConfig,
    scipScope,
    execution,
    embeddingModelName,
    validationPolicy,
    fingerprintConfiguration,
    stableFingerprint,
    currentFingerprint,
  };
}

function validationOptions(inputs: KbIndexInputs): ValidateIndexOptions {
  return {
    rootDir: inputs.sourceRoot,
    branch: inputs.walkerConfig.branch,
    walkerConfig: inputs.walkerConfig,
    scipScope: inputs.scipScope,
    policy: inputs.validationPolicy,
  };
}

function validateKbIndex(
  lore: LoreModule,
  target: Parameters<LoreModule['validateIndex']>[0],
  inputs: KbIndexInputs,
): IndexHealthReport {
  const report = enforceNativeCompilerEvidence(
    lore.validateIndex(target, validationOptions(inputs)),
  );
  if (!inputs.sourceRevision ||
      report.freshness?.baselineHeadSha === inputs.sourceRevision.headSha) return report;
  const revisionIssue: IndexHealthIssue = {
    severity: 'error',
    code: 'SOURCE_REVISION_MISMATCH',
    message: `Lore baseline revision ${report.freshness?.baselineHeadSha ?? 'unknown'} does not match source HEAD ${inputs.sourceRevision.headSha}.`,
  };
  return {
    ...report,
    ok: false,
    status: 'invalid',
    errors: [...report.errors, revisionIssue],
  };
}

async function removeSqliteFiles(dbPath: string): Promise<void> {
  await unlink(dbPath).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  });
  await unlink(`${dbPath}-wal`).catch(() => {});
  await unlink(`${dbPath}-shm`).catch(() => {});
}

async function promoteKbCandidate(candidatePath: string, destinationPath: string): Promise<void> {
  await rename(candidatePath, destinationPath);
  await unlink(`${destinationPath}-wal`).catch(() => {});
  await unlink(`${destinationPath}-shm`).catch(() => {});
  await unlink(`${candidatePath}-wal`).catch(() => {});
  await unlink(`${candidatePath}-shm`).catch(() => {});
}

async function initializeKbEmbedder(
  ctx: MigrationFlowContext,
  lore: LoreModule,
  embeddingModelName: string | undefined,
): Promise<void> {
  const embCfg = ctx.config.options.kbIndex?.embeddings;
  if (!embCfg?.enabled || ctx.embedder) return;
  const model = embeddingModelName ?? lore.DEFAULT_EMBEDDING_MODEL;
  ctx.logger.info(`Embeddings enabled (model: ${model})`);
  ctx.embedder = new lore.TransformersJsProvider(model);
  try {
    await ctx.embedder.init();
    const device = (ctx.embedder as { device?: string }).device;
    ctx.logger.info(`Embedding model loaded — dims: ${ctx.embedder.dims}${device ? `, device: ${device}` : ''}`);
  } catch (err) {
    try { await ctx.embedder.dispose(); } catch { /* ignore */ }
    ctx.embedder = undefined;
    throw new Error(
      `Embedding initialization failed for configured model ${model}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

export async function prepareExistingKbForUse(ctx: MigrationFlowContext): Promise<void> {
  const lore = await loadLore();
  const inputs = await resolveKbIndexInputs(ctx);
  if (!(await fileExists(ctx.paths.kbDbFile))) {
    throw new Error('Resume KB validation failed: knowledge-base database is missing; rerun without --resume');
  }

  try {
    const db = lore.openDb(ctx.paths.kbDbFile);
    try {
      const storedFingerprint = lore.getLoreMeta(db, AAMF_INDEX_FINGERPRINT_KEY);
      if (!storedFingerprint || storedFingerprint !== inputs.currentFingerprint) {
        throw new Error('knowledge-base inputs changed or lack AAMF cache identity');
      }
      if (!hasPersistedEmbeddings(lore, db, inputs.embeddingModelName)) {
        throw new Error('knowledge base lacks compatible persisted embeddings');
      }
      const report = validateKbIndex(lore, db, inputs);
      logIndexHealth(ctx, report, 'Resume Lore index validation');
      if (!report.ok) throw qualityError(lore, report);
    } finally {
      db.close();
    }
  } catch (error) {
    const report = reportFromError(error);
    if (report) logIndexHealth(ctx, report, 'Resume Lore index validation');
    throw new Error(
      `Resume KB validation failed: ${error instanceof Error ? error.message : String(error)}; rerun without --resume`,
      { cause: error },
    );
  }

  await initializeKbEmbedder(ctx, lore, inputs.embeddingModelName);
  await startKbServer(ctx);
}

export async function buildKbIndex(
  flowCtx: FlowExecutionContext<MigrationFlowContext>,
): Promise<PhaseResult> {
  const ctx = flowCtx.context;
  const start = Date.now();
  const inputs = await resolveKbIndexInputs(ctx);
  const {
    sourceRoot,
    walkerConfig,
    scipScope,
    execution,
    embeddingModelName,
    validationPolicy,
    currentFingerprint,
  } = inputs;
  const kbDbPath = ctx.paths.kbDbFile;
  const candidateDbPath = `${kbDbPath}.rebuild`;
  ctx.logger.info(`Building KB index at ${kbDbPath} (source: ${sourceRoot})`);
  const lore = await loadLore();

  // ── Fingerprint guard ──
  if (ctx.config.options.reuseKb && await fileExists(kbDbPath)) {
    try {
      const db = lore.openDb(kbDbPath);
      try {
        const storedFingerprint = lore.getLoreMeta(db, AAMF_INDEX_FINGERPRINT_KEY);
        const embeddingsReady = hasPersistedEmbeddings(lore, db, embeddingModelName);
        if (storedFingerprint && storedFingerprint === currentFingerprint && embeddingsReady) {
          const report = validateKbIndex(lore, db, inputs);
          logIndexHealth(ctx, report, 'Cached Lore index validation');
          if (report.ok) {
            await initializeKbEmbedder(ctx, lore, embeddingModelName);
            ctx.logger.info('Phase 0 reused/skipped — KB fingerprint and quality gate match');
            const checkpointState = ctx.checkpoint.getState();
            checkpointState.phase0Fingerprint = currentFingerprint;
            await ctx.checkpoint.save(checkpointState);
            await startKbServer(ctx);
            return { phase: 0, name: 'KB Indexing', success: true, outputPath: kbDbPath, duration: Date.now() - start };
          }
          ctx.logger.warn('Cached KB failed migration-grade validation; rebuilding');
        } else {
          ctx.logger.info(
            embeddingsReady
              ? 'Cached KB fingerprint is missing or stale; rebuilding'
              : 'Cached KB is missing compatible persisted embeddings; rebuilding',
          );
        }
      } finally { db.close(); }
    } catch (error) {
      const report = reportFromError(error);
      if (report) logIndexHealth(ctx, report, 'Cached Lore index validation');
      ctx.logger.warn(`Cached KB could not be validated; rebuilding: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else if (await fileExists(kbDbPath)) {
    ctx.logger.info('KB reuse disabled by options.reuseKb=false; rebuilding');
  }

  ctx.logger.info('Phase 0 rebuilt — source fingerprint changed or no existing KB');

  await initializeKbEmbedder(ctx, lore, embeddingModelName);

  // ── Logger init ──
  const loreLogLevel = ctx.config.options.kbIndex?.logLevel ?? 'debug';
  lore.initLogger({
    level: lore.LOG_LEVEL_NAMES[loreLogLevel] ?? lore.LogLevel.DEBUG,
    logFile: ctx.paths.loreLogFile,
  });

  // ── Retry loop ──
  const maxAttempts = ctx.config.options.maxRetriesPerTask;
  const timeout = ctx.config.agentBackend.phaseTimeouts?.[0] ?? DEFAULT_INDEX_TIMEOUT_MS;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await removeSqliteFiles(candidateDbPath);
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) {
        ctx.logger.warn(`Failed to remove stale KB candidate, retrying: ${err instanceof Error ? err.message : String(err)}`);
        await new Promise(resolveDelay => setTimeout(resolveDelay, 1_000 * attempt));
        continue;
      }
      break;
    }

    const halfTimeout = Math.round(timeout / 2);
    const builder = new lore.IndexBuilder(candidateDbPath, walkerConfig, ctx.embedder, {
      scip: true,
      scipScope,
      lsp: false,
      embeddings: ctx.embedder !== undefined,
      execution,
      validation: validationPolicy,
    });

    try {
      const effective = await builder.resolveConfiguration();
      if (execution.allowSubprocessExecution !== true &&
          (effective.execution.allowIndexerExecution || effective.execution.allowLspExecution)) {
        throw new Error(
          'Lore widened process execution beyond options.kbIndex.execution.allowSubprocessExecution; ' +
          'authorize subprocess execution explicitly in addition to any build, custom-command, or installation grant',
        );
      }
      ctx.logger.info(
        `Lore effective indexing settings: scip=${effective.scip?.enabled === true}, ` +
        `lsp=${effective.lsp === null ? 'disabled' : 'enabled'}, ` +
        `scope=${JSON.stringify(effective.scipScope)}, ` +
        `execution=${JSON.stringify(effective.execution)}`,
      );
      await runKbBuildAttempt(
        () => builder.build(),
        timeout,
        false,
        () => {
        ctx.logger.warn(
          `KB index build still running after ${Math.round(halfTimeout / 1000)}s ` +
          `(timeout: ${Math.round(timeout / 1000)}s)`,
        );
        },
      );
      const postBuildStableFingerprint = await computeKbInputFingerprint(
        sourceRoot,
        walkerConfig,
        inputs.fingerprintConfiguration,
        { stabilityCheck: true },
      );
      if (postBuildStableFingerprint !== inputs.stableFingerprint) {
        throw new Error('KB immutable source, revision, configuration, or tool inputs changed during indexing');
      }
      const postBuildFingerprint = await computeKbInputFingerprint(
        sourceRoot,
        walkerConfig,
        inputs.fingerprintConfiguration,
      );
      const report = validateKbIndex(lore, candidateDbPath, inputs);
      logIndexHealth(ctx, report, 'Lore index validation');
      if (!report.ok) throw qualityError(lore, report);
      const certifiedFingerprint = await computeKbInputFingerprint(
        sourceRoot,
        walkerConfig,
        inputs.fingerprintConfiguration,
      );
      if (certifiedFingerprint !== postBuildFingerprint) {
        throw new Error('KB indexing inputs changed during post-build certification');
      }
      const certifiedStableFingerprint = await computeKbInputFingerprint(
        sourceRoot,
        walkerConfig,
        inputs.fingerprintConfiguration,
        { stabilityCheck: true },
      );
      if (certifiedStableFingerprint !== inputs.stableFingerprint) {
        throw new Error('KB immutable inputs changed during post-build certification');
      }

      const db = lore.openDb(candidateDbPath);
      try {
        if (hasPersistedEmbeddings(lore, db, embeddingModelName)) {
          lore.setLoreMeta(db, AAMF_INDEX_FINGERPRINT_KEY, certifiedFingerprint);
        } else {
          ctx.logger.warn('KB cache identity not persisted because compatible embeddings are absent');
        }
      }
      finally { db.close(); }

      await promoteKbCandidate(candidateDbPath, kbDbPath);

      const checkpointState = ctx.checkpoint.getState();
      checkpointState.phase0Fingerprint = certifiedFingerprint;
      await ctx.checkpoint.save(checkpointState);
      await startKbServer(ctx);
      return { phase: 0, name: 'KB Indexing', success: true, outputPath: kbDbPath, duration: Date.now() - start };
    } catch (err) {
      lastErr = err;
      const report = reportFromError(err);
      if (report) {
        logIndexHealth(ctx, report, 'Lore index validation');
        break;
      }
      if (attempt < maxAttempts) {
        ctx.logger.warn(`KB index attempt ${attempt} failed, retrying: ${err instanceof Error ? err.message : String(err)}`);
        await new Promise(r => setTimeout(r, 1_000 * attempt));
      }
    }
  }

  const failResult: PhaseResult = {
    phase: 0, name: 'KB Indexing', success: false, duration: Date.now() - start,
    error: lastErr instanceof Error ? lastErr.message : String(lastErr),
  };
  assertPhaseSuccess(failResult);
  return failResult; // unreachable
}
