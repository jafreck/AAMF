/**
 * Tests for KbServerProcess.
 *
 * The KB server now runs as an in-process HTTP MCP server rather than a
 * spawned subprocess, so tests exercise the HTTP lifecycle directly.
 *
 * `start()` requires a valid SQLite KB database to open; tests that exercise
 * the full server lifecycle use a real DB built by IndexBuilder from a fixture.
 * Simple contract tests (e.g. mcpConfig shape before start) do not need a DB.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'node:http';
import { join, resolve } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { IndexBuilder } from '@jafreck/lore';
import { KbServerProcess } from '../../src/core/kb-server-process.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const FIXTURE_DIR = resolve(
  import.meta.dirname ?? new URL('.', import.meta.url).pathname,
  '../fixtures/tiny-python-project',
);

let tempDir: string;
let dbPath: string;

function rawRequest(
  url: string,
  options: { method?: string; headers?: Record<string, string>; chunks?: string[] } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolveRequest, rejectRequest) => {
    const parsed = new URL(url);
    const request = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method: options.method ?? 'POST',
      headers: options.headers,
    }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => resolveRequest({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.on('error', rejectRequest);
    for (const chunk of options.chunks ?? []) request.write(chunk);
    request.end();
  });
}

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'aamf-kbproc-test-'));
  dbPath = join(tempDir, 'kb.db');
  const builder = new IndexBuilder(dbPath, { rootDir: FIXTURE_DIR });
  await builder.build();
}, 60_000);

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('KbServerProcess', () => {
  // ─── mcpConfig ────────────────────────────────────────────────────────────

  describe('mcpConfig (before start)', () => {
    it('should throw before start() is called', () => {
      const proc = new KbServerProcess(dbPath);
      expect(() => proc.mcpConfig).toThrow();
    });
  });

  // ─── stop() before start ──────────────────────────────────────────────────

  describe('stop()', () => {
    it('should resolve immediately when the server was never started', async () => {
      const proc = new KbServerProcess(dbPath);
      await expect(proc.stop()).resolves.toBeUndefined();
    });
  });

  // ─── start() / stop() lifecycle ───────────────────────────────────────────

  describe('start() and stop() lifecycle', () => {
    it('should start and expose a URL in mcpConfig', async () => {
      const proc = new KbServerProcess(dbPath);
      await proc.start();
      try {
        const cfg = proc.mcpConfig;
        expect(cfg).toHaveProperty('url');
        expect(cfg.url).toMatch(/^http:\/\/(localhost|127\.0\.0\.1):\d+\/mcp$/);
      } finally {
        await proc.stop();
      }
    });

    it('should be a no-op if already started', async () => {
      const proc = new KbServerProcess(dbPath);
      await proc.start();
      const urlBefore = proc.mcpConfig.url;
      await proc.start(); // second call
      const urlAfter = proc.mcpConfig.url;
      expect(urlBefore).toBe(urlAfter);
      await proc.stop();
    });

    it('should serve HTTP requests after start()', async () => {
      const proc = new KbServerProcess(dbPath);
      await proc.start();
      try {
        const url = proc.mcpConfig.url;
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              protocolVersion: '2024-11-05',
              capabilities: {},
              clientInfo: { name: 'test', version: '0.0.1' },
            },
          }),
        });
        expect(res.status).toBeLessThan(500);
      } finally {
        await proc.stop();
      }
    });

    it('should reject declared and streamed oversized requests with 413 and remain healthy', async () => {
      const proc = new KbServerProcess(dbPath, undefined, undefined, undefined, {
        maxRequestBytes: 512,
      });
      await proc.start();
      try {
        const url = proc.mcpConfig.url;
        const declared = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: 'x'.repeat(513),
        });
        expect(declared.status).toBe(413);

        const streamed = await rawRequest(url, {
          headers: { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' },
          chunks: ['x'.repeat(300), 'y'.repeat(300)],
        });
        expect(streamed.status).toBe(413);
        expect(streamed.body).toContain('Request body too large');

        const healthy = await fetch(url, { method: 'GET' });
        expect(healthy.status).toBe(400);
      } finally {
        await proc.stop();
      }
    });

    it('should reject an untrusted Host header before creating a session', async () => {
      const proc = new KbServerProcess(dbPath);
      await proc.start();
      try {
        const response = await rawRequest(proc.mcpConfig.url, {
          headers: { Host: 'evil.example.test', 'Content-Type': 'application/json' },
          chunks: [JSON.stringify({
            jsonrpc: '2.0', id: 1, method: 'initialize',
            params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
          })],
        });
        expect(response.status).toBe(403);
        expect(proc.sessionCount).toBe(0);
      } finally {
        await proc.stop();
      }
    });

    it('should stop cleanly and refuse to serve after stop()', async () => {
      const proc = new KbServerProcess(dbPath);
      await proc.start();
      const url = proc.mcpConfig.url;
      await proc.stop();

      // After stopping, the port should be unreachable.
      await expect(
        fetch(url, { method: 'POST' }),
      ).rejects.toThrow();
    });
  });

  // ─── Session-based MCP transport ──────────────────────────────────────────

  describe('session-based MCP transport', () => {
    const MCP_HEADERS = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    };

    /** Send an MCP initialize request and return the session ID. */
    async function initSession(url: string): Promise<string> {
      const res = await fetch(url, {
        method: 'POST',
        headers: MCP_HEADERS,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'test', version: '0.0.1' },
          },
        }),
      });
      expect(res.status).toBe(200);
      const sid = res.headers.get('mcp-session-id');
      expect(sid).toBeTruthy();
      // Drain response body
      await res.text();
      return sid!;
    }

    it('should establish a session and serve tools/list on the same session', async () => {
      const proc = new KbServerProcess(dbPath);
      await proc.start();
      try {
        const url = proc.mcpConfig.url;
        const sid = await initSession(url);

        // Send initialized notification
        const notifRes = await fetch(url, {
          method: 'POST',
          headers: { ...MCP_HEADERS, 'mcp-session-id': sid },
          body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        });
        expect(notifRes.status).toBeLessThan(300);
        await notifRes.text();

        // List tools on same session
        const toolsRes = await fetch(url, {
          method: 'POST',
          headers: { ...MCP_HEADERS, 'mcp-session-id': sid },
          body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
        });
        expect(toolsRes.status).toBe(200);
        const toolsBody = await toolsRes.text();
        expect(toolsBody).toContain('lore_search');
      } finally {
        await proc.stop();
      }
    });

    it('should reject new sessions at the configured hard limit', async () => {
      const proc = new KbServerProcess(dbPath, undefined, undefined, undefined, { maxSessions: 1 });
      await proc.start();
      try {
        await initSession(proc.mcpConfig.url);
        const response = await fetch(proc.mcpConfig.url, {
          method: 'POST',
          headers: MCP_HEADERS,
          body: JSON.stringify({
            jsonrpc: '2.0', id: 2, method: 'initialize',
            params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'second', version: '1' } },
          }),
        });
        expect(response.status).toBe(503);
        expect(proc.sessionCount).toBe(1);
      } finally {
        await proc.stop();
      }
    });

    it('should remove and close a session after DELETE', async () => {
      const proc = new KbServerProcess(dbPath);
      await proc.start();
      try {
        const sid = await initSession(proc.mcpConfig.url);
        const response = await fetch(proc.mcpConfig.url, {
          method: 'DELETE',
          headers: { ...MCP_HEADERS, 'mcp-session-id': sid },
        });
        expect(response.status).toBeLessThan(300);
        expect(proc.sessionCount).toBe(0);
      } finally {
        await proc.stop();
      }
    });

    it('should close resources when session initialization fails', async () => {
      const handleSpy = vi.spyOn(StreamableHTTPServerTransport.prototype, 'handleRequest')
        .mockRejectedValueOnce(new Error('initialize failed'));
      const closeSpy = vi.spyOn(StreamableHTTPServerTransport.prototype, 'close');
      const proc = new KbServerProcess(dbPath, undefined, undefined, undefined, { stopTimeoutMs: 100 });
      await proc.start();
      try {
        const response = await fetch(proc.mcpConfig.url, {
          method: 'POST',
          headers: MCP_HEADERS,
          body: JSON.stringify({
            jsonrpc: '2.0', id: 1, method: 'initialize',
            params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
          }),
        });
        expect(response.status).toBe(500);
        expect(proc.sessionCount).toBe(0);
        expect(closeSpy).toHaveBeenCalled();
      } finally {
        handleSpy.mockRestore();
        closeSpy.mockRestore();
        await proc.stop();
      }
    });

    it('should evict abandoned sessions after the configured idle period', async () => {
      const proc = new KbServerProcess(dbPath, undefined, undefined, undefined, {
        sessionIdleTimeoutMs: 30,
        sessionSweepIntervalMs: 5,
        stopTimeoutMs: 100,
      });
      await proc.start();
      try {
        await initSession(proc.mcpConfig.url);
        expect(proc.sessionCount).toBe(1);
        await vi.waitFor(() => expect(proc.sessionCount).toBe(0), { timeout: 500, interval: 10 });
      } finally {
        await proc.stop();
      }
    });

    it('should contain async transport failures and return a generic 500 response', async () => {
      const proc = new KbServerProcess(dbPath);
      await proc.start();
      try {
        const url = proc.mcpConfig.url;
        const sid = await initSession(url);
        const entry = [...((proc as any)._sessions as Map<string, any>).values()][0];
        entry.transport.handleRequest = vi.fn().mockRejectedValue(new Error('sensitive internal failure'));

        const response = await fetch(url, {
          method: 'POST',
          headers: { ...MCP_HEADERS, 'mcp-session-id': sid },
          body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
        });
        expect(response.status).toBe(500);
        const body = await response.text();
        expect(body).toContain('Internal server error');
        expect(body).not.toContain('sensitive internal failure');
      } finally {
        await proc.stop();
      }
    });

    it('should close all session and database state during bounded shutdown', async () => {
      const proc = new KbServerProcess(dbPath, undefined, undefined, undefined, { stopTimeoutMs: 250 });
      await proc.start();
      await initSession(proc.mcpConfig.url);

      await proc.stop();

      expect(proc.sessionCount).toBe(0);
      expect((proc as any).db).toBeNull();
      expect((proc as any).httpServer).toBeNull();
      expect((proc as any).sessionSweepTimer).toBeNull();
    });

    it('should bound shutdown when a session close never settles', async () => {
      const proc = new KbServerProcess(dbPath, undefined, undefined, undefined, { stopTimeoutMs: 25 });
      await proc.start();
      await initSession(proc.mcpConfig.url);
      const entry = [...((proc as any)._sessions as Map<string, any>).values()][0];
      entry.close = () => new Promise<void>(() => {});

      const started = Date.now();
      await proc.stop();
      expect(Date.now() - started).toBeLessThan(500);
      expect(proc.sessionCount).toBe(0);
      expect((proc as any).db).toBeNull();
    });

    it('should return 400 for POST without session ID on non-initialize request', async () => {
      const proc = new KbServerProcess(dbPath);
      await proc.start();
      try {
        const url = proc.mcpConfig.url;
        const res = await fetch(url, {
          method: 'POST',
          headers: MCP_HEADERS,
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
        });
        expect(res.status).toBe(400);
      } finally {
        await proc.stop();
      }
    });

    it('should return 400 for GET without a valid session ID', async () => {
      const proc = new KbServerProcess(dbPath);
      await proc.start();
      try {
        const url = proc.mcpConfig.url;
        const res = await fetch(url, { method: 'GET' });
        expect(res.status).toBe(400);
      } finally {
        await proc.stop();
      }
    });

    it('should return 404 for DELETE without a valid session ID', async () => {
      const proc = new KbServerProcess(dbPath);
      await proc.start();
      try {
        const url = proc.mcpConfig.url;
        const res = await fetch(url, { method: 'DELETE' });
        expect(res.status).toBe(404);
      } finally {
        await proc.stop();
      }
    });

    it('should return 405 for unsupported HTTP methods', async () => {
      const proc = new KbServerProcess(dbPath);
      await proc.start();
      try {
        const url = proc.mcpConfig.url;
        const res = await fetch(url, { method: 'PUT' });
        expect(res.status).toBe(405);
      } finally {
        await proc.stop();
      }
    });
  });
});
