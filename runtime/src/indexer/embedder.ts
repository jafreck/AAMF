/**
 * @module indexer/embedder
 *
 * Provides an `EmbeddingProvider` abstraction for generating dense vector
 * embeddings from text. The primary implementation (`SentenceTransformersProvider`)
 * delegates to a Python subprocess that runs a sentence-transformers model,
 * communicating over stdin/stdout using newline-delimited JSON (NDJSON).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as readline from 'node:readline';

// ─── Public interface ─────────────────────────────────────────────────────────

export interface EmbeddingProvider {
  /** Embed a batch of texts; returns one float vector per input. */
  embed(texts: string[]): Promise<number[][]>;
  /** Human-readable model identifier. */
  readonly modelName: string;
  /** Dimensionality of the returned vectors. */
  readonly dims: number;
  /** Release the underlying process / resources. */
  dispose(): Promise<void>;
}

// ─── Python bootstrap script ──────────────────────────────────────────────────

/**
 * Inline Python script: reads NDJSON lines from stdin, each with a `texts`
 * array, and writes back NDJSON lines with an `embeddings` array.
 *
 * Model name is received as the first CLI argument (sys.argv[1]).
 */
const BOOTSTRAP_SCRIPT = `
import sys, json
from sentence_transformers import SentenceTransformer
model = SentenceTransformer(sys.argv[1], trust_remote_code=True)
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    req = json.loads(line)
    vecs = model.encode(req.get('texts', []), normalize_embeddings=True).tolist()
    sys.stdout.write(json.dumps({'embeddings': vecs}) + '\\n')
    sys.stdout.flush()
`.trimStart();

// ─── Implementation ───────────────────────────────────────────────────────────

interface PendingRequest {
  resolve: (value: number[][]) => void;
  reject: (reason: unknown) => void;
}

/**
 * Communicates with a Python subprocess via stdin/stdout NDJSON to produce
 * embeddings using a sentence-transformers compatible model.
 *
 * The subprocess is spawned lazily on the first call to `embed()` and kept
 * alive for the lifetime of the provider for efficiency.
 */
export class SentenceTransformersProvider implements EmbeddingProvider {
  readonly modelName: string;
  readonly dims: number;

  private proc: ChildProcess | null = null;
  private rl: readline.Interface | null = null;
  private readonly pendingRequests: PendingRequest[] = [];
  private readonly pythonBin: string;

  constructor(modelName: string, dims: number, pythonBin = 'python3') {
    this.modelName = modelName;
    this.dims = dims;
    this.pythonBin = pythonBin;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    this.ensureProcess();
    return new Promise<number[][]>((resolve, reject) => {
      this.pendingRequests.push({ resolve, reject });
      this.proc!.stdin!.write(JSON.stringify({ texts }) + '\n');
    });
  }

  async dispose(): Promise<void> {
    if (!this.proc) return;
    const proc = this.proc;
    this.proc = null;
    this.rl?.close();
    this.rl = null;
    proc.stdin?.end();
    await new Promise<void>(resolve => {
      const timeout = setTimeout(() => { proc.kill(); resolve(); }, 5_000);
      proc.once('close', () => { clearTimeout(timeout); resolve(); });
    });
  }

  /** Spawn the Python subprocess and wire up the readline interface. */
  private ensureProcess(): void {
    if (this.proc) return;

    // Pass the script via -c and the model name as the first positional argument.
    this.proc = spawn(this.pythonBin, ['-c', BOOTSTRAP_SCRIPT, this.modelName], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });

    this.rl = readline.createInterface({ input: this.proc.stdout! });

    this.rl.on('line', (line) => {
      const pending = this.pendingRequests.shift();
      if (!pending) return;
      try {
        const { embeddings } = JSON.parse(line) as { embeddings: number[][] };
        pending.resolve(embeddings);
      } catch (err) {
        pending.reject(err);
      }
    });

    this.proc.on('error', (err) => {
      const reqs = this.pendingRequests.splice(0);
      this.proc = null;
      this.rl = null;
      for (const r of reqs) r.reject(err);
    });

    this.proc.on('exit', (code) => {
      if (code !== 0 && this.pendingRequests.length > 0) {
        const err = new Error(`Embedding subprocess exited with code ${code}`);
        const reqs = this.pendingRequests.splice(0);
        for (const r of reqs) r.reject(err);
      }
      if (this.proc) { this.proc = null; this.rl = null; }
    });
  }
}

// ─── Qwen3 factory ────────────────────────────────────────────────────────────

/** Known embedding dimensions for each supported Qwen3-Embedding model size. */
const QWEN3_DIMS: Record<'0.6B' | '4B' | '8B', number> = {
  '0.6B': 1024,
  '4B':   2560,
  '8B':   4096,
};

/**
 * Creates a `SentenceTransformersProvider` pre-configured for the specified
 * Qwen3-Embedding model size.
 *
 * @param size      Model size variant: `'0.6B'`, `'4B'`, or `'8B'`.
 * @param pythonBin Path to the Python executable (default: `'python3'`).
 */
export function Qwen3EmbeddingProvider(
  size: '0.6B' | '4B' | '8B',
  pythonBin = 'python3',
): SentenceTransformersProvider {
  const modelName = `Qwen/Qwen3-Embedding-${size}`;
  return new SentenceTransformersProvider(modelName, QWEN3_DIMS[size], pythonBin);
}
