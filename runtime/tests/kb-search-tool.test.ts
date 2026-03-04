import { describe, it, expect, vi } from 'vitest';
import { handler, type SearchObservation, type SearchObserver } from '../src/kb-server/tools/search.js';

type Row = {
  symbol_id: number;
  name: string;
  kind: string;
  file_path: string;
  start_line: number;
  end_line: number;
  score: number;
};

function makeDb(opts: {
  structural?: Row[];
  likeFallback?: Row[];
  semantic?: Row[];
  throwStructural?: boolean;
  throwSemantic?: boolean;
}): any {
  return {
    prepare: (sql: string) => {
      if (sql.includes('FROM symbols_fts')) {
        if (opts.throwStructural) throw new Error('fts parse error');
        return { all: () => opts.structural ?? [] };
      }
      if (sql.includes('WHERE s.name LIKE')) {
        return { all: () => opts.likeFallback ?? [] };
      }
      if (sql.includes('FROM symbol_embeddings')) {
        if (opts.throwSemantic) throw new Error('semantic failed');
        return { all: () => opts.semantic ?? [] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
}

describe('kb search tool handler', () => {
  const s1: Row = {
    symbol_id: 1,
    name: 'alpha',
    kind: 'function',
    file_path: 'a.ts',
    start_line: 1,
    end_line: 2,
    score: -1,
  };
  const s2: Row = {
    symbol_id: 2,
    name: 'beta',
    kind: 'function',
    file_path: 'b.ts',
    start_line: 3,
    end_line: 4,
    score: -0.8,
  };
  const s3: Row = {
    symbol_id: 3,
    name: 'gamma',
    kind: 'function',
    file_path: 'c.ts',
    start_line: 5,
    end_line: 6,
    score: -0.6,
  };

  it('uses structural mode by default', async () => {
    const db = makeDb({ structural: [s1, s2] });

    const result = await handler(db, { query: 'alpha' });

    expect(result.mode_used).toBe('structural');
    expect(result.results).toEqual([s1, s2]);
  });

  it('falls back to LIKE search when FTS query fails', async () => {
    const db = makeDb({ throwStructural: true, likeFallback: [s2] });

    const result = await handler(db, { query: 'operator+*', mode: 'structural' });

    expect(result.mode_used).toBe('structural');
    expect(result.results).toEqual([s2]);
  });

  it('returns semantic results when embedder succeeds', async () => {
    const db = makeDb({ structural: [s1], semantic: [s3, s2] });
    const embedder = { embed: vi.fn().mockResolvedValue([[0.1, 0.2]]) };

    const result = await handler(db, { query: 'concept', mode: 'semantic' }, embedder as any);

    expect(result.mode_used).toBe('semantic');
    expect(result.results).toEqual([s3, s2]);
    expect(embedder.embed).toHaveBeenCalledWith(['concept']);
  });

  it('falls back to structural in semantic mode when embeddings are unavailable', async () => {
    const db = makeDb({ structural: [s1], throwSemantic: true });
    const embedder = { embed: vi.fn().mockResolvedValue([[0.3, 0.4]]) };

    const result = await handler(db, { query: 'concept', mode: 'semantic' }, embedder as any);

    expect(result.mode_used).toBe('structural (fallback: no embeddings)');
    expect(result.results).toEqual([s1]);
  });

  it('fuses structural and semantic rankings with RRF and deduplicates by symbol id', async () => {
    const structural = [s1, s2];
    const semantic = [{ ...s2, score: 0.01 }, { ...s3, score: 0.02 }];
    const db = makeDb({ structural, semantic });
    const embedder = { embed: vi.fn().mockResolvedValue([[0.9, 0.8]]) };

    const result = await handler(db, { query: 'anything', mode: 'fused', limit: 10 }, embedder as any);

    expect(result.mode_used).toBe('fused');
    expect(result.results).toHaveLength(3);
    expect(result.results[0]?.symbol_id).toBe(2);
    expect(new Set(result.results.map(r => r.symbol_id)).size).toBe(3);
  });

  it('degrades to structural mode when fused search has no embedder', async () => {
    const db = makeDb({ structural: [s1, s2] });

    const result = await handler(db, { query: 'q', mode: 'fused' });

    expect(result.mode_used).toBe('structural (no query-time embedder)');
    expect(result.results).toEqual([s1, s2]);
  });
});

// ─── SearchObserver callback ────────────────────────────────────────────────

describe('kb search tool – observer callback', () => {
  const s1: Row = {
    symbol_id: 1,
    name: 'alpha',
    kind: 'function',
    file_path: 'a.ts',
    start_line: 1,
    end_line: 2,
    score: -1,
  };

  it('should invoke observer with correct fields on structural search', async () => {
    const db = makeDb({ structural: [s1] });
    const observations: SearchObservation[] = [];
    const observer: SearchObserver = (obs) => observations.push(obs);

    await handler(db, { query: 'alpha', mode: 'structural' }, undefined, observer);

    expect(observations).toHaveLength(1);
    const obs = observations[0]!;
    expect(obs.query).toBe('alpha');
    expect(obs.requestedMode).toBe('structural');
    expect(obs.modeUsed).toBe('structural');
    expect(obs.resultCount).toBe(1);
    expect(obs.topScore).toBe(-1);
    expect(obs.latencyMs).toBeGreaterThanOrEqual(0);
    expect(obs.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('should report zero results and null topScore on no matches', async () => {
    const db = makeDb({ structural: [] });
    const observations: SearchObservation[] = [];
    const observer: SearchObserver = (obs) => observations.push(obs);

    await handler(db, { query: 'zzz', mode: 'structural' }, undefined, observer);

    expect(observations).toHaveLength(1);
    expect(observations[0]!.resultCount).toBe(0);
    expect(observations[0]!.topScore).toBeNull();
  });

  it('should report fallback mode when semantic requested without embedder', async () => {
    const db = makeDb({ structural: [s1] });
    const observations: SearchObservation[] = [];
    const observer: SearchObserver = (obs) => observations.push(obs);

    await handler(db, { query: 'alpha', mode: 'semantic' }, undefined, observer);

    expect(observations).toHaveLength(1);
    expect(observations[0]!.requestedMode).toBe('semantic');
    expect(observations[0]!.modeUsed).toBe('structural (no query-time embedder)');
  });

  it('should not break search if observer throws', async () => {
    const db = makeDb({ structural: [s1] });
    const throwingObserver: SearchObserver = () => { throw new Error('boom'); };

    const result = await handler(db, { query: 'alpha', mode: 'structural' }, undefined, throwingObserver);

    expect(result.mode_used).toBe('structural');
    expect(result.results).toEqual([s1]);
  });

  it('should report fused mode on successful fused search', async () => {
    const semantic = [{ ...s1, score: 0.01 }];
    const db = makeDb({ structural: [s1], semantic });
    const embedder = { embed: vi.fn().mockResolvedValue([[0.1, 0.2]]) };
    const observations: SearchObservation[] = [];
    const observer: SearchObserver = (obs) => observations.push(obs);

    await handler(db, { query: 'alpha', mode: 'fused' }, embedder as any, observer);

    expect(observations).toHaveLength(1);
    expect(observations[0]!.requestedMode).toBe('fused');
    expect(observations[0]!.modeUsed).toBe('fused');
  });
});
