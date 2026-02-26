/**
 * Tests for KbServerProcess.
 *
 * These tests cover the public API of KbServerProcess (mcpConfig getter,
 * start/stop lifecycle) without actually spawning the full server process.
 * The subprocess behaviour is tested via mocked child_process.spawn calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

// We mock child_process before importing the module under test so that
// no real subprocesses are spawned during testing.
vi.mock('node:child_process', () => {
  const mockSpawn = vi.fn();
  return { spawn: mockSpawn };
});

import { spawn } from 'node:child_process';
import { KbServerProcess } from '../src/core/kb-server-process.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Create a fake ChildProcess-like EventEmitter with the minimal shape used by KbServerProcess. */
function makeFakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stderr: EventEmitter;
    stdout: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  child.stderr = new EventEmitter();
  child.stdout = new EventEmitter();
  child.kill = vi.fn();
  child.pid = 12345;
  return child;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('KbServerProcess', () => {
  const mockSpawn = vi.mocked(spawn);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── mcpConfig ────────────────────────────────────────────────────────────

  describe('mcpConfig', () => {
    it('should return a config with command and args fields', () => {
      const proc = new KbServerProcess('/tmp/test.db');
      const cfg = proc.mcpConfig;
      expect(cfg).toHaveProperty('command');
      expect(cfg).toHaveProperty('args');
      expect(typeof cfg.command).toBe('string');
      expect(Array.isArray(cfg.args)).toBe(true);
    });

    it('should include the db path in the args', () => {
      const dbPath = '/some/path/to/kb.db';
      const proc = new KbServerProcess(dbPath);
      const cfg = proc.mcpConfig;
      expect(cfg.args).toContain(dbPath);
      expect(cfg.args).toContain('--db');
    });

    it('should return the same config object on repeated calls', () => {
      const proc = new KbServerProcess('/tmp/test.db');
      expect(proc.mcpConfig).toBe(proc.mcpConfig);
    });

    it('should use "tsx" command in dev mode (default)', () => {
      // AAMF_USE_COMPILED_KB_SERVER is not set → dev mode
      const origEnv = process.env['AAMF_USE_COMPILED_KB_SERVER'];
      delete process.env['AAMF_USE_COMPILED_KB_SERVER'];
      const proc = new KbServerProcess('/tmp/test.db');
      expect(proc.mcpConfig.command).toBe('tsx');
      if (origEnv !== undefined) process.env['AAMF_USE_COMPILED_KB_SERVER'] = origEnv;
    });
  });

  // ─── stop() ───────────────────────────────────────────────────────────────

  describe('stop()', () => {
    it('should resolve immediately when the server was never started', async () => {
      const proc = new KbServerProcess('/tmp/test.db');
      await expect(proc.stop()).resolves.toBeUndefined();
    });

    it('should send SIGTERM to the child process', async () => {
      const fakeChild = makeFakeChild();
      mockSpawn.mockReturnValue(fakeChild as unknown as ReturnType<typeof spawn>);

      const proc = new KbServerProcess('/tmp/test.db');

      // Start resolves once READY is received; emit it asynchronously.
      const startPromise = proc.start();
      fakeChild.stderr.emit('data', Buffer.from('READY\n'));
      await startPromise;

      const stopPromise = proc.stop();
      // Simulate the process exiting after SIGTERM.
      fakeChild.emit('exit', 0);
      await stopPromise;

      expect(fakeChild.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('should resolve after child exits', async () => {
      const fakeChild = makeFakeChild();
      mockSpawn.mockReturnValue(fakeChild as unknown as ReturnType<typeof spawn>);

      const proc = new KbServerProcess('/tmp/test.db');

      const startPromise = proc.start();
      fakeChild.stderr.emit('data', Buffer.from('READY\n'));
      await startPromise;

      let resolved = false;
      const stopPromise = proc.stop().then(() => { resolved = true; });

      expect(resolved).toBe(false);
      fakeChild.emit('exit', 0);
      await stopPromise;
      expect(resolved).toBe(true);
    });
  });

  // ─── start() ──────────────────────────────────────────────────────────────

  describe('start()', () => {
    it('should resolve when server emits READY on stderr', async () => {
      const fakeChild = makeFakeChild();
      mockSpawn.mockReturnValue(fakeChild as unknown as ReturnType<typeof spawn>);

      const proc = new KbServerProcess('/tmp/test.db');
      const startPromise = proc.start();

      fakeChild.stderr.emit('data', Buffer.from('READY\n'));
      await expect(startPromise).resolves.toBeUndefined();
    });

    it('should reject when the child process errors', async () => {
      const fakeChild = makeFakeChild();
      mockSpawn.mockReturnValue(fakeChild as unknown as ReturnType<typeof spawn>);

      const proc = new KbServerProcess('/tmp/test.db');
      const startPromise = proc.start();

      fakeChild.emit('error', new Error('ENOENT'));
      await expect(startPromise).rejects.toThrow('ENOENT');
    });

    it('should reject when the child exits before sending READY', async () => {
      const fakeChild = makeFakeChild();
      mockSpawn.mockReturnValue(fakeChild as unknown as ReturnType<typeof spawn>);

      const proc = new KbServerProcess('/tmp/test.db');
      const startPromise = proc.start();

      fakeChild.emit('exit', 1);
      await expect(startPromise).rejects.toThrow(/exited unexpectedly/);
    });

    it('should reject if server does not become ready within the timeout', async () => {
      vi.useFakeTimers();
      const fakeChild = makeFakeChild();
      mockSpawn.mockReturnValue(fakeChild as unknown as ReturnType<typeof spawn>);

      const proc = new KbServerProcess('/tmp/test.db');
      const startPromise = proc.start(30_000);

      // Advance time past the timeout without emitting READY.
      vi.advanceTimersByTime(30_001);
      await expect(startPromise).rejects.toThrow(/did not become ready/);
      vi.useRealTimers();
    });

    it('should be a no-op if already started', async () => {
      const fakeChild = makeFakeChild();
      mockSpawn.mockReturnValue(fakeChild as unknown as ReturnType<typeof spawn>);

      const proc = new KbServerProcess('/tmp/test.db');

      const first = proc.start();
      fakeChild.stderr.emit('data', Buffer.from('READY\n'));
      await first;

      // Second start() should resolve immediately without spawning again.
      await expect(proc.start()).resolves.toBeUndefined();
      expect(mockSpawn).toHaveBeenCalledTimes(1);
    });
  });
});
