/**
 * Tests for Lore's Transformers.js EmbeddingProvider implementation.
 *
 * These tests load an ONNX embedding model and are gated behind the
 * `AAMF_EMBEDDER=1` environment flag.
 * They are skipped in CI unless that flag is explicitly set.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  DEFAULT_EMBEDDING_MODEL,
  TransformersJsProvider,
} from '@jafreck/lore';

const ENABLED = process.env.AAMF_EMBEDDER === '1';

// ─── Gated: constructor / property tests (requires AAMF_EMBEDDER=1) ───────────

describe.skipIf(!ENABLED)('TransformersJsProvider (before initialization)', () => {
  it('should expose modelName from constructor', () => {
    const p = new TransformersJsProvider('my/model');
    expect(p.modelName).toBe('my/model');
  });

  it('dims should throw before init() is called', () => {
    const p = new TransformersJsProvider('my/model');
    expect(() => p.dims).toThrow('call init() first');
  });

  it('dispose() should resolve immediately when no model was loaded', async () => {
    const p = new TransformersJsProvider('my/model');
    await expect(p.dispose()).resolves.toBeUndefined();
  });
});

describe.skipIf(!ENABLED)('default embedding model', () => {
  it('should configure the current Qwen3 ONNX model', () => {
    const p = new TransformersJsProvider(DEFAULT_EMBEDDING_MODEL);
    expect(p.modelName).toBe('onnx-community/Qwen3-Embedding-0.6B-ONNX');
  });
});

// ─── Gated: requires AAMF_EMBEDDER=1 and an ONNX model download ──────────────

describe.skipIf(!ENABLED)('TransformersJsProvider', () => {
  let provider: TransformersJsProvider;

  afterEach(async () => {
    await provider?.dispose();
  });

  it('returns float arrays of the expected dimension', async () => {
    provider = new TransformersJsProvider(DEFAULT_EMBEDDING_MODEL);
    await provider.init();
    const result = await provider.embed(['hello world']);

    expect(result).toHaveLength(1);
    expect(result[0]!).toHaveLength(provider.dims);
    expect(result[0]!.every(v => typeof v === 'number' && isFinite(v))).toBe(true);
  }, 120_000); // allow time for model load

  it('batches multiple texts into a single model call', async () => {
    provider = new TransformersJsProvider(DEFAULT_EMBEDDING_MODEL);
    await provider.init();
    const texts = ['foo bar', 'baz qux', 'hello world'];
    const result = await provider.embed(texts);

    expect(result).toHaveLength(texts.length);
    for (const vec of result) {
      expect(vec).toHaveLength(provider.dims);
    }
  }, 120_000);

  it('returns an empty array for empty input without loading a model', async () => {
    provider = new TransformersJsProvider(DEFAULT_EMBEDDING_MODEL);
    const result = await provider.embed([]);
    expect(result).toEqual([]);
  });

  it('modelName is set correctly', () => {
    provider = new TransformersJsProvider(DEFAULT_EMBEDDING_MODEL);
    expect(provider.modelName).toBe(DEFAULT_EMBEDDING_MODEL);
  });
});
