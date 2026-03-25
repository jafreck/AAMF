/**
 * Shared KB server lifecycle helpers used by both the kb-indexing step
 * (fresh runs) and the runtime's resume path.
 */

import type { MigrationFlowContext } from '../context.js';
import { fileExists } from '../../util/fs.js';

/**
 * Start the source KB MCP server and attach it to the flow context.
 * No-ops if the server is already running.
 */
export async function startKbServer(ctx: MigrationFlowContext): Promise<void> {
  if (ctx.kbServer) return;
  try {
    const { KbServerProcess } = await import('../../core/kb-server-process.js');
    const lore = await import('@jafreck/lore');
    const loreLogLevel = ctx.config.options.kbIndex?.logLevel ?? 'debug';
    ctx.kbServer = new KbServerProcess(ctx.paths.kbDbFile, ctx.embedder, (obs) => {
      ctx.logger.debug(
        `lore_search: query=${JSON.stringify(obs.query)} mode=${obs.requestedMode}→${obs.modeUsed} results=${obs.resultCount} topScore=${obs.topScore} latency=${obs.latencyMs}ms`,
      );
    }, {
      level: lore.LOG_LEVEL_NAMES[loreLogLevel] ?? lore.LogLevel.DEBUG,
      logFile: ctx.paths.loreLogFile,
    });
    await ctx.kbServer.start();
    ctx.logger.info(`KB server started (lore log: ${ctx.paths.loreLogFile})`);
  } catch (err) {
    ctx.logger.warn(`KB server failed to start: ${err instanceof Error ? err.message : String(err)}`);
    ctx.kbServer = undefined;
  }

  // Also start target KB server if the target index already exists (e.g. resume)
  if (!ctx.targetKbServer && (await fileExists(ctx.paths.kbTargetDbFile))) {
    await startTargetKbServer(ctx);
  }
}

/**
 * Start the target KB MCP server and attach it to the flow context.
 * No-ops if the server is already running.
 */
export async function startTargetKbServer(ctx: MigrationFlowContext): Promise<void> {
  if (ctx.targetKbServer) return;
  try {
    const { KbServerProcess } = await import('../../core/kb-server-process.js');
    const lore = await import('@jafreck/lore');
    const loreLogLevel = ctx.config.options.kbIndex?.logLevel ?? 'debug';
    ctx.targetKbServer = new KbServerProcess(ctx.paths.kbTargetDbFile, undefined, (obs) => {
      ctx.logger.debug(
        `target_lore_search: query=${JSON.stringify(obs.query)} mode=${obs.requestedMode}→${obs.modeUsed} results=${obs.resultCount} topScore=${obs.topScore} latency=${obs.latencyMs}ms`,
      );
    }, {
      level: lore.LOG_LEVEL_NAMES[loreLogLevel] ?? lore.LogLevel.DEBUG,
      logFile: ctx.paths.loreTargetLogFile,
    });
    await ctx.targetKbServer.start();
    ctx.logger.info(`Target KB server started (lore log: ${ctx.paths.loreTargetLogFile})`);
  } catch (err) {
    ctx.logger.warn(`Target KB server failed to start: ${err instanceof Error ? err.message : String(err)}`);
    ctx.targetKbServer = undefined;
  }
}
