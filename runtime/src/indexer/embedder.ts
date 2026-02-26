/**
 * @module indexer/embedder
 *
 * Provides an `EmbeddingProvider` abstraction for generating dense vector
 * embeddings from text. The primary implementation (`SentenceTransformersProvider`)
 * delegates to a Python subprocess that runs a sentence-transformers model,
 * communicating over stdin/stdout using newline-delimited JSON (NDJSON).
 *
 * The model's embedding dimensionality is auto-detected at startup — the
 * Python script writes a `{"dims": N}` line before entering the request loop.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as readline from 'node:readline';

// ─── Public interface ─────────────────────────────────────────────────────────

export interface EmbeddingProvider {
  /** Embed a batch of texts; returns one float vector per input. */
  embed(texts: string[]): Promise<number[][]>;
  /** Human-readable model identifier. */
  readonly modelName: string;
  /**
   * Dimensionality of the returned vectors.
   * Only valid after `init()` resolves (throws before that).
   */
  readonly dims: number;
  /**
   * Spawn the Python subprocess, load the model, and detect dim size.
   * Must be called (and awaited) before the first `embed()` call.
   */
  init(): Promise<void>;
  /** Release the underlying process / resources. */
  dispose(): Promise<void>;
}

// ─── Python bootstrap script ──────────────────────────────────────────────────

/**
 * Inline Python script that:
 *   1. Loads the model.
 *   2. Prints `{"dims": <N>}` on the first stdout line.
 *   3. Enters an NDJSON request loop (stdin → stdout).
 *
 * Model name is received as sys.argv[1].
 */
const BOOTSTRAP_SCRIPT = `
import sys, json
from sentence_transformers import SentenceTransformer
model = SentenceTransformer(sys.argv[1], trust_remote_code=True)
dims = model.get_sentence_embedding_dimension()
sys.stdout.write(json.dumps({"dims": dims}) + "\\n")
sys.stdout.flush()
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
 * Call `init()` first to spawn the process and detect the model's embedding
 * dimensionality.  The subprocess is kept alive for the lifetime of the
 * provider for efficiency.
 */
export class SentenceTransformersProvider implements EmbeddingProvider {
  readonly modelName: string;
  private _dims: number | null = null;

  private proc: ChildProcess | null = null;
  private rl: readline.Interface | null = null;
  private readonly pendingRequests: PendingRequest[] = [];
  private readonly pythonBin: string;
  /** Whether the first stdout line (dims handshake) has been consumed. */
  private initialized = false;

  constructor(modelName: string, pythonBin = 'python3') {
    this.modelName = modelName;
    this.pythonBin = pythonBin;
  }

  /** Embedding dimensionality — available only after `init()`. */
  get dims(): number {
    if (this._dims === null) {
      throw new Error('EmbeddingProvider not initialised — call init() first');
    }
    return this._dims;
  }

  /**
   * Spawn the Python subprocess, load the model, and read the `{"dims": N}`
   * handshake line.  This may take a while on first run (model download).
   */
  async init(): Promise<void> {
    if (this.initialized) return;
    this.spawnProcess();

    // The very first line from the subprocess is the dims handshake.
    return new Promise<void>((resolve, reject) => {
      const onLine = (line: string) => {
        try {
          const msg = JSON.parse(line) as { dims?: number };
          if (typeof msg.dims === 'number') {
            this._dims = msg.dims;
            this.initialized = true;
            resolve();
          } else {
            reject(new Error(`Unexpected handshake from embedding subprocess: ${line}`));
          }
        } catch (err) {
          reject(new Error(`Failed to parse embedding handshake: ${line}`));
        }
      };
      // Read exactly one line for the handshake, then re-wire for embed requests.
      this.rl!.once('line', onLine);

      // If the process dies before the handshake, reject.
      this.proc!.once('exit', (code) => {
        if (!this.initialized) {
          reject(new Error(`Embedding subprocess exited with code ${code} before handshake`));
        }
      });
    });
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    if (!this.initialized) {
      throw new Error('EmbeddingProvider not initialised — call init() first');
    }
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
  private spawnProcess(): void {
    if (this.proc) return;

    this.proc = spawn(this.pythonBin, ['-c', BOOTSTRAP_SCRIPT, this.modelName], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });

    this.rl = readline.createInterface({ input: this.proc.stdout! });

    // After init(), all subsequent lines are embed responses.
    this.rl.on('line', (line) => {
      // Skip lines until init handshake is done (handled by init's once listener).
      if (!this.initialized) return;
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
  return new SentenceTransformersProvider(modelName, pythonBin);
}
