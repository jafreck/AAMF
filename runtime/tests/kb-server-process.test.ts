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

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join, resolve } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { IndexBuilder } from '../src/indexer/index.js';
import { KbServerProcess } from '../src/core/kb-server-process.js';

const FIXTURE_DIR = resolve(
  import.meta.dirname ?? new URL('.', import.meta.url).pathname,
  'fixtures/tiny-python-project',
);

let tempDir: string;
let dbPath: string;

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
});
