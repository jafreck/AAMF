/**
 * Tests for EmbeddingProvider / SentenceTransformersProvider.
 *
 * These tests require a Python environment with `sentence-transformers`
 * installed and are gated behind the `AAMF_EMBEDDER=1` environment flag.
 * They are skipped in CI unless that flag is explicitly set.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { SentenceTransformersProvider, Qwen3EmbeddingProvider } from '../src/indexer/embedder.js';

const ENABLED = process.env.AAMF_EMBEDDER === '1';

// ─── Non-gated: constructor / property tests ──────────────────────────────────

describe('SentenceTransformersProvider (no subprocess)', () => {
  it('should expose modelName and dims from constructor', () => {
    const p = new SentenceTransformersProvider('my/model', 768);
    expect(p.modelName).toBe('my/model');
    expect(p.dims).toBe(768);
  });

  it('should return [] for empty input without spawning a process', async () => {
    const p = new SentenceTransformersProvider('my/model', 768);
    const result = await p.embed([]);
    expect(result).toEqual([]);
  });

  it('dispose() should resolve immediately when no subprocess was started', async () => {
    const p = new SentenceTransformersProvider('my/model', 768);
    await expect(p.dispose()).resolves.toBeUndefined();
  });
});

describe('Qwen3EmbeddingProvider factory', () => {
  it('should set correct modelName and dims for 0.6B', () => {
    const p = Qwen3EmbeddingProvider('0.6B');
    expect(p.modelName).toBe('Qwen/Qwen3-Embedding-0.6B');
    expect(p.dims).toBe(1024);
  });

  it('should set correct modelName and dims for 4B', () => {
    const p = Qwen3EmbeddingProvider('4B');
    expect(p.modelName).toBe('Qwen/Qwen3-Embedding-4B');
    expect(p.dims).toBe(2560);
  });

  it('should set correct modelName and dims for 8B', () => {
    const p = Qwen3EmbeddingProvider('8B');
    expect(p.modelName).toBe('Qwen/Qwen3-Embedding-8B');
    expect(p.dims).toBe(4096);
  });
});

// ─── Gated: requires AAMF_EMBEDDER=1 and a Python environment ─────────────────

describe.skipIf(!ENABLED)('Qwen3EmbeddingProvider', () => {
  let provider: SentenceTransformersProvider;

  afterEach(async () => {
    await provider?.dispose();
  });

  it('returns float arrays of the expected dimension (0.6B)', async () => {
    provider = Qwen3EmbeddingProvider('0.6B');
    const result = await provider.embed(['hello world']);

    expect(result).toHaveLength(1);
    expect(result[0]).toHaveLength(provider.dims);
    expect(result[0].every(v => typeof v === 'number' && isFinite(v))).toBe(true);
  }, 120_000); // allow time for model load

  it('batches multiple texts into a single round-trip', async () => {
    provider = Qwen3EmbeddingProvider('0.6B');
    const texts = ['foo bar', 'baz qux', 'hello world'];
    const result = await provider.embed(texts);

    expect(result).toHaveLength(texts.length);
    for (const vec of result) {
      expect(vec).toHaveLength(provider.dims);
    }
  }, 120_000);

  it('returns an empty array for empty input without spawning a process', async () => {
    provider = Qwen3EmbeddingProvider('0.6B');
    const result = await provider.embed([]);
    expect(result).toEqual([]);
  });

  it('modelName is set correctly', () => {
    provider = Qwen3EmbeddingProvider('0.6B');
    expect(provider.modelName).toBe('Qwen/Qwen3-Embedding-0.6B');
    expect(provider.dims).toBe(1024);
  });
});
