import { spawn, execFile, type SpawnOptions } from 'node:child_process';
import { platform, homedir } from 'node:os';

/** Result returned after a spawned child process completes. */
export interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Wall-clock duration in milliseconds. */
  duration: number;
  /** Whether the process was killed (e.g. due to timeout). */
  killed: boolean;
}

export interface SpawnWithTimeoutOptions extends SpawnOptions {
  timeout?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Spawn a child process, capture stdout/stderr, and enforce an optional
 * timeout by killing the process tree if it exceeds the limit.
 */
export async function spawnWithTimeout(
  command: string,
  args: string[],
  options: SpawnWithTimeoutOptions = {},
): Promise<SpawnResult> {
  const { timeout, ...spawnOpts } = options;
  const start = performance.now();

  return new Promise<SpawnResult>((resolve, reject) => {
    const child = spawn(command, args, { ...spawnOpts, stdio: ['ignore', 'pipe', 'pipe'] });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let killed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    child.stdout!.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr!.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    if (timeout !== undefined && timeout > 0) {
      timer = setTimeout(() => {
        killed = true;
        if (child.pid != null) {
          killProcessTree(child.pid).catch(() => {
            // Fallback: kill the child directly if tree-kill fails.
            try { child.kill('SIGKILL'); } catch { /* already exited */ }
          });
        } else {
          try { child.kill('SIGKILL'); } catch { /* already exited */ }
        }
      }, timeout);
    }

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      const duration = performance.now() - start;
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
        stderr: Buffer.concat(stderrChunks).toString('utf-8'),
        duration,
        killed,
      });
    });

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Kill a process and its children.
 *
 * On Windows, uses `taskkill /T /F /PID` for tree kill.
 * On Unix, sending a signal to a negative PID targets the entire process group.
 * Falls back to killing just the PID if the group/tree kill fails.
 */
export async function killProcessTree(pid: number): Promise<void> {
  if (platform() === 'win32') {
    return new Promise<void>((resolve) => {
      execFile('taskkill', ['/T', '/F', '/PID', String(pid)], (err) => {
        if (err) {
          // taskkill failed — try direct kill as fallback
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // Process already exited; nothing to do.
          }
        }
        resolve();
      });
    });
  }

  // Unix: negative PID kills the entire process group.
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // Process group kill failed — try killing the individual process.
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Process already exited; nothing to do.
    }
  }
}

/**
 * Resolve the PATH that a user's login shell would see.
 *
 * Spawns the given shell (or `$SHELL`, or `/bin/sh`) with `-l -c 'echo $PATH'`
 * to capture the fully-initialised PATH, including entries added by
 * `~/.zshrc`, `~/.bashrc`, `~/.cargo/env`, etc.
 *
 * The resolved PATH can optionally be extended with `extraPath` entries,
 * which are prepended so they take priority.
 *
 * On failure (e.g. shell not found), falls back to the current `process.env.PATH`.
 */
export async function resolveLoginPath(options: {
  /** Shell binary to invoke for login PATH resolution. */
  shell?: string;
  /** Additional directories to prepend to the resolved PATH. Supports ~ expansion. */
  extraPath?: string[];
  /** Timeout in ms for the shell invocation (default 5 000). */
  timeout?: number;
} = {}): Promise<string> {
  const shell = options.shell ?? process.env.SHELL ?? '/bin/sh';
  const timeout = options.timeout ?? 5_000;
  const home = homedir();

  let resolvedPath = process.env.PATH ?? '';

  try {
    const result = await spawnWithTimeout(shell, ['-l', '-c', 'echo "$PATH"'], { timeout });
    const output = result.stdout.trim();
    if (result.exitCode === 0 && output.length > 0) {
      resolvedPath = output;
    }
  } catch {
    // Shell invocation failed — keep current PATH as fallback.
  }

  // Prepend extraPath entries (with ~ expansion)
  if (options.extraPath && options.extraPath.length > 0) {
    const expanded = options.extraPath.map(p => p.replace(/^~(?=\/|$)/, home));
    resolvedPath = [...expanded, resolvedPath].join(':');
  }

  return resolvedPath;
}
