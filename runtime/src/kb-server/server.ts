/**
 * @module kb-server/server
 *
 * Knowledge-base MCP server.
 *
 * Exports `createKbMcpServer()` for use by `KbServerProcess` (HTTP transport)
 * and retains a standalone CLI entry point for development/debugging.
 *
 * MCP tools exposed:
 *   kb_lookup    — symbol / file lookup
 *   kb_graph     — call / import graph queries
 *   kb_search    — structural, semantic, and fused search
 *   kb_snippet   — source-code snippet extraction
 *   kb_metrics   — aggregate code metrics
 *   kb_writeback — LLM summary write-back
 *
 * Standalone usage:
 *   node dist/kb-server/server.js --db <path-to-kb.db>
 *   tsx src/kb-server/server.ts --db <path-to-kb.db>
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { fileURLToPath } from 'url';
import { getKbMeta, SentenceTransformersProvider, type EmbeddingProvider } from '@aamf/lore';
import { openReadOnly, type Database } from './db.js';
import * as lookup from './tools/lookup.js';
import * as graph from './tools/graph.js';
import * as search from './tools/search.js';
import type { SearchObserver } from './tools/search.js';
import * as snippet from './tools/snippet.js';
import * as metrics from './tools/metrics.js';
import * as writeback from './tools/writeback.js';

// ─── Server options ───────────────────────────────────────────────────────────

/** Optional configuration for `createKbMcpServer`. */
export interface KbServerOptions {
  /** Callback invoked after every `kb_search` call with query/mode/latency/result metadata. */
  searchObserver?: SearchObserver;
}

// ─── Server factory ───────────────────────────────────────────────────────────

/**
 * Create and return a fully-configured `McpServer` with all KB tools registered.
 *
 * @param db       Read-only SQLite connection to the knowledge-base.
 * @param dbPath   Path to the DB file, needed by `kb_writeback` for write access.
 * @param embedder Optional live embedding provider for semantic/fused search.
 * @param options  Optional server configuration (e.g. search observer).
 */
export function createKbMcpServer(
  db: Database.Database,
  dbPath: string,
  embedder?: EmbeddingProvider,
  options?: KbServerOptions,
): McpServer {
  const server = new McpServer(
    { name: 'aamf-kb-server', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  // ── kb_lookup ──────────────────────────────────────────────────────────────
  server.tool(
    lookup.toolDef.name,
    lookup.toolDef.description,
    {
      kind: z.enum(['symbol', 'file']).describe('Whether to look up a symbol or a file.'),
      query: z.string().describe('Symbol name or file path to look up.'),
    },
    async (args) => ({
      content: [{ type: 'text', text: JSON.stringify(lookup.handler(db, args)) }],
    }),
  );

  // ── kb_graph ───────────────────────────────────────────────────────────────
  server.tool(
    graph.toolDef.name,
    graph.toolDef.description,
    {
      kind: z.enum(['call', 'import']).describe('"call" or "import" graph edges.'),
      source_id: z.number().optional().describe('Filter edges by source node id.'),
      limit: z.number().optional().describe('Max edges to return (default 200).'),
    },
    async (args) => ({
      content: [{ type: 'text', text: JSON.stringify(graph.handler(db, args)) }],
    }),
  );

  // ── kb_search ──────────────────────────────────────────────────────────────
  server.tool(
    search.toolDef.name,
    search.toolDef.description,
    {
      query: z.string().describe('Search query.'),
      mode: z
        .enum(['structural', 'semantic', 'fused'])
        .optional()
        .describe('Search mode (default: structural).'),
      limit: z.number().optional().describe('Max results (default 20).'),
    },
    async (args) => ({
      content: [{ type: 'text', text: JSON.stringify(await search.handler(db, args, embedder, options?.searchObserver)) }],
    }),
  );

  // ── kb_snippet ─────────────────────────────────────────────────────────────
  server.tool(
    snippet.toolDef.name,
    snippet.toolDef.description,
    {
      path: z.string().describe('Absolute file path as stored in the index.'),
      start_line: z.number().optional().describe('First line (1-based, inclusive).'),
      end_line: z.number().optional().describe('Last line (1-based, inclusive).'),
    },
    async (args) => ({
      content: [{ type: 'text', text: JSON.stringify(snippet.handler(db, args)) }],
    }),
  );

  // ── kb_metrics ─────────────────────────────────────────────────────────────
  server.tool(
    metrics.toolDef.name,
    metrics.toolDef.description,
    {},
    async (_args) => ({
      content: [{ type: 'text', text: JSON.stringify(metrics.handler(db, {})) }],
    }),
  );

  // ── kb_writeback ───────────────────────────────────────────────────────────
  server.tool(
    writeback.toolDef.name,
    writeback.toolDef.description,
    {
      symbol_id: z.number().describe('Symbol id to attach the summary to.'),
      summary: z.string().describe('Natural-language summary text.'),
      model: z.string().describe('Model identifier that generated the summary.'),
    },
    async (args) => ({
      content: [
        { type: 'text', text: JSON.stringify(writeback.handler(dbPath, args)) },
      ],
    }),
  );

  return server;
}

// ─── Embedding helper ─────────────────────────────────────────────────────────

/**
 * Read the embedding model stored in `kb_meta` at index time and spin up a
 * `SentenceTransformersProvider` instance for it.  Returns `undefined` when no
 * embedding model is recorded in the database.
 */
async function buildEmbedder(db: Database.Database): Promise<EmbeddingProvider | undefined> {
  const modelName = getKbMeta(db, 'embedding_model');
  if (!modelName) return undefined;

  const provider = new SentenceTransformersProvider(modelName);
  try {
    await provider.init();
    return provider;
  } catch {
    // Model not available — fall back to structural search only.
    try { await provider.dispose(); } catch { /* ignore */ }
    return undefined;
  }
}

// ─── CLI argument parsing ─────────────────────────────────────────────────────

function parseArgs(): { dbPath: string } {
  const args = process.argv.slice(2);
  const dbIdx = args.indexOf('--db');
  if (dbIdx === -1 || !args[dbIdx + 1]) {
    console.error('Usage: kb-server --db <path>');
    process.exit(1);
  }
  return { dbPath: args[dbIdx + 1]! };
}

// ─── Main (standalone CLI) ────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { dbPath } = parseArgs();

  const db = openReadOnly(dbPath);
  const embedder = await buildEmbedder(db);

  const server = createKbMcpServer(db, dbPath, embedder, {
    searchObserver: (obs) => {
      process.stderr.write(
        `[kb_search] query=${JSON.stringify(obs.query)} mode=${obs.requestedMode}→${obs.modeUsed} results=${obs.resultCount} topScore=${obs.topScore} latency=${obs.latencyMs}ms\n`,
      );
    },
  });

  // Connect via stdio transport (standalone/debug mode).
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Signal readiness to the parent process over stderr.
  process.stderr.write('READY\n');
}

// Only run when executed as a standalone script, not when imported as a module.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('KB server fatal error:', err);
    process.exit(1);
  });
}
