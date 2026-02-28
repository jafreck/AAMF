/**
 * @module core/kb-server-process
 *
 * Manages the lifecycle of the KB MCP server as an in-process HTTP server.
 *
 * Instead of spawning a subprocess (stdio transport), `KbServerProcess` starts
 * a `StreamableHTTPServerTransport` bound to `localhost:0` (OS-assigned port).
 * All agents connect to the single shared server over its lifetime.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { EmbeddingProvider } from '@aamf/lore';
import { openReadOnly } from '../kb-server/db.js';
import { createKbMcpServer } from '../kb-server/server.js';
import type { McpServerConfig } from '../agents/types.js';

// Re-export for convenience.
export type { McpServerConfig };

// ─── KbServerProcess ──────────────────────────────────────────────────────────

/**
 * Hosts the KB MCP server on an in-process HTTP endpoint.
 *
 * @example
 * ```ts
 * const srv = new KbServerProcess('/path/to/kb.db');
 * await srv.start();
 * // Agents use srv.mcpConfig.url to reach the server.
 * await srv.stop();
 * ```
 */
export class KbServerProcess {
  private readonly dbPath: string;
  private httpServer: http.Server | null = null;
  private _port: number | null = null;
  private db: import('better-sqlite3').Database | null = null;
  private readonly embedder: EmbeddingProvider | undefined;

  /**
   * @param dbPath     Path to the KB SQLite database.
   * @param embedder   Optional pre-initialised embedding provider for semantic search.
   *                   The caller owns the lifecycle — `stop()` will NOT dispose it.
   */
  constructor(dbPath: string, embedder?: EmbeddingProvider) {
    this.dbPath = dbPath;
    this.embedder = embedder;
  }

  /**
   * HTTP URL of the running server (e.g. `"http://localhost:4321/mcp"`).
   * Only valid after `start()` has resolved.
   */
  get mcpConfig(): McpServerConfig {
    if (this._port === null) {
      throw new Error('KB server has not been started — call start() first');
    }
    return { url: `http://localhost:${this._port}/mcp` };
  }

  /**
   * Start the in-process HTTP MCP server and bind to a free OS-assigned port.
   * Resolves once the server is listening.
   */
  async start(): Promise<void> {
    if (this.httpServer) return;

    this.db = openReadOnly(this.dbPath);

    const mcpServer = createKbMcpServer(this.db, this.dbPath, this.embedder);

    // Stateless transport: each POST request gets its own temporary session.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await mcpServer.connect(transport);

    const httpServer = http.createServer(async (req, res) => {
      if (req.method === 'POST' || req.method === 'GET' || req.method === 'DELETE') {
        let body: unknown;
        if (req.method === 'POST') {
          const raw = await new Promise<string>((resolve, reject) => {
            const chunks: Buffer[] = [];
            req.on('data', (chunk: Buffer) => chunks.push(chunk));
            req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
            req.on('error', reject);
          });
          try { body = JSON.parse(raw); } catch { /* leave body undefined */ }
        }
        await transport.handleRequest(req, res, body);
      } else {
        res.writeHead(405).end();
      }
    });

    await new Promise<void>((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(0, '127.0.0.1', () => resolve());
    });

    this._port = (httpServer.address() as AddressInfo).port;
    this.httpServer = httpServer;
  }

  /**
   * Shut down the HTTP server.
   * Resolves immediately if the server was never started.
   */
  async stop(): Promise<void> {
    // Close the read-only DB handle.
    if (this.db) {
      try { this.db.close(); } catch { /* best-effort */ }
      this.db = null;
    }

    return new Promise((resolve, reject) => {
      if (!this.httpServer) {
        resolve();
        return;
      }
      const server = this.httpServer;
      this.httpServer = null;
      this._port = null;
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}
