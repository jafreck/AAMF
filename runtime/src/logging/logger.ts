import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import chalk from 'chalk';
import { format } from 'date-fns';
import { LogLevel, LogEntry, RuntimeEvent } from './events.js';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const LEVEL_COLOR: Record<LogLevel, (s: string) => string> = {
  debug: chalk.gray,
  info: chalk.blue,
  warn: chalk.yellow,
  error: chalk.red,
};

export interface LoggerOptions {
  logDir: string;
  level: LogLevel;
  console: boolean;
}

export class Logger {
  private readonly logDir: string;
  private readonly minLevel: number;
  private readonly consoleEnabled: boolean;
  private source = 'runtime';
  private phase?: number;
  private taskId?: string;
  private runId?: string;
  private invocationId?: string;
  private agent?: string;
  private attempt?: number;
  private dirReady = false;

  /**
   * Write queue — serializes appendFile calls so they never interleave
   * and tracks pending writes so they can be awaited on shutdown.
   */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(opts: LoggerOptions);
  constructor(parent: Logger, source: string);
  constructor(optsOrParent: LoggerOptions | Logger, source?: string) {
    if (optsOrParent instanceof Logger) {
      // child constructor
      this.logDir = optsOrParent.logDir;
      this.minLevel = optsOrParent.minLevel;
      this.consoleEnabled = optsOrParent.consoleEnabled;
      this.dirReady = optsOrParent.dirReady;
      this.source = source!;
      this.runId = optsOrParent.runId;
      this.invocationId = optsOrParent.invocationId;
      this.agent = optsOrParent.agent;
      this.attempt = optsOrParent.attempt;
      this.phase = optsOrParent.phase;
      this.taskId = optsOrParent.taskId;
      // Share the write chain with parent so all children serialize through one queue
      this.writeChain = optsOrParent.writeChain;
    } else {
      this.logDir = optsOrParent.logDir;
      this.minLevel = LEVEL_PRIORITY[optsOrParent.level];
      this.consoleEnabled = optsOrParent.console;
    }
  }

  /* ── context setters ─────────────────────────────────────── */

  setSource(source: string): void {
    this.source = source;
  }

  setPhase(phase: number): void {
    this.phase = phase;
  }

  setTaskId(taskId?: string): void {
    this.taskId = taskId;
  }

  setRunId(runId: string): void {
    this.runId = runId;
  }

  setInvocationId(invocationId: string): void {
    this.invocationId = invocationId;
  }

  setAgent(agent: string): void {
    this.agent = agent;
  }

  setAttempt(attempt: number): void {
    this.attempt = attempt;
  }

  /* ── level helpers ───────────────────────────────────────── */

  debug(message: string, data?: Record<string, unknown>): void {
    this.log('debug', message, data);
  }

  info(message: string, data?: Record<string, unknown>): void {
    this.log('info', message, data);
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.log('warn', message, data);
  }

  error(message: string, data?: Record<string, unknown>): void {
    this.log('error', message, data);
  }

  /* ── typed events ────────────────────────────────────────── */

  event(ev: RuntimeEvent): void {
    const { type, ...rest } = ev;
    this.log('info', type, rest as Record<string, unknown>);
  }

  repeatedFailure(
    ev: Omit<Extract<RuntimeEvent, { type: 'repeated-failure-detected' }>, 'type'>,
  ): void {
    this.event({ type: 'repeated-failure-detected', ...ev });
  }

  /* ── child logger ────────────────────────────────────────── */

  child(source: string): Logger {
    return new Logger(this, source);
  }

  /* ── agent log file ──────────────────────────────────────── */

  async writeAgentLog(agent: string, taskId: string, content: string, invocationId?: string): Promise<void> {
    await this.ensureLogDir();
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = invocationId
      ? `${agent}-${taskId}-${invocationId}-${ts}.log`
      : `${agent}-${taskId}-${ts}.log`;
    await writeFile(join(this.logDir, filename), content, 'utf-8');
  }

  /* ── internals ───────────────────────────────────────────── */

  private log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    if (LEVEL_PRIORITY[level] < this.minLevel) return;

    const now = new Date();
    const entry: LogEntry = {
      timestamp: now.toISOString(),
      level,
      source: this.source,
      ...(this.phase !== undefined && { phase: this.phase }),
      ...(this.taskId !== undefined && { taskId: this.taskId }),
      ...(this.runId !== undefined && { runId: this.runId }),
      ...(this.invocationId !== undefined && { invocationId: this.invocationId }),
      ...(this.agent !== undefined && { agent: this.agent }),
      ...(this.attempt !== undefined && { attempt: this.attempt }),
      message,
      ...(data !== undefined && { data }),
    };

    if (this.consoleEnabled) {
      const time = format(now, 'HH:mm:ss');
      const tag = level.toUpperCase().padEnd(5);
      const colorize = LEVEL_COLOR[level];
      const tags: string[] = [];
      if (this.runId) tags.push(`run=${this.runId}`);
      if (this.invocationId) tags.push(`inv=${this.invocationId}`);
      if (this.phase !== undefined) tags.push(`phase=${this.phase}`);
      if (this.taskId) tags.push(`task=${this.taskId}`);
      if (this.agent) tags.push(`agent=${this.agent}`);
      const corr = tags.length > 0 ? ' ' + chalk.dim(tags.join(' ')) : '';
      const line = `${chalk.dim(`[${time}]`)} ${colorize(tag)} ${chalk.cyan(this.source)}${corr}: ${message}`;
      // eslint-disable-next-line no-console
      console.log(line);
    }

    // Queue the write — serialized through writeChain to prevent interleaving
    this.writeChain = this.writeChain
      .then(() => this.appendEntry(entry))
      .catch(() => {/* best-effort: swallow write errors to keep the chain alive */});
  }

  /** Await all pending log writes. Call during graceful shutdown. */
  async flush(): Promise<void> {
    await this.writeChain;
  }

  private async appendEntry(entry: LogEntry): Promise<void> {
    await this.ensureLogDir();
    const line = JSON.stringify(entry) + '\n';
    await appendFile(join(this.logDir, 'migration.log'), line, 'utf-8');
  }

  private async ensureLogDir(): Promise<void> {
    if (this.dirReady) return;
    await mkdir(this.logDir, { recursive: true });
    this.dirReady = true;
  }
}
