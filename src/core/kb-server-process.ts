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

const DEFAULT_MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_SESSION_SWEEP_INTERVAL_MS = 60_000;
const DEFAULT_STOP_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_SESSIONS = 64;

export interface KbServerProcessOptions {
  maxRequestBytes?: number;
  sessionIdleTimeoutMs?: number;
  sessionSweepIntervalMs?: number;
  stopTimeoutMs?: number;
  maxSessions?: number;
}

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  lastActivityMs: number;
  sessionId?: string;
  close: (closeTransport?: boolean) => Promise<void>;
}

class PayloadTooLargeError extends Error {
  constructor() {
    super('Request body too large');
    this.name = 'PayloadTooLargeError';
  }
}

function jsonRpcError(status: number, message: string): string {
  return JSON.stringify({ jsonrpc: '2.0', error: { code: status === 413 ? -32600 : -32603, message }, id: null });
}

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
  private _sessions: Map<string, SessionEntry> | null = null;
  private pendingSessions: Set<SessionEntry> | null = null;
  private sessionSweepTimer: ReturnType<typeof setInterval> | null = null;
  private sweepInProgress = false;
  private stopping = false;
  private readonly embedder: EmbeddingProvider | undefined;
  private readonly searchObserver: SearchObserver | undefined;
  private readonly loreLoggerOpts: LoreLoggerOptions | undefined;
  private readonly options: Required<KbServerProcessOptions>;
  private loreLogger: LoreLogger | undefined;

  /**
   * @param dbPath          Path to the KB SQLite database.
   * @param embedder        Optional pre-initialised embedding provider for semantic search.
   *                        The caller owns the lifecycle — `stop()` will NOT dispose it.
   * @param searchObserver  Optional callback invoked after every lore_search call.
   * @param loreLoggerOpts  Optional Lore-internal logger configuration.
   */
  constructor(
    dbPath: string,
    embedder?: EmbeddingProvider,
    searchObserver?: SearchObserver,
    loreLoggerOpts?: LoreLoggerOptions,
    options: KbServerProcessOptions = {},
  ) {
    this.dbPath = dbPath;
    this.embedder = embedder;
    this.searchObserver = searchObserver;
    this.loreLoggerOpts = loreLoggerOpts;
    this.options = {
      maxRequestBytes: options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES,
      sessionIdleTimeoutMs: options.sessionIdleTimeoutMs ?? DEFAULT_SESSION_IDLE_TIMEOUT_MS,
      sessionSweepIntervalMs: options.sessionSweepIntervalMs ?? DEFAULT_SESSION_SWEEP_INTERVAL_MS,
      stopTimeoutMs: options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS,
      maxSessions: options.maxSessions ?? DEFAULT_MAX_SESSIONS,
    };
  }

  /** Active sessions, exposed for health checks and deterministic lifecycle tests. */
  get sessionCount(): number {
    return this._sessions?.size ?? 0;
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
    this.stopping = false;

    this.db = openReadOnly(this.dbPath);

    const loreLogger = this.loreLoggerOpts ? new LoreLogger(this.loreLoggerOpts) : undefined;
    this.loreLogger = loreLogger;
    const serverOptions: LoreServerOptions = {
      ...(this.searchObserver ? { searchObserver: this.searchObserver } : {}),
      ...(loreLogger ? { logger: loreLogger } : {}),
    };

    // Session-based transport: each agent gets a unique session.
    // We create a new Lore MCP server + transport pair per session because the
    // MCP SDK only allows one transport per server instance at a time.
    const sessions = new Map<string, SessionEntry>();
    const pendingSessions = new Set<SessionEntry>();
    let initializingSessions = 0;
    this._sessions = sessions;
    this.pendingSessions = pendingSessions;

    const db = this.db;
    const dbPath = this.dbPath;
    const embedder = this.embedder;

    const handleRequest = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
      if (this.stopping) {
        res.writeHead(503, { 'Content-Type': 'application/json' }).end(jsonRpcError(503, 'Server shutting down'));
        return;
      }
      const expectedHosts = new Set([`localhost:${this._port}`, `127.0.0.1:${this._port}`]);
      if (!req.headers.host || !expectedHosts.has(req.headers.host)) {
        res.writeHead(403, { 'Content-Type': 'application/json' }).end(jsonRpcError(403, 'Forbidden'));
        return;
      }

      if (req.method === 'POST') {
        const declaredLength = Number(req.headers['content-length']);
        if (Number.isFinite(declaredLength) && declaredLength > this.options.maxRequestBytes) {
          req.resume();
          throw new PayloadTooLargeError();
        }
        const raw = await new Promise<string>((resolveBody, rejectBody) => {
          const chunks: Buffer[] = [];
          let total = 0;
          let complete = false;
          const cleanup = () => {
            req.off('data', onData);
            req.off('end', onEnd);
            req.off('error', onError);
          };
          const onData = (chunk: Buffer) => {
            if (complete) return;
            total += chunk.length;
            if (total > this.options.maxRequestBytes) {
              complete = true;
              cleanup();
              req.resume();
              rejectBody(new PayloadTooLargeError());
              return;
            }
            chunks.push(chunk);
          };
          const onEnd = () => {
            if (complete) return;
            complete = true;
            cleanup();
            resolveBody(Buffer.concat(chunks).toString('utf8'));
          };
          const onError = (error: Error) => {
            if (complete) return;
            complete = true;
            cleanup();
            rejectBody(error);
          };
          req.on('data', onData);
          req.on('end', onEnd);
          req.on('error', onError);
        });
        let body: unknown;
        try { body = JSON.parse(raw); } catch { /* leave body undefined */ }

        const sessionId = req.headers['mcp-session-id'] as string | undefined;
        let entry = sessionId ? sessions.get(sessionId) : undefined;

        if (entry) {
          // Existing session — forward request.
          entry.lastActivityMs = Date.now();
          await entry.transport.handleRequest(req, res, body);
        } else if (!sessionId && isInitializeRequest(body)) {
          // New session — create transport + server pair.
          if (sessions.size + initializingSessions >= this.options.maxSessions) {
            res.writeHead(503, { 'Content-Type': 'application/json' }).end(jsonRpcError(503, 'Session limit reached'));
            return;
          }
          initializingSessions++;
          let newEntry!: SessionEntry;
          let mcpServer: Awaited<ReturnType<typeof createLoreMcpServer>> | undefined;
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            enableDnsRebindingProtection: true,
            allowedHosts: [...expectedHosts],
            onsessioninitialized: async (sid) => {
              newEntry.sessionId = sid;
              if (this.stopping) {
                await newEntry.close();
                return;
              }
              sessions.set(sid, newEntry);
            },
            onsessionclosed: async (sid) => {
              const closing = sessions.get(sid);
              if (closing) await closing.close(false);
            },
          });
          let closePromise: Promise<void> | undefined;
          newEntry = {
            transport,
            lastActivityMs: Date.now(),
            close: (closeTransport = true) => {
              if (closePromise) return closePromise;
              if (newEntry.sessionId) sessions.delete(newEntry.sessionId);
              closePromise = (async () => {
                const operations: Promise<unknown>[] = [];
                if (closeTransport) operations.unshift(transport.close());
                if (mcpServer) operations.push(mcpServer.close());
                const results = await Promise.allSettled(operations);
                for (const result of results) {
                  if (result.status === 'rejected') {
                    loreLogger?.warn('kb-server', 'Failed to close MCP session resource', {
                      error: result.reason instanceof Error ? result.reason.message : String(result.reason),
                    });
                  }
                }
              })();
              return closePromise;
            },
          };
          pendingSessions.add(newEntry);

          try {
            mcpServer = await createLoreMcpServer(db, dbPath, embedder, serverOptions);
            await mcpServer.connect(transport);
            await transport.handleRequest(req, res, body);
          } catch (error) {
            await this.settleWithin(newEntry.close(), this.options.stopTimeoutMs);
            throw error;
          } finally {
            initializingSessions--;
            pendingSessions.delete(newEntry);
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
          entry.lastActivityMs = Date.now();
          await entry.transport.handleRequest(req, res);
        } else {
          res.writeHead(400).end();
        }
      } else if (req.method === 'DELETE') {
        const sessionId = req.headers['mcp-session-id'] as string | undefined;
        const entry = sessionId ? sessions.get(sessionId) : undefined;
        if (entry) {
          entry.lastActivityMs = Date.now();
          await entry.transport.handleRequest(req, res);
          await entry.close();
        } else {
          res.writeHead(404).end();
        }
      } else {
        res.writeHead(405).end();
      }
    };

    const httpServer = http.createServer((req, res) => {
      void handleRequest(req, res).catch((error: unknown) => {
        const tooLarge = error instanceof PayloadTooLargeError;
        loreLogger?.error('kb-server', 'MCP request failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        if (!res.headersSent && !res.writableEnded) {
          const status = tooLarge ? 413 : 500;
          const message = tooLarge ? 'Request body too large' : 'Internal server error';
          res.writeHead(status, { 'Content-Type': 'application/json' }).end(jsonRpcError(status, message));
        } else if (!res.writableEnded) {
          res.destroy();
        }
      });
    });

    try {
      await new Promise<void>((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(0, '127.0.0.1', () => resolve());
      });
    } catch (error) {
      try { this.db?.close(); } catch { /* best-effort */ }
      this.db = null;
      this._sessions = null;
      this.pendingSessions = null;
      loreLogger?.close();
      this.loreLogger = undefined;
      throw error;
    }

    this._port = (httpServer.address() as AddressInfo).port;
    httpServer.requestTimeout = 60_000;
    httpServer.headersTimeout = 30_000;
    this.httpServer = httpServer;

    if (this.options.sessionIdleTimeoutMs > 0 && this.options.sessionSweepIntervalMs > 0) {
      this.sessionSweepTimer = setInterval(() => {
        void this.evictIdleSessions().catch(error => {
          loreLogger?.error('kb-server', 'Idle-session eviction failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }, this.options.sessionSweepIntervalMs);
      this.sessionSweepTimer.unref();
    }
  }

  private async evictIdleSessions(now = Date.now()): Promise<void> {
    if (this.sweepInProgress || !this._sessions || this.options.sessionIdleTimeoutMs <= 0) return;
    this.sweepInProgress = true;
    try {
      const expired = [...this._sessions.values()].filter(
        entry => now - entry.lastActivityMs >= this.options.sessionIdleTimeoutMs,
      );
      for (const entry of expired) {
        if (entry.sessionId) this._sessions.delete(entry.sessionId);
      }
      await Promise.allSettled(expired.map(entry => this.settleWithin(entry.close(), this.options.stopTimeoutMs)));
    } finally {
      this.sweepInProgress = false;
    }
  }

  private async settleWithin(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        promise.then(() => undefined, () => undefined),
        new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Shut down the HTTP server.
   * Resolves immediately if the server was never started.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.sessionSweepTimer) {
      clearInterval(this.sessionSweepTimer);
      this.sessionSweepTimer = null;
    }

    const server = this.httpServer;
    this.httpServer = null;
    this._port = null;
    let finishServerClose: (() => void) | undefined;
    const serverClose = server
      ? new Promise<void>(resolve => {
          finishServerClose = resolve;
          server.close(() => resolve());
          server.closeIdleConnections();
        })
      : Promise.resolve();

    // Close all active MCP sessions.
    if (this._sessions || this.pendingSessions) {
      const entries = [...new Set([
        ...(this._sessions?.values() ?? []),
        ...(this.pendingSessions ?? []),
      ])];
      this._sessions?.clear();
      this._sessions = null;
      this.pendingSessions?.clear();
      this.pendingSessions = null;
      await Promise.allSettled(entries.map(entry => this.settleWithin(entry.close(), this.options.stopTimeoutMs)));
    }

    if (server) {
      let forced: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          serverClose,
          new Promise<void>(resolve => {
            forced = setTimeout(() => {
              server.closeAllConnections();
              finishServerClose?.();
              resolve();
            }, this.options.stopTimeoutMs);
          }),
        ]);
      } finally {
        if (forced) clearTimeout(forced);
      }
    }

    // Close the read-only DB handle.
    if (this.db) {
      try { this.db.close(); } catch { /* best-effort */ }
      this.db = null;
    }
    this.loreLogger?.close();
    this.loreLogger = undefined;
  }
}
