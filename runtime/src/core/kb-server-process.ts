/**
 * @module core/kb-server-process
 *
 * Manages the lifecycle of the KB MCP server subprocess and exposes the
 * `McpServerConfig` that agents need to spawn their own connections.
 *
 * Launch modes (controlled by `AAMF_USE_COMPILED_KB_SERVER` env flag):
 *  - dev  (default) : spawns via `tsx src/kb-server/server.ts --db <path>`
 *  - prod           : spawns via `node dist/kb-server/server.js --db <path>`
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import type { McpServerConfig } from '../kb-server/server.js';

// Re-export for convenience.
export type { McpServerConfig };

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Directory containing this source file (runtime/src/core/). */
const __dirname = dirname(fileURLToPath(import.meta.url));
/** runtime/src/ */
const SRC_ROOT = join(__dirname, '..');
/** runtime/ (package root) */
const PACKAGE_ROOT = join(SRC_ROOT, '..');

/** Default milliseconds to wait for the server to write READY before giving up. */
const START_TIMEOUT_MS = 30_000;

function buildConfig(dbPath: string): McpServerConfig {
  if (process.env['AAMF_USE_COMPILED_KB_SERVER'] === '1') {
    return {
      command: 'node',
      args: [join(PACKAGE_ROOT, 'dist', 'kb-server', 'server.js'), '--db', dbPath],
    };
  }
  return {
    command: 'tsx',
    args: [join(SRC_ROOT, 'kb-server', 'server.ts'), '--db', dbPath],
  };
}

// ─── KbServerProcess ──────────────────────────────────────────────────────────

/**
 * Wrapper around the KB MCP server subprocess.
 *
 * @example
 * ```ts
 * const srv = new KbServerProcess('/path/to/kb.db');
 * await srv.start();
 * // Agent can now use srv.mcpConfig to connect.
 * await srv.stop();
 * ```
 */
export class KbServerProcess {
  private readonly dbPath: string;
  private readonly config: McpServerConfig;
  private child: ChildProcess | null = null;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    this.config = buildConfig(dbPath);
  }

  /** McpServerConfig usable by an MCP client to spawn its own connection. */
  get mcpConfig(): McpServerConfig {
    return this.config;
  }

  /**
   * Spawn the server subprocess and wait for it to signal readiness.
   *
   * The server writes `READY\n` to stderr once connected.  `start()` resolves
   * when that line is received, or rejects if the process exits first or if
   * the server does not become ready within `timeoutMs` milliseconds.
   *
   * @param timeoutMs - Maximum milliseconds to wait for READY (default: 30 s).
   */
  start(timeoutMs = START_TIMEOUT_MS): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.child) {
        resolve();
        return;
      }

      const { command, args, env } = this.config;
      const child = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...env },
      });

      this.child = child;

      let stderrBuf = '';
      let settled = false;

      const settle = (fn: () => void) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          fn();
        }
      };

      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        this.child = null;
        settle(() => reject(new Error(`KB server did not become ready within ${timeoutMs}ms`)));
      }, timeoutMs);

      child.stderr?.on('data', (chunk: Buffer) => {
        stderrBuf += chunk.toString();
        if (stderrBuf.includes('READY')) {
          settle(() => resolve());
        }
      });

      child.on('error', (err) => {
        this.child = null;
        settle(() => reject(err));
      });

      child.on('exit', (code) => {
        this.child = null;
        // If we haven't resolved yet (no READY received), reject.
        settle(() => reject(new Error(`KB server exited unexpectedly with code ${code}`)));
      });
    });
  }

  /**
   * Send SIGTERM to the child process and wait for it to exit.
   * Resolves immediately if the server was not started.
   */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      const child = this.child;
      if (!child) {
        resolve();
        return;
      }

      child.once('exit', () => {
        this.child = null;
        resolve();
      });

      child.kill('SIGTERM');
    });
  }
}
