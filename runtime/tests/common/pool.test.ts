import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const RUST_OUTPUT_ROOT = join(
  __dirname,
  '..',
  'fixtures',
  'zstd-c-project',
  '.aamf',
  'zstd-rust-output',
);
const POOL_RS = join(RUST_OUTPUT_ROOT, 'src', 'common', 'pool.rs');

let poolSource: string;

describe('pool.rs — POOL symbol migration parity', () => {
  // Load the file once for all structural checks.
  it('should exist and be readable', async () => {
    poolSource = await readFile(POOL_RS, 'utf-8');
    expect(poolSource.length).toBeGreaterThan(0);
  });

  // ── Type definitions (POOL_ctx_s → PoolCtx, POOL_job_s → PoolJob) ──────

  describe('PoolJob (POOL_job_s)', () => {
    it('should be a public struct', () => {
      expect(poolSource).toMatch(/pub struct PoolJob/);
    });

    it('should expose a public `function` field of type PoolFunction', () => {
      expect(poolSource).toMatch(/pub\s+function\s*:\s*PoolFunction/);
    });
  });

  describe('PoolCtx (POOL_ctx_s)', () => {
    it('should be a public struct', () => {
      expect(poolSource).toMatch(/pub struct PoolCtx/);
    });

    it('should have a multithread variant with shared state, condvars, and thread handles', () => {
      // The multithread variant stores Arc<Mutex<...>>, condvars, and threads.
      expect(poolSource).toMatch(/shared\s*:\s*Arc<Mutex<PoolShared>>/);
      expect(poolSource).toMatch(/push_cond\s*:\s*Arc<Condvar>/);
      expect(poolSource).toMatch(/pop_cond\s*:\s*Arc<Condvar>/);
      expect(poolSource).toMatch(/threads\s*:\s*Vec<JoinHandle<\(\)>>/);
    });

    it('should have a single-thread variant gated behind cfg(not(feature = "multithread"))', () => {
      expect(poolSource).toMatch(
        /cfg\(not\(feature\s*=\s*"multithread"\)\)\s*\]\s*\n\s*pub struct PoolCtx/,
      );
    });
  });

  describe('PoolFunction type alias', () => {
    it('should define a public PoolFunction type alias for a boxed FnOnce + Send', () => {
      expect(poolSource).toMatch(
        /pub type PoolFunction\s*=\s*Box<dyn FnOnce\(\)\s*\+\s*Send\s*\+\s*'static>/,
      );
    });
  });

  // ── Function signatures ─────────────────────────────────────────────────

  describe('PoolCtx::create (POOL_create)', () => {
    it('should accept (num_threads: usize, queue_size: usize) and return Option<Self>', () => {
      expect(poolSource).toMatch(
        /pub fn create\s*\(\s*num_threads\s*:\s*usize\s*,\s*queue_size\s*:\s*usize\s*\)\s*->\s*Option<Self>/,
      );
    });
  });

  describe('PoolCtx::try_add (POOL_tryAdd)', () => {
    it('should accept (&self, function: PoolFunction) and return bool', () => {
      expect(poolSource).toMatch(
        /pub fn try_add\s*\(\s*&self\s*,\s*function\s*:\s*PoolFunction\s*\)\s*->\s*bool/,
      );
    });

    it('should return false when the queue is full (multithread path)', () => {
      // The implementation checks is_queue_full and returns false early
      expect(poolSource).toMatch(/is_queue_full/);
      expect(poolSource).toMatch(/return false/);
    });

    it('should notify workers after adding a job (multithread path)', () => {
      // After enqueue, a pop_cond.notify_one() is called to wake a worker
      expect(poolSource).toMatch(/pop_cond\.notify_one\(\)/);
    });

    it('should execute function inline in single-thread mode', () => {
      // In the non-multithread impl, try_add calls the function directly
      expect(poolSource).toMatch(/\(function\)\(\)/);
    });
  });

  describe('PoolCtx::size_of (POOL_sizeof)', () => {
    it('should return usize', () => {
      expect(poolSource).toMatch(/pub fn size_of\s*\(\s*&self\s*\)\s*->\s*usize/);
    });

    it('should account for queue and thread storage in multithread mode', () => {
      // Mirrors pool.c POOL_sizeof: sizeof(ctx) + queueSize*sizeof(job) + threadCapacity*sizeof(thread)
      expect(poolSource).toMatch(/mem::size_of::<PoolCtx>\(\)/);
      expect(poolSource).toMatch(/queue_size\s*\*\s*mem::size_of::<Option<PoolJob>>/);
      expect(poolSource).toMatch(/thread_capacity\s*\*\s*mem::size_of::<JoinHandle<\(\)>>/);
    });
  });

  describe('PoolCtx::join_jobs (POOL_joinJobs)', () => {
    it('should have signature (&self) with no return', () => {
      expect(poolSource).toMatch(/pub fn join_jobs\s*\(\s*&self\s*\)/);
    });

    it('should wait while queue is not empty or threads are busy', () => {
      expect(poolSource).toMatch(/queue_empty.*num_threads_busy/s);
    });

    it('should be a no-op in single-thread mode', () => {
      // There should be a comment/block indicating nothing to do for single-threaded
      expect(poolSource).toMatch(/Nothing to do.*single-threaded|single.threaded/i);
    });
  });

  describe('pool_sizeof standalone helper', () => {
    it('should return 0 for None (mirrors POOL_sizeof(NULL) → 0)', () => {
      expect(poolSource).toMatch(
        /pub fn pool_sizeof\s*\(\s*ctx\s*:\s*Option<&PoolCtx>\s*\)\s*->\s*usize/,
      );
      expect(poolSource).toMatch(/None\s*=>\s*0/);
    });
  });

  // ── Shared internal state (PoolShared) ──────────────────────────────────

  describe('PoolShared (internal state mirroring POOL_ctx_s fields)', () => {
    it('should have circular buffer fields (queue, queue_head, queue_tail, queue_size)', () => {
      expect(poolSource).toMatch(/queue\s*:\s*Vec<Option<PoolJob>>/);
      expect(poolSource).toMatch(/queue_head\s*:\s*usize/);
      expect(poolSource).toMatch(/queue_tail\s*:\s*usize/);
      expect(poolSource).toMatch(/queue_size\s*:\s*usize/);
    });

    it('should track thread state (num_threads_busy, queue_empty, thread_limit, thread_capacity)', () => {
      expect(poolSource).toMatch(/num_threads_busy\s*:\s*usize/);
      expect(poolSource).toMatch(/queue_empty\s*:\s*bool/);
      expect(poolSource).toMatch(/thread_limit\s*:\s*usize/);
      expect(poolSource).toMatch(/thread_capacity\s*:\s*usize/);
    });

    it('should have a shutdown flag', () => {
      expect(poolSource).toMatch(/shutdown\s*:\s*bool/);
    });
  });

  // ── Behavioral invariants ───────────────────────────────────────────────

  describe('behavioral invariants', () => {
    it('should allocate queue_size + 1 slots (circular buffer sentinel)', () => {
      // Mirrors C code: ctx->queueSize = queueSize + 1;
      expect(poolSource).toMatch(/queue_size\s*\+\s*1/);
    });

    it('should implement Drop for multithread PoolCtx (POOL_free)', () => {
      expect(poolSource).toMatch(/impl Drop for PoolCtx/);
      expect(poolSource).toMatch(/shutdown_and_join/);
    });

    it('should reject zero threads in create', () => {
      expect(poolSource).toMatch(/num_threads\s*==\s*0/);
      expect(poolSource).toMatch(/return None/);
    });
  });

  // ── Compilation check ──────────────────────────────────────────────────

  describe('Rust compilation', () => {
    it('should compile without errors (default features)', () => {
      const result = execSync('cargo check 2>&1', {
        cwd: RUST_OUTPUT_ROOT,
        timeout: 60_000,
        encoding: 'utf-8',
      });
      // cargo check exits 0 on success; if it throws, the test fails.
      expect(result).not.toMatch(/^error\[/m);
    });

    it('should compile without errors (multithread feature)', () => {
      const result = execSync('cargo check --features multithread 2>&1', {
        cwd: RUST_OUTPUT_ROOT,
        timeout: 60_000,
        encoding: 'utf-8',
      });
      expect(result).not.toMatch(/^error\[/m);
    });

    it('should pass built-in #[cfg(test)] tests', () => {
      const result = execSync('cargo test 2>&1', {
        cwd: RUST_OUTPUT_ROOT,
        timeout: 60_000,
        encoding: 'utf-8',
      });
      expect(result).toMatch(/test result: ok/);
    });

    it('should pass built-in #[cfg(test)] tests with multithread feature', () => {
      const result = execSync('cargo test --features multithread 2>&1', {
        cwd: RUST_OUTPUT_ROOT,
        timeout: 60_000,
        encoding: 'utf-8',
      });
      expect(result).toMatch(/test result: ok/);
    });
  });
});
