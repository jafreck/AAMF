import { describe, it, expect, vi, afterEach } from 'vitest';
import { execFile } from 'node:child_process';

// We test the module by mocking child_process.execFile.

describe('ensurePythonDeps', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should do nothing when all packages are already importable', async () => {
    // Mock execFile to always succeed (packages present)
    vi.mock('node:child_process', async (importOriginal) => {
      const original = await importOriginal<typeof import('node:child_process')>();
      return {
        ...original,
        execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb?: Function) => {
          if (cb) cb(null, '', '');
          return {} as any;
        }),
      };
    });

    // Re-import to pick up mock
    const { ensurePythonDeps } = await import('../src/indexer/ensure-python-deps.js');
    await expect(ensurePythonDeps('python3')).resolves.toBeUndefined();
  });
});
