import { spawn, execFile, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { platform, homedir } from 'node:os';
import { trackProcess, killAllTrackedProcesses } from '@cadre-dev/framework/runtime';

const activeChildren = new Set<ChildProcess>();
const activeProcessGroups = new Set<number>();

export function trackActiveProcess(child: ChildProcess): void {
  pruneProcessGroups();
  activeChildren.add(child);
  if (child.pid !== undefined && platform() !== 'win32') {
    activeProcessGroups.add(child.pid);
  }
  const remove = (): void => { activeChildren.delete(child); };
  if (typeof child.once === 'function') {
    child.once('exit', remove);
    child.once('error', remove);
  } else if (typeof child.on === 'function') {
    child.on('exit', remove);
    child.on('error', remove);
  }
}

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
  /** Called with each chunk of stdout data as it arrives (streaming). */
  onStdoutData?: (chunk: Buffer) => void;
  /** Called with each chunk of stderr data as it arrives (streaming). */
  onStderrData?: (chunk: Buffer) => void;
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
  const { timeout, signal, onStdoutData, onStderrData, ...spawnOpts } = options;
  const start = performance.now();

  return new Promise<SpawnResult>((resolve, reject) => {
    // detached: true gives the child its own process group (PGID = child.pid).
    // This makes killProcessTree(child.pid) correctly sweep all grandchildren
    // (e.g. Electron helpers spawned by the copilot CLI) via process.kill(-pid).
    const child = spawn(command, args, { ...spawnOpts, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });

    trackProcess(child);
    trackActiveProcess(child);

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let killed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closeFallbackTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    let exitCode: number | undefined;
    const onAbort = (): void => {
      killed = true;
      if (child.pid != null) {
        void killProcessTree(child.pid);
      }
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });

    const EXIT_CLOSE_GRACE_MS = 1200;

    const finalize = (code: number): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (closeFallbackTimer) clearTimeout(closeFallbackTimer);
      signal?.removeEventListener('abort', onAbort);

      // Close read ends so inherited FDs in helper processes cannot keep
      // the parent event loop alive indefinitely.
      child.stdout?.destroy();
      child.stderr?.destroy();

      const duration = performance.now() - start;
      resolve({
        exitCode: code,
        stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
        stderr: Buffer.concat(stderrChunks).toString('utf-8'),
        duration,
        killed,
      });
    };

    child.stdout!.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk);
      if (onStdoutData) onStdoutData(chunk);
    });
    child.stderr!.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
      if (onStderrData) onStderrData(chunk);
    });

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

    // Prefer 'close' so we capture trailing output flushed right as the child
    // exits. Some Electron-based CLIs can keep stdio open indefinitely via
    // helper descendants; when that happens, a short post-exit fallback timer
    // forces completion.
    child.on('exit', (code) => {
      activeChildren.delete(child);
      exitCode = code ?? 1;
      if (!closeFallbackTimer) {
        closeFallbackTimer = setTimeout(() => {
          finalize(exitCode ?? 1);
        }, EXIT_CLOSE_GRACE_MS);
      }
    });

    child.on('close', (code) => {
      finalize(code ?? exitCode ?? 1);
    });

    child.on('error', (err) => {
      activeChildren.delete(child);
      if (timer) clearTimeout(timer);
      if (closeFallbackTimer) clearTimeout(closeFallbackTimer);
      signal?.removeEventListener('abort', onAbort);
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

/**
 * Kill all active child processes spawned by spawnWithTimeout.
 *
 * Delegates to the @cadre-dev/framework process tracker which sends SIGTERM
 * to each tracked process group. Used by the shutdown handler to prevent
 * orphaned agent processes when the runtime receives SIGINT/SIGTERM.
 */
export async function killAllActiveProcesses(timeoutMs = 5_000): Promise<void> {
  const children = [...activeChildren];
  const processGroups = [...activeProcessGroups];
  const exits = children.map(child => waitForChildExit(child, timeoutMs));
  killAllTrackedProcesses();
  const escalation = setTimeout(() => {
    for (const child of children) {
      if (child.pid == null || child.exitCode !== null || child.signalCode !== null) continue;
      void killProcessTree(child.pid);
    }
  }, Math.min(1_000, Math.max(1, Math.floor(timeoutMs / 2))));
  const results = await Promise.allSettled(exits);
  clearTimeout(escalation);
  if (platform() !== 'win32') {
    for (const processGroup of processGroups) {
      if (!isProcessGroupAlive(processGroup)) continue;
      try { process.kill(-processGroup, 'SIGKILL'); } catch { /* already exited */ }
    }
    const groupDeadline = Date.now() + timeoutMs;
    while (
      processGroups.some(isProcessGroupAlive) &&
      Date.now() < groupDeadline
    ) {
      await new Promise<void>(resolve => setTimeout(resolve, 25));
    }
  }
  const timedOut = results.filter(result => result.status === 'rejected').length;
  const survivingGroups = platform() === 'win32'
    ? 0
    : processGroups.filter(isProcessGroupAlive).length;
  if (timedOut > 0 || survivingGroups > 0) {
    throw new Error(
      `Timed out waiting for ${timedOut} child process(es) and ${survivingGroups} process group(s) to exit`,
    );
  }
  processGroups.forEach(group => activeProcessGroups.delete(group));
}

function isProcessGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

function pruneProcessGroups(): void {
  if (platform() === 'win32') return;
  for (const processGroup of activeProcessGroups) {
    if (!isProcessGroupAlive(processGroup)) activeProcessGroups.delete(processGroup);
  }
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      rejectExit(new Error('Child process exit timeout'));
    }, timeoutMs);
    const onExit = (): void => {
      clearTimeout(timer);
      resolveExit();
    };
    child.once('exit', onExit);
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
