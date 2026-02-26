/**
 * @module kb-server/server
 *
 * Knowledge-base MCP server entry point.
 *
 * Exposes the following MCP tools via stdio transport:
 *   kb_lookup    — symbol / file lookup
 *   kb_graph     — call / import graph queries
 *   kb_search    — structural, semantic, and fused search
 *   kb_snippet   — source-code snippet extraction
 *   kb_metrics   — aggregate code metrics
 *   kb_writeback — LLM summary write-back
 *
 * Usage (standalone):
 *   node dist/kb-server/server.js --db <path-to-kb.db>
 *   tsx src/kb-server/server.ts --db <path-to-kb.db>
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { openReadOnly } from './db.js';
import * as lookup from './tools/lookup.js';
import * as graph from './tools/graph.js';
import * as search from './tools/search.js';
import * as snippet from './tools/snippet.js';
import * as metrics from './tools/metrics.js';
import * as writeback from './tools/writeback.js';

// ─── McpServerConfig type ─────────────────────────────────────────────────────

/**
 * Configuration that an MCP client uses to spawn the KB server subprocess.
 * Modelled after the stdio-transport `StdioServerParameters` shape.
 */
export interface McpServerConfig {
  /** The executable to run (e.g. "node" or "tsx"). */
  command: string;
  /** Arguments passed to the executable. */
  args: string[];
  /** Optional environment variables to inject into the subprocess. */
  env?: Record<string, string>;
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

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { dbPath } = parseArgs();

  // Open the read-only DB connection shared by all read-only tools.
  const db = openReadOnly(dbPath);

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
      content: [{ type: 'text', text: JSON.stringify(search.handler(db, args)) }],
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

  // Connect via stdio transport.
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Signal readiness to the parent process over stderr.
  process.stderr.write('READY\n');
}

main().catch((err) => {
  console.error('KB server fatal error:', err);
  process.exit(1);
});
