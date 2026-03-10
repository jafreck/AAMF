import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { spawnWithTimeout, resolveLoginPath, killProcessTree, killAllActiveProcesses } from '../src/util/process.js';

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

  it('should resolve login PATH and prepend expanded extraPath entries', async () => {
    const result = await resolveLoginPath({ shell: '/bin/sh', extraPath: ['~/aamf-extra-bin'] });
    expect(result.startsWith(`${homedir()}/aamf-extra-bin:`)).toBe(true);
  });

  it('should fall back to process PATH when shell invocation fails', async () => {
    const baseline = process.env.PATH ?? '';
    const result = await resolveLoginPath({ shell: '/definitely/not/a/shell' });
    expect(result).toBe(baseline);
  });

  it('should still prepend extraPath when shell invocation fails', async () => {
    const baseline = process.env.PATH ?? '';
    const result = await resolveLoginPath({
      shell: '/definitely/not/a/shell',
      extraPath: ['/tmp/aamf-extra'],
    });
    expect(result).toBe(`/tmp/aamf-extra:${baseline}`);
  });

  it('killProcessTree should not throw for a non-existent pid', async () => {
    await expect(killProcessTree(999_999)).resolves.toBeUndefined();
  });

  describe('streaming callbacks', () => {
    it('should invoke onStdoutData for each stdout chunk', async () => {
      const chunks: string[] = [];
      const result = await spawnWithTimeout('echo', ['hello streaming'], {
        onStdoutData: (chunk) => chunks.push(chunk.toString()),
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('hello streaming');
      // The callback should have received at least one chunk containing the output
      const combined = chunks.join('');
      expect(combined).toContain('hello streaming');
    });

    it('should invoke onStderrData for each stderr chunk', async () => {
      const chunks: string[] = [];
      const result = await spawnWithTimeout('node', ['-e', "console.error('err-stream')"], {
        onStderrData: (chunk) => chunks.push(chunk.toString()),
      });
      expect(result.stderr.trim()).toBe('err-stream');
      const combined = chunks.join('');
      expect(combined).toContain('err-stream');
    });

    it('should still produce full stdout/stderr when callbacks are provided', async () => {
      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];
      const result = await spawnWithTimeout('node', [
        '-e', "console.log('out1'); console.log('out2'); console.error('err1');",
      ], {
        onStdoutData: (chunk) => stdoutChunks.push(chunk.toString()),
        onStderrData: (chunk) => stderrChunks.push(chunk.toString()),
      });
      expect(result.stdout).toContain('out1');
      expect(result.stdout).toContain('out2');
      expect(result.stderr).toContain('err1');
    });
  });

  describe('killAllActiveProcesses', () => {
    it('should kill a long-running child process', async () => {
      // Start a process that would run for 60 seconds
      const promise = spawnWithTimeout('node', ['-e', 'setTimeout(() => {}, 60000)']);
      // Give it a moment to spawn
      await new Promise(r => setTimeout(r, 200));
      // Kill all active — this should terminate the child
      await killAllActiveProcesses();
      const result = await promise;
      expect(result.killed).toBe(false); // killed flag is set by timeout, not external kill
      expect(result.exitCode).not.toBe(0);
    });

    it('should be a no-op when no processes are active', async () => {
      await expect(killAllActiveProcesses()).resolves.toBeUndefined();
    });

    it('should clear the registry after killing', async () => {
      const promise = spawnWithTimeout('node', ['-e', 'setTimeout(() => {}, 60000)']);
      await new Promise(r => setTimeout(r, 200));
      await killAllActiveProcesses();
      await promise;
      // Second call should be a no-op (registry was cleared)
      await expect(killAllActiveProcesses()).resolves.toBeUndefined();
    });
  });
});
