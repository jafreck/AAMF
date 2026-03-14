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
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createLoreMcpServer, openReadOnly, type EmbeddingProvider, type LoreServerOptions, type SearchObserver, LoreLogger, type LoreLoggerOptions } from '@jafreck/lore';
import type { McpServerConfig } from '../agents/types.js';


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
  private _sessions: Map<string, { transport: StreamableHTTPServerTransport; close: () => Promise<void> }> | null = null;
  private readonly embedder: EmbeddingProvider | undefined;
  private readonly searchObserver: SearchObserver | undefined;
  private readonly loreLoggerOpts: LoreLoggerOptions | undefined;

  /**
   * @param dbPath          Path to the KB SQLite database.
   * @param embedder        Optional pre-initialised embedding provider for semantic search.
   *                        The caller owns the lifecycle — `stop()` will NOT dispose it.
   * @param searchObserver  Optional callback invoked after every lore_search call.
   * @param loreLoggerOpts  Optional Lore-internal logger configuration.
   */
  constructor(dbPath: string, embedder?: EmbeddingProvider, searchObserver?: SearchObserver, loreLoggerOpts?: LoreLoggerOptions) {
    this.dbPath = dbPath;
    this.embedder = embedder;
    this.searchObserver = searchObserver;
    this.loreLoggerOpts = loreLoggerOpts;
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

    const loreLogger = this.loreLoggerOpts ? new LoreLogger(this.loreLoggerOpts) : undefined;
    const serverOptions: LoreServerOptions = {
      ...(this.searchObserver ? { searchObserver: this.searchObserver } : {}),
      ...(loreLogger ? { logger: loreLogger } : {}),
    };

    // Session-based transport: each agent gets a unique session.
    // We create a new Lore MCP server + transport pair per session because the
    // MCP SDK only allows one transport per server instance at a time.
    const sessions = new Map<string, { transport: StreamableHTTPServerTransport; close: () => Promise<void> }>();
    this._sessions = sessions;

    const db = this.db;
    const dbPath = this.dbPath;
    const embedder = this.embedder;

    const httpServer = http.createServer(async (req, res) => {
      if (req.method === 'POST') {
        const raw = await new Promise<string>((resolve, reject) => {
          const chunks: Buffer[] = [];
          req.on('data', (chunk: Buffer) => chunks.push(chunk));
          req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
          req.on('error', reject);
        });
        let body: unknown;
        try { body = JSON.parse(raw); } catch { /* leave body undefined */ }

        const sessionId = req.headers['mcp-session-id'] as string | undefined;
        let entry = sessionId ? sessions.get(sessionId) : undefined;

        if (entry) {
          // Existing session — forward request.
          await entry.transport.handleRequest(req, res, body);
        } else if (!sessionId && isInitializeRequest(body)) {
          // New session — create transport + server pair.
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
          });
          const mcpServer = createLoreMcpServer(db, dbPath, embedder, serverOptions);
          await mcpServer.connect(transport);

          // Store session once the transport assigns an ID.
          transport.onclose = () => {
            const sid = transport.sessionId;
            if (sid) sessions.delete(sid);
          };

          await transport.handleRequest(req, res, body);

          const sid = transport.sessionId;
          if (sid) {
            sessions.set(sid, {
              transport,
              close: async () => { transport.close(); mcpServer.close(); },
            });
          }
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
            id: null,
          }));
        }
      } else if (req.method === 'GET') {
        // SSE stream for existing sessions
        const sessionId = req.headers['mcp-session-id'] as string | undefined;
        const entry = sessionId ? sessions.get(sessionId) : undefined;
        if (entry) {
          await entry.transport.handleRequest(req, res);
        } else {
          res.writeHead(400).end();
        }
      } else if (req.method === 'DELETE') {
        const sessionId = req.headers['mcp-session-id'] as string | undefined;
        const entry = sessionId ? sessions.get(sessionId) : undefined;
        if (entry) {
          await entry.transport.handleRequest(req, res);
          sessions.delete(sessionId!);
        } else {
          res.writeHead(404).end();
        }
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
    // Close all active MCP sessions.
    if (this._sessions) {
      for (const entry of this._sessions.values()) {
        try { await entry.close(); } catch { /* best-effort */ }
      }
      this._sessions.clear();
      this._sessions = null;
    }

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
