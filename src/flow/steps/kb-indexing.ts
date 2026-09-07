/**
 * Phase 0 — KB Indexing (deterministic)
 *
 * Builds the local knowledge-base SQLite index from the source directory.
 * Includes retry logic, fingerprint caching, and embedding setup.
 */

import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { unlink } from 'node:fs/promises';
import type { FlowExecutionContext } from '@cadre-dev/framework/flow';
import type { MigrationFlowContext } from '../context.js';
import type { PhaseResult } from '../../agents/types.js';
import { assertPhaseSuccess } from './shared.js';
import { startKbServer } from './kb-server-lifecycle.js';
import { fileExists } from '../../util/fs.js';

const loadLore = () => import('@jafreck/lore');
type LoreModule = Awaited<ReturnType<typeof loadLore>>;

const DEFAULT_INDEX_TIMEOUT_MS = 5 * 60_000;

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

function computeSourceFingerprintCompat(
  lore: LoreModule, rootDir: string,
  walkerConfig: { includeGlobs?: string[]; excludeGlobs?: string[] },
  embeddingModel?: string,
): string {
  const fn = (lore as { computeSourceFingerprint?: (...args: any[]) => string }).computeSourceFingerprint;
  if (typeof fn === 'function') return fn(rootDir, walkerConfig, embeddingModel);
  const data = JSON.stringify({
    rootDir,
    includeGlobs: walkerConfig.includeGlobs ?? [],
    excludeGlobs: walkerConfig.excludeGlobs ?? [],
    embeddingModel: embeddingModel ?? '',
  });
  return createHash('sha256').update(data).digest('hex');
}

function getKbFingerprintCompat(lore: LoreModule, db: unknown): string | undefined {
  const getLoreMeta = (lore as { getLoreMeta?: (db: unknown, key: string) => string | undefined }).getLoreMeta;
  if (typeof getLoreMeta === 'function') return getLoreMeta(db, 'source_fingerprint');
  const getKbFingerprint = (lore as { getKbFingerprint?: (...args: any[]) => string | undefined }).getKbFingerprint;
  if (typeof getKbFingerprint === 'function') return getKbFingerprint(db);
  const getKbMeta = (lore as { getKbMeta?: (...args: any[]) => string | undefined }).getKbMeta;
  if (typeof getKbMeta === 'function') return getKbMeta(db, 'source_fingerprint');
  return undefined;
}

export async function buildKbIndex(
  flowCtx: FlowExecutionContext<MigrationFlowContext>,
): Promise<PhaseResult> {
  const ctx = flowCtx.context;
  const start = Date.now();
  const sourceRoot = resolve(ctx.projectRoot, ctx.config.source.path);
  const kbDbPath = ctx.paths.kbDbFile;
  ctx.logger.info(`Building KB index at ${kbDbPath} (source: ${sourceRoot})`);
  const lore = await loadLore();

  // ── Fingerprint guard ──
  const embCfg = ctx.config.options.kbIndex?.embeddings;
  const embeddingModelName = embCfg?.enabled
    ? (embCfg.model ?? 'Qwen/Qwen3-Embedding-0.6B') : undefined;
  const walkerConfig = { rootDir: sourceRoot };
  const currentFingerprint = computeSourceFingerprintCompat(
    lore, sourceRoot,
    walkerConfig as { includeGlobs?: string[]; excludeGlobs?: string[] },
    embeddingModelName,
  );
  if (await fileExists(kbDbPath)) {
    try {
      const db = lore.openDb(kbDbPath);
      try {
        const storedFingerprint = getKbFingerprintCompat(lore, db);
        if (storedFingerprint && storedFingerprint === currentFingerprint) {
          ctx.logger.info('Phase 0 reused/skipped — KB fingerprint matches');
          const checkpointState = ctx.checkpoint.getState();
          checkpointState.phase0Fingerprint = currentFingerprint;
          await ctx.checkpoint.save(checkpointState);
          await startKbServer(ctx);
          return { phase: 0, name: 'KB Indexing', success: true, outputPath: kbDbPath, duration: Date.now() - start };
        }
      } finally { db.close(); }
    } catch { /* DB corrupt — rebuild */ }
  }

  ctx.logger.info('Phase 0 rebuilt — source fingerprint changed or no existing KB');

  // ── Embedding provider ──
  if (embCfg?.enabled) {
    const model = embeddingModelName ?? lore.DEFAULT_EMBEDDING_MODEL;
    ctx.logger.info(`Embeddings enabled (model: ${model})`);
    ctx.embedder = new lore.TransformersJsProvider(model);
    try {
      await ctx.embedder.init();
      const device = (ctx.embedder as { device?: string }).device;
      ctx.logger.info(`Embedding model loaded — dims: ${ctx.embedder.dims}${device ? `, device: ${device}` : ''}`);
    } catch (err) {
      ctx.logger.warn(`Embedding init failed — skipping: ${err instanceof Error ? err.message : String(err)}`);
      try { await ctx.embedder.dispose(); } catch { /* ignore */ }
      ctx.embedder = undefined;
    }
  }

  // ── LSP settings ──
  const lspConfig = ctx.config.options.kbIndex?.lsp;
  const lspSettings = lspConfig?.enabled ? {
    enabled: true as const,
    requestTimeoutMs: lspConfig.requestTimeoutMs ?? 5000,
    servers: lspConfig.servers
      ? Object.fromEntries(
          Object.entries(lspConfig.servers).map(([lang, srv]) => [
            lang, { command: srv.command, args: srv.args ?? [] },
          ]),
        )
      : {},
  } : undefined;

  if (lspSettings) {
    ctx.logger.info(
      `LSP enabled (timeout: ${lspSettings.requestTimeoutMs}ms` +
      (Object.keys(lspSettings.servers).length > 0
        ? `, servers: ${Object.keys(lspSettings.servers).join(', ')}` : '') + ')',
    );
    for (const [lang, srv] of Object.entries(lspSettings.servers)) {
      try { execFileSync('which', [srv.command], { stdio: 'pipe' }); }
      catch { ctx.logger.warn(`LSP server '${srv.command}' for '${lang}' not found on PATH`); }
    }
  }

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
    if (await fileExists(kbDbPath)) {
      try {
        await unlink(kbDbPath);
        await unlink(kbDbPath + '-wal').catch(() => {});
        await unlink(kbDbPath + '-shm').catch(() => {});
        ctx.logger.info('Removed stale KB database before rebuild');
      } catch (err) {
        ctx.logger.warn(`Failed to remove stale KB: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const halfTimeout = Math.round(timeout / 2);
    const builder = new lore.IndexBuilder(kbDbPath, walkerConfig, ctx.embedder, { lsp: lspSettings });

    try {
      await runKbBuildAttempt(
        () => builder.build(),
        timeout,
        !!lspSettings,
        () => {
        ctx.logger.warn(
          `KB index build still running after ${Math.round(halfTimeout / 1000)}s ` +
          `(timeout: ${Math.round(timeout / 1000)}s)` +
          (lspSettings ? ' — LSP server may still be indexing.' : ''),
        );
        },
      );
      const checkpointState = ctx.checkpoint.getState();
      checkpointState.phase0Fingerprint = currentFingerprint;
      await ctx.checkpoint.save(checkpointState);
      await startKbServer(ctx);
      return { phase: 0, name: 'KB Indexing', success: true, outputPath: kbDbPath, duration: Date.now() - start };
    } catch (err) {
      lastErr = err;
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
