import { describe, it, expect } from 'vitest';
import { classifyError } from '../src/core/orchestrator.js';

describe('classifyError', () => {
  // ─── File Lock Patterns ──────────────────────────────────────────

  it('should detect Cargo file lock contention', () => {
    const err = 'Blocking waiting for file lock on artifact directory /tmp/target';
    expect(classifyError(err)).toBe('file-lock');
  });

  it('should detect NuGet/MSBuild file lock', () => {
    const err = 'Could not acquire lock on file "packages.lock.json"';
    expect(classifyError(err)).toBe('file-lock');
  });

  it('should detect generic lock file error', () => {
    const err = 'Error: lock file /tmp/lockfile is locked by another process';
    expect(classifyError(err)).toBe('file-lock');
  });

  // ─── Process Killed ──────────────────────────────────────────────

  it('should detect SIGKILL', () => {
    expect(classifyError('process killed by signal: killed')).toBe('process-killed');
    expect(classifyError('error: SIGKILL received')).toBe('process-killed');
    expect(classifyError('killed by signal 9')).toBe('process-killed');
  });

  // ─── OOM ─────────────────────────────────────────────────────────

  it('should detect out of memory', () => {
    expect(classifyError('fatal error: out of memory')).toBe('oom');
    expect(classifyError('Cannot allocate memory')).toBe('oom');
    expect(classifyError('OOM killer invoked')).toBe('oom');
  });

  // ─── Disk Full ───────────────────────────────────────────────────

  it('should detect disk full', () => {
    expect(classifyError('write error: no space left on device')).toBe('disk-full');
    expect(classifyError('ENOSPC: no space left on device')).toBe('disk-full');
  });

  // ─── Network Errors ──────────────────────────────────────────────

  it('should detect network errors', () => {
    expect(classifyError('network error: connection refused')).toBe('network');
    expect(classifyError('could not resolve host: crates.io')).toBe('network');
    expect(classifyError('failed to download package from npm registry')).toBe('network');
    expect(classifyError('connection timed out')).toBe('network');
    expect(classifyError('DNS resolution failed for pypi.org')).toBe('network');
    expect(classifyError('registry https://registry.npmjs.org unavailable')).toBe('network');
  });

  it('should detect HTTP/2 GOAWAY and API transport failures as network errors', () => {
    expect(classifyError('HTTP/2 GOAWAY received from upstream')).toBe('network');
    expect(classifyError('stream closed due to connection_error')).toBe('network');
    expect(classifyError('API returned 503 temporarily')).toBe('network');
    expect(classifyError('Error: Service Unavailable')).toBe('network');
  });

  // ─── Timeout ─────────────────────────────────────────────────────

  it('should detect timeouts', () => {
    expect(classifyError('command timed out after 300000ms')).toBe('timeout');
    expect(classifyError('deadline exceeded')).toBe('timeout');
    expect(classifyError('operation timeout')).toBe('timeout');
  });

  // ─── Permission ──────────────────────────────────────────────────

  it('should detect permission errors', () => {
    expect(classifyError('Error: EACCES: permission denied, open /usr/local/bin/node')).toBe('permission');
    expect(classifyError("sh: permission denied: ./build.sh")).toBe('permission');
  });

  // ─── Read-only FS ────────────────────────────────────────────────

  it('should detect read-only filesystem', () => {
    expect(classifyError('read-only file system')).toBe('fs-readonly');
    expect(classifyError('EROFS: read-only file system')).toBe('fs-readonly');
  });

  // ─── Code Quality Errors (should NOT match) ─────────────────────

  it('should return undefined for compilation errors', () => {
    expect(classifyError('error[E0308]: mismatched types')).toBeUndefined();
  });

  it('should return undefined for test assertion failures', () => {
    expect(classifyError('FAILED: expected 42 but got 0')).toBeUndefined();
  });

  it('should return undefined for linker errors', () => {
    expect(classifyError('ld: symbol(s) not found for architecture x86_64')).toBeUndefined();
  });

  it('should return undefined for generic code errors', () => {
    expect(classifyError('SyntaxError: Unexpected token')).toBeUndefined();
    expect(classifyError("error CS1002: ; expected")).toBeUndefined();
    expect(classifyError('undefined reference to `main`')).toBeUndefined();
  });

  it('should return undefined for empty string', () => {
    expect(classifyError('')).toBeUndefined();
  });
});
