import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawnWithTimeout } from '../src/util/process.js';

describe('spawnWithTimeout', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'aamf-process-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should capture stdout', async () => {
    const result = await spawnWithTimeout('echo', ['hello']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello');
    expect(result.killed).toBe(false);
  });

  it('should capture exit code', async () => {
    const result = await spawnWithTimeout('node', ['-e', 'process.exit(42)']);
    expect(result.exitCode).toBe(42);
    expect(result.killed).toBe(false);
  });

  it('should capture stderr', async () => {
    const result = await spawnWithTimeout('node', ['-e', "console.error('err')"]);
    expect(result.stderr.trim()).toBe('err');
  });

  it('should kill process on timeout', async () => {
    const result = await spawnWithTimeout('node', ['-e', 'setTimeout(() => {}, 60000)'], {
      timeout: 300,
    });
    expect(result.killed).toBe(true);
  });

  it('should complete normally without timeout option', async () => {
    const result = await spawnWithTimeout('echo', ['fast']);
    expect(result.exitCode).toBe(0);
    expect(result.killed).toBe(false);
    expect(result.stdout.trim()).toBe('fast');
  });

  it('should reject with error for invalid command', async () => {
    await expect(
      spawnWithTimeout('__no_such_binary__', []),
    ).rejects.toThrow();
  });

  it('should respect cwd option', async () => {
    const resolved = await realpath(tempDir);
    const result = await spawnWithTimeout('pwd', [], { cwd: tempDir });
    expect(result.stdout.trim()).toBe(resolved);
  });

  it('should track duration', async () => {
    const result = await spawnWithTimeout('node', ['-e', 'setTimeout(() => {}, 100)']);
    expect(result.duration).toBeGreaterThanOrEqual(80);
  });
});
